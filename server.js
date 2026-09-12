// Doodle District LAN server: static files + a WebSocket room hub, with no npm dependencies.
//
// The original game was peer-to-peer over WebRTC and needed a public signalling service on the
// internet. This replaces that entirely: one machine runs this server, everybody on the LAN points
// their browser (and the in-game server box) at its IPv4 or IPv6 address, and every message is
// relayed here. No STUN, no NAT traversal, no mDNS candidates - things that all tend to fail on a
// closed network - and nothing to install.
//
//   node server.js [port]        default 8080, or set PORT
//
// Rooms live only in memory. A room dies when its last member leaves; if the host leaves while
// others are still in it, the oldest remaining member is promoted and everyone is told.

'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
// unset means every interface, which is what a LAN game wants. Set it to 127.0.0.1 when something
// else — a reverse proxy — is the only thing that should be able to reach the game.
const HOST = process.env.HOST || undefined;
const ROOT = __dirname;
const MAX_PLAYERS = 32;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1: they get misread over voice chat
const MAX_FRAME = 1 << 20;
const STALL_BYTES = 64 * 1024;   // unsent backlog past which superseded state is dropped, not queued
const WEDGE_BYTES = 192 * 1024;  // ...and past which, with nothing coming back, the socket is written off

// ---------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wasm': 'application/wasm',
};

// three.js is 1.3MB of source and 260KB gzipped, which is the difference between a snappy load and
// a five-second stare on anything slower than a LAN. Nothing here changes while the process runs,
// so each file is compressed once and the bytes are kept; a stat per request catches an edit.
const COMPRESSIBLE = /^(text\/|application\/(javascript|json)|image\/svg)/;
const gzCache = new Map(); // absolute path -> { mtimeMs, buf }

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { rel = '/'; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel));
  // path.normalize collapses "..", but a crafted path could still escape; check the result
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end('forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // A vendored library is pinned and can be held for ever; the game's own source is edited
    // between matches, and a cached copy of it would be a bug report that cannot be reproduced.
    const vendor = file.slice(ROOT.length).split(path.sep).includes('vendor');
    const cache = vendor ? 'public, max-age=31536000, immutable' : 'no-cache';
    const head = (extra, len) => ({ 'content-type': type, 'content-length': len, 'cache-control': cache, ...extra });
    const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && COMPRESSIBLE.test(type) && st.size > 1024;
    if (!gzip) {
      res.writeHead(200, head({}, st.size));
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
      return;
    }
    const done = (buf) => {
      res.writeHead(200, head({ 'content-encoding': 'gzip', vary: 'accept-encoding' }, buf.length));
      res.end(req.method === 'HEAD' ? undefined : buf);
    };
    const hit = gzCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) { done(hit.buf); return; }
    fs.readFile(file, (e, raw) => {
      if (e) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
      zlib.gzip(raw, { level: 6 }, (ze, buf) => {
        if (ze) { res.writeHead(200, head({}, raw.length)).end(raw); return; }
        gzCache.set(file, { mtimeMs: st.mtimeMs, buf });
        done(buf);
      });
    });
  });
}

// ---------------------------------------------------------------- minimal RFC 6455 server
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSConn {
  constructor(socket) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.closed = false;
    this.onmessage = null; this.onclose = null; this.dropped = 0;
    this.fragOp = 0; this.frags = [];
    this.out = []; this.outLen = 0; this.flushT = null;
    socket.on('data', (d) => this._feed(d));
    // Sockets handed over by an HTTP upgrade allow half-open, so a peer that hangs up gives us
    // 'end' and nothing else: no 'close', no 'error'. Miss that and the connection sits here for
    // ever — the player keeps their slot, the room is never dropped, and if they were the host
    // nobody is ever promoted in their place.
    socket.on('end', () => this._dead());
    socket.on('error', () => this._dead());
    socket.on('close', () => this._dead());
    socket.setNoDelay(true); // a 40ms Nagle delay on 20Hz position updates is very visible
  }
  _dead() {
    if (this.closed) return;
    this.closed = true;
    if (this.flushT) { clearImmediate(this.flushT); this.flushT = null; }
    this.out.length = 0; this.outLen = 0;
    try { this.socket.destroy(); } catch (e) { /* already gone */ }
    if (this.onclose) this.onclose();
  }
  _feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const f = this._readFrame();
      if (!f) break;
      if (f.opcode === 0x8) { this.close(); return; }              // close
      if (f.opcode === 0x9) { this._write(f.payload, 0xa); continue; } // ping -> pong
      if (f.opcode === 0xa) continue;                              // pong
      if (f.opcode === 0x0) { this.frags.push(f.payload); }        // continuation
      else { this.fragOp = f.opcode; this.frags = [f.payload]; }
      if (!f.fin) continue;
      const body = this.frags.length === 1 ? this.frags[0] : Buffer.concat(this.frags);
      this.frags = [];
      if (this.fragOp === 0x1 && this.onmessage) this.onmessage(body.toString('utf8'));
    }
  }
  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0, opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return null;
      const hi = b.readUInt32BE(2);
      if (hi !== 0) { this.close(); return null; }
      len = b.readUInt32BE(6); off = 10;
    }
    if (len > MAX_FRAME) { this.close(); return null; }
    const need = off + (masked ? 4 : 0) + len;
    if (b.length < need) return null;
    let payload;
    if (masked) {
      const key = b.slice(off, off + 4);
      payload = Buffer.allocUnsafe(len);
      b.copy(payload, 0, off + 4, off + 4 + len);
      for (let i = 0; i < len; i++) payload[i] ^= key[i & 3];
    } else {
      payload = b.slice(off, off + len);
    }
    this.buf = b.slice(need);
    return { fin, opcode, payload };
  }
  _write(payload, opcode) {
    if (this.closed) return;
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.allocUnsafe(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.allocUnsafe(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.allocUnsafe(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    head[0] = 0x80 | opcode;
    // Queued, not written. A full room relays every position update to nine other sockets twenty
    // times a second; writing each frame the moment it is built costs two syscalls each, and with
    // Nagle off (which a shooter wants) every one of them can leave as its own packet - eighteen
    // packets per socket per tick carrying ninety bytes apiece. Everything produced in one turn of
    // the event loop goes out together instead: same bytes, same order, one write, microseconds
    // later. setImmediate and not a timer, so this is never a frame of added latency.
    this.out.push(head, payload);
    this.outLen += head.length + len;
    if (!this.flushT) this.flushT = setImmediate(() => this._flush());
  }
  _flush() {
    this.flushT = null;
    if (!this.out.length) return;
    const buf = Buffer.concat(this.out, this.outLen);
    this.out.length = 0; this.outLen = 0;
    if (this.closed) return;
    try { this.socket.write(buf); } catch (e) { this._dead(); }
  }
  // What is waiting to reach this peer: bytes not yet flushed, plus bytes node is holding because
  // the kernel would not take them. Zero on a healthy connection; tens of kilobytes means the link
  // has stalled and TCP is retransmitting into the dark.
  get pending() { return this.outLen + (this.socket.writableLength || 0); }
  // A position update is worth sending only if it is the newest one. Queueing it behind 64KB of
  // its own predecessors makes the stall worse and delivers a burst of history when the link
  // recovers, so past that mark the droppable traffic is simply skipped: the next tick supersedes
  // it anyway. Joins, leaves, host changes and damage are not droppable and always go.
  send(str, droppable) {
    if (droppable && this.pending > STALL_BYTES) { this.dropped++; return; }
    this._write(Buffer.from(str, 'utf8'), 0x1);
  }
  close() {
    if (this.closed) return;
    if (this.flushT) { clearImmediate(this.flushT); this.flushT = null; }
    this._flush();                 // anything already queued goes out ahead of the close frame
    this.closed = true;
    try {
      this._closing = true;
      this.socket.end(Buffer.from([0x88, 0x00]));
      // end() only half-closes. A peer that never answers the close frame would otherwise hold
      // the socket open for ever, which is exactly the peer we are most likely closing on.
      setTimeout(() => { try { this.socket.destroy(); } catch (e) { /* gone */ } }, 2000).unref();
    } catch (e) { /* already gone */ }
    if (this.onclose) this.onclose();
  }
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade !== 'websocket') { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  return new WSConn(socket);
}

// ---------------------------------------------------------------- rooms
const clients = new Map();  // id -> client
const rooms = new Map();    // CODE -> room  (aliases point at the same room object)

let seq = 0;
const newId = () => 'p' + (++seq).toString(36) + Math.random().toString(36).slice(2, 7);
const randCode = () => Array.from({ length: 5 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
const norm = (c) => String(c || '').trim().toUpperCase();

function freeCode() {
  for (let i = 0; i < 200; i++) { const c = randCode(); if (!rooms.has(c)) return c; }
  return randCode() + seq.toString(36).toUpperCase();
}

function makeRoom(code, host, { isPublic, name, map, max }) {
  const room = {
    code, codes: new Set([code]), hostId: host.id, isPublic: !!isPublic,
    members: new Map(), max: Number.isSafeInteger(max) ? Math.min(Math.max(2, max), MAX_PLAYERS) : MAX_PLAYERS,
    inMatch: false, accepting: true, hostName: name || '', map: map || null,
    mode: null, combat: null, actors: new Map(), bots: new Map(), lobbyBots: new Set(), evictedBots: new Set(), unshielded: new Map(),
  };
  rooms.set(code, room);
  return room;
}

function dropRoom(room) {
  for (const c of room.codes) if (rooms.get(c) === room) rooms.delete(c);
}

function send(client, obj, droppable) { if (client && client.ws && !client.ws.closed) client.ws.send(JSON.stringify(obj), droppable); }
function toRoom(room, obj, exceptId, droppable) {
  const s = JSON.stringify(obj);
  for (const m of room.members.values()) if (m.id !== exceptId && m.ws && !m.ws.closed) m.ws.send(s, droppable);
}

function roomInfo(room) {
  return {
    code: room.code, players: room.members.size, max: room.max, inMatch: room.inMatch,
    hostName: room.hostName, isPublic: room.isPublic, map: room.map, full: room.members.size >= room.max,
    mode: room.mode, bots: room.lobbyBots.size,
  };
}
const roster = (room) => [...room.members.values()].map((m) => ({ id: m.id, name: m.name }));

function leaveRoom(client, reason) {
  const room = client.room;
  if (!room) return;
  client.room = null;
  client.grenades.clear();
  room.members.delete(client.id);
  room.actors.delete(client.id);
  room.unshielded.delete(client.id);
  if (room.combat) room.combat.actors = room.combat.actors.filter((a) => a.id !== client.id);
  if (room.members.size === 0) { dropRoom(room); return; }
  if (room.hostId === client.id) {
    // promote the longest-standing member rather than dropping everyone's match
    const next = room.members.values().next().value;
    room.hostId = next.id; room.hostName = next.name;
    toRoom(room, { t: 'host', id: next.id, code: room.code });
  }
  toRoom(room, { t: 'gone', id: client.id, reason: reason || null });
}

function joinRoom(client, room, meta) {
  if (!room.accepting) return { error: 'that lobby is closed' };
  if (room.members.size >= room.max) return { error: 'that lobby is full' };
  leaveRoom(client);
  // Reserve the human's seat before the host catches up with peer events. Keep retired bot IDs
  // for the room's lifetime so queued snapshots or a reconnecting successor cannot restore them.
  if (room.members.size + room.lobbyBots.size >= room.max) {
    const id = room.lobbyBots.values().next().value;
    room.evictedBots.add(id); room.lobbyBots.delete(id); room.bots.delete(id); room.actors.delete(id); room.unshielded.delete(id);
    if (room.combat) room.combat.actors = room.combat.actors.filter((a) => a.id !== id);
  }
  client.room = room;
  client.meta = meta || {};
  room.members.set(client.id, client);
  toRoom(room, { t: 'peer', id: client.id, meta: { name: client.name, ...(meta || {}) } }, client.id);
  return {
    t: 'joined', code: room.code, id: client.id, hostId: room.hostId, isPublic: room.isPublic,
    map: room.map, inMatch: room.inMatch, max: room.max, members: roster(room), combat: room.combat,
  };
}

// ---------------------------------------------------------------- surviving a blip
//
// A closed socket used to be the end of somebody's match: the slot was freed on the spot, the room
// was told `gone`, and if it was the host everyone was dragged through a promotion. Over wifi, over
// mobile data, or over any path with real packet loss that happens for a second or two at a time,
// and the game becomes unplayable for reasons that have nothing to do with the game.
//
// So a socket closing no longer means the player left - it means they went quiet. The seat, the id,
// the room and the host job are all held while the client opens a new socket and says `resume` with
// the token it was handed at `hello`. Come back in time and the room is never told anything
// happened. Miss the window and the ordinary leave path runs, exactly as it did before.
const GRACE_MS = 12000;      // how long a quiet player keeps their seat
const HOST_GRACE_MS = 3500;  // the host holds the enemies and the clock, so hand those on sooner

function stall(client) {
  const room = client.room;
  if (!room) { clients.delete(client.id); return; }
  client.gone = Date.now();
  toRoom(room, { t: 'stall', id: client.id }, client.id);
  client.graceT = setTimeout(() => {
    if (!client.gone) return;
    leaveRoom(client, 'connection lost');
    clients.delete(client.id);
  }, room.hostId === client.id ? HOST_GRACE_MS : GRACE_MS);
  client.graceT.unref();
}

// Both the first socket of a seat and every socket that resumes it come through here, so a resumed
// player is wired up exactly like a fresh one.
function bind(ws, client) {
  ws.onmessage = (raw) => { client.seen = Date.now(); try { onMessage(client, raw); } catch (e) { console.error('message error:', e.message); } };
  ws.onclose = () => {
    if (client.ws !== ws) return;   // a superseded socket of a seat somebody has already resumed
    if (client.gone) return;        // already quiet; the grace timer owns what happens next
    if (client.room) { stall(client); return; }
    leaveRoom(client); clients.delete(client.id);
  };
}

// a lobby that changed hosts keeps living on generation codes (CODE-1, CODE-2); look through them
function resolveRoom(code) {
  const c = norm(code);
  if (rooms.has(c)) return rooms.get(c);
  const base = c.replace(/-\d+$/, '');
  if (rooms.has(base)) return rooms.get(base);
  for (const suf of ['-1', '-2', '-3']) if (rooms.has(base + suf)) return rooms.get(base + suf);
  return null;
}

// ---------------------------------------------------------------- lag compensation
//
// A shooter does not see the present. Their screen shows everyone else as they were one network
// trip ago, and the client deliberately holds them back a further 80ms so the gaps between position
// packets can be interpolated rather than guessed at. Put the crosshair on a sprinting player and
// it is on where they were, not where they are. Check that against the live position and almost
// every honest hit at any real latency is thrown out - at 120ms round trip and 7m/s that is a metre
// and a half of error, which is wider than a person.
//
// So: keep a short trail of where everyone has been, measure each player's round trip here rather
// than believing what they claim it is, and wind the world back to the shooter's screen before
// judging their shot. No clocks need to agree. A position that arrived here at T reached the
// shooter at T + oneway, was drawn INTERP later, and a claim about it comes back at
// T + rtt + INTERP; subtract that from now and you are looking at what they were looking at.
//
// What this is not: the server has no copy of the level and no skeleton, so it cannot re-run the
// client's raycast. It cannot know a wall was in the way, and it tests a capsule where the client
// tested animated limbs. It is a plausibility check with the latency taken out - which is the part
// that was missing. Until now `pdmg` went straight from one player to another and was simply
// believed, whatever it said.
const INTERP_MS = 80;         // must match the interpolation delay in src/players.js
const MAX_REWIND_MS = 500;    // however bad the ping, a claim older than this is not honoured
const HIST_MS = 1500;
const HULL_R = 0.75;          // body half width is 0.35; the rest is slack for limbs, for the 20Hz
const HULL_LO = -0.15;        // position feed, and for the client's own smoothing of it
const HULL_HI = 2.0;
const ORIGIN_SLACK = 6.0;     // how far from the shooter a shot may claim to have started

// PVP numbers lifted from GUNS in src/weapons.js: the most one hit can take off, and how fast
// claims may arrive. A shotgun fires ten pellets and each one reports separately.
// `mv` is the muzzle velocity from the same table, and only bounds how long a round may claim to
// have been in the air.
const ARMS = {
  rifle: { max: 19 * 1.8, rate: 11, burst: 4, reach: 300, mv: 330 },
  shotgun: { max: 16 * 1.6, rate: 10 / 0.78, burst: 30, reach: 60, mv: 200 },
  sniper: { max: 150 * 1.5, rate: 5, burst: 3, reach: 300, mv: 450 },
  revolver: { max: 52 * 2.9, rate: 1 / 0.3, burst: 3, reach: 300, mv: 260 },
  katana: { max: 165, base: 55, rate: 3, burst: 4, reach: 4.5 },
  grenade: { max: 62, rate: 1.25, burst: 8, reach: 6.4 * 0.95 },
};
const shots = { ok: 0, rejected: 0, why: {} };
const deny = (r) => { shots.rejected++; shots.why[r] = (shots.why[r] || 0) + 1; return false; };

// The host still owns simulation and objectives. This small roster lets the hit judge enforce
// team and round boundaries without pretending to run a second copy of the level or the AI.
const teamMode = (room) => room.mode === 'tdm' || room.mode === 'demolition';
const combatPhases = new Set(['warmup', 'live', 'roundover', 'over']);
function clearCombat(room) {
  room.combat = null; room.actors.clear(); room.bots.clear(); room.unshielded.clear();
  for (const member of room.members.values()) { member.grenades.clear(); member.hist.length = 0; member.buckets = {}; }
}
function noteLobby(room, d) {
  if (!d || d.players === undefined) return true;
  if (!Array.isArray(d.players) || d.players.length > room.max) return deny('oversized lobby roster');
  const ids = new Set(), bots = new Set(), rows = [];
  for (const row of d.players) {
    if (!row || typeof row.id !== 'string' || !row.id.length || row.id.length > 96 || ids.has(row.id)) return deny('malformed lobby roster');
    ids.add(row.id);
    if (row.bot === true) {
      if (room.members.has(row.id)) return deny('human listed as bot');
      if (room.evictedBots.has(row.id)) continue;
      bots.add(row.id);
    }
    rows.push(row);
  }
  if (room.members.size + bots.size > room.max) return deny('too many participants');
  room.lobbyBots = bots; d.players = rows;
  // Two joins can beat the first host reply. Trim retired bots instead of dropping that reply:
  // it may be the only targeted start packet that the first joining player will receive.
  if (Array.isArray(d.combat?.actors)) d.combat = { ...d.combat, actors: d.combat.actors.filter((a) => !(a?.bot === true && room.evictedBots.has(a.id))) };
  return true;
}
function noteCombat(room, d) {
  if (!d || !['tdm', 'demolition'].includes(d.mode) || !Number.isSafeInteger(d.round) || d.round < 0 || !combatPhases.has(d.phase) || !Array.isArray(d.actors) || d.actors.length > room.max) return deny('malformed combat state');
  if (room.combat && d.mode === room.mode && d.round < room.combat.round) return deny('stale combat state');
  const actors = new Map(), bots = new Map();
  for (const row of d.actors) {
    if (!row || typeof row.id !== 'string' || row.id.length > 96 || !row.id.length || actors.has(row.id) || (row.team !== 0 && row.team !== 1) || !Number.isSafeInteger(row.life) || row.life < 0) return deny('malformed combat actor');
    const bot = row.bot === true;
    if (bot && room.evictedBots.has(row.id)) continue;
    if (bot && (room.members.has(row.id) || room.members.size + bots.size >= room.max)) return deny('invalid bot actor');
    if (!bot && !room.members.has(row.id)) continue;
    // A queued host snapshot cannot restore protection already surrendered by firing. Keep this
    // separate from ordinary expiry: warmup -> live legitimately grants the opening protection.
    const forfeited = d.mode === room.mode && room.combat?.round === d.round && room.unshielded.has(row.id) && room.unshielded.get(row.id) === row.life;
    actors.set(row.id, { ...row, bot, alive: row.alive === true, protectedUntil: !forfeited && Number.isFinite(row.protectedUntil) ? Math.max(0, row.protectedUntil) : 0 });
    if (bot) bots.set(row.id, room.bots.get(row.id) || { id: row.id, room, bot: true, hist: [], rtt: [], buckets: {}, grenades: new Map() });
  }
  const fresh = !room.combat || d.mode !== room.mode || d.round !== room.combat.round;
  if (fresh) room.unshielded.clear();
  else for (const [id, life] of room.unshielded) if (!actors.has(id) || actors.get(id).life !== life) room.unshielded.delete(id);
  for (const actor of [...room.members.values(), ...bots.values()]) {
    const next = actors.get(actor.id), changedLife = next && room.actors.get(actor.id)?.life !== next.life;
    if (fresh || changedLife) {
      // Rewind may interpolate within a life, never from the corpse to the next spawn. Keep
      // registered grenades across respawns: their launch and held positions belong to that life.
      actor.hist.length = 0; actor.buckets = {};
      if (fresh) actor.grenades.clear();
      const spawn = next && vec3(next.spawn);
      if (spawn) actor.hist.push({ t: Date.now(), x: spawn[0], y: spawn[1], z: spawn[2], alive: next.alive });
    }
  }
  room.mode = d.mode; room.actors = actors; room.bots = bots; room.lobbyBots = new Set(bots.keys());
  room.combat = { ...d, actors: [...actors.values()] };
  return room.combat;
}
function sendCombat(room, client) {
  if (room.combat) send(client, { t: 'm', tt: 'combatstate', d: room.combat, from: room.hostId });
}
function combatGate(room, attacker, victim, d, registered = null) {
  if (!teamMode(room)) return true;
  const c = room.combat;
  if (!c || c.phase !== 'live' || d?.round !== c.round) return deny('combat round is not live');
  const a = room.actors.get(attacker.id), b = victim && room.actors.get(victim.id);
  if (!a || (!a.alive && !registered)) return deny('combat attacker is down');
  if (!Number.isSafeInteger(d.life) || d.life !== (registered ? registered.life : a.life) || (registered && registered.round !== c.round)) return deny('stale attacker life');
  if (victim && (!b || !b.alive)) return deny('combat target is down');
  if (b && (!Number.isSafeInteger(d.targetLife) || d.targetLife !== b.life)) return deny('stale target life');
  if (b && a.team === b.team) return deny('friendly fire');
  if (b && b.protectedUntil > Date.now()) return deny('spawn protection');
  return true;
}
function combatMove(room, client, round, life) {
  if (!teamMode(room)) return true;
  const a = room.actors.get(client.id);
  return (room.combat && round === room.combat.round && a && Number.isSafeInteger(life) && life === a.life) || deny('stale position life');
}

// Round trip, measured from this end. The client is never asked what its ping is: a bigger number
// buys a deeper rewind, so that is the one thing it must not be allowed to say.
function noteRtt(client, ms) {
  if (!(ms >= 0) || ms > 5000) return;
  const s = client.rtt;
  s.push(ms); if (s.length > 8) s.shift();
}
// The floor of the recent samples. Jitter only ever delays a packet, never hurries it, so the
// smallest round trip seen lately is the honest one and an average would just track the worst luck.
function rttOf(client) {
  if (client.bot) { const host = client.room.members.get(client.room.hostId); return host ? rttOf(host) : 0; }
  return client.rtt.length ? Math.min(...client.rtt) : 0;
}

function noteMove(client, d, now) {
  if (!Array.isArray(d) || d.length < 8) return false;
  const [x, y, z] = d;
  if (![x, y, z].every(Number.isFinite)) return false;
  const h = client.hist;
  h.push({ t: now, x, y, z, alive: !!(d[6] & 64) });
  while (h.length > 2 && now - h[0].t > HIST_MS) h.shift();
  const room = client.room, life = room.actors.get(client.id)?.life;
  for (const g of client.grenades.values()) if (g.phase === 'armed' && now <= g.expiresAt + 200 && (!teamMode(room) || (g.life === life && g.round === room.combat?.round))) g.held = [x, y + 0.9, z];
  return true;
}
// Where this player was on the server's clock at time t, interpolated between the two samples
// either side of it - the feed is only 20Hz, so landing between packets is the normal case.
function whereAt(client, t) {
  const h = client.hist;
  if (!h.length) return null;
  if (t <= h[0].t) return h[0];
  const last = h[h.length - 1];
  if (t >= last.t) return last;
  for (let i = h.length - 1; i > 0; i--) {
    const a = h[i - 1], b = h[i];
    if (a.t > t) continue;
    const k = (t - a.t) / Math.max(1, b.t - a.t);
    return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, alive: b.alive };
  }
  return h[0];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.sqrt(dot3(a, a));
// Closest approach between the shot (origin, along dir, up to maxT) and the standing figure's
// axis, as a squared distance. Ericson's segment-segment routine, with the degenerate cases in.
function raySegDist2(o, dir, maxT, p, q) {
  const d1 = [dir[0] * maxT, dir[1] * maxT, dir[2] * maxT], d2 = sub(q, p), r = sub(o, p);
  const a = dot3(d1, d1), e = dot3(d2, d2), f = dot3(d2, r);
  let s = 0, t = 0;
  if (a <= 1e-9 && e <= 1e-9) return dot3(r, r);
  if (a <= 1e-9) { t = Math.min(1, Math.max(0, f / e)); } else {
    const c = dot3(d1, r);
    if (e <= 1e-9) { s = Math.min(1, Math.max(0, -c / a)); } else {
      const b = dot3(d1, d2), denom = a * e - b * b;
      s = denom > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const w = [r[0] + d1[0] * s - d2[0] * t, r[1] + d1[1] * s - d2[1] * t, r[2] + d1[2] * s - d2[2] * t];
  return dot3(w, w);
}
// Squared distance from a point to the standing figure's axis - what a shot that curved on the way
// there gets checked against, since there is no straight line left to trace.
function pointSegDist2(p, a, b) {
  const ab = sub(b, a), ap = sub(p, a), e = dot3(ab, ab);
  const t = e > 1e-9 ? Math.min(1, Math.max(0, dot3(ap, ab) / e)) : 0;
  const w = [ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t];
  return dot3(w, w);
}
const vec3 = (v) => (Array.isArray(v) && v.length >= 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1], v[2]] : null);

// Grenades outlive their thrower's current position and even their life. Remember only the launch
// envelope and fuse, not a second physics simulation: bounces remain the owning client's job.
const GRENADE_FUSE_MS = 7000, GRENADE_GRACE_MS = 5000, GRENADE_LIMIT = 32;
const grenadeId = (id) => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/.test(id);
function pruneGrenades(client, now) {
  for (const [id, g] of client.grenades) if (now > g.expiresAt + GRENADE_GRACE_MS) client.grenades.delete(id);
}
function noteGrenade(client, d, now) {
  if (!d || !grenadeId(d.id) || !['armed', 'thrown'].includes(d.phase) || !Number.isFinite(d.expiresAt)) return deny('malformed grenade');
  const pos = vec3(d.pos), vel = vec3(d.vel);
  if (!pos || !vel || d.pos.length !== 3 || d.vel.length !== 3 || pos.some((n) => Math.abs(n) > 10000) || len3(vel) > 80) return deny('malformed grenade');
  if (d.thrownAt != null && (!Number.isFinite(d.thrownAt) || d.thrownAt < d.expiresAt - GRENADE_FUSE_MS - 750 || d.thrownAt > now + 750)) return deny('grenade throw time out of range');
  pruneGrenades(client, now);
  let g = client.grenades.get(d.id);
  if (g) {
    if (Math.abs(d.expiresAt - g.wireExpires) > 1) return deny('grenade fuse changed');
    if (g.phase === 'thrown' || d.phase === 'armed') return false;
    // A held grenade can move with its owner. Keep that position separately so a late death/drop
    // packet is not compared with the owner's already respawned location.
    const sameLife = !teamMode(client.room) || g.life === client.room.actors.get(client.id)?.life;
    const self = sameLife && whereAt(client, now), at = self && [self.x, self.y + 0.9, self.z];
    if (len3(sub(pos, g.held)) > ORIGIN_SLACK && (!at || len3(sub(pos, at)) > ORIGIN_SLACK)) return deny('grenade did not start at the holder');
  } else {
    const slack = Math.min(1500, rttOf(client) + 750);
    if (d.expiresAt > now + GRENADE_FUSE_MS + slack || d.expiresAt < now - slack) return deny('grenade fuse out of range');
    // Input uses real elapsed time, so a slow frame may report a pin that was already pulled.
    const self = whereAt(client, now);
    if (!self || len3(sub(pos, [self.x, self.y + 0.9, self.z])) > ORIGIN_SLACK) return deny('grenade did not start at the holder');
    if (client.grenades.size >= GRENADE_LIMIT || !withinFireRate(client, 'grenade', now)) return deny('too many grenades');
    g = { phase: d.phase, wireExpires: d.expiresAt, expiresAt: Math.min(d.expiresAt, now + GRENADE_FUSE_MS), held: pos, victims: new Set(), ...(teamMode(client.room) ? { round: d.round, life: d.life } : {}) };
    client.grenades.set(d.id, g);
  }
  g.phase = d.phase;
  if (d.phase === 'thrown') {
    g.pos = pos; g.vel = vel;
    const launched = d.thrownAt ?? now - Math.min(MAX_REWIND_MS, rttOf(client) / 2);
    g.thrownAt = Math.min(now, g.expiresAt, launched);
  }
  return { id: d.id, phase: d.phase, pos, vel, expiresAt: g.expiresAt, charged: true, ...(d.phase === 'thrown' ? { thrownAt: g.thrownAt } : {}), ...(teamMode(client.room) ? { round: g.round, life: g.life } : {}) };
}
function grenadeCanReach(g, at) {
  if (g.phase === 'armed') return len3(sub(at, g.held)) <= ORIGIN_SLACK;
  const flight = Math.max(0, (g.expiresAt - g.thrownAt) / 1000), delta = sub(at, g.pos);
  const horizontal = Math.hypot(g.vel[0], g.vel[2]) * flight + ORIGIN_SLACK;
  const vertical = Math.abs(g.vel[1]) * flight + 11 * flight * flight + ORIGIN_SLACK;
  return Math.hypot(delta[0], delta[2]) <= horizontal && Math.abs(delta[1]) <= vertical;
}

// A token bucket per weapon: enough to cover a burst, refilling at the rate the gun can actually
// fire. Stops a client claiming a hundred sniper hits in a second without punishing a shotgun for
// reporting ten pellets at once.
function withinFireRate(client, kind, now) {
  const a = ARMS[kind];
  const b = client.buckets[kind] || (client.buckets[kind] = { n: a.burst, t: now });
  b.n = Math.min(a.burst, b.n + ((now - b.t) / 1000) * a.rate); b.t = now;
  if (b.n < 1) return false;
  b.n -= 1; return true;
}

function resolveHit(client, m) {
  const room = client.room;
  if (!room) return deny('no room');
  const victim = room.members.get(m.to) || room.bots.get(m.to);
  if (!victim || victim === client) return deny('no such target');
  const launched = m.k === 'grenade' && client.grenades.get(m.gid);
  const lingeringGrenade = launched?.phase === 'thrown' ? launched : null;
  if (!combatGate(room, client, victim, m, lingeringGrenade)) return false;
  const arm = ARMS[m.k];
  if (!arm) return deny('unknown weapon');
  const dmg = Number(m.dmg);
  let damageCap = arm.max + 1;
  if (m.k === 'katana') {
    const charge = m.charge === undefined ? 0 : m.charge;
    if (!Number.isFinite(charge) || charge < 0 || charge > 1) return deny('invalid slash charge');
    damageCap = Math.round(arm.base * (1 + 2 * charge));
  }
  if (!(dmg > 0) || dmg > damageCap) return deny('damage out of range');
  const now = Date.now();
  const recordedGrenade = m.k === 'grenade' && m.gid != null;
  let grenade = null;
  if (recordedGrenade) {
    pruneGrenades(client, now);
    grenade = grenadeId(m.gid) && client.grenades.get(m.gid);
    if (!grenade) return deny('unknown grenade');
    if (now < grenade.expiresAt - Math.min(MAX_REWIND_MS, rttOf(client) + 100)) return deny('grenade has not exploded');
    if (grenade.victims.has(victim.id)) return deny('duplicate grenade hit');
  } else if (!withinFireRate(client, m.k, now)) return deny('firing too fast');

  // Wind the target back to the shooter's screen. Their own round trip sets how far, capped so a
  // player who lets their connection rot cannot reach ever further into the past.
  // Note what it is NOT: the flight time of the round. A claim is sent when the bullet lands, not
  // when it leaves, so the shooter's screen was already this far behind whatever it was aiming at.
  // Which is also why a client cannot buy anything by lying about `t` - it does not appear here.
  const rewind = Math.min(MAX_REWIND_MS, rttOf(client) + INTERP_MS);
  const seen = whereAt(victim, now - rewind);
  if (!seen) return deny('target never reported a position');
  if (!seen.alive) return deny('target already down');
  const target = [seen.x, seen.y, seen.z];
  // How long the round was in the air: zero unless the room is playing with ballistics, and capped
  // at what the gun could plausibly take to cross its own range.
  const rawT = Number(m.ft);
  const tof = rawT > 0 && arm.mv ? Math.min(rawT, Math.min(1, (arm.reach / arm.mv) * 1.5)) : 0;
  // Where the shooter was when they pulled the trigger. `hist` is stamped with arrival times, and a
  // sample arrives one upload trip after the moment it describes, so the moment the trigger went is
  // `now - tof` on this clock - and plain `now` for an instant shot, which is what it always was.
  const selfNow = whereAt(client, now - tof * 1000);

  if (m.k === 'grenade') {
    const at = vec3(m.at);
    if (!at) return deny('malformed claim');
    const c = [target[0], target[1] + 0.9, target[2]];
    if (len3(sub(at, c)) > arm.reach + HULL_R) return deny('outside the blast');
    if (grenade) {
      if (!grenadeCanReach(grenade, at)) return deny('blast outside grenade flight');
      if (grenade.blast && len3(sub(at, grenade.blast)) > 1) return deny('grenade blast moved');
      grenade.blast = at;
      grenade.victims.add(victim.id);
    } else if (selfNow && len3(sub(at, [selfNow.x, selfNow.y, selfNow.z])) > 45) return deny('blast nowhere near the thrower');
  } else if (m.k === 'katana') {
    if (!selfNow) return deny('shooter never reported a position');
    const gap = len3(sub([selfNow.x, selfNow.y + 0.9, selfNow.z], [target[0], target[1] + 0.9, target[2]]));
    if (gap > arm.reach) return deny('out of reach');
  } else {
    const o = vec3(m.o);
    if (!o) return deny('malformed claim');
    if (selfNow && len3(sub(o, [selfNow.x, selfNow.y + 0.9, selfNow.z])) > ORIGIN_SLACK) return deny('shot did not start at the shooter');
    const lo = [target[0], target[1] + HULL_LO, target[2]], hi = [target[0], target[1] + HULL_HI, target[2]];
    if (tof > 0) {
      // A round that fell on the way cannot be re-traced from here, so what gets checked is the
      // point the client says it landed on: it has to be on the figure where the rewind puts them,
      // and no further from the muzzle than the gun reaches.
      const p = vec3(m.p);
      if (!p) return deny('malformed claim');
      if (len3(sub(p, o)) > arm.reach + HULL_R) return deny('out of reach');
      if (pointSegDist2(p, lo, hi) > HULL_R * HULL_R) return deny('shot missed where they were');
    } else {
      const dir = vec3(m.d);
      if (!dir) return deny('malformed claim');
      const dl = len3(dir);
      if (dl < 1e-6) return deny('malformed claim');
      const unit = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
      const reach = Math.min(arm.reach, Math.max(1, Number(m.r) || arm.reach) + 2);
      if (raySegDist2(o, unit, reach, lo, hi) > HULL_R * HULL_R) return deny('shot missed where they were');
    }
  }

  shots.ok++;
  const from = grenade ? vec3(m.at) : selfNow ? [+selfNow.x.toFixed(1), +(selfNow.y + 0.9).toFixed(1), +selfNow.z.toFixed(1)] : null;
  const d = { amount: Math.round(dmg), from, by: client.id, crit: !!m.crit, src: m.k, ...(teamMode(room) ? { round: room.combat.round, life: room.actors.get(victim.id).life } : {}) };
  if (victim.bot) send(room.members.get(room.hostId), { t: 'm', tt: 'bdmg', from: client.id, d: { ...d, id: victim.id } });
  else send(victim, { t: 'm', tt: 'pdmg', from: client.id, d });
  return true;
}

const HOST_MESSAGES = new Set(['lobby', 'start', 'combatstate', 'end', 'score', 'backtolobby', 'clock', 'botps', 'bothit', 'botnade', 'botdead', 'botshots']);
function onMessage(client, raw) {
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  const room = client.room;

  switch (m.t) {
    case 'hello':
      client.name = String(m.name || '').slice(0, 14);
      send(client, { t: 'hello', id: client.id, max: MAX_PLAYERS, now: Date.now() });
      break;

    case 'name':
      client.name = String(m.name || '').slice(0, 14);
      if (room && room.hostId === client.id) room.hostName = client.name;
      break;

    case 'create': {
      leaveRoom(client);
      const want = m.code ? norm(m.code) : null;
      if (want && rooms.has(want)) { send(client, { t: 'error', for: 'create', message: 'that code is taken' }); break; }
      const r = makeRoom(want || freeCode(), client, { isPublic: m.isPublic, name: client.name, map: m.map, max: m.max });
      client.room = r; r.members.set(client.id, client);
      send(client, { t: 'created', code: r.code, id: client.id, hostId: r.hostId, isPublic: r.isPublic, max: r.max, members: roster(r) });
      break;
    }

    case 'alias': {
      // after a host transfer the lobby answers on a generation code; re-claim the code people know
      if (!room || room.hostId !== client.id) break;
      const c = norm(m.code);
      if (!c || (rooms.has(c) && rooms.get(c) !== room)) { send(client, { t: 'error', for: 'alias', message: 'that code is taken' }); break; }
      rooms.set(c, room); room.codes.add(c); room.code = c;
      send(client, { t: 'alias', code: c });
      toRoom(room, { t: 'roominfo', code: c }, client.id);
      break;
    }

    case 'join': {
      const r = resolveRoom(m.code);
      if (!r) { send(client, { t: 'error', for: 'join', message: 'no lobby with that code' }); break; }
      const res = joinRoom(client, r, m.meta);
      if (res.error) send(client, { t: 'error', for: 'join', message: res.error });
      else send(client, res);
      break;
    }

    case 'quick': {
      // the fullest lobby with room left, so players pile into one game instead of scattering
      let best = null;
      for (const r of new Set(rooms.values())) {
        if (!r.isPublic || !r.accepting || r.members.size >= r.max) continue;
        if (!best || r.members.size > best.members.size) best = r;
      }
      if (!best) { send(client, { t: 'error', for: 'quick', message: 'no open public lobbies' }); break; }
      const res = joinRoom(client, best, m.meta);
      if (res.error) send(client, { t: 'error', for: 'quick', message: res.error });
      else send(client, res);
      break;
    }

    case 'list':
      send(client, {
        t: 'list',
        rooms: [...new Set(rooms.values())].filter((r) => r.isPublic).map(roomInfo).sort((a, b) => b.players - a.players),
      });
      break;

    case 'state':
      if (!room || room.hostId !== client.id) break;
      if (typeof m.inMatch === 'boolean') room.inMatch = m.inMatch;
      if (typeof m.accepting === 'boolean') room.accepting = m.accepting;
      if (m.map) room.map = m.map;
      break;

    case 'kick': {
      if (!room || room.hostId !== client.id) break;
      const victim = room.members.get(m.id);
      if (!victim) break;
      send(victim, { t: 'closed', reason: m.reason || 'kicked' });
      leaveRoom(victim, m.reason || 'kicked');
      break;
    }

    case 'leave':
      leaveRoom(client);
      break;

    // A new socket claiming a seat that went quiet. The token was handed out over the seat's
    // original connection and is never relayed, so holding it is the proof of being the same
    // player - which matters, because the seat carries a score and possibly the host job.
    case 'resume': {
      const seat = clients.get(String(m.id || ''));
      const ok = seat && seat.gone && seat.room && seat.token && m.token === seat.token;
      if (!ok) { send(client, { t: 'error', for: 'resume', message: 'that seat is gone' }); break; }
      clearTimeout(seat.graceT); seat.graceT = null; seat.gone = 0;
      clients.delete(client.id);          // this socket arrived as a stranger; it is not one
      const old = seat.ws;
      seat.ws = client.ws; seat.seen = Date.now();
      bind(seat.ws, seat);
      if (old && old !== seat.ws) { try { old.close(); } catch (e) { /* already gone */ } }
      send(seat, {
        // the seat's token, not this socket's: the stranger record it arrived as has just been
        // thrown away, and the client has to keep holding the key to the seat it actually has
        t: 'resumed', token: seat.token, code: seat.room.code, id: seat.id, hostId: seat.room.hostId,
        isPublic: seat.room.isPublic, map: seat.room.map, inMatch: seat.room.inMatch,
        max: seat.room.max, members: roster(seat.room), combat: seat.room.combat,
      });
      toRoom(seat.room, { t: 'back', id: seat.id }, seat.id);
      break;
    }

    // a shot the shooter believes landed. Judged here, against where the target was on their
    // screen rather than where it is now - see the lag compensation section above.
    case 'hit':
      resolveHit(client, m);
      break;

    // game payload: the server does the routing the host used to do by hand
    case 'm': {
      if (!room) break;
      if (HOST_MESSAGES.has(m.tt) && client.id !== room.hostId) { deny('host message sent by guest'); break; }
      if (m.tt === 'bdmg') { deny('bdmg sent direct'); break; }
      if (m.tt === 'combatreq') { sendCombat(room, client); break; }
      if (m.tt === 'unshield') {
        const d = m.d, id = d?.id ?? client.id, a = room.actors.get(id);
        if (!teamMode(room) || room.combat?.phase !== 'live' || !a?.alive || d?.round !== room.combat.round || !Number.isSafeInteger(d?.life) || d.life !== a.life || (id !== client.id && !(client.id === room.hostId && a.bot))) { deny('invalid protection forfeiture'); break; }
        a.protectedUntil = 0; room.unshielded.set(id, a.life);
        send(room.members.get(room.hostId), { t: 'm', tt: 'unshield', from: client.id, d: { id, round: room.combat.round, life: a.life } });
        break;
      }
      if (m.tt === 'lobby' || m.tt === 'start') {
        if (!noteLobby(room, m.d)) break;
        const mode = m.d && m.d.mode;
        if (typeof mode === 'string' && mode !== room.mode) { clearCombat(room); room.mode = mode; }
      }
      // Targeted late-join starts are snapshots of the current match, not a new match.
      if (m.tt === 'start' && !m.to && !(m.d && m.d.late)) clearCombat(room);
      if (m.tt === 'combatstate') {
        const state = noteCombat(room, m.d); if (!state) break;
        m.d = state;
      }
      if (m.tt === 'end' && room.combat) room.combat.phase = 'over';
      if (m.tt === 'backtolobby') clearCombat(room);
      if (m.tt === 'bothit') {
        const bot = m.d && room.bots.get(m.d.id);
        if (!bot) { deny('unknown bot'); break; }
        resolveHit(bot, m.d); break;
      }
      if (m.tt === 'botps') {
        const bot = m.d && room.bots.get(m.d.id);
        if (bot && !combatMove(room, bot, m.d.round, m.d.life)) break;
        if (!bot || !noteMove(bot, m.d.ps, Date.now())) { deny('invalid bot position'); break; }
      }
      if (m.tt === 'botnade') {
        const bot = m.d && room.bots.get(m.d.id), packet = m.d && m.d.nade;
        if (!bot || !packet || !combatGate(room, bot, null, { ...packet, round: m.d.round }, bot.grenades.get(packet.id))) break;
        packet.round = m.d.round;
        const grenade = noteGrenade(bot, packet, Date.now()); if (!grenade) break;
        toRoom(room, { t: 'm', tt: 'nade', from: bot.id, d: { ...grenade, round: room.combat.round } }, client.id);
        break;
      }
      if (m.tt === 'nade' && teamMode(room) && !(m.d && m.d.charged === true)) { deny('unregistered team grenade'); break; }
      if (m.tt === 'nade' && m.d && m.d.charged === true) {
        if (!combatGate(room, client, null, m.d, client.grenades.get(m.d.id))) break;
        const grenade = noteGrenade(client, m.d, Date.now());
        if (!grenade) break;
        m.d = { ...grenade, ...(teamMode(room) ? { round: room.combat.round } : {}) };
      }
      // Damage is no longer something one player may simply announce to another. It arrives as a
      // claim and leaves as `pdmg` only if it survives resolveHit. The exception is the host, which
      // simulates the enemies in co-op and so is the only one that can say a bot hurt you - it is
      // already trusted with every enemy in the game.
      if (m.tt === 'pdmg' && (client.id !== room.hostId || teamMode(room))) { deny('pdmg sent direct'); break; }
      // The position feed is relayed as it always was, but read on the way past: this is what the
      // rewind is built from, stamped with the time it got here.
      if (m.tt === 'ps') {
        if (!combatMove(room, client, m.d?.[14], m.d?.[15])) break;
        noteMove(client, m.d, Date.now());
      }
      // Position and enemy snapshots describe the present and are worthless late; everything else
      // is an event that has to arrive. See WSConn.send for what that buys on a stalled link.
      const drop = m.tt === 'ps' || m.tt === 'esnap' || m.tt === 'botps';
      const out = JSON.stringify({ t: 'm', tt: m.tt, d: m.d, from: client.id });
      if (m.to) {
        const target = room.members.get(m.to);
        if (target && target.ws && !target.ws.closed) {
          target.ws.send(out, drop);
          if (m.tt === 'start' && m.d && m.d.late) sendCombat(room, target);
        }
        break;
      }
      if (m.relay || client.id === room.hostId) { for (const p of room.members.values()) if (p.id !== client.id && p.ws && !p.ws.closed) p.ws.send(out, drop); break; }
      const host = room.members.get(room.hostId);
      if (host && host.ws && !host.ws.closed) host.ws.send(out, drop);
      break;
    }

    case 'ping':
      send(client, { t: 'pong', d: m.d, now: Date.now() });
      break;

    // the answer to our own ping, which is how the rewind depth is measured
    case 'pong':
      if (typeof m.d === 'number') noteRtt(client, Date.now() - m.d);
      break;

    default: break;
  }
}

// ---------------------------------------------------------------- wiring
const server = http.createServer((req, res) => {
  if (req.url === '/lan/info') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    const inRooms = [...clients.values()].filter((c) => c.room);
    const pings = inRooms.map((c) => Math.round(rttOf(c)));
    res.end(JSON.stringify({
      port: PORT, addresses: localAddresses(), rooms: new Set(rooms.values()).size, players: clients.size,
      shots: { ...shots, rtt: pings.sort((a, b) => a - b) },
      // what the links themselves are doing, which is the first thing to look at when someone says
      // the game keeps dropping them: quiet seats waiting on a resume, and superseded state that
      // was skipped rather than queued behind a stalled socket
      links: {
        quiet: inRooms.filter((c) => c.gone).length,
        backlog: inRooms.map((c) => (c.gone ? -1 : c.ws.pending)).sort((a, b) => b - a).slice(0, 5),
        skipped: inRooms.reduce((n, c) => n + (c.ws.dropped || 0), 0),
      },
    }));
    return;
  }
  serveStatic(req, res);
});

server.on('upgrade', (req, socket) => {
  const url = (req.url || '').split('?')[0];
  if (url !== '/ws') { socket.destroy(); return; }
  const ws = handleUpgrade(req, socket);
  if (!ws) return;
  const client = {
    id: newId(), ws, name: '', room: null, meta: {}, seen: Date.now(), hist: [], rtt: [], buckets: {},
    token: crypto.randomBytes(12).toString('base64url'), gone: 0, graceT: null, grenades: new Map(),
  };
  clients.set(client.id, client);
  bind(ws, client);
  send(client, { t: 'hello', id: client.id, token: client.token, max: MAX_PLAYERS, now: Date.now() });
});

// Closing a laptop lid or dropping off the wifi sends no FIN, so TCP alone would hold that player's
// slot for minutes. Clients ping every few seconds; miss enough of them and we treat them as gone,
// which now means the seat goes quiet and is held for the grace period rather than freed outright.
//
// The second rule is the one that matters on a bad link. A socket can be open and useless: TCP
// retransmitting into a black hole with our writes stacking up behind it, for thirty seconds at a
// time. Waiting out SILENT_MS on that is half a minute of a frozen match. When the backlog is deep
// and nothing at all has come back, write the socket off - the client opens a new one and resumes
// into the same seat within a second or so, which is far less disruptive than riding out the stall.
const SILENT_MS = 20000;
const WEDGE_MS = 6000;
setInterval(() => {
  const now = Date.now();
  for (const c of clients.values()) {
    pruneGrenades(c, now);
    if (c.gone) continue;   // no socket to close; the grace timer is already counting
    const quiet = now - c.seen;
    if (quiet > SILENT_MS || (quiet > WEDGE_MS && c.ws.pending > WEDGE_BYTES)) c.ws.close();
  }
}, 2000).unref();

// Round trips, for the rewind. Only people in a room, and only while a match could be running:
// there is nothing to compensate for in a lobby. A second apart is fine - the floor of the last
// eight samples is what gets used, so this is looking for the shape of the connection, not a
// reading of this instant.
setInterval(() => {
  const now = Date.now();
  for (const c of clients.values()) if (c.room) send(c, { t: 'ping', d: now });
}, 1000).unref();

// The same numbers, handed back to the room for the scoreboard. Measured here rather than
// self-reported, so what a player reads on Tab is exactly what the rewind is working from and
// nobody can flatter their own connection. A quiet seat reports -1 rather than a stale reading.
setInterval(() => {
  for (const room of new Set(rooms.values())) {
    if (room.members.size < 2) continue;
    const p = {};
    for (const m of room.members.values()) p[m.id] = m.gone ? -1 : Math.round(rttOf(m));
    toRoom(room, { t: 'pings', p }, null, true);
  }
}, 1000).unref();

function localAddresses() {
  const out = [];
  // a sandbox can refuse the netlink socket this needs (systemd RestrictAddressFamilies, containers).
  // Nothing here is worth dropping a room full of players over, so an empty list is the answer.
  let ifaces;
  try { ifaces = os.networkInterfaces(); } catch (e) { return out; }
  for (const [iface, addrs] of Object.entries(ifaces || {})) {
    for (const a of addrs || []) {
      if (a.internal) continue;
      if (a.family === 'IPv6' && /^fe80:/i.test(a.address)) continue; // link-local needs a zone id browsers will not take
      out.push({ iface, family: a.family, address: a.address });
    }
  }
  // IPv4 first: it is what people can actually read out loud to each other
  return out.sort((a, b) => (a.family === b.family ? 0 : a.family === 'IPv4' ? -1 : 1));
}

server.listen(PORT, HOST, () => {
  const addrs = HOST ? [] : localAddresses();
  const url = (a) => (a.family === 'IPv6' ? `http://[${a.address}]:${PORT}` : `http://${a.address}:${PORT}`);
  console.log('\n  Doodle District — LAN server\n');
  console.log(`  on this machine   http://${HOST && HOST !== '127.0.0.1' ? HOST : 'localhost'}:${PORT}`);
  if (HOST) console.log(`  (bound to ${HOST} only — reachable through whatever proxies to it)`);
  else if (!addrs.length) console.log('  (no LAN address found — is this machine on a network?)');
  for (const a of addrs) console.log(`  on the LAN        ${url(a)}   [${a.iface} ${a.family}]`);
  console.log('\n  Others open one of the LAN links, or keep their own copy and type');
  console.log(`  the address into PLAY ONLINE → server. Ctrl+C to stop.\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`port ${PORT} is already in use — try: node server.js ${PORT + 1}`);
  else console.error(e.message);
  process.exit(1);
});
