// BallPlexx server: authoritative 60Hz physics, lobbies with optional passwords, bots, host settings and presets.
// Run:      npm install && node server.js        (PORT env var, default 3000)
// Proxmox LXC (Debian/Ubuntu): apt install -y nodejs npm, copy this folder to /opt/ballplexx, npm install
// systemd unit /etc/systemd/system/ballplexx.service, then: systemctl enable --now ballplexx
//   [Service]  WorkingDirectory=/opt/ballplexx  ExecStart=/usr/bin/node server.js  Restart=always
//   [Install]  WantedBy=multi-user.target
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
// ---- admin settings: change the password below (or set the BALLPLEXX_ADMIN environment variable) ----
const ADMIN_PASSWORD = process.env.BALLPLEXX_ADMIN || 'change-this-admin-password';   // opens the hidden admin panel
const BAN_FILE = path.join(__dirname, 'bans.json');                                   // banned IPs are saved here
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
  { n: 'Bumper bowl (circle with bumpers)', R: 320, G: 130, obs: [[200, 200, 24, 1.3], [440, 200, 24, 1.3], [200, 440, 24, 1.3], [440, 440, 24, 1.3]] },
  // Hazard maps: touching a saw or an active lava splat demolishes a player for a few seconds (host setting). Lava is telegraphed first.
  { n: 'Volcano (lava splats demolish you)', W: 1000, H: 500, G: 140, col: '#4d3b36', haz: [{ k: 'lava', every: 110, rmin: 36, rmax: 58, warn: 75, life: 300 }] },
  { n: 'Sawmill (moving saws)', W: 1000, H: 500, G: 140, col: '#3f464e', haz: [
    { k: 'patrol', x1: 500, y1: 36, x2: 500, y2: 464, r: 24, v: 2.4, s0: .3 },
    { k: 'patrol', x1: 320, y1: 464, x2: 320, y2: 36, r: 20, v: 1.7, s0: 0 },
    { k: 'patrol', x1: 680, y1: 36, x2: 680, y2: 464, r: 20, v: 1.7, s0: 0 }] },
  { n: 'Windmill (spinning arms)', W: 1000, H: 500, G: 140, col: '#3f464e', haz: [
    { k: 'arm', x: 500, y: 250, n: 4, gap: 50, r: 17, w: .02, a: 0 }, { k: 'arm', x: 500, y: 250, n: 4, gap: 50, r: 17, w: .02, a: Math.PI }] },
  { n: 'Wrecking balls (roaming killers)', W: 1100, H: 550, G: 150, col: '#3f464e', haz: [{ k: 'roam', n: 3, r: 24, v: 3 }] },
].map(m => m.R ? { ...m, shape: 'circle', W: 2 * m.R, H: 2 * m.R } : { ...m, shape: 'rect' });
// Validate and clamp a map sent from the map maker. Admins get much wider limits (object counts are still capped to avoid freezing the server).
function cleanMap(r, free) {
  if (!r || typeof r !== 'object') return null;
  const num = (v, d, lo, hi) => { v = +v; if (!Number.isFinite(v)) v = d; return free ? clamp(v, -1e5, 1e5) : clamp(v, lo, hi); };
  const circ = r.shape === 'circle', m = { n: clean(r.n, 40, 'Custom map'), shape: circ ? 'circle' : 'rect' };
  if (/^#[0-9a-fA-F]{6}$/.test(r.col)) m.col = r.col;
  if (circ) { m.R = num(r.R, 300, 100, 1500); m.W = m.H = 2 * m.R; } else { m.W = num(r.W, 800, 200, 6000); m.H = num(r.H, 400, 150, 3000); }
  m.G = num(r.G, 130, 40, m.H - 40);
  const A = a => Array.isArray(a) ? a : [], X = v => num(v, m.W / 2, -50, m.W + 50), Y = v => num(v, m.H / 2, -50, m.H + 50), cnt = (v, d) => Math.min(2000, Math.round(num(v, d, 1, 12)));
  m.obs = A(r.obs).slice(0, free ? 500 : 80).map(o => { o = A(o); const e = num(o[3], 0, 0, 10); return [X(o[0]), Y(o[1]), num(o[2], 20, 4, 200)].concat(e ? [e] : []); });
  m.haz = [];
  for (const h of A(r.haz).slice(0, free ? 100 : 30)) {
    if (!h || typeof h !== 'object') continue;
    if (h.k === 'patrol') { const d = { k: 'patrol', x1: X(h.x1), y1: Y(h.y1), x2: X(h.x2), y2: Y(h.y2), r: num(h.r, 22, 6, 80), v: num(h.v, 2, .2, 12), s0: num(h.s0, 0, 0, 1) }; if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) >= 1) m.haz.push(d); }
    else if (h.k === 'arm') m.haz.push({ k: 'arm', x: X(h.x), y: Y(h.y), n: cnt(h.n, 3), gap: num(h.gap, 55, 10, 200), r: num(h.r, 17, 6, 60), w: num(h.w, .02, -.2, .2), a: num(h.a, 0, -7, 7) });
    else if (h.k === 'roam') m.haz.push({ k: 'roam', n: cnt(h.n, 2), r: num(h.r, 22, 6, 80), v: num(h.v, 2.6, .2, 12) });
    else if (h.k === 'pool') m.haz.push({ k: 'pool', x: X(h.x), y: Y(h.y), r: num(h.r, 40, 10, 300) });
    else if (h.k === 'lava' && !m.haz.some(z => z.k === 'lava')) { const rmin = num(h.rmin, 36, 10, 200); m.haz.push({ k: 'lava', every: Math.round(num(h.every, 110, 30, 3000)), rmin, rmax: Math.max(rmin, num(h.rmax, 58, 10, 300)), warn: Math.round(num(h.warn, 75, 10, 600)), life: Math.round(num(h.life, 300, 30, 3000)) }); }
  }
  return m;
}
const mapOf = L => (L.size === -1 && L.cmap) || MAPS[L.size] || MAPS[1];
const isFree = (L, p) => !!((L.host && L.host.admin) || (p && p.admin));   // admin lobbies (and admin edits) skip the host setting limits
function getMap(L) {                      // geometry for the lobby's map and goal-size setting (cached per lobby)
  const m = mapOf(L), key = L.size + '|' + L.set.gs + '|' + L.cv;
  if (L.mk !== key) {
    const G = L.host && L.host.admin ? m.G * L.set.gs : Math.min(m.G * L.set.gs, m.H - 40), y1 = (m.H - G) / 2, y2 = (m.H + G) / 2;
    L.mk = key;
    L.mv = { ...m, G, y1, y2,
      posts: [[0, y1], [0, y2], [m.W, y1], [m.W, y2]].map(([x, y]) => ({ x, y, vx: 0, vy: 0, r: 5, im: 0 })),
      obs: (m.obs || []).map(([x, y, r, e]) => ({ x, y, vx: 0, vy: 0, r, im: 0, e })) };
  }
  return L.mv;
}
// sc score limit, tm minutes, ps player speed, kp kick power, cv curve, sp sprint boost, gh ghost allowed, pc player collisions,
// bf ball friction, bn bounciness, br ball size, pr player size, bm ball weight, pf player friction, gs goal size, sd stamina drain
const DEF = { sc: 5, tm: 3, ps: 1, kp: .85, cv: 1.6, sp: 1.5, gh: 1, pc: 1, pw: 1, bf: 1, bn: .5, br: 1, pr: 1, bm: 1, pf: 1.6, gs: 1, sd: 1, bl: 5, hk: 1, dt: 3 };
// bl: bot difficulty 1 to 10, hk: hazards demolish players, dt: seconds a demolished player stays out
// Hard limits for host settings. They are wide on purpose (speed 50x, curve 100x) and only there to keep the physics from breaking.
const RANGE = { sc: [1, 999], tm: [1, 180], ps: [.1, 50], kp: [0, 100], cv: [0, 100], sp: [1, 50], gh: [0, 1], pc: [0, 1], pw: [0, 1],
  bf: [0, 50], bn: [0, 5], br: [.2, 10], pr: [.2, 10], bm: [.05, 100], pf: [.1, 20], gs: [.1, 10], sd: [0, 100], bl: [1, 10], hk: [0, 1], dt: [0, 60] };

const PAGES = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')];
const srv = http.createServer((q, r) => {
  const f = PAGES.find(p => fs.existsSync(p));
  if (!f) { r.writeHead(500, { 'Content-Type': 'text/plain' }); return r.end('index.html not found. Looked in:\n' + PAGES.join('\n')); }
  fs.readFile(f, (e, d) => { r.writeHead(e ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(e ? String(e) : d); });
});
// ---- IP bans (saved to BAN_FILE) and admin login ----
const IPRE = /^[0-9a-fA-F:.]{3,45}$/;
const bans = Object.create(null);
try { Object.assign(bans, JSON.parse(fs.readFileSync(BAN_FILE, 'utf8'))); } catch { /* no ban file yet */ }
const saveBans = () => { try { fs.writeFileSync(BAN_FILE, JSON.stringify(bans, null, 1)); } catch (e) { console.log('Could not save bans:', e.message); } };
const isLoop = ip => !ip || ip === '127.0.0.1' || ip === '::1';
function clientIP(req) {
  let ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  if (isLoop(ip) || process.env.TRUST_PROXY) {              // behind a reverse proxy: use the address it forwards
    const x = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim().replace(/^::ffff:/, '');
    if (x) ip = x;
  }
  return ip;
}
function banOf(ip) {
  const b = bans[ip]; if (!b) return null;
  if (b.until && b.until < Date.now()) { delete bans[ip]; saveBans(); return null; }
  return b;
}
const banText = b => 'You are banned from this server' + (b.until ? ' until ' + new Date(b.until).toLocaleString() : '') + (b.reason ? '. Reason: ' + b.reason : '') + '.';
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const adminOK = s => crypto.timingSafeEqual(sha(s), sha(ADMIN_PASSWORD));
const aTry = Object.create(null);
if (ADMIN_PASSWORD === 'change-this-admin-password') console.log('WARNING: the admin password is still the default. Change ADMIN_PASSWORD near the top of server.js.');
const wss = new WebSocketServer({ server: srv, maxPayload: 4096 });
const lobbies = new Map(), all = new Set();
let uid = 0, lid = 0;
const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const err = (p, msg) => send(p.ws, { t: 'err', msg });
const note = (p, msg) => send(p.ws, { t: 'note', msg });
const cast = (L, m) => { const s = JSON.stringify(m); L.players.forEach(p => p.ws && p.ws.readyState === 1 && p.ws.send(s)); };
const r1 = n => Math.round(n * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clean = (s, n, d) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) || d;
const mk = o => ({ id: ++uid, name: '', team: 's', L: null, x: 0, y: 0, vx: 0, vy: 0, r: PR, im: .5,
  ix: 0, iy: 0, k: 0, c: 0, sp: 0, kc: 0, st: 1, tired: 0, on: 0, g: 0, gh: 0, fails: 0, lockUntil: 0, bt: 0, aim: 0, aimT: 0, dead: 0, inv: 0, admin: false, ip: '', cs: [4, 0, 0], ...o });

function pushList() {
  const list = [...lobbies.values()].map(L => ({ id: L.id, name: L.name, mode: L.mode, n: L.players.filter(q => !q.bot).length, ph: L.ph, lock: !!L.pw }));
  all.forEach(p => !p.L && send(p.ws, { t: 'lobbies', list }));
}
function info(L) {
  const msg = { t: 'lobby', id: L.id, name: L.name, mode: L.mode, size: L.size, set: L.set, host: L.host.id, ph: L.ph,
    players: L.players.map(q => ({ id: q.id, name: q.name, team: q.team, bot: !!q.bot, admin: !!q.admin, cs: q.cs })), cmap: L.cmap || undefined, free: !!(L.host && L.host.admin) };
  L.players.forEach(p => p.ws && send(p.ws, p === L.host || p.admin ? { ...msg, pw: L.pw, bans: L.bans.map(({ id, name }) => ({ id, name })) } : msg));   // only the host sees the password and the ban list
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
function spawn(p, M) { p.x = p.team === 'r' ? M.W * .25 : M.W * .75; p.y = M.H / 2; p.vx = p.vy = 0; p.st = 1; p.tired = 0; p.dead = 0; p.inv = 90; }   // inv: 1.5 s of safety after every spawn
function kickoff(L) {
  const M = mapOf(L), b = L.g.ball; b.x = M.W / 2; b.y = M.H / 2; b.vx = b.vy = b.sp = 0;
  L.g.hz = L.g.hz.filter(h => h.k === 'saw' || h.st); L.g.last = 0; if (L.g.lava) L.g.lava.t = Math.round(L.g.lava.every * 1.5);   // lava is cleared at every kickoff
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
  L.g = { ph: 'play', sc: [0, 0], tl: L.set.tm * 3600, pt: 0, msg: '', hz: [], ev: [], last: 0, ball: { x: 0, y: 0, vx: 0, vy: 0, sp: 0, r: BR, im: 1 } };
  kickoff(L); initHaz(L); info(L);
}
function handle(p, m) {
  if (m.name) p.name = clean(m.name, 16, p.name);
  const L = p.L, host = L && (L.host === p || p.admin);   // admins can run any lobby they are in
  if (String(m.t).startsWith('a_') && !p.admin) return;          // admin-only messages
  switch (m.t) {
    case 'create': {
      if (L) return;
      const n = { id: ++lid, name: clean(m.lname, 24, p.name + "'s lobby"), mode: [0, 1, 2, 3].includes(m.mode) ? m.mode : 2,   // 0 = infinite (inf vs inf)
        size: Number.isInteger(m.size) && MAPS[m.size] ? m.size : 1, set: { ...DEF }, host: p, players: [p], ph: 'lobby', g: null, bans: [], bid: 0, cmap: null, cv: 0, pw: String(m.pass || '').slice(0, 32) };
      lobbies.set(n.id, n); p.L = n; p.team = 's'; info(n); break;
    }
    case 'join': {
      const T = lobbies.get(m.id);
      if (L) return;
      if (!T) return send(p.ws, { t: 'err', msg: 'That lobby no longer exists.' });
      if (T.players.length >= MAXP) return send(p.ws, { t: 'err', msg: 'Lobby is full.' });
      if (!p.admin && T.bans.some(x => x.ip && x.ip === p.ip)) return err(p, 'You are banned from this lobby.');
      if (T.pw && !p.admin) {                                       // password check, with a short lockout after 5 wrong guesses
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
      if (L.ph === 'play' && p.team !== 's') spawn(p, mapOf(L));
      info(L); break;
    }
    case 'start': if (host && L.ph === 'lobby' && L.players.some(q => q.team !== 's')) startGame(L); break;
    case 'stop': if (host && L.ph === 'play') { L.ph = 'lobby'; L.g = null; info(L); } break;
    case 'in': p.ix = clamp(+m.x || 0, -1, 1); p.iy = clamp(+m.y || 0, -1, 1); p.k = m.k ? 1 : 0; p.c = Math.sign(+m.c || 0); p.sp = m.s ? 1 : 0; p.g = m.g ? 1 : 0; break;
    case 'bot':
      if (host && ['r', 'b'].includes(m.team) && L.players.length < MAXP && L.players.filter(q => q.team === m.team).length < (L.mode || 99)) {
        const q = mk({ bot: 1, team: m.team, L }); q.name = 'Bot ' + q.id; L.players.push(q);
        if (L.ph === 'play') spawn(q, mapOf(L));
        info(L);
      } else if (host) err(p, 'That team is full.');
      break;
    case 'rm': {
      if (!host) return;
      const t = L.players.find(q => q.id === m.id); if (!t || t === p) return;
      if (t.admin) return err(p, 'You cannot remove an admin.');
      if (t.bot) { L.players = L.players.filter(q => q !== t); info(L); break; }
      if (m.ban) {                                      // lobby ban: by IP, so renaming or rejoining does not help
        if (isLoop(t.ip)) err(p, "Could not ban: this player's IP is unknown, so they were only kicked.");
        else L.bans.push({ id: ++L.bid, ip: t.ip, name: t.name });
        err(t, 'You were banned from that lobby.');
      } else err(t, 'You were kicked from the lobby.');
      leave(t);
      break;
    }
    case 'set': {
      if (!host) return;
      if (m.k === 'pass') { L.pw = String(m.v || '').slice(0, 32); info(L); break; }
      if (m.k === 'reset') { L.set = { ...DEF }; info(L); break; }
      const k = m.k, v = +m.v; if (!Number.isFinite(v)) return;
      if (k === 'size' || k === 'mode') {
        if (L.ph !== 'lobby') return;
        if (k === 'size' && ((Number.isInteger(v) && MAPS[v]) || (v === -1 && L.cmap))) L.size = v;
        else if (k === 'mode' && [0, 1, 2, 3].includes(v) && (v === 0 || ['r', 'b'].every(t => L.players.filter(q => q.team === t).length <= v))) L.mode = v;
        else return;
      } else if (RANGE[k]) L.set[k] = isFree(L, p) ? v : Math.round(clamp(v, ...RANGE[k]) * 100) / 100; else return;
      info(L); break;
    }
    case 'preset': {                                   // load or import a settings preset (validated and clamped)
      if (!host || !m.set || typeof m.set !== 'object') return;
      for (const k in RANGE) { const v = parseFloat(m.set[k]); if (Number.isFinite(v)) L.set[k] = isFree(L, p) ? v : Math.round(clamp(v, ...RANGE[k]) * 100) / 100; }
      if (L.ph === 'lobby') {                          // map and mode only change between matches
        if (m.cmap) { const c = cleanMap(m.cmap, isFree(L, p)); if (c) { L.cmap = c; L.cv++; L.size = -1; } }
        else { const i = MAPS.findIndex(x => x.n === m.map); if (i >= 0) L.size = i; }
        const v = +m.mode;
        if ([0, 1, 2, 3].includes(v) && (v === 0 || ['r', 'b'].every(t => L.players.filter(q => q.team === t).length <= v))) L.mode = v;
      }
      info(L); break;
    }
    case 'unban': if (host) { L.bans = L.bans.filter(x => x.id !== m.id); info(L); } break;
    case 'alogin': {                                   // hidden admin login, slowed down after 5 wrong guesses (per IP)
      const t = aTry[p.ip] || (aTry[p.ip] = { n: 0, until: 0 });
      if (Date.now() < t.until) return err(p, 'Too many attempts. Try again later.');
      if (adminOK(m.pass)) { t.n = 0; p.admin = true; send(p.ws, { t: 'admin', on: true }); if (p.L) info(p.L); }
      else { if (++t.n >= 5) t.until = Date.now() + 60000 * Math.min(60, 2 ** (t.n - 5)); err(p, 'Wrong password.'); }
      break;
    }
    case 'a_list':
      send(p.ws, { t: 'a_data',
        players: [...all].map(q => ({ id: q.id, name: q.name, ip: q.ip, admin: q.admin, lobby: q.L ? q.L.name : '' })),
        bans: Object.keys(bans).filter(ip => banOf(ip)).map(ip => ({ ip, name: bans[ip].name, reason: bans[ip].reason, until: bans[ip].until })),
        lobbies: [...lobbies.values()].map(x => ({ id: x.id, name: x.name, n: x.players.filter(q => !q.bot).length, ph: x.ph, lock: !!x.pw })) });
      break;
    case 'a_kick': {
      const t = [...all].find(q => q.id === m.id);
      if (!t || t.admin) return err(p, 'You cannot kick an admin.');
      send(t.ws, { t: 'banned', msg: 'You were kicked by an admin. Reload the page to reconnect.' }); t.ws.close(); note(p, 'Kicked ' + t.name + '.'); break;
    }
    case 'a_ban': {
      const t = m.id ? [...all].find(q => q.id === m.id) : null, ip = t ? t.ip : String(m.ip || '').trim();
      if (t && t.admin) return err(p, 'You cannot ban an admin.');
      if (!IPRE.test(ip) || isLoop(ip)) return err(p, 'That is not a usable IP address (if a proxy hides it, see TRUST_PROXY).');
      if (ip === p.ip) return err(p, 'You cannot ban your own IP.');
      const mins = clamp(+m.mins || 0, 0, 525600);
      bans[ip] = { name: t ? t.name : '', reason: String(m.reason || '').slice(0, 80), at: Date.now(), until: mins ? Date.now() + mins * 60000 : 0 };
      saveBans();
      [...all].filter(q => q.ip === ip && !q.admin).forEach(q => { send(q.ws, { t: 'banned', msg: banText(bans[ip]) }); q.ws.close(); });
      note(p, 'Banned ' + ip + '.'); break;
    }
    case 'a_unban': if (bans[String(m.ip)]) { delete bans[String(m.ip)]; saveBans(); note(p, 'Unbanned ' + m.ip + '.'); } break;
    case 'a_close': {
      const x = lobbies.get(m.lid); if (!x) return;
      x.players.filter(q => !q.bot).forEach(q => { err(q, 'The lobby was closed by an admin.'); leave(q); }); break;
    }
    case 'a_say': { const s = clean(m.msg, 120, ''); if (s) all.forEach(q => note(q, 'Admin: ' + s)); break; }
    case 'cos': p.cs = [Math.round(clamp(+m.sh || 0, 0, 8)), Math.round(clamp(+m.shot || 0, 0, 6)), Math.round(clamp(+m.goal || 0, 0, 6))]; if (L) info(L); break;
    case 'cmap': {                                     // use a map made in the map maker (only between matches)
      if (!host || L.ph !== 'lobby') return;
      const c = cleanMap(m.map, isFree(L, p)); if (!c) return err(p, 'That map is not valid.');
      L.cmap = c; L.cv++; L.size = -1; info(L); break;
    }
    case 'leave': leave(p); break;
  }
}

// ---- bots ----
function botAI(p, ps, b, M, T, hz) {
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
  let vx = d > 5 ? dx / d * spd : 0, vy = d > 5 ? dy / d * spd : 0;
  for (const h of hz || []) {                                    // steer away from saws and lava (better bots start earlier)
    if (h.k !== 'saw' && !(h.t >= h.warn - 20 && h.t < h.warn + h.life)) continue;
    const hx = p.x - h.x, hy = p.y - h.y, hd = Math.hypot(hx, hy) || 1, lim = h.r + p.r + 45 + 45 * sk;
    if (hd < lim) { const f = (lim - hd) / lim * 3 * (.4 + .6 * sk); vx += hx / hd * f; vy += hy / hd * f; }
  }
  const vm = Math.hypot(vx, vy); if (vm > 1) { vx /= vm; vy /= vm; }
  p.ix = vx; p.iy = vy;
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
  const g = L.g; g.sc[i]++; g.ev.push([1, g.last || 0, r1(g.ball.x), r1(g.ball.y), i]);
  if (g.sc[i] >= L.set.sc) return finish(L);
  g.ph = 'goal'; g.pt = 120; g.msg = (i ? 'BLUE' : 'RED') + ' SCORES!';
}
// ---- hazards: saws patrol, spin or roam and lava splats erupt. Touching one demolishes a player for T.dt seconds ----
function initHaz(L) {
  const M = getMap(L), g = L.g; g.hz = []; g.lava = null;
  for (const d of M.haz || []) {
    if (d.k === 'patrol') {
      const dx = d.x2 - d.x1, dy = d.y2 - d.y1, len = Math.hypot(dx, dy); if (len < 1) continue;
      g.hz.push({ k: 'saw', r: d.r, x: d.x1, y: d.y1, vx: 0, vy: 0, im: 0, d, len, ux: dx / len, uy: dy / len, s: (d.s0 || 0) * len, dir: 1 });
    } else if (d.k === 'arm') {
      for (let i = 1; i <= d.n; i++) g.hz.push({ k: 'saw', r: d.r, x: d.x, y: d.y, vx: 0, vy: 0, im: 0, arm: { x: d.x, y: d.y, dist: d.gap * i, a: d.a, w: d.w } });
    } else if (d.k === 'roam') {
      for (let i = 0; i < d.n; i++) {
        let x, y; for (let tries = 0; tries < 30; tries++) { x = M.W * (.12 + .76 * Math.random()); y = M.H * (.12 + .76 * Math.random()); if (Math.hypot(x - M.W / 2, y - M.H / 2) >= 130) break; }
        const a = Math.random() * 6.283;
        g.hz.push({ k: 'saw', r: d.r, x, y, vx: Math.cos(a) * d.v, vy: Math.sin(a) * d.v, im: 0, roam: 1 });
      }
    } else if (d.k === 'pool') {                            // lava pit: always deadly
      g.hz.push({ k: 'lava', x: d.x, y: d.y, r: d.r, t: 0, warn: 0, life: 1e9, st: 1 });
    } else if (d.k === 'lava') g.lava = { ...d, t: Math.round(d.every * 1.5) };
  }
}
function hazards(L, M, T, ps, alive) {
  const g = L.g;
  for (const h of g.hz) {
    if (h.k !== 'saw') { h.t++; continue; }
    const ox = h.x, oy = h.y;
    if (h.d) { h.s += h.dir * h.d.v; if (h.s < 0 || h.s > h.len) { h.dir = -h.dir; h.s = clamp(h.s, 0, h.len); } h.x = h.d.x1 + h.ux * h.s; h.y = h.d.y1 + h.uy * h.s; }
    else if (h.arm) { const a = h.arm; a.a += a.w; h.x = a.x + Math.cos(a.a) * a.dist; h.y = a.y + Math.sin(a.a) * a.dist; }
    else { h.x += h.vx; h.y += h.vy; if (h.x < h.r || h.x > M.W - h.r) { h.vx = -h.vx; h.x = clamp(h.x, h.r, M.W - h.r); } if (h.y < h.r || h.y > M.H - h.r) { h.vy = -h.vy; h.y = clamp(h.y, h.r, M.H - h.r); } }
    if (!h.roam) { h.vx = h.x - ox; h.vy = h.y - oy; }            // velocity, so the ball bounces off a moving saw correctly
  }
  g.hz = g.hz.filter(h => h.k === 'saw' || h.t < h.warn + h.life + 20);
  const lv = g.lava;
  if (lv && --lv.t <= 0) {                                        // a new lava splat lands, often near a player
    lv.t = Math.round(lv.every * (.6 + .8 * Math.random()));
    let x, y;
    if (alive.length && Math.random() < .6) { const p = alive[Math.floor(Math.random() * alive.length)]; x = p.x + (Math.random() - .5) * 220; y = p.y + (Math.random() - .5) * 220; }
    else { x = M.W * (.1 + .8 * Math.random()); y = M.H * (.1 + .8 * Math.random()); }
    g.hz.push({ k: 'lava', x: clamp(x, 50, M.W - 50), y: clamp(y, 50, M.H - 50), r: lv.rmin + (lv.rmax - lv.rmin) * Math.random(), t: 0, warn: lv.warn, life: lv.life });
  }
  for (const p of ps) {
    if (p.dead) { if (--p.dead <= 0) { spawn(p, M); p.y = M.H * (.2 + .6 * Math.random()); } continue; }
    if (p.inv > 0) { p.inv--; continue; }
    if (!T.hk) continue;
    for (const h of g.hz) {
      const on = h.k === 'saw' || (h.t >= h.warn && h.t < h.warn + h.life);
      if (on && Math.hypot(p.x - h.x, p.y - h.y) < p.r + h.r * (h.k === 'saw' ? .95 : .9)) { p.dead = Math.max(1, Math.round(T.dt * 60)); p.vx = p.vy = 0; p.k = p.c = 0; break; }
    }
  }
}
const hzOut = h => h.k === 'saw' ? [r1(h.x), r1(h.y), h.r, 0, 0]
  : [r1(h.x), r1(h.y), Math.round(h.r), h.t < h.warn ? 1 : 2, Math.round(100 * (h.t < h.warn ? h.t / h.warn : Math.min(1, (h.t - h.warn) / h.life))) / 100];
function step(L) {
  const g = L.g, b = g.ball, M = getMap(L), T = L.set, ps = L.players.filter(p => p.team !== 's'), alive = ps.filter(p => !p.dead);
  BN = T.bn; b.r = BR * T.br; b.im = 1 / T.bm;
  const free = !!(L.host && L.host.admin), capP = free ? Infinity : 150, capB = free ? Infinity : 120;   // admin lobbies: no safety limits at all
  const pd = free ? 1 - .04 * T.pf : clamp(1 - .04 * T.pf, .02, .999), bd = free ? 1 - .01 * T.bf : clamp(1 - .01 * T.bf, 0, 1), acc = 2.4 * (1 - pd) / pd;   // acc keeps top speed constant whatever the friction
  for (const p of ps) { p.r = PR * T.pr; p.gh = T.gh && p.g ? 1 : 0; }   // ghost: ball passes through, no kicking
  if (g.ph === 'play') {
    for (const p of alive) {
      if (p.bot) botAI(p, alive, b, M, T, g.hz);
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
        g.ev.push([0, p.id, r1(b.x), r1(b.y), p.c]); g.last = p.id;
      }
    }
    hazards(L, M, T, ps, alive);
    if (--g.tl <= 0) finish(L);
  }
  if (b.sp) {                                                   // curve: rotate velocity (positive = turn right)
    const c = Math.cos(b.sp), s = Math.sin(b.sp), vx = b.vx;
    b.vx = vx * c - b.vy * s; b.vy = vx * s + b.vy * c; b.sp *= .98; if (Math.abs(b.sp) < 1e-4) b.sp = 0;
  }
  for (const p of alive) { p.x += p.vx; p.y += p.vy; p.vx *= pd; p.vy *= pd; const s = Math.hypot(p.vx, p.vy); if (s > capP) { p.vx *= capP / s; p.vy *= capP / s; } }
  b.x += b.vx; b.y += b.vy; b.vx *= bd; b.vy *= bd;
  { const s = Math.hypot(b.vx, b.vy); if (s > capB) { b.vx *= capB / s; b.vy *= capB / s; } }   // speed caps keep extreme settings from blowing up
  for (let i = 0; i < alive.length; i++) { if (T.pc) for (let j = i + 1; j < alive.length; j++) hit(alive[i], alive[j]); if (!alive[i].gh) { hit(alive[i], b); if (Math.hypot(alive[i].x - b.x, alive[i].y - b.y) <= alive[i].r + b.r + 1) g.last = alive[i].id; } }
  M.posts.forEach(o => hit(o, b));
  M.obs.forEach(o => { hit(o, b, o.e || BN); alive.forEach(p => hit(o, p)); });
  g.hz.forEach(h => { if (h.k === 'saw') hit(h, b, 1.1); });
  alive.forEach(p => {                                  // players may leave the pitch (pw) so they can get behind a stuck ball
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
  cast(L, { t: 's', p: ps.map(p => [p.id, r1(p.x), r1(p.y), (!p.gh && (p.k || p.c) ? 1 : 0) | (p.on ? 2 : 0) | (p.gh ? 4 : 0) | (p.dead ? 8 : 0), Math.round(p.st * 100) / 100, Math.ceil(p.dead / 60)]),
    b: [r1(b.x), r1(b.y), Math.round(b.sp * 1000) / 1000], h: g.hz.map(hzOut), e: g.ev.length ? g.ev : undefined, s: g.sc, tl: Math.max(0, Math.ceil(g.tl / 60)), ph: g.ph, m: g.msg });
  g.ev = [];
}
// fixed 60Hz timestep
const DT = 1000 / 60; let last = Date.now(), acc = 0;
setInterval(() => {
  const n = Date.now(); acc = Math.min(acc + n - last, 100); last = n;
  while (acc >= DT) { acc -= DT; lobbies.forEach(L => L.ph === 'play' && step(L)); }
}, 8);

wss.on('connection', (ws, req) => {
  let ip = clientIP(req); if (!IPRE.test(ip)) ip = '';
  const bn = isLoop(ip) ? null : banOf(ip);
  if (bn) { send(ws, { t: 'banned', msg: banText(bn) }); ws.close(); return; }
  const p = mk({ ws, ip }); p.name = 'Player' + p.id;
  all.add(p); send(ws, { t: 'me', id: p.id, maps: MAPS.map(({ n, shape, W, H, G, R, obs, col }) => ({ n, shape, W, H, G, R, obs, col })), ranges: RANGE }); pushList();
  ws.on('message', d => { let m; try { m = JSON.parse(d); } catch { return; } if (m && typeof m === 'object') handle(p, m); });
  ws.on('close', () => { leave(p); all.delete(p); });
});
srv.listen(PORT, () => console.log('BallPlexx listening on :' + PORT));
