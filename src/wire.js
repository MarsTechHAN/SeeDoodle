// Quantized position packets for the existing `ps` / `botps` feed. The game layer still
// sees the encodeLocal() array; this file is only the bytes on the socket.
//
// Version the packet so a tab from before this format is refused instead of painting
// everyone at the origin. Bump WIRE when the layout changes.

export const WIRE = 1;
export const MAGIC = 0xD1;
export const KIND = { PS: 1, BOTPS: 2, NEARBY: 3, INPUT: 4, SNAP: 5 };
export const TIER = { VISIBLE: 0, NEARBY: 1 };
// 10 frames was a third of a second and a 64-player hitch would jump the replay.
export const INPUT_WINDOW = 32;

const te = new TextEncoder();
const td = new TextDecoder();
const PI2 = Math.PI * 2;

function wrapPi(a) {
  a = ((a + Math.PI) % PI2 + PI2) % PI2;
  return a - Math.PI;
}
const clamp16 = (n) => (n < -32768 ? -32768 : n > 32767 ? 32767 : n);
const q = (v, scale) => clamp16(Math.round(Number(v) * scale) | 0);

function writeStr(view, offset, text) {
  const bytes = te.encode(String(text || '').slice(0, 96));
  view.setUint8(offset, bytes.length);
  new Uint8Array(view.buffer, view.byteOffset + offset + 1, bytes.length).set(bytes);
  return offset + 1 + bytes.length;
}
function readStr(view, offset) {
  const n = view.getUint8(offset);
  const s = td.decode(new Uint8Array(view.buffer, view.byteOffset + offset + 1, n));
  return { s, offset: offset + 1 + n };
}

// encodeLocal() is cm / 0.01 rad / 0.1 m/s. Same steps, packed.
function writePose(view, offset, d) {
  const hook = !!(d[6] & 128) && d.length >= 14;
  const life = Number.isSafeInteger(d[14]) && Number.isSafeInteger(d[15]);
  let bits = 0;
  if (hook) bits |= 1;
  if (life) bits |= 2;
  view.setUint8(offset, bits);
  view.setInt16(offset + 1, q(d[0], 100), true);
  view.setInt16(offset + 3, q(d[1], 100), true);
  view.setInt16(offset + 5, q(d[2], 100), true);
  view.setInt16(offset + 7, q(wrapPi(d[3]), 1000), true);
  view.setInt16(offset + 9, q(d[4], 1000), true);
  view.setUint8(offset + 11, d[5] & 255);
  view.setUint16(offset + 12, d[6] & 0xffff, true);
  view.setUint8(offset + 14, Math.max(0, Math.min(255, Math.round(d[7]) | 0)));
  view.setInt16(offset + 15, q(d[8], 10), true);
  view.setInt16(offset + 17, q(d[9], 10), true);
  view.setInt16(offset + 19, q(d[10], 10), true);
  let o = offset + 21;
  if (hook) {
    view.setInt16(o, q(d[11], 10), true);
    view.setInt16(o + 2, q(d[12], 10), true);
    view.setInt16(o + 4, q(d[13], 10), true);
    o += 6;
  }
  if (life) {
    view.setUint16(o, d[14] & 0xffff, true);
    view.setUint16(o + 2, d[15] & 0xffff, true);
    o += 4;
  }
  return o;
}
function readPose(view, offset) {
  const bits = view.getUint8(offset);
  const hook = !!(bits & 1), life = !!(bits & 2);
  const d = [
    view.getInt16(offset + 1, true) / 100,
    view.getInt16(offset + 3, true) / 100,
    view.getInt16(offset + 5, true) / 100,
    view.getInt16(offset + 7, true) / 1000,
    view.getInt16(offset + 9, true) / 1000,
    view.getUint8(offset + 11),
    view.getUint16(offset + 12, true),
    view.getUint8(offset + 14),
    view.getInt16(offset + 15, true) / 10,
    view.getInt16(offset + 17, true) / 10,
    view.getInt16(offset + 19, true) / 10,
  ];
  let o = offset + 21;
  if (hook) {
    d.push(view.getInt16(o, true) / 10, view.getInt16(o + 2, true) / 10, view.getInt16(o + 4, true) / 10);
    o += 6;
  }
  if (life) {
    while (d.length < 14) d.push(0);
    d.push(view.getUint16(o, true), view.getUint16(o + 2, true));
    o += 4;
  }
  return { d, offset: o };
}

function headerBytes(from) {
  return 3 + 1 + (from ? te.encode(String(from).slice(0, 96)).length : 0);
}

export function encodePs(d, from = '') {
  const hook = !!(d[6] & 128) && d.length >= 14;
  const life = Number.isSafeInteger(d[14]) && Number.isSafeInteger(d[15]);
  const buf = new ArrayBuffer(headerBytes(from) + 21 + (hook ? 6 : 0) + (life ? 4 : 0));
  const view = new DataView(buf);
  view.setUint8(0, MAGIC); view.setUint8(1, WIRE); view.setUint8(2, KIND.PS);
  const o = writeStr(view, 3, from);
  writePose(view, o, d);
  return buf;
}

export function encodeBotPs(data, from = '') {
  const d = data.ps, id = data.id;
  const hook = !!(d[6] & 128) && d.length >= 14;
  const life = Number.isSafeInteger(data.round) && Number.isSafeInteger(data.life);
  const idBytes = te.encode(String(id || '').slice(0, 96));
  const buf = new ArrayBuffer(headerBytes(from) + 1 + idBytes.length + 21 + (hook ? 6 : 0) + (life ? 4 : 0));
  const view = new DataView(buf);
  view.setUint8(0, MAGIC); view.setUint8(1, WIRE); view.setUint8(2, KIND.BOTPS);
  let o = writeStr(view, 3, from);
  o = writeStr(view, o, id);
  const pose = Array.isArray(d) ? d.slice() : [];
  if (life) { while (pose.length < 14) pose.push(0); pose[14] = data.round; pose[15] = data.life; }
  writePose(view, o, pose);
  return buf;
}

// Nearby: 1 m, no aim / weapon / health. Enough to place a footstep and prime
// the interpolator; worthless to aim with. `id` is set for a host bot.
export function encodeNearby(d, from = '', id = '') {
  const flags = (Number(d[6]) || 0) & ~(8 | 32);
  const buf = new ArrayBuffer(headerBytes(from) + 1 + te.encode(String(id || '').slice(0, 96)).length + 8);
  const view = new DataView(buf);
  view.setUint8(0, MAGIC); view.setUint8(1, WIRE); view.setUint8(2, KIND.NEARBY);
  let o = writeStr(view, 3, from);
  o = writeStr(view, o, id);
  view.setInt16(o, q(d[0], 1), true);
  view.setInt16(o + 2, q(d[1], 1), true);
  view.setInt16(o + 4, q(d[2], 1), true);
  view.setUint16(o + 6, flags & 0xffff, true);
  return buf;
}

export function writeHeader(view, offset, seq, ack, ackBits) {
  view.setUint16(offset, seq & 0xffff, true);
  view.setUint16(offset + 2, ack & 0xffff, true);
  view.setUint32(offset + 4, ackBits >>> 0, true);
  return offset + 8;
}
export function readHeader(view, offset) {
  return {
    seq: view.getUint16(offset, true),
    ack: view.getUint16(offset + 2, true),
    ackBits: view.getUint32(offset + 4, true),
    offset: offset + 8,
  };
}

export function encodeInput(frames, firstTick, seq, ack, ackBits, from = '') {
  const n = Math.max(0, Math.min(INPUT_WINDOW, frames.length));
  const buf = new ArrayBuffer(headerBytes(from) + 8 + 2 + 1 + n * 6);
  const view = new DataView(buf);
  view.setUint8(0, MAGIC); view.setUint8(1, WIRE); view.setUint8(2, KIND.INPUT);
  let o = writeStr(view, 3, from);
  o = writeHeader(view, o, seq, ack, ackBits);
  view.setUint16(o, firstTick & 0xffff, true); view.setUint8(o + 2, n); o += 3;
  for (let i = 0; i < n; i++) {
    const bits = frames[i];
    view.setUint32(o, Number(bits & 0xffffffffn), true);
    view.setUint16(o + 4, Number((bits >> 32n) & 0xffffn), true);
    o += 6;
  }
  return buf;
}

export function poseBytes(d) {
  const hook = !!(d?.[6] & 128) && d.length >= 14;
  const life = Number.isSafeInteger(d?.[14]) && Number.isSafeInteger(d?.[15]);
  return 21 + (hook ? 6 : 0) + (life ? 4 : 0);
}

export function encodeSnap(entities, tick, seq, ack, ackBits, opts = {}) {
  // Sized for the 1200-byte datagram cap. Priority in the caller already trimmed `entities`.
  const from = opts.from || '';
  let need = headerBytes(from) + 8 + 2 + 2 + 1 + 1;
  for (const e of entities) {
    need += 1 + te.encode(String(e.id || '').slice(0, 96)).length + 1;
    need += e.tier === TIER.NEARBY ? 8 : poseBytes(e.d);
  }
  const buf = new ArrayBuffer(need);
  const view = new DataView(buf);
  view.setUint8(0, MAGIC); view.setUint8(1, WIRE); view.setUint8(2, KIND.SNAP);
  let o = writeStr(view, 3, from);
  o = writeHeader(view, o, seq, ack, ackBits);
  view.setUint16(o, tick & 0xffff, true);
  view.setUint16(o + 2, (opts.baseline || 0) & 0xffff, true);
  view.setUint8(o + 4, entities.length & 255);
  view.setUint8(o + 5, opts.starve ? 1 : 0);
  o += 6;
  for (const e of entities) {
    o = writeStr(view, o, e.id);
    view.setUint8(o, e.tier & 15); o += 1;
    if (e.tier === TIER.NEARBY) {
      view.setInt16(o, q(e.d[0], 1), true);
      view.setInt16(o + 2, q(e.d[1], 1), true);
      view.setInt16(o + 4, q(e.d[2], 1), true);
      view.setUint16(o + 6, (e.d[6] || 0) & ~(8 | 32) & 0xffff, true);
      o += 8;
    } else {
      o = writePose(view, o, e.d);
    }
  }
  return buf;
}

export function isWirePacket(buf) {
  if (!buf || buf.byteLength < 4) return false;
  const view = buf instanceof DataView ? buf : new DataView(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  return view.getUint8(0) === MAGIC && view.getUint8(1) === WIRE;
}

export function decodePacket(buf) {
  if (!buf || buf.byteLength < 4) return null;
  const view = buf instanceof DataView ? buf : new DataView(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  if (view.getUint8(0) !== MAGIC || view.getUint8(1) !== WIRE) return null;
  const kind = view.getUint8(2);
  const fromR = readStr(view, 3);
  if (kind === KIND.PS) {
    const pose = readPose(view, fromR.offset);
    return { kind, from: fromR.s || null, d: pose.d };
  }
  if (kind === KIND.BOTPS) {
    const idR = readStr(view, fromR.offset);
    const pose = readPose(view, idR.offset);
    const d = pose.d;
    return { kind, from: fromR.s || null, id: idR.s, ps: d, d, round: d[14], life: d[15] };
  }
  if (kind === KIND.NEARBY) {
    const idR = readStr(view, fromR.offset);
    const o = idR.offset;
    const d = [
      view.getInt16(o, true), view.getInt16(o + 2, true), view.getInt16(o + 4, true),
      0, 0, 0, view.getUint16(o + 6, true), 0, 0, 0, 0,
    ];
    return { kind, from: fromR.s || null, id: idR.s || fromR.s, d, ps: d, nearby: true };
  }
  if (kind === KIND.INPUT) {
    const h = readHeader(view, fromR.offset);
    const firstTick = view.getUint16(h.offset, true), count = view.getUint8(h.offset + 2);
    if (count > INPUT_WINDOW) return null;
    const frames = [];
    let o = h.offset + 3;
    for (let i = 0; i < count; i++) {
      const lo = BigInt(view.getUint32(o, true));
      const hi = BigInt(view.getUint16(o + 4, true));
      frames.push(lo | (hi << 32n));
      o += 6;
    }
    return { kind, from: fromR.s || null, seq: h.seq, ack: h.ack, ackBits: h.ackBits, firstTick, frames };
  }
  if (kind === KIND.SNAP) {
    const h = readHeader(view, fromR.offset);
    const tick = view.getUint16(h.offset, true), baseline = view.getUint16(h.offset + 2, true);
    const count = view.getUint8(h.offset + 4), starve = !!view.getUint8(h.offset + 5);
    const entities = [];
    let o = h.offset + 6;
    for (let i = 0; i < count; i++) {
      const idR = readStr(view, o);
      const tier = view.getUint8(idR.offset);
      if (tier === TIER.NEARBY) {
        const p = idR.offset + 1;
        entities.push({
          id: idR.s, tier,
          d: [view.getInt16(p, true), view.getInt16(p + 2, true), view.getInt16(p + 4, true), 0, 0, 0, view.getUint16(p + 6, true), 0, 0, 0, 0],
          nearby: true,
        });
        o = p + 8;
      } else {
        const pose = readPose(view, idR.offset + 1);
        entities.push({ id: idR.s, tier, d: pose.d });
        o = pose.offset;
      }
    }
    return { kind, from: fromR.s || null, seq: h.seq, ack: h.ack, ackBits: h.ackBits, tick, baseline, starve, entities };
  }
  return null;
}
