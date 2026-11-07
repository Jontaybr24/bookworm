// Bookworm server: serves the page, keeps accounts and games, and proxies book lookups to Open Library.
// No dependencies. Everything lives in one file: DATA_DIR/data.json (see load/save).
//
// Roles: the first account ever registered is the master (can do everything, including demoting Gamemasters and
// removing accounts or games). Gamemasters manage the shared tile pool and can promote other accounts to Gamemaster.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'bw_session';
const SESSION_DAYS = 30;
const MAX_BODY = 64 * 1024;

const DEFAULT_TILES = [
  'A book set in a library', 'A book with a map inside', 'A debut novel', 'A book over 500 pages',
  'A book under 200 pages', 'A book in translation', 'A book with a one-word title', 'A book published this year',
  'A book published before 1950', 'A book by an author from a different continent', 'A mystery or thriller',
  'A fantasy novel', 'A science fiction novel', 'A memoir or biography', 'A book of poetry', 'A graphic novel',
  'A book recommended by a friend', 'A book with a blue cover', 'A book with an animal on the cover',
  'A book set at sea', 'A retelling of a myth or fairy tale', 'A book that was made into a movie',
  'A book you have been meaning to read for ages', 'A book with a number in the title', 'A historical fiction novel',
  'A book set in a city you want to visit', 'A non-fiction book about science', 'A book with an unreliable narrator',
  'A book with multiple narrators', 'A short story collection', 'A banned or challenged book', 'A prize winner',
  'A book bought at an indie bookstore', 'A book borrowed from the library', 'A cosy read', 'A horror novel',
  'A book with a food in the title', 'A classic you never read in school', 'A book set in the future',
  'A book about books or reading',
];

// ---------- storage ----------
function emptyData() {
  return {
    users: {}, sessions: {}, games: {},
    tiles: DEFAULT_TILES.map((text) => ({ id: newId(), text })),
  };
}
function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(DATA_FILE)) return emptyData();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    // Never replace an unreadable file with an empty one: keep a copy and stop, so nothing is overwritten.
    const copy = DATA_FILE + '.unreadable-' + Date.now();
    fs.copyFileSync(DATA_FILE, copy);
    console.error(`Could not read ${DATA_FILE} (${e.message}). A copy is at ${copy}. Fix or remove it, then restart.`);
    process.exit(1);
  }
}
let db = load();
// Fields added after v0.0.0.1 (friends and invites), filled in for data files made before them.
db.friendRequests ||= [];   // [{ from, to, at }] — pending; accepting moves both into each other's friends
db.invites ||= [];          // [{ gameId, from, to, at }] — pending game invitations
for (const u of Object.values(db.users)) u.friends ||= [];
function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
}
save();

// ---------- helpers ----------
function newId() { return crypto.randomBytes(9).toString('base64url'); }
function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
  } while (Object.values(db.games).some((g) => g.code === code));
  return code;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function gameStatus(g) {
  const t = today();
  if (t < g.start) return 'upcoming';
  if (t > g.end) return 'ended';
  return 'active';
}
const LINES = (() => {
  const lines = [];
  for (let r = 0; r < 5; r++) lines.push([0, 1, 2, 3, 4].map((c) => r * 5 + c));
  for (let c = 0; c < 5; c++) lines.push([0, 1, 2, 3, 4].map((r) => r * 5 + c));
  lines.push([0, 6, 12, 18, 24], [4, 8, 12, 16, 20]);
  return lines;
})();
// A player's board position p shows tile order[p]. A shelf (bingo) is any full row, column or diagonal of read books.
function shelves(player) {
  const read = (p) => player.squares[player.order[p]]?.status === 'read';
  return LINES.filter((line) => line.every(read)).length;
}
function cleanStr(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function validDate(s) { return typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && !isNaN(Date.parse(s)); }

async function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const key = await scrypt(pw, salt, 64);
  return { salt, hash: key.toString('hex') };
}

function publicUser(u) {
  return u && { id: u.id, username: u.username, role: u.role, isGM: u.role !== 'player', isMaster: u.role === 'master' };
}
function isMember(g, u) { return !!g.players[u.id]; }
function canView(g, u) { return isMember(g, u) || u.role === 'master'; }

function gameView(g, u) {
  const players = Object.entries(g.players).map(([uid, p]) => ({
    id: uid,
    username: db.users[uid]?.username || '(removed)',
    order: p.order,
    squares: p.squares,
    shelves: shelves(p),
    read: Object.values(p.squares).filter((s) => s.status === 'read').length,
    planned: Object.values(p.squares).filter((s) => s.status === 'planned').length,
  }));
  return {
    id: g.id, name: g.name, start: g.start, end: g.end, status: gameStatus(g),
    creatorId: g.creatorId, creator: db.users[g.creatorId]?.username || '(removed)',
    tiles: g.tiles, players, isMember: isMember(g, u),
    // The join code is only ever sent from inside a game, to its members (and the master).
    code: canView(g, u) ? g.code : undefined,
  };
}
function gameSummary(g, u) {
  return {
    id: g.id, name: g.name, start: g.start, end: g.end, status: gameStatus(g),
    playerCount: Object.keys(g.players).length, isMember: isMember(g, u),
    myShelves: g.players[u.id] ? shelves(g.players[u.id]) : null,
  };
}
function addPlayer(g, uid) {
  if (!g.players[uid]) g.players[uid] = { order: shuffle([...Array(25).keys()]), squares: {}, joinedAt: Date.now() };
}

// ---------- http plumbing ----------
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
}
function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
function currentUser(req) {
  const token = cookies(req)[COOKIE];
  const s = token && db.sessions[token];
  if (!s) return null;
  if (s.expires < Date.now()) { delete db.sessions[token]; save(); return null; }
  return db.users[s.userId] || null;
}
function startSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { userId: user.id, expires: Date.now() + SESSION_DAYS * 864e5 };
  save();
  return sessionCookie(token, SESSION_DAYS * 86400);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------- book lookups (Open Library) ----------
const bookCache = new Map();
async function olFetch(url) {
  if (bookCache.has(url)) return bookCache.get(url);
  const r = await fetch(url, { headers: { 'User-Agent': 'Bookworm book bingo (prototype)' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) fail(502, 'Book search is unavailable right now');
  const json = await r.json();
  if (bookCache.size > 500) bookCache.delete(bookCache.keys().next().value);
  bookCache.set(url, json);
  return json;
}
async function searchBooks(q) {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=12&fields=key,title,author_name,first_publish_year,cover_i`;
  const json = await olFetch(url);
  return (json.docs || []).map((d) => ({
    key: d.key, title: d.title, author: (d.author_name || []).slice(0, 2).join(', '), year: d.first_publish_year || null,
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
  }));
}
async function bookDescription(key) {
  if (!/^\/works\/OL\d+W$/.test(key)) fail(400, 'Bad book key');
  const json = await olFetch(`https://openlibrary.org${key}.json`);
  let d = json.description;
  if (d && typeof d === 'object') d = d.value;
  d = typeof d === 'string' ? d.replace(/\r/g, '').split(/\n\s*-{3,}|\n\s*\(\[source\]/)[0].trim() : '';
  return d.length > 600 ? d.slice(0, 597).replace(/\s+\S*$/, '') + '…' : d;
}

// ---------- routes ----------
async function api(req, res, url) {
  const method = req.method;
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  // "/games/abc123/leave" becomes "POST /games/:id/leave"; the real id stays in parts[1].
  const hasId = ['users', 'tiles', 'games', 'friends', 'invites'].includes(parts[0]) && parts[1] && parts[1] !== 'join';
  const route = `${method} /${parts.map((p, i) => (i === 1 && hasId ? ':id' : p)).join('/')}`;
  const body = ['POST', 'PUT', 'DELETE'].includes(method) ? await readBody(req) : {};
  const me = currentUser(req);
  const need = () => me || fail(401, 'Please sign in');
  const needGM = () => (need().role !== 'player' ? me : fail(403, 'Gamemasters only'));
  const needMaster = () => (need().role === 'master' ? me : fail(403, 'Master account only'));

  // --- accounts ---
  if (route === 'POST /register') {
    const username = cleanStr(body.username, 24);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[A-Za-z0-9_.-]{3,24}$/.test(username)) fail(400, 'Usernames are 3–24 letters, numbers, _ . or -');
    if (password.length < 6) fail(400, 'Passwords need at least 6 characters');
    if (Object.values(db.users).some((u) => u.username.toLowerCase() === username.toLowerCase())) fail(409, 'That username is taken');
    const first = Object.keys(db.users).length === 0;
    const user = { id: newId(), username, role: first ? 'master' : 'player', friends: [], createdAt: Date.now(), ...(await hashPassword(password)) };
    db.users[user.id] = user;
    save();
    return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': startSession(user) });
  }
  if (route === 'POST /login') {
    const username = cleanStr(body.username, 24).toLowerCase();
    const user = Object.values(db.users).find((u) => u.username.toLowerCase() === username);
    const { hash } = await hashPassword(String(body.password || ''), user ? user.salt : 'x');
    if (!user || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'))) fail(401, 'Wrong username or password');
    return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': startSession(user) });
  }
  if (route === 'POST /logout') {
    const token = cookies(req)[COOKIE];
    if (token) { delete db.sessions[token]; save(); }
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (route === 'GET /me') return send(res, 200, { user: publicUser(me) });

  // --- users (Gamemasters see the list and can promote; only the master can demote or remove) ---
  if (route === 'GET /users') {
    needGM();
    return send(res, 200, { users: Object.values(db.users).map(publicUser).sort((a, b) => a.username.localeCompare(b.username)) });
  }
  if (route === 'POST /users/:id/promote') {
    needGM();
    const u = db.users[parts[1]] || fail(404, 'No such account');
    if (u.role === 'player') { u.role = 'gamemaster'; save(); }
    return send(res, 200, { user: publicUser(u) });
  }
  if (route === 'POST /users/:id/demote') {
    needMaster();
    const u = db.users[parts[1]] || fail(404, 'No such account');
    if (u.role === 'gamemaster') { u.role = 'player'; save(); }
    return send(res, 200, { user: publicUser(u) });
  }
  if (route === 'DELETE /users/:id') {
    needMaster();
    const u = db.users[parts[1]] || fail(404, 'No such account');
    if (u.role === 'master') fail(400, 'The master account cannot be removed');
    delete db.users[u.id];
    for (const [t, s] of Object.entries(db.sessions)) if (s.userId === u.id) delete db.sessions[t];
    for (const g of Object.values(db.games)) delete g.players[u.id];
    for (const other of Object.values(db.users)) other.friends = other.friends.filter((id) => id !== u.id);
    db.friendRequests = db.friendRequests.filter((r) => r.from !== u.id && r.to !== u.id);
    db.invites = db.invites.filter((i) => i.from !== u.id && i.to !== u.id);
    save();
    return send(res, 200, { ok: true });
  }

  // --- tile pool ---
  if (route === 'GET /tiles') { need(); return send(res, 200, { tiles: db.tiles }); }
  if (route === 'POST /tiles') {
    needGM();
    const text = cleanStr(body.text, 80) || fail(400, 'Tile text is required');
    if (db.tiles.some((t) => t.text.toLowerCase() === text.toLowerCase())) fail(409, 'That tile already exists');
    const tile = { id: newId(), text };
    db.tiles.push(tile); save();
    return send(res, 200, { tile });
  }
  if (route === 'DELETE /tiles/:id') {
    needGM();
    const before = db.tiles.length;
    db.tiles = db.tiles.filter((t) => t.id !== parts[1]);
    if (db.tiles.length === before) fail(404, 'No such tile');
    save(); // games keep their own copy of their tiles, so removing one from the pool never changes a game
    return send(res, 200, { ok: true });
  }

  // --- games ---
  if (route === 'GET /games') {
    need();
    const list = Object.values(db.games).filter((g) => canView(g, me)).sort((a, b) => b.createdAt - a.createdAt);
    return send(res, 200, { games: list.map((g) => gameSummary(g, me)) });
  }
  if (route === 'POST /games') {
    need();
    const name = cleanStr(body.name, 60) || fail(400, 'Give the game a name');
    if (!validDate(body.start) || !validDate(body.end)) fail(400, 'Pick a start and end date');
    if (body.end < body.start) fail(400, 'The end date must be on or after the start date');
    const chosen = (Array.isArray(body.tileIds) ? body.tileIds : []).map((id) => db.tiles.find((t) => t.id === id)).filter(Boolean);
    const custom = (Array.isArray(body.custom) ? body.custom : []).map((t) => cleanStr(t, 80)).filter(Boolean);
    const picked = [...new Map([...chosen.map((t) => t.text), ...custom].map((t) => [t.toLowerCase(), t])).values()];
    if (picked.length > 25) fail(400, `That's ${picked.length} tiles — a card has exactly 25`);
    const rest = shuffle(db.tiles.map((t) => t.text).filter((t) => !picked.some((p) => p.toLowerCase() === t.toLowerCase())));
    while (picked.length < 25 && rest.length) picked.push(rest.pop());
    if (picked.length < 25) fail(400, 'Not enough tiles to fill a card — add some custom tiles');
    const g = {
      id: newId(), code: newCode(), name, start: body.start, end: body.end, creatorId: me.id, createdAt: Date.now(),
      tiles: picked.map((text, i) => ({ id: i, text, custom: custom.some((c) => c.toLowerCase() === text.toLowerCase()) })),
      players: {},
    };
    addPlayer(g, me.id);
    db.games[g.id] = g; save();
    return send(res, 200, { game: gameView(g, me) });
  }
  if (route === 'POST /games/join') {
    need();
    const code = cleanStr(body.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const g = Object.values(db.games).find((x) => x.code === code) || fail(404, 'No game has that code');
    if (gameStatus(g) === 'ended') fail(400, 'That game has already ended');
    addPlayer(g, me.id); save();
    return send(res, 200, { game: gameView(g, me) });
  }
  if (route === 'GET /games/:id') {
    need();
    const g = db.games[parts[1]];
    if (!g || !canView(g, me)) fail(404, 'Game not found');
    return send(res, 200, { game: gameView(g, me) });
  }
  if (route === 'DELETE /games/:id') {
    need();
    const g = db.games[parts[1]];
    if (!g || !canView(g, me)) fail(404, 'Game not found');
    if (g.creatorId !== me.id && me.role !== 'master') fail(403, 'Only the creator or the master can delete a game');
    delete db.games[g.id];
    db.invites = db.invites.filter((i) => i.gameId !== g.id);
    save();
    return send(res, 200, { ok: true });
  }

  // --- friends: you can befriend anyone who shares a game with you; they accept the request ---
  const nameOf = (id) => ({ id, username: db.users[id]?.username || '(removed)' });
  if (route === 'GET /friends') {
    need();
    return send(res, 200, {
      friends: me.friends.map(nameOf).sort((a, b) => a.username.localeCompare(b.username)),
      incoming: db.friendRequests.filter((r) => r.to === me.id).map((r) => nameOf(r.from)),
      outgoing: db.friendRequests.filter((r) => r.from === me.id).map((r) => nameOf(r.to)),
    });
  }
  if (route === 'POST /friends/:id') {
    need();
    const other = db.users[parts[1]] || fail(404, 'No such reader');
    if (other.id === me.id) fail(400, "You can't befriend yourself");
    if (me.friends.includes(other.id)) return send(res, 200, { status: 'friends' });
    // If they already asked you, sending one back is the same as accepting.
    const theirs = db.friendRequests.find((r) => r.from === other.id && r.to === me.id);
    if (theirs) {
      db.friendRequests = db.friendRequests.filter((r) => r !== theirs);
      me.friends.push(other.id); other.friends.push(me.id); save();
      return send(res, 200, { status: 'friends' });
    }
    const shareGame = Object.values(db.games).some((g) => g.players[me.id] && g.players[other.id]);
    if (!shareGame) fail(403, 'You can only add friends you share a game with');
    if (!db.friendRequests.some((r) => r.from === me.id && r.to === other.id)) {
      db.friendRequests.push({ from: me.id, to: other.id, at: Date.now() }); save();
    }
    return send(res, 200, { status: 'requested' });
  }
  if (route === 'POST /friends/:id/accept') {
    need();
    const req0 = db.friendRequests.find((r) => r.from === parts[1] && r.to === me.id) || fail(404, 'No such request');
    const other = db.users[req0.from];
    db.friendRequests = db.friendRequests.filter((r) => r !== req0);
    if (other && !me.friends.includes(other.id)) { me.friends.push(other.id); other.friends.push(me.id); }
    save();
    return send(res, 200, { status: 'friends' });
  }
  // Declines a request to you, cancels one from you, or ends a friendship — whichever applies.
  if (route === 'DELETE /friends/:id') {
    need();
    const id = parts[1];
    db.friendRequests = db.friendRequests.filter((r) => !((r.from === id && r.to === me.id) || (r.from === me.id && r.to === id)));
    me.friends = me.friends.filter((f) => f !== id);
    if (db.users[id]) db.users[id].friends = db.users[id].friends.filter((f) => f !== me.id);
    save();
    return send(res, 200, { ok: true });
  }

  // --- game invitations (to friends only) ---
  if (route === 'POST /games/:id/invite') {
    need();
    const g = db.games[parts[1]];
    if (!g || !isMember(g, me)) fail(404, 'Game not found');
    if (gameStatus(g) === 'ended') fail(400, 'This game has ended');
    const ids = (Array.isArray(body.userIds) ? body.userIds : []).filter((id) => me.friends.includes(id) && !g.players[id]);
    let sent = 0;
    for (const to of ids) {
      if (db.invites.some((i) => i.gameId === g.id && i.to === to)) continue;
      db.invites.push({ gameId: g.id, from: me.id, to, at: Date.now() }); sent++;
    }
    save();
    return send(res, 200, { sent });
  }
  if (route === 'GET /invites') {
    need();
    db.invites = db.invites.filter((i) => db.games[i.gameId]); // drop invites to deleted games
    const mine = db.invites.filter((i) => i.to === me.id && gameStatus(db.games[i.gameId]) !== 'ended' && !db.games[i.gameId].players[me.id]);
    return send(res, 200, { invites: mine.map((i) => {
      const g = db.games[i.gameId];
      return { gameId: g.id, name: g.name, start: g.start, end: g.end, status: gameStatus(g), from: nameOf(i.from).username, playerCount: Object.keys(g.players).length };
    }) });
  }
  if (route === 'POST /invites/:id/accept') {
    need();
    const inv = db.invites.find((i) => i.gameId === parts[1] && i.to === me.id) || fail(404, 'No such invitation');
    const g = db.games[inv.gameId] || fail(404, 'That game no longer exists');
    if (gameStatus(g) === 'ended') fail(400, 'That game has already ended');
    addPlayer(g, me.id);
    db.invites = db.invites.filter((i) => !(i.gameId === g.id && i.to === me.id));
    save();
    return send(res, 200, { game: gameView(g, me) });
  }
  if (route === 'DELETE /invites/:id') {
    need();
    db.invites = db.invites.filter((i) => !(i.gameId === parts[1] && i.to === me.id));
    save();
    return send(res, 200, { ok: true });
  }
  if (route === 'POST /games/:id/leave') {
    need();
    const g = db.games[parts[1]];
    if (!g || !isMember(g, me)) fail(404, 'Game not found');
    delete g.players[me.id]; save();
    return send(res, 200, { ok: true });
  }
  // Set or clear one of your own squares. status: "read" (only while the game is active), "planned", or null to clear.
  if (method === 'POST' && parts[0] === 'games' && parts[2] === 'squares' && parts.length === 4) {
    need();
    const g = db.games[parts[1]];
    if (!g || !isMember(g, me)) fail(404, 'Game not found');
    const tileId = Number(parts[3]);
    if (!Number.isInteger(tileId) || tileId < 0 || tileId > 24) fail(400, 'Bad tile');
    const player = g.players[me.id];
    const status = gameStatus(g);
    if (status === 'ended') fail(400, 'This game has ended');
    if (body.status === null || body.status === undefined) {
      delete player.squares[tileId];
    } else {
      if (!['read', 'planned'].includes(body.status)) fail(400, 'Bad status');
      if (body.status === 'read' && status !== 'active') fail(400, `You can log finished books once the game starts on ${g.start}. Plan it for now!`);
      const b = body.book || {};
      const book = {
        key: cleanStr(b.key, 40), title: cleanStr(b.title, 200) || fail(400, 'Pick a book'), author: cleanStr(b.author, 120),
        year: Number.isInteger(b.year) ? b.year : null, description: cleanStr(b.description, 700),
        cover: /^https:\/\/covers\.openlibrary\.org\/b\/id\/\d+-[SML]\.jpg$/.test(b.cover || '') ? b.cover : null,
      };
      player.squares[tileId] = { status: body.status, book, updatedAt: Date.now() };
    }
    save();
    return send(res, 200, { game: gameView(g, me) });
  }

  // --- books ---
  if (route === 'GET /books/search') {
    need();
    const q = cleanStr(url.searchParams.get('q'), 120);
    if (q.length < 2) return send(res, 200, { books: [] });
    return send(res, 200, { books: await searchBooks(q) });
  }
  if (route === 'GET /books/description') {
    need();
    return send(res, 200, { description: await bookDescription(String(url.searchParams.get('key') || '')) });
  }

  fail(404, 'Not found');
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    serveStatic(req, res, url.pathname);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Something went wrong' });
  }
}).listen(PORT, HOST, () => console.log(`Bookworm listening on http://${HOST}:${PORT} (data: ${DATA_FILE})`));
