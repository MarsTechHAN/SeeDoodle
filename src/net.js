// Networking over a plain WebSocket to the LAN server in ../server.js.
//
// This used to be WebRTC peer-to-peer through a public signalling service, which needs the
// internet and tends to fall over on a closed network (STUN unreachable, mDNS candidates blocked,
// NAT hairpinning). Now one machine runs the server and everyone talks to it: rooms live there,
// and it does the message routing the host used to do by hand.
//
// The public shape of this class is deliberately unchanged from the peer-to-peer version, so the
// game code above it did not have to be rewritten: one host per room is still the authority, and
// send/broadcast/sendTo still mean "to everyone", "to everyone but me", "to one player".

import { WIRE, KIND, encodePs, encodeBotPs, encodeInput, decodePacket } from './wire.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const WIRE_STALE = 'reload — the wire format changed';
export const makeCode = () => Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

const DEFAULT_PORT = 8080;
const OPEN_TIMEOUT = 8000, REQ_TIMEOUT = 12000;
// A socket that closes mid-match is usually the network hiccuping, not the player leaving, so we
// go back for the seat the server is holding. Rising gaps because the first two attempts cost
// nothing and a link that is still down after ten seconds is not coming back this second either.
const RETRY_MS = [200, 400, 900, 1800, 3000, 4000];

// The room server is whichever machine served this page. There is nothing to configure: you opened
// somebody's link, so they are the server, and everyone who opened the same link lands together.
function serverURL() {
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
    return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
  }
  return `ws://localhost:${DEFAULT_PORT}/ws`;
}

function concatU8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

// Same framing as wt-listen.js: 4-byte length + payload on the control stream,
// raw datagrams for droppable binary. Looks like a WebSocket to Net.
async function wtSocket(wt) {
  const ctl = await wt.createBidirectionalStream();
  const ctlWriter = ctl.writable.getWriter();
  let dgramWriter = null;
  try { dgramWriter = wt.datagrams.writable.getWriter(); } catch (e) { dgramWriter = null; }
  const sock = {
    readyState: 1,
    binaryType: 'arraybuffer',
    onmessage: null,
    onclose: null,
    onerror: null,
    path: (!dgramWriter || wt.reliability === 'reliable-only') ? 'webtransport-reliable' : 'webtransport',
    send(data) {
      if (typeof data === 'string') {
        const bytes = new TextEncoder().encode(data);
        const frame = new Uint8Array(4 + bytes.length);
        new DataView(frame.buffer).setUint32(0, bytes.length, true);
        frame.set(bytes, 4);
        ctlWriter.write(frame).catch(() => sock.close());
        return;
      }
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (dgramWriter && sock.path === 'webtransport') {
        dgramWriter.write(u8).catch(() => { dgramWriter = null; sock.path = 'webtransport-reliable'; });
        return;
      }
      const frame = new Uint8Array(4 + u8.length);
      new DataView(frame.buffer).setUint32(0, u8.length, true);
      frame.set(u8, 4);
      ctlWriter.write(frame).catch(() => sock.close());
    },
    close() {
      if (sock.readyState === 3) return;
      sock.readyState = 3;
      try { wt.close(); } catch (e) { /* already gone */ }
      if (sock.onclose) sock.onclose();
    },
  };
  const emit = (payload, binary) => {
    if (!sock.onmessage) return;
    sock.onmessage({ data: binary ? payload : new TextDecoder().decode(payload) });
  };
  const pumpCtl = async () => {
    const reader = ctl.readable.getReader();
    let buf = new Uint8Array(0);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf = concatU8(buf, value instanceof Uint8Array ? value : new Uint8Array(value));
        while (buf.length >= 4) {
          const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
          if (buf.length < 4 + n) break;
          const payload = buf.subarray(4, 4 + n);
          buf = buf.subarray(4 + n);
          emit(payload, payload.length > 0 && payload[0] === 0xD1);
        }
      }
    } catch (e) { /* closed */ }
    sock.close();
  };
  pumpCtl();
  if (dgramWriter) {
    (async () => {
      try {
        const reader = wt.datagrams.readable.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) emit(value.buffer ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value, true);
        }
      } catch (e) { /* closed */ }
    })();
  }
  return sock;
}

export class Net {
  constructor() {
    this.sock = null; this.url = null; this.conns = new Map(); this.isHost = false;
    this.id = null; this.code = null; this.hostId = null; this.aliasCode = null;
    this.handlers = new Map(); this.connected = false;
    this.onPeerJoin = null; this.onPeerLeave = null; this.onDisconnect = null; this.onAlias = null; this.onHostChange = null;
    this.onStall = null; this.onPeerStall = null;
    this.maxPlayers = 32; this._accepting = true; this._inMatch = false; this._hostName = '';
    this.stats = { sent: 0, recv: 0 }; this.isPublic = false;
    this._waits = new Map(); this._waitSeq = 0; this._pingT = null; this.rtt = 0;
    this.token = null; this.resuming = false; this._resumeSeat = null; this._meta = {}; this.pings = {};
    this._serverOffset = Date.now() - performance.now(); this._serverLast = 0; this._clockReady = false; this._clockSamples = [];
    // 'local' in solo, a peer id while a host owns the room, 'server' in battlefield.
    this.authority = null; this.path = 'offline'; this.battlefieldMax = 128;
    this._seq = 0; this._ack = 0; this._ackBits = 0; this._pred = []; this._inTick = 0;
    this._wt = null; this._wtWrite = null;
  }
  owns(what = 'sim') {
    if (this.authority === 'server') return what === 'server';
    if (!this.connected) return true;
    return this.isHost;
  }
  resetPrediction() { this._pred.length = 0; this._inTick = 0; }
  // A fuse must keep running across frame stalls, sleep and wall-clock adjustments. Server time
  // gives every peer the same deadline; performance.now keeps local countdowns monotonic.
  serverNow() { return this._serverLast = Math.max(this._serverLast, performance.now() + this._serverOffset); }
  _syncClock(now, rtt = null) {
    if (!Number.isFinite(now)) return;
    const offset = now + (rtt || 0) / 2 - performance.now();
    if (!this._clockReady) { this._serverOffset = offset; this._serverLast = 0; this._clockReady = true; }
    if (rtt === null || !Number.isFinite(rtt) || rtt < 0 || rtt > 5000) return;
    this._clockSamples.push({ rtt, offset }); if (this._clockSamples.length > 8) this._clockSamples.shift();
    this._serverOffset = this._clockSamples.reduce((a, b) => a.rtt <= b.rtt ? a : b).offset;
  }
  get active() { return !!this.sock && this.connected; }
  get peerIds() { return [...this.conns.keys()]; }
  on(type, fn) { this.handlers.set(type, fn); }
  _emit(type, data, from) { const h = this.handlers.get(type); if (h) h(data, from); }

  // the host advertises these three to the server so the lobby list stays honest
  get accepting() { return this._accepting; }
  set accepting(v) { this._accepting = !!v; this._pushState(); }
  get inMatch() { return this._inMatch; }
  set inMatch(v) { this._inMatch = !!v; this._pushState(); }
  get hostName() { return this._hostName; }
  set hostName(v) { this._hostName = v; if (this.sock && this.sock.readyState === 1) this._raw({ t: 'name', name: v }); }
  _pushState() { if (this.isHost && this.sock && this.sock.readyState === 1) this._raw({ t: 'state', accepting: this._accepting, inMatch: this._inMatch }); }

  // ---- transport ----
  _raw(obj) { const s = this.sock; if (s && s.readyState === 1) s.send(JSON.stringify(obj)); }
  _bin(buf) { const s = this.sock; if (s && s.readyState === 1) s.send(buf); }
  _live(sock, path) {
    this.sock = sock;
    sock.binaryType = 'arraybuffer';
    sock.onmessage = (ev) => this._onMessage(ev.data);
    sock.onclose = () => this._onClose();
    sock.onerror = () => { /* onclose always follows */ };
    this.path = path || 'websocket';
    this._raw({ t: 'ping', d: performance.now() });
    this._pingT = setInterval(() => this._raw({ t: 'ping', d: performance.now() }), 5000);
    if (this._hostName) this._raw({ t: 'name', name: this._hostName });
  }
  async _openWebTransport() {
    // HTTPS-only, and the server has to be listening. A LAN `http://` page stays on WebSocket.
    // One session owns both JSON and binary — opening this beside a WebSocket gave every tab two
    // seats and two hello ids.
    if (typeof WebTransport === 'undefined' || typeof location === 'undefined' || location.protocol !== 'https:') return null;
    const wt = new WebTransport(`${location.protocol}//${location.host}/wt`);
    const ready = wt.ready.then(() => true, () => false);
    const ok = await Promise.race([ready, new Promise((r) => setTimeout(() => r(false), 1500))]);
    if (!ok) { try { wt.close(); } catch (e) { /* ignore */ } return null; }
    const sock = await wtSocket(wt);
    this._wt = wt;
    return sock;
  }
  _close() {
    clearInterval(this._pingT); this._pingT = null;
    if (this._wt) { try { this._wt.close(); } catch (e) { /* already gone */ } this._wt = null; this._wtWrite = null; }
    const s = this.sock; this.sock = null;
    if (s && s.readyState === 1) { try { s.close(); } catch (e) { /* ignore */ } }
    for (const [, w] of this._waits) w.reject(new Error('disconnected from the server'));
    this._waits.clear();
  }
  async _ensure() {
    if (this.sock && this.sock.readyState === 1) return;
    if (this._opening) return this._opening;
    if (!this.url) this.url = serverURL();
    this._close();
    this._opening = (async () => {
      // WebSocket first. This page is often behind an nginx TLS terminator that cannot
      // speak WebTransport; trying WT first either waits 1.5s or, worse, "connects" to
      // an HTTP/3 edge that is not the room and then looks like a lost server.
      let wsErr;
      try {
        await new Promise((resolve, reject) => {
          let sock;
          try { sock = new WebSocket(this.url); } catch (e) { reject(new Error('the server is not reachable')); return; }
          const timer = setTimeout(() => { try { sock.close(); } catch (e) { /* ignore */ } reject(new Error('the server did not answer')); }, OPEN_TIMEOUT);
          sock.onopen = () => {
            clearTimeout(timer);
            this._live(sock, 'websocket');
            resolve();
          };
          sock.onerror = () => { clearTimeout(timer); reject(new Error('could not reach the server')); };
          sock.onclose = () => { clearTimeout(timer); reject(new Error('could not reach the server')); };
        });
        return;
      } catch (e) { wsErr = e; }
      try {
        const wt = await this._openWebTransport();
        if (wt) {
          this._live(wt, wt.path);
          return;
        }
      } catch (e) { /* WS error is the one the player can act on */ }
      throw wsErr || new Error('could not reach the server');
    })().finally(() => { this._opening = null; });
    return this._opening;
  }
  _onClose() {
    this.sock = null; clearInterval(this._pingT); this._pingT = null;
    for (const [, w] of this._waits) w.reject(new Error('lost the connection to the server'));
    this._waits.clear();
    if (!this.connected) return;
    // Not a departure - a hiccup, until proven otherwise. The server holds the seat for a few
    // seconds, so keep the match standing and go back for it. `connected` deliberately stays true:
    // the game above carries on simulating and its sends no-op until there is a socket again.
    if (this.resuming) return;
    this.resuming = true;
    // Each replacement socket receives a new hello id; retries must keep claiming the original seat.
    this._resumeSeat = { id: this.id, token: this.token, code: this.code };
    if (this.onStall) this.onStall(true);
    this._retry(0);
  }
  // Try the held seat first, then a plain rejoin of the same room (which is what is left when the
  // grace period ran out and somebody else was promoted), then wait and try again.
  async _retry(n) {
    if (!this.resuming) return;
    if (n >= RETRY_MS.length) { this._giveUp('lost the connection to the server'); return; }
    await new Promise((r) => setTimeout(r, RETRY_MS[n]));
    if (!this.resuming) return;
    const seat = this._resumeSeat;
    try { await this._ensure(); } catch (e) { this._retry(n + 1); return; }
    if (!this.resuming) return;
    try {
      const res = await this._request({ t: 'resume', id: seat.id, token: seat.token }, 'resume', 6000);
      this._back(res, res.hostId === (res.id || this.id));
      return;
    } catch (e) { /* the seat is gone; get back in the ordinary way */ }
    if (!this.resuming) return;
    if (!seat.code) { this._giveUp('lost the connection to the server'); return; }
    try {
      const res = await this._request({ t: 'join', code: seat.code, name: this._hostName, meta: { ...this._meta, prev: seat.id } }, 'join');
      this._back(res, res.hostId === (res.id || this.id));
    } catch (e) { this._retry(n + 1); }
  }
  _back(res, isHost) {
    const oldHost = this.hostId, wasHost = this.isHost;
    this._adopt(res, isHost);
    this.resuming = false; this._resumeSeat = null;
    if (oldHost !== this.hostId && this.onHostChange) this.onHostChange(this.hostId, this.isHost && !wasHost);
    if (this.onStall) this.onStall(false, res);
  }
  _giveUp(msg) {
    this.resuming = false; this._resumeSeat = null;
    if (this.onStall) this.onStall(false);
    this.connected = false; this.conns.clear();
    if (this.onDisconnect) this.onDisconnect(msg);
  }
  // one in-flight request per kind; the reply carries `for` so it can be matched back
  _request(msg, kind, timeoutMs = REQ_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const key = kind + ':' + (++this._waitSeq);
      const timer = setTimeout(() => { this._waits.delete(key); reject(new Error('the server did not answer')); }, timeoutMs);
      this._waits.set(key, {
        kind,
        resolve: (v) => { clearTimeout(timer); this._waits.delete(key); resolve(v); },
        reject: (e) => { clearTimeout(timer); this._waits.delete(key); reject(e); },
      });
      this._raw(msg);
    });
  }
  _settle(kind, err, val) {
    for (const [key, w] of this._waits) {
      if (w.kind !== kind) continue;
      this._waits.delete(key);
      if (err) w.reject(err); else w.resolve(val);
      return true;
    }
    return false;
  }

  _noteAck(seq) {
    if (!Number.isInteger(seq)) return;
    const delta = (seq - this._ack + 65536) % 65536;
    if (delta === 0 || delta > 32) { if (seq !== this._ack) { this._ack = seq; this._ackBits = 0; } return; }
    this._ackBits = ((this._ackBits << delta) | (1 << (delta - 1))) >>> 0;
    this._ack = seq;
  }
  _onBinary(raw) {
    const msg = decodePacket(raw);
    if (!msg) return;
    this.stats.recv++;
    if (msg.seq != null) this._noteAck(msg.seq);
    if (msg.kind === KIND.PS) this._emit('ps', msg.d, msg.from);
    else if (msg.kind === KIND.BOTPS) this._emit('botps', { id: msg.id, ps: msg.ps, round: msg.round, life: msg.life, nearby: !!msg.nearby }, msg.from);
    else if (msg.kind === KIND.NEARBY) {
      if (msg.id && msg.id !== msg.from) this._emit('botps', { id: msg.id, ps: msg.d, nearby: true }, msg.from);
      else this._emit('nearby', msg.d, msg.from);
    } else if (msg.kind === KIND.SNAP) this._emit('snap', msg, msg.from);
  }
  _onMessage(raw) {
    if (typeof raw !== 'string') { this._onBinary(raw); return; }
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    this.stats.recv++;
    switch (m.t) {
      case 'hello':
        if (m.wire !== WIRE) { this._close(); this._giveUp(WIRE_STALE); break; }
        this.id = m.id; if (m.token) this.token = m.token; if (m.max) this.maxPlayers = m.max;
        if (m.battlefieldMax) this.battlefieldMax = m.battlefieldMax;
        if (m.path && this.path === 'offline') this.path = m.path;
        this._syncClock(m.now); break;
      case 'created': this._settle('create', null, m); break;
      case 'joined': this._settle('join', null, m) || this._settle('quick', null, m); break;
      case 'resumed': this._settle('resume', null, m); break;
      // somebody else's link went quiet. Their seat is being held, so leave the figure standing
      // and say so rather than tearing them out of the match over a couple of dropped packets.
      case 'stall': if (this.onPeerStall) this.onPeerStall(m.id, true); break;
      case 'back': if (this.onPeerStall) this.onPeerStall(m.id, false); break;
      case 'list': this._settle('list', null, m.rooms || []); break;
      case 'alias':
        this.aliasCode = m.code; this.code = m.code;
        if (this.onAlias) this.onAlias(m.code);
        break;
      case 'roominfo': if (m.code) { this.code = m.code; this.aliasCode = m.code; } break;
      case 'error': {
        const err = new Error(m.message || 'the server refused that');
        if (!this._settle(m.for || '', err)) this._emit('refused', { reason: err.message });
        break;
      }
      case 'peer':
        if (!this.connected) break;
        this.conns.set(m.id, this._conn(m.id));
        if (this.isHost && this.onPeerJoin) this.onPeerJoin(m.id, m.meta || {});
        break;
      case 'gone':
        if (!this.conns.has(m.id)) break;
        this.conns.delete(m.id);
        if (this.isHost) { if (this.onPeerLeave) this.onPeerLeave(m.id); }
        else this._emit('leave', { id: m.id });
        break;
      case 'host': {
        const wasHost = this.isHost;
        this.hostId = m.id; this.isHost = m.id === this.id;
        if (m.code) this.code = m.code;
        this.conns.delete(this.id);
        if (this.onHostChange) this.onHostChange(m.id, this.isHost && !wasHost);
        break;
      }
      case 'closed':
        this.connected = false; this.conns.clear();
        if (this.onDisconnect) this.onDisconnect(m.reason || '');
        break;
      case 'm': this._emit(m.tt, m.d, m.from); break;
      // the server times our round trip itself so it knows how far to rewind the world when it
      // judges a shot; all this end has to do is answer, echoing its clock back untouched
      case 'ping': this._raw({ t: 'pong', d: m.d }); break;
      case 'pong':
        if (Number.isFinite(m.d)) { const rtt = performance.now() - m.d; this.rtt = Math.round(rtt); this._syncClock(m.now, rtt); }
        break;
      // everyone's round trip as the server measures it; -1 is a seat whose link is quiet
      case 'pings': this.pings = m.p || {}; break;
      default: break;
    }
  }
  // main.js closes a silent player's connection by hand; with a server that is a kick
  _conn(id) { return { peer: id, open: true, close: () => this._raw({ t: 'kick', id, reason: 'lost connection' }) }; }
  _adopt(res, isHost) {
    this.connected = true; this.isHost = isHost;
    this.id = res.id || this.id; this.hostId = res.hostId; this.code = res.code; this.aliasCode = res.code;
    // a resumed seat keeps its own key: the `hello` on this socket was addressed to the stranger
    // it arrived as, and that record is gone
    if (res.token) this.token = res.token;
    this.isPublic = !!res.isPublic; if (res.max) this.maxPlayers = res.max;
    this.conns.clear(); this.pings = {};
    for (const p of res.members || []) if (p.id !== this.id) this.conns.set(p.id, this._conn(p.id));
    this._pushState();
  }

  // ---- lobby creation / joining ----
  async host({ isPublic = false, code = null } = {}) {
    this.leave();
    await this._ensure();
    const res = await this._request({ t: 'create', code, isPublic, name: this._hostName, max: this.maxPlayers }, 'create');
    this._adopt(res, true);
    this._accepting = true; this._pushState();
    return this.code;
  }
  async join(code, meta = {}, wantId = null) {
    this.leave();
    code = String(code || '').trim().toUpperCase();
    if (!code) throw new Error('enter a lobby code');
    await this._ensure();
    this._meta = meta || {};
    const res = await this._request({ t: 'join', code, name: meta.name || this._hostName, meta }, 'join');
    this._adopt(res, res.hostId === (res.id || this.id));
    return this.code;
  }
  async quickJoin(meta = {}, onStatus = null) {
    this.leave();
    await this._ensure();
    if (onStatus) onStatus('looking for an open lobby…');
    this._meta = meta || {};
    const res = await this._request({ t: 'quick', name: meta.name || this._hostName, meta }, 'quick');
    this._adopt(res, res.hostId === (res.id || this.id));
    return this.code;
  }
  async listLobbies(meta = {}, onStatus = null) {
    if (this.active) throw new Error('leave the lobby first');
    await this._ensure();
    if (onStatus) onStatus('looking…');
    return await this._request({ t: 'list' }, 'list', 8000);
  }
  // the room keeps answering on the code people already know
  claimAlias(code) {
    if (!this.isHost || !code) return;
    this._raw({ t: 'alias', code: String(code).toUpperCase() });
  }
  leave() {
    this.resuming = false; this._resumeSeat = null;   // whatever we were going back for, we no longer want it
    if (this.sock && this.sock.readyState === 1 && this.connected) this._raw({ t: 'leave' });
    this.connected = false; this.isHost = false; this.conns.clear();
    this.code = null; this.hostId = null; this.aliasCode = null; this._inMatch = false;
    this.authority = null; this.resetPrediction();
  }
  disconnect() { this.leave(); this._close(); }

  // ---- messaging ----
  // host: to everyone; client: to the host, and on to everyone if relay is set
  send(type, data, relay = false) {
    if (!this.connected) return;
    this.stats.sent++;
    if (type === 'ps') { this._bin(encodePs(data)); return; }
    if (type === 'botps') { this._bin(encodeBotPs(data)); return; }
    this._raw({ t: 'm', tt: type, d: data, relay: !!relay });
  }
  sendInput(frames, firstTick) {
    if (!this.connected) return;
    this.stats.sent++;
    this._seq = (this._seq + 1) & 0xffff;
    this._bin(encodeInput(frames, firstTick, this._seq, this._ack, this._ackBits));
  }
  broadcast(type, data) { this.send(type, data, true); }
  sendTo(pid, type, data) {
    if (!this.connected) return;
    this.stats.sent++;
    this._raw({ t: 'm', tt: type, d: data, to: pid });
  }
  // A shot we believe landed. This is a claim, not damage: the server rewinds the target to where
  // it was on our screen and decides. It used to be `sendTo(id, 'pdmg')`, which the other end
  // simply believed, and which the server now refuses to carry.
  hit(pid, claim) {
    if (!this.connected) return;
    this.stats.sent++;
    this._raw({ t: 'hit', to: pid, ...claim });
  }
}
