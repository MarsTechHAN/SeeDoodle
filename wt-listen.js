// Optional WebTransport listener. `node server.js` stays WebSocket-only when this
// module, the native quiche binding, or TLS certificates are missing — that is
// the LAN promise. A 128-player deploy installs @fails-components/webtransport
// and points TLS_CERT / TLS_KEY at a certificate the browser will accept
// (or hands serverCertificateHashes to the tab).
//
// The adapter looks like WSConn so send() / sendBin() / bind() stay unchanged.
// Datagrams carry input and snapshots; a length-prefixed bidi stream carries
// lobby / chat / match events. Same wire bytes as WebSocket.

'use strict';
const fs = require('fs');

const MAX_FRAME = 1 << 20;

function readPem(value) {
  if (!value) return null;
  if (value.includes('-----BEGIN')) return value;
  try { return fs.readFileSync(value); } catch (e) { return null; }
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

class WTConn {
  constructor(session) {
    this.session = session;
    this.closed = false;
    this.pending = 0;
    this.dropped = 0;
    this.onmessage = null;
    this.onclose = null;
    this._dgramWriter = null;
    this._ctlWriter = null;
    this._ctlBuf = new Uint8Array(0);
  }
  async start() {
    await this.session.ready;
    try {
      this._dgramWriter = this.session.datagrams.writable.getWriter();
      this._pump(this.session.datagrams.readable.getReader(), (u8) => this._emit(u8, true));
    } catch (e) { this._dgramWriter = null; }
    this._acceptCtl();
    if (this.session.closed && this.session.closed.then) {
      this.session.closed.then(() => this._dead()).catch(() => this._dead());
    }
  }
  async _acceptCtl() {
    try {
      const incoming = this.session.incomingBidirectionalStreams;
      const reader = incoming.getReader ? incoming.getReader() : null;
      const stream = reader ? (await reader.read()).value : (await incoming[Symbol.asyncIterator]().next()).value;
      if (!stream) return;
      this._ctlWriter = stream.writable.getWriter();
      this._pump(stream.readable.getReader(), (chunk) => this._feedCtl(chunk));
    } catch (e) { /* session died before a control stream */ }
  }
  _feedCtl(chunk) {
    this._ctlBuf = concat(this._ctlBuf, chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    while (this._ctlBuf.length >= 4) {
      const n = new DataView(this._ctlBuf.buffer, this._ctlBuf.byteOffset, this._ctlBuf.byteLength).getUint32(0, true);
      if (n > MAX_FRAME) { this.close(); return; }
      if (this._ctlBuf.length < 4 + n) break;
      const payload = this._ctlBuf.subarray(4, 4 + n);
      this._ctlBuf = this._ctlBuf.subarray(4 + n);
      this._emit(payload, payload.length > 0 && payload[0] === 0xD1);
    }
  }
  _emit(payload, binary) {
    if (!this.onmessage) return;
    if (binary) this.onmessage(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
    else this.onmessage(new TextDecoder().decode(payload));
  }
  async _pump(reader, fn) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) fn(value);
      }
    } catch (e) { /* closed */ }
    this._dead();
  }
  _frame(bytes) {
    const out = new Uint8Array(4 + bytes.length);
    new DataView(out.buffer).setUint32(0, bytes.length, true);
    out.set(bytes, 4);
    return out;
  }
  send(str) {
    if (this.closed || !this._ctlWriter) return;
    const bytes = new TextEncoder().encode(str);
    this._ctlWriter.write(this._frame(bytes)).catch(() => this._dead());
  }
  sendBin(buf, droppable) {
    if (this.closed) return;
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (this._dgramWriter) {
      this._dgramWriter.write(u8).catch(() => { this._dgramWriter = null; });
      return;
    }
    if (droppable && !this._ctlWriter) { this.dropped++; return; }
    if (this._ctlWriter) this._ctlWriter.write(this._frame(u8)).catch(() => this._dead());
  }
  _dead() {
    if (this.closed) return;
    this.closed = true;
    try { this.session.close(); } catch (e) { /* already gone */ }
    if (this.onclose) this.onclose();
  }
  close() { this._dead(); }
}

async function acceptSessions(h3, onConn) {
  const stream = await h3.sessionStream('/wt');
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const conn = new WTConn(value);
    try { await conn.start(); } catch (e) { continue; }
    onConn(conn);
  }
}

module.exports = function attachWebTransport(httpServer, opts) {
  const cert = readPem(process.env.TLS_CERT), key = readPem(process.env.TLS_KEY);
  if (!cert || !key) {
    console.log('  WebTransport      skipped (set TLS_CERT / TLS_KEY to enable)\n');
    return null;
  }
  let Http3Server;
  try { ({ Http3Server } = require('@fails-components/webtransport')); }
  catch (e) {
    console.log('  WebTransport      skipped (@fails-components/webtransport not installed)\n');
    return null;
  }
  const port = (opts && opts.port) || 8080;
  const server = new Http3Server({ port, host: (opts && opts.host) || '::', secret: 'doodle', cert, privKey: key });
  server.startServer();
  if (typeof opts.accept === 'function') {
    acceptSessions(server, opts.accept).catch((e) => console.error('  WebTransport      session loop:', e.message));
  }
  console.log('  WebTransport      /wt on UDP ' + port + '\n');
  return server;
};
