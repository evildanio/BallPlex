// BallPlexx server: authoritative 60Hz physics, lobbies with optional passwords, bots, host settings and presets.
// Run:      npm install && node server.js        (PORT env var, default 3000)
// Proxmox LXC (Debian/Ubuntu): apt install -y nodejs npm, copy this folder to /opt/ballplexx, npm install
// systemd unit /etc/systemd/system/ballplexx.service, then: systemctl enable --now ballplexx
//   [Service]  WorkingDirectory=/opt/ballplexx  ExecStart=/usr/bin/node server.js  Restart=always
//   [Install]  WantedBy=multi-user.target
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const PR = 15, BR = 10, GD = 40, MG = 30, MAXP = 24, KICK = 5, CURVE = 0.02;   // MG: how far players may leave the pitch
let BN = 0.5;   // restitution, set per lobby every tick
const grid = (W, H, cols, rows, r) => { const o = []; for (let i = 1; i <= cols; i++) for (let j = 1; j <= rows; j++) o.push([W * i / (cols + 1), H * j / (rows + 1), r]); return o; };
// Map list. R = circle arena, obs = [x, y, radius, bounce] round obstacles (bounce > 1 makes a bumper). Index 1 is the default.
const MAPS = [
  { n: 'Small', W: 600, H: 300, G: 100 },
  { n: 'Medium', W: 800, H: 400, G: 130 },
  { n: 'Large', W: 1100, H: 550, G: 170 },
  { n: 'Closet (tiny chaos)', W: 420, H: 220, G: 100 },
  { n: 'Corridor (long and narrow)', W: 1400, H: 200, G: 90 },
  { n: 'Marathon (extremely long)', W: 2800, H: 300, G: 150 },
  { n: 'Huge', W: 1800, H: 900, G: 260 },
  { n: 'Arena (circle)', R: 300, G: 130 },
  { n: 'Bowl (small circle)', R: 170, G: 90 },
  { n: 'Pinball (bouncy bumpers)', W: 900, H: 450, G: 130, obs: [[270, 135, 26, 1.3], [270, 315, 26, 1.3], [630, 135, 26, 1.3], [630, 315, 26, 1.3], [450, 75, 22, 1.3], [450, 375, 22, 1.3]] },
  { n: 'Pillars', W: 900, H: 450, G: 130, obs: grid(900, 450, 4, 3, 14) },
].map(m => m.R ? { ...m, shape: 'circle', W: 2 * m.R, H: 2 * m.R } : { ...m, shape: 'rect' });
const maps = {};
function getMap(L) {                      // geometry for the lobby's map and goal-size setting (cached)
  const key = L.size + '|' + L.set.gs;
  if (!maps[key]) {
    const m = MAPS[L.size], G = Math.min(m.G * L.set.gs, m.H - 40), y1 = (m.H - G) / 2, y2 = (m.H + G) / 2;
    maps[key] = { ...m, G, y1, y2,
      posts: [[0, y1], [0, y2], [m.W, y1], [m.W, y2]].map(([x, y]) => ({ x, y, vx: 0, vy: 0, r: 5, im: 0 })),
      obs: (m.obs || []).map(([x, y, r, e]) => ({ x, y, vx: 0, vy: 0, r, im: 0, e })) };
  }
  return maps[key];
}
// sc score limit, tm minutes, ps player speed, kp kick power, cv curve, sp sprint boost, gh ghost allowed, pc player collisions,
// bf ball friction, bn bounciness, br ball size, pr player size, bm ball weight, pf player friction, gs goal size, sd stamina drain
const DEF = { sc: 5, tm: 3, ps: 1, kp: .85, cv: 1.6, sp: 1.5, gh: 1, pc: 1, pw: 1, bf: 1, bn: .5, br: 1, pr: 1, bm: 1, pf: 1.6, gs: 1, sd: 1, bl: 5 };   // bl: bot difficulty, 1 to 10   // pw: players may pass through walls
const RANGE = { sc: [1, 15], tm: [1, 10], ps: [.5, 2], kp: [.5, 2], cv: [0, 3], sp: [1, 2.5], gh: [0, 1], pc: [0, 1], pw: [0, 1],
  bf: [.2, 3], bn: [.1, 1.2], br: [.6, 2], pr: [.6, 1.6], bm: [.4, 3], pf: [.4, 3], gs: [.5, 2], sd: [0, 3], bl: [1, 10] };

const PAGES = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')];
const srv = http.createServer((q, r) => {
  const f = PAGES.find(p => fs.existsSync(p));
  if (!f) { r.writeHead(500, { 'Content-Type': 'text/plain' }); return r.end('index.html not found. Looked in:\n' + PAGES.join('\n')); }
  fs.readFile(f, (e, d) => { r.writeHead(e ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(e ? String(e) : d); });
});
const wss = new WebSocketServer({ server: srv, maxPayload: 4096 });
const lobbies = new Map(), all = new Set();
let uid = 0, lid = 0;
const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const err = (p, msg) => send(p.ws, { t: 'err', msg });
const cast = (L, m) => { const s = JSON.stringify(m); L.players.forEach(p => p.ws && p.ws.readyState === 1 && p.ws.send(s)); };
const r1 = n => Math.round(n * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clean = (s, n, d) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) || d;
const mk = o => ({ id: ++uid, name: '', team: 's', L: null, x: 0, y: 0, vx: 0, vy: 0, r: PR, im: .5,
  ix: 0, iy: 0, k: 0, c: 0, sp: 0, kc: 0, st: 1, tired: 0, on: 0, g: 0, gh: 0, fails: 0, lockUntil: 0, bt: 0, aim: 0, aimT: 0, ...o });

function pushList() {
  const list = [...lobbies.values()].map(L => ({ id: L.id, name: L.name, mode: L.mode, n: L.players.filter(q => !q.bot).length, ph: L.ph, lock: !!L.pw }));
  all.forEach(p => !p.L && send(p.ws, { t: 'lobbies', list }));
}
function info(L) {
  const msg = { t: 'lobby', id: L.id, name: L.name, mode: L.mode, size: L.size, set: L.set, host: L.host.id, ph: L.ph,
    players: L.players.map(q => ({ id: q.id, name: q.name, team: q.team, bot: !!q.bot })) };
  L.players.forEach(p => p.ws && send(p.ws, p === L.host ? { ...msg, pw: L.pw } : msg));   // only the host is told the password
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
  const M = MAPS[L.size], b = L.g.ball; b.x = M.W / 2; b.y = M.H / 2; b.vx = b.vy = b.sp = 0;
  const per = Math.max(2, Math.floor(M.H / 48));          // players per column; big teams line up in several columns
  for (const t of ['r', 'b']) {
    const ps = L.players.filter(p => p.team === t);
    ps.forEach((p, i) => {
      const col = Math.floor(i / per), n = Math.min(per, ps.length - col * per);
      spawn(p, M); p.x += (t === 'r' ? -1 : 1) * col * 46; p.y = M.H * (i % per + 1) / (n + 1);
    });
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
      const n = { id: ++lid, name: clean(m.lname, 24, p.name + "'s lobby"), mode: [0, 1, 2, 3].includes(m.mode) ? m.mode : 2,   // 0 = infinite (inf vs inf)
        size: Number.isInteger(m.size) && MAPS[m.size] ? m.size : 1, set: { ...DEF }, host: p, players: [p], ph: 'lobby', g: null, pw: String(m.pass || '').slice(0, 32) };
      lobbies.set(n.id, n); p.L = n; p.team = 's'; info(n); break;
    }
    case 'join': {
      const T = lobbies.get(m.id);
      if (L) return;
      if (!T) return send(p.ws, { t: 'err', msg: 'That lobby no longer exists.' });
      if (T.players.length >= MAXP) return send(p.ws, { t: 'err', msg: 'Lobby is full.' });
      if (T.pw) {                                       // password check, with a short lockout after 5 wrong guesses
        if (Date.now() < p.lockUntil) return send(p.ws, { t: 'err', msg: 'Too many wrong passwords. Wait a few seconds.' });
        if (String(m.pass || '') !== T.pw) {
          if (++p.fails >= 5) { p.fails = 0; p.lockUntil = Date.now() + 10000; }
          return send(p.ws, { t: 'err', msg: 'Wrong password.' });
        }
        p.fails = 0;
      }
      T.players.push(p); p.L = T; p.team = 's'; info(T); break;
    }
    case 'team': {
      if (!L || !['r', 'b', 's'].includes(m.team) || m.team === p.team) return;
      if (m.team !== 's' && L.players.filter(q => q.team === m.team).length >= (L.mode || 99)) return err(p, 'That team is full.');
      p.team = m.team; p.ix = p.iy = p.k = p.c = p.sp = p.g = 0;
      if (L.ph === 'play' && p.team !== 's') spawn(p, MAPS[L.size]);
      info(L); break;
    }
    case 'start': if (host && L.ph === 'lobby' && L.players.some(q => q.team !== 's')) startGame(L); break;
    case 'stop': if (host && L.ph === 'play') { L.ph = 'lobby'; L.g = null; info(L); } break;
    case 'in': p.ix = clamp(+m.x || 0, -1, 1); p.iy = clamp(+m.y || 0, -1, 1); p.k = m.k ? 1 : 0; p.c = Math.sign(+m.c || 0); p.sp = m.s ? 1 : 0; p.g = m.g ? 1 : 0; break;
    case 'bot':
      if (host && ['r', 'b'].includes(m.team) && L.players.length < MAXP && L.players.filter(q => q.team === m.team).length < (L.mode || 99)) {
        const q = mk({ bot: 1, team: m.team, L }); q.name = 'Bot ' + q.id; L.players.push(q);
        if (L.ph === 'play') spawn(q, MAPS[L.size]);
        info(L);
      } else if (host) err(p, 'That team is full.');
      break;
    case 'rm': {
      if (!host) return;
      const t = L.players.find(q => q.id === m.id); if (!t || t === p) return;
      if (t.bot) { L.players = L.players.filter(q => q !== t); info(L); } else leave(t);
      break;
    }
    case 'set': {
      if (!host) return;
      if (m.k === 'pass') { L.pw = String(m.v || '').slice(0, 32); info(L); break; }
      if (m.k === 'reset') { L.set = { ...DEF }; info(L); break; }
      const k = m.k, v = +m.v; if (isNaN(v)) return;
      if (k === 'size' || k === 'mode') {
        if (L.ph !== 'lobby') return;
        if (k === 'size' && Number.isInteger(v) && MAPS[v]) L.size = v;
        else if (k === 'mode' && [0, 1, 2, 3].includes(v) && (v === 0 || ['r', 'b'].every(t => L.players.filter(q => q.team === t).length <= v))) L.mode = v;
        else return;
      } else if (RANGE[k]) L.set[k] = Math.round(clamp(v, ...RANGE[k]) * 100) / 100; else return;
      info(L); break;
    }
    case 'preset': {                                   // load or import a settings preset (validated and clamped)
      if (!host || !m.set || typeof m.set !== 'object') return;
      for (const k in RANGE) { const v = parseFloat(m.set[k]); if (Number.isFinite(v)) L.set[k] = Math.round(clamp(v, ...RANGE[k]) * 100) / 100; }
      if (L.ph === 'lobby') {                          // map and mode only change between matches
        const i = MAPS.findIndex(x => x.n === m.map); if (i >= 0) L.size = i;
        const v = +m.mode;
        if ([0, 1, 2, 3].includes(v) && (v === 0 || ['r', 'b'].every(t => L.players.filter(q => q.team === t).length <= v))) L.mode = v;
      }
      info(L); break;
    }
    case 'leave': leave(p); break;
  }
}

// ---- bots ----
function botAI(p, ps, b, M, T) {
  if (p.bt-- > 0) return;                                        // reaction delay: keep the previous inputs
  const sk = ((T.bl || 5) - 1) / 9;                              // 0 = easiest, 1 = hardest
  p.bt = Math.round((1 - sk) * 12);
  if (--p.aimT <= 0) { p.aim = Math.random() * 2 - 1; p.aimT = 4 + Math.floor(Math.random() * 5); }
  const d0 = q => Math.hypot(q.x - b.x, q.y - b.y), mates = ps.filter(q => q.team === p.team);
  const near = mates.reduce((a, q) => d0(q) < d0(a) ? q : a), dir = p.team === 'r' ? 1 : -1;
  const gx = p.team === 'r' ? M.W : 0, og = M.W - gx; let tx, ty;
  if (near === p) {                                              // chaser: get behind the ball, then drive it at goal
    const aimY = M.H / 2 + p.aim * (M.H * .45 * (1 - sk) + M.G * .35 * sk);   // easy bots aim anywhere, hard bots aim at the corners
    const ax = gx - b.x, ay = aimY - b.y, l = Math.hypot(ax, ay) || 1;
    tx = b.x - ax / l * 24; ty = b.y - ay / l * 24;
    if ((p.x - b.x) * dir > 0 && Math.abs(p.y - b.y) < 45) ty += (p.y < b.y ? -1 : 1) * 45;   // wrong side: go around
    else if (Math.hypot(tx - p.x, ty - p.y) < 16) { tx = b.x; ty = b.y; }
  } else {                                                       // others: spread out between the ball and their own goal
    const i = mates.indexOf(p), n = mates.length;
    tx = og + (b.x - og) * (.25 + .5 * i / n);
    ty = Math.max(20, Math.min(M.H - 20, M.H / 2 + (b.y - M.H / 2) * .5 + (i - (n - 1) / 2) * 45));
  }
  const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy), spd = .45 + .55 * sk;   // easy bots run slower
  p.ix = d > 5 ? dx / d * spd : 0; p.iy = d > 5 ? dy / d * spd : 0;
  p.sp = near === p && sk > .3 && d > 90 ? 1 : 0;
  p.k = d0(p) < p.r + b.r + 5 && (b.x - p.x) * dir > -3 ? 1 : 0; p.c = 0;
}

// ---- physics ----
function hit(a, b, e = BN) {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), m = a.r + b.r;
  if (d >= m || !d) return;
  const nx = dx / d, ny = dy / d, t = a.im + b.im, o = m - d;
  a.x -= nx * o * a.im / t; a.y -= ny * o * a.im / t; b.x += nx * o * b.im / t; b.y += ny * o * b.im / t;
  const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rv < 0) { const j = -(1 + e) * rv / t; a.vx -= j * a.im * nx; a.vy -= j * a.im * ny; b.vx += j * b.im * nx; b.vy += j * b.im * ny; }
}
function wall(o, x0, x1, y0, y1) {
  if (o.x < x0) { o.x = x0; o.vx = Math.abs(o.vx) * BN } else if (o.x > x1) { o.x = x1; o.vx = -Math.abs(o.vx) * BN }
  if (o.y < y0) { o.y = y0; o.vy = Math.abs(o.vy) * BN } else if (o.y > y1) { o.y = y1; o.vy = -Math.abs(o.vy) * BN }
}
const mouth = (b, M) => b.y > M.y1 && b.y < M.y2;
function cwall(o, R, lim) {                         // keep o inside a circle of radius lim around (R, R)
  const dx = o.x - R, dy = o.y - R, d = Math.hypot(dx, dy);
  if (d <= lim || !d) return;
  const nx = dx / d, ny = dy / d, vn = o.vx * nx + o.vy * ny;
  o.x = R + nx * lim; o.y = R + ny * lim;
  if (vn > 0) { o.vx -= (1 + BN) * vn * nx; o.vy -= (1 + BN) * vn * ny; }
}
function ballWalls(b, M) {
  const m = mouth(b, M);
  if (m && (b.x < 0 || b.x > M.W)) wall(b, -GD + b.r, M.W + GD - b.r, M.y1 + b.r, M.y2 - b.r);   // inside goal pocket
  else if (M.shape === 'circle') { if (!(m && (b.x < M.R / 2 || b.x > M.R * 1.5))) cwall(b, M.R, M.R - b.r); }
  else if (m) wall(b, -1e9, 1e9, b.r, M.H - b.r);                                               // open goal mouth
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
  const pd = 1 - .04 * T.pf, bd = 1 - .01 * T.bf, acc = 2.4 * (1 - pd) / pd;   // acc keeps top speed constant whatever the friction
  for (const p of ps) { p.r = PR * T.pr; p.gh = T.gh && p.g ? 1 : 0; }   // ghost: ball passes through, no kicking
  if (g.ph === 'play') {
    for (const p of ps) {
      if (p.bot) botAI(p, ps, b, M, T);
      const mv = Math.hypot(p.ix, p.iy), spr = p.sp && !p.tired && mv > .1 && p.st > 0;
      if (spr) { p.st -= T.sd / 150; if (p.st <= 0) { p.st = 0; p.tired = 1; } }
      else { p.st = Math.min(1, p.st + 1 / 360); if (p.tired && p.st > .3) p.tired = 0; }
      p.on = spr ? 1 : 0;
      const l = Math.max(1, mv), a = acc * T.ps * (spr ? T.sp : 1);
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
  M.obs.forEach(o => { hit(o, b, o.e || BN); ps.forEach(p => hit(o, p)); });
  ps.forEach(p => {                                  // players may leave the pitch (pw) so they can get behind a stuck ball
    const e = T.pw ? MG : -p.r;
    if (M.shape === 'circle') cwall(p, M.R, M.R + e); else wall(p, -e, M.W + e, -e, M.H + e);
  });
  ballWalls(b, M);
  if (g.ph === 'play') { const m = mouth(b, M); if (m && b.x < 0) score(L, 1); else if (m && b.x > M.W) score(L, 0); }
  else if (--g.pt <= 0) {
    if (g.ph === 'over') { L.ph = 'lobby'; L.g = null; info(L); return; }
    g.ph = 'play'; g.msg = ''; kickoff(L);
  }
  if (ps.length > 8 && (g.n = (g.n || 0) + 1) & 1) return;   // big lobbies: 30 snapshots/s
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
  all.add(p); send(ws, { t: 'me', id: p.id, maps: MAPS.map(({ n, shape, W, H, G, R, obs }) => ({ n, shape, W, H, G, R, obs })) }); pushList();
  ws.on('message', d => { let m; try { m = JSON.parse(d); } catch { return; } if (m && typeof m === 'object') handle(p, m); });
  ws.on('close', () => { leave(p); all.delete(p); });
});
srv.listen(PORT, () => console.log('BallPlexx listening on :' + PORT));
