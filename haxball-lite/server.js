// Haxball-lite server: authoritative 60Hz physics, lobbies, bots, host settings.
// Run:      npm install && node server.js        (PORT env var, default 3000)
// Proxmox LXC (Debian/Ubuntu): apt install -y nodejs npm, copy this folder to /opt/haxball, npm install
// systemd unit /etc/systemd/system/haxball.service, then: systemctl enable --now haxball
//   [Service]  WorkingDirectory=/opt/haxball  ExecStart=/usr/bin/node server.js  Restart=always
//   [Install]  WantedBy=multi-user.target
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const PR = 15, BR = 10, GD = 40, ACC = 0.1, KICK = 5, CURVE = 0.02;
let BN = 0.5;   // restitution, set per lobby every tick
const SIZES = [[600, 300, 100], [800, 400, 130], [1100, 550, 170]].map(([W, H, G]) => ({ W, H, G }));
const maps = {};
function getMap(L) {                      // geometry for the lobby's map size and goal-size setting (cached)
  const key = L.size + '|' + L.set.gs;
  if (!maps[key]) {
    const { W, H, G: g0 } = SIZES[L.size], G = Math.min(g0 * L.set.gs, H - 40), y1 = (H - G) / 2, y2 = (H + G) / 2;
    maps[key] = { W, H, y1, y2, posts: [[0, y1], [0, y2], [W, y1], [W, y2]].map(([x, y]) => ({ x, y, vx: 0, vy: 0, r: 5, im: 0 })) };
  }
  return maps[key];
}
// sc score limit, tm minutes, ps player speed, kp kick power, cv curve, sp sprint boost, gh ghost allowed, pc player collisions,
// bf ball friction, bn bounciness, br ball size, pr player size, bm ball weight, pf player friction, gs goal size, sd stamina drain
const DEF = { sc: 5, tm: 3, ps: 1, kp: 1, cv: 1, sp: 1.5, gh: 1, pc: 1, bf: 1, bn: .5, br: 1, pr: 1, bm: 1, pf: 1, gs: 1, sd: 1 };
const RANGE = { sc: [1, 15], tm: [1, 10], ps: [.5, 2], kp: [.5, 2], cv: [0, 3], sp: [1, 2.5], gh: [0, 1], pc: [0, 1],
  bf: [.2, 3], bn: [.1, 1.2], br: [.6, 2], pr: [.6, 1.6], bm: [.4, 3], pf: [.4, 2], gs: [.5, 2], sd: [0, 3] };

const PAGES = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')];
const srv = http.createServer((q, r) => {
  const f = PAGES.find(p => fs.existsSync(p));
  if (!f) { r.writeHead(500, { 'Content-Type': 'text/plain' }); return r.end('index.html not found. Looked in:\n' + PAGES.join('\n')); }
  fs.readFile(f, (e, d) => { r.writeHead(e ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(e ? String(e) : d); });
});
const wss = new WebSocketServer({ server: srv, maxPayload: 1024 });
const lobbies = new Map(), all = new Set();
let uid = 0, lid = 0;
const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const cast = (L, m) => { const s = JSON.stringify(m); L.players.forEach(p => p.ws && p.ws.readyState === 1 && p.ws.send(s)); };
const r1 = n => Math.round(n * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clean = (s, n, d) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) || d;
const mk = o => ({ id: ++uid, name: '', team: 's', L: null, x: 0, y: 0, vx: 0, vy: 0, r: PR, im: .5,
  ix: 0, iy: 0, k: 0, c: 0, sp: 0, kc: 0, st: 1, tired: 0, on: 0, g: 0, gh: 0, ...o });

function pushList() {
  const list = [...lobbies.values()].map(L => ({ id: L.id, name: L.name, mode: L.mode, n: L.players.filter(q => !q.bot).length, ph: L.ph }));
  all.forEach(p => !p.L && send(p.ws, { t: 'lobbies', list }));
}
function info(L) {
  cast(L, { t: 'lobby', id: L.id, name: L.name, mode: L.mode, size: L.size, set: L.set, host: L.host.id, ph: L.ph,
    players: L.players.map(q => ({ id: q.id, name: q.name, team: q.team, bot: !!q.bot })) });
  pushList();
}
function leave(p) {
  const L = p.L; if (!L) return;
  p.L = null; p.team = 's'; p.ix = p.iy = p.k = p.c = p.sp = p.g = 0;
  L.players = L.players.filter(q => q !== p);
  if (!L.players.some(q => !q.bot)) lobbies.delete(L.id);
  else { if (L.host === p) L.host = L.players.find(q => !q.bot); info(L); }
  send(p.ws, { t: 'left' }); pushList();
}
function spawn(p, M) { p.x = p.team === 'r' ? M.W * .25 : M.W * .75; p.y = M.H / 2; p.vx = p.vy = 0; p.st = 1; p.tired = 0; }
function kickoff(L) {
  const M = SIZES[L.size], b = L.g.ball; b.x = M.W / 2; b.y = M.H / 2; b.vx = b.vy = b.sp = 0;
  for (const t of ['r', 'b']) {
    const ps = L.players.filter(p => p.team === t);
    ps.forEach((p, i) => { spawn(p, M); p.y = M.H * (i + 1) / (ps.length + 1); });
  }
}
function startGame(L) {
  L.ph = 'play';
  L.g = { ph: 'play', sc: [0, 0], tl: L.set.tm * 3600, pt: 0, msg: '', ball: { x: 0, y: 0, vx: 0, vy: 0, sp: 0, r: BR, im: 1 } };
  kickoff(L); info(L);
}
function handle(p, m) {
  if (m.name) p.name = clean(m.name, 16, p.name);
  const L = p.L, host = L && L.host === p;
  switch (m.t) {
    case 'create': {
      if (L) return;
      const n = { id: ++lid, name: clean(m.lname, 24, p.name + "'s lobby"), mode: [1, 2, 3].includes(m.mode) ? m.mode : 2,
        size: [0, 1, 2].includes(m.size) ? m.size : 1, set: { ...DEF }, host: p, players: [p], ph: 'lobby', g: null };
      lobbies.set(n.id, n); p.L = n; p.team = 's'; info(n); break;
    }
    case 'join': {
      const T = lobbies.get(m.id);
      if (L || !T || T.players.length >= 16) return;
      T.players.push(p); p.L = T; p.team = 's'; info(T); break;
    }
    case 'team': {
      if (!L || !['r', 'b', 's'].includes(m.team) || m.team === p.team) return;
      if (m.team !== 's' && L.players.filter(q => q.team === m.team).length >= L.mode) return;
      p.team = m.team; p.ix = p.iy = p.k = p.c = p.sp = p.g = 0;
      if (L.ph === 'play' && p.team !== 's') spawn(p, SIZES[L.size]);
      info(L); break;
    }
    case 'start': if (host && L.ph === 'lobby' && L.players.some(q => q.team !== 's')) startGame(L); break;
    case 'stop': if (host && L.ph === 'play') { L.ph = 'lobby'; L.g = null; info(L); } break;
    case 'in': p.ix = clamp(+m.x || 0, -1, 1); p.iy = clamp(+m.y || 0, -1, 1); p.k = m.k ? 1 : 0; p.c = Math.sign(+m.c || 0); p.sp = m.s ? 1 : 0; p.g = m.g ? 1 : 0; break;
    case 'bot':
      if (host && ['r', 'b'].includes(m.team) && L.players.length < 16 && L.players.filter(q => q.team === m.team).length < L.mode) {
        const q = mk({ bot: 1, team: m.team, L }); q.name = 'Bot ' + q.id; L.players.push(q);
        if (L.ph === 'play') spawn(q, SIZES[L.size]);
        info(L);
      } break;
    case 'rm': {
      if (!host) return;
      const t = L.players.find(q => q.id === m.id); if (!t || t === p) return;
      if (t.bot) { L.players = L.players.filter(q => q !== t); info(L); } else leave(t);
      break;
    }
    case 'set': {
      if (!host) return;
      if (m.k === 'reset') { L.set = { ...DEF }; info(L); break; }
      const k = m.k, v = +m.v; if (isNaN(v)) return;
      if (k === 'size' || k === 'mode') {
        if (L.ph !== 'lobby') return;
        if (k === 'size' && [0, 1, 2].includes(v)) L.size = v;
        else if (k === 'mode' && [1, 2, 3].includes(v) && ['r', 'b'].every(t => L.players.filter(q => q.team === t).length <= v)) L.mode = v;
        else return;
      } else if (RANGE[k]) L.set[k] = Math.round(clamp(v, ...RANGE[k]) * 100) / 100; else return;
      info(L); break;
    }
    case 'leave': leave(p); break;
  }
}

// ---- bots ----
function botAI(p, ps, b, M) {
  const d0 = q => Math.hypot(q.x - b.x, q.y - b.y), mates = ps.filter(q => q.team === p.team);
  const near = mates.reduce((a, q) => d0(q) < d0(a) ? q : a), dir = p.team === 'r' ? 1 : -1;
  const gx = p.team === 'r' ? M.W : 0, og = M.W - gx; let tx, ty;
  if (near === p) {                                   // chaser: get behind the ball, then drive it at goal
    const ax = gx - b.x, ay = M.H / 2 - b.y, l = Math.hypot(ax, ay) || 1;
    tx = b.x - ax / l * 24; ty = b.y - ay / l * 24;
    if ((p.x - b.x) * dir > 0 && Math.abs(p.y - b.y) < 45) ty += (p.y < b.y ? -1 : 1) * 45;   // wrong side: go around
    else if (Math.hypot(tx - p.x, ty - p.y) < 16) { tx = b.x; ty = b.y; }
  } else { tx = og + (b.x - og) * .45; ty = M.H / 2 + (b.y - M.H / 2) * .5; }                 // others: cover the goal side
  const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
  p.ix = d > 5 ? dx / d : 0; p.iy = d > 5 ? dy / d : 0; p.sp = near === p && d > 90 ? 1 : 0;
  p.k = d0(p) < p.r + b.r + 5 && (b.x - p.x) * dir > -3 ? 1 : 0; p.c = 0;
}

// ---- physics ----
function hit(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), m = a.r + b.r;
  if (d >= m || !d) return;
  const nx = dx / d, ny = dy / d, t = a.im + b.im, o = m - d;
  a.x -= nx * o * a.im / t; a.y -= ny * o * a.im / t; b.x += nx * o * b.im / t; b.y += ny * o * b.im / t;
  const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rv < 0) { const j = -(1 + BN) * rv / t; a.vx -= j * a.im * nx; a.vy -= j * a.im * ny; b.vx += j * b.im * nx; b.vy += j * b.im * ny; }
}
function wall(o, x0, x1, y0, y1) {
  if (o.x < x0) { o.x = x0; o.vx = Math.abs(o.vx) * BN } else if (o.x > x1) { o.x = x1; o.vx = -Math.abs(o.vx) * BN }
  if (o.y < y0) { o.y = y0; o.vy = Math.abs(o.vy) * BN } else if (o.y > y1) { o.y = y1; o.vy = -Math.abs(o.vy) * BN }
}
const mouth = (b, M) => b.y > M.y1 && b.y < M.y2;
function ballWalls(b, M) {
  const m = mouth(b, M);
  if (m && (b.x < 0 || b.x > M.W)) wall(b, -GD + b.r, M.W + GD - b.r, M.y1 + b.r, M.y2 - b.r);   // inside goal pocket
  else if (m) wall(b, -1e9, 1e9, b.r, M.H - b.r);                                              // open goal mouth
  else wall(b, b.r, M.W - b.r, b.r, M.H - b.r);
}
function finish(L) {
  const g = L.g, [r, b] = g.sc; g.ph = 'over'; g.pt = 300;
  g.msg = r === b ? 'DRAW' : (r > b ? 'RED' : 'BLUE') + ' WINS!';
}
function score(L, i) {
  const g = L.g; g.sc[i]++;
  if (g.sc[i] >= L.set.sc) return finish(L);
  g.ph = 'goal'; g.pt = 120; g.msg = (i ? 'BLUE' : 'RED') + ' SCORES!';
}
function step(L) {
  const g = L.g, b = g.ball, M = getMap(L), T = L.set, ps = L.players.filter(p => p.team !== 's');
  BN = T.bn; b.r = BR * T.br; b.im = 1 / T.bm;
  const pd = 1 - .04 * T.pf, bd = 1 - .01 * T.bf;
  for (const p of ps) { p.r = PR * T.pr; p.gh = T.gh && p.g ? 1 : 0; }   // ghost: ball passes through, no kicking
  if (g.ph === 'play') {
    for (const p of ps) {
      if (p.bot) botAI(p, ps, b, M);
      const mv = Math.hypot(p.ix, p.iy), spr = p.sp && !p.tired && mv > .1 && p.st > 0;
      if (spr) { p.st -= T.sd / 150; if (p.st <= 0) { p.st = 0; p.tired = 1; } }
      else { p.st = Math.min(1, p.st + 1 / 360); if (p.tired && p.st > .3) p.tired = 0; }
      p.on = spr ? 1 : 0;
      const l = Math.max(1, mv), a = ACC * T.ps * (spr ? T.sp : 1);
      p.vx += p.ix / l * a; p.vy += p.iy / l * a;
      if (p.kc) p.kc--;
      const dx = b.x - p.x, dy = b.y - p.y, d = Math.hypot(dx, dy);
      if (!p.gh && (p.k || p.c) && !p.kc && d && d < p.r + b.r + 4) {      // Space/X = straight kick, Q/E = kick with curve
        const f = KICK * T.kp; b.vx += dx / d * f; b.vy += dy / d * f; b.sp = p.c * CURVE * T.cv; p.kc = 8;
      }
    }
    if (--g.tl <= 0) finish(L);
  }
  if (b.sp) {                                                   // curve: rotate velocity (positive = turn right)
    const c = Math.cos(b.sp), s = Math.sin(b.sp), vx = b.vx;
    b.vx = vx * c - b.vy * s; b.vy = vx * s + b.vy * c; b.sp *= .98; if (Math.abs(b.sp) < 1e-4) b.sp = 0;
  }
  for (const p of ps) { p.x += p.vx; p.y += p.vy; p.vx *= pd; p.vy *= pd; }
  b.x += b.vx; b.y += b.vy; b.vx *= bd; b.vy *= bd;
  for (let i = 0; i < ps.length; i++) { if (T.pc) for (let j = i + 1; j < ps.length; j++) hit(ps[i], ps[j]); if (!ps[i].gh) hit(ps[i], b); }
  M.posts.forEach(o => hit(o, b));
  ps.forEach(p => wall(p, p.r, M.W - p.r, p.r, M.H - p.r)); ballWalls(b, M);
  if (g.ph === 'play') { const m = mouth(b, M); if (m && b.x < 0) score(L, 1); else if (m && b.x > M.W) score(L, 0); }
  else if (--g.pt <= 0) {
    if (g.ph === 'over') { L.ph = 'lobby'; L.g = null; info(L); return; }
    g.ph = 'play'; g.msg = ''; kickoff(L);
  }
  cast(L, { t: 's', p: ps.map(p => [p.id, r1(p.x), r1(p.y), (!p.gh && (p.k || p.c) ? 1 : 0) | (p.on ? 2 : 0) | (p.gh ? 4 : 0), Math.round(p.st * 100) / 100]),
    b: [r1(b.x), r1(b.y), Math.round(b.sp * 1000) / 1000], s: g.sc, tl: Math.max(0, Math.ceil(g.tl / 60)), ph: g.ph, m: g.msg });
}
// fixed 60Hz timestep
const DT = 1000 / 60; let last = Date.now(), acc = 0;
setInterval(() => {
  const n = Date.now(); acc = Math.min(acc + n - last, 100); last = n;
  while (acc >= DT) { acc -= DT; lobbies.forEach(L => L.ph === 'play' && step(L)); }
}, 8);

wss.on('connection', ws => {
  const p = mk({ ws }); p.name = 'Player' + p.id;
  all.add(p); send(ws, { t: 'me', id: p.id }); pushList();
  ws.on('message', d => { let m; try { m = JSON.parse(d); } catch { return; } if (m && typeof m === 'object') handle(p, m); });
  ws.on('close', () => { leave(p); all.delete(p); });
});
srv.listen(PORT, () => console.log('Haxball-lite listening on :' + PORT));
