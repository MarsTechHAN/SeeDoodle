// Room-side interest management and the battlefield tick. The browser never loads this;
// server.js imports it after wire.js. AoI runs on the existing host-auth `ps` feed (P2).
// Battlefield additionally steps every body from input (P3) and writes snapshots.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { World } from './physics.js';
import { buildCollision } from './level.js';
import { bakePvs, decodePvs, encodePvs, pvsVisible, VISIBLE_R, NEARBY_R, HYSTERESIS_MS, SNAP_BUDGET } from './pvs.js';
import { step, makeSimPlayer, unpackInputFrame, copyMove, STEP_DT, packInputFrame } from './move.js';
import { TIER, encodePs, encodeBotPs, encodeNearby, encodeSnap, encodeInput, decodePacket, poseBytes } from './wire.js';
import { mobOf, diffOf, MOB_FULL } from './settings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PVS_DIR = path.join(HERE, '..', 'pvs');
const worlds = new Map();

function cacheKey(map, opts) {
  return `${map || 'district'}|${opts.arena ? 1 : 0}|${opts.team ? 1 : 0}`;
}

function mapOpts(room) {
  if (room.mode === 'coop' || !room.mode) return {};
  if (room.mode === 'tdm' || room.mode === 'demolition' || room.mode === 'battlefield') return { team: true };
  return { arena: true };
}

function loadWorld(map, opts, fresh) {
  const key = cacheKey(map, opts);
  if (!fresh) {
    const hit = worlds.get(key);
    if (hit) return hit;
  }
  const world = new World();
  const level = buildCollision(world, map || 'district', opts);
  world.finalize();
  if (level?.bounds) {
    world.bounds.min.set(level.bounds.minX, -20, level.bounds.minZ);
    world.bounds.max.set(level.bounds.maxX, 80, level.bounds.maxZ);
  }
  let pvs = null;
  try { fs.mkdirSync(PVS_DIR, { recursive: true }); } catch (e) { /* ignore */ }
  const pvsFile = path.join(PVS_DIR, key.replace(/\|/g, '_') + '.bin');
  try {
    const raw = fs.readFileSync(pvsFile);
    pvs = decodePvs(raw);
  } catch (e) { /* bake below */ }
  if (!pvs) {
    const t0 = Date.now();
    pvs = bakePvs(world, level.bounds || { minX: -60, maxX: 60, minZ: -60, maxZ: 60 });
    try { fs.writeFileSync(pvsFile, Buffer.from(encodePvs(pvs))); } catch (e) { /* cache is optional */ }
    console.log(`  PVS ${key}  ${pvs.n} sectors  ${Date.now() - t0}ms`);
  }
  const bundle = { world, level, pvs, key, shared: !fresh };
  if (!fresh) worlds.set(key, bundle);
  return bundle;
}

export function attachMap(room) {
  const opts = mapOpts(room);
  const key = cacheKey(room.map, opts);
  // Battlefield ticks doors / lifts / glass. Sharing that world across rooms would
  // open one match's door in another.
  const fresh = room.mode === 'battlefield';
  if (room._col && room._col.key === key && (!fresh || !room._col.shared)) return room._col;
  room._col = loadWorld(room.map, opts, fresh);
  room._los = room._los || new Map();
  room._nearAt = room._nearAt || new Map();
  room._prio = room._prio || new Map();
  room._bytes = room._bytes || new Map();
  return room._col;
}

function lastPos(client, room) {
  const sim = room?._auth?.bodies?.get(client.id);
  if (sim?.body?.pos) {
    const p = sim.body.pos;
    return { x: p.x, y: p.y, z: p.z, alive: sim.alive !== false };
  }
  const h = client?.hist;
  return h && h.length ? h[h.length - 1] : null;
}

function teamOf(room, id) {
  return room.actors.get(id)?.team;
}

function losKey(a, b) { return a < b ? a + '>' + b : b + '>' + a; }

function lineOfSight(room, viewer, target, now) {
  const col = room._col; if (!col) return true;
  const va = lastPos(viewer, room), vb = lastPos(target, room); if (!va || !vb) return false;
  const key = losKey(viewer.id, target.id);
  const cache = room._los.get(key);
  const same = cache && cache.sx === ((va.x / 16) | 0) && cache.sz === ((va.z / 16) | 0)
    && cache.tx === ((vb.x / 16) | 0) && cache.tz === ((vb.z / 16) | 0);
  if (same && now - cache.t < 80) return cache.ok || now < cache.until;
  const eyeA = { x: va.x, y: va.y + 1.6, z: va.z }, eyeB = { x: vb.x, y: vb.y + 1.6, z: vb.z };
  const ok = col.world.hasLineOfSight(eyeA, eyeB);
  const until = ok ? now + HYSTERESIS_MS : (cache?.until || 0);
  room._los.set(key, { t: now, ok, until: ok ? now + HYSTERESIS_MS : until, sx: (va.x / 16) | 0, sz: (va.z / 16) | 0, tx: (vb.x / 16) | 0, tz: (vb.z / 16) | 0 });
  return ok || now < until;
}

export const TIER_DISTANT = 2;
export function aoiTier(room, viewer, target, now) {
  if (!viewer || !target || viewer.id === target.id) return TIER.VISIBLE;
  // Small rooms and co-op: the quadratic term is cheap and the host still owns waves.
  if (room.mode === 'coop' || room.members.size + (room.bots?.size || 0) < 6) return TIER.VISIBLE;
  const va = lastPos(viewer, room), vb = lastPos(target, room);
  if (!va || !vb) return TIER.NEARBY;
  const dx = va.x - vb.x, dz = va.z - vb.z, dy = va.y - vb.y;
  const dist = Math.hypot(dx, dy, dz);
  const mate = teamOf(room, viewer.id) != null && teamOf(room, viewer.id) === teamOf(room, target.id);
  if (mate && dist > VISIBLE_R) return TIER.NEARBY;
  if (dist > VISIBLE_R && !mate) return TIER_DISTANT;
  attachMap(room);
  const pvsOk = !room._col?.pvs || pvsVisible(room._col.pvs, va.x, va.z, vb.x, vb.z);
  if (dist <= VISIBLE_R && pvsOk && lineOfSight(room, viewer, target, now)) return TIER.VISIBLE;
  if (dist <= NEARBY_R || mate) return TIER.NEARBY;
  return TIER_DISTANT;
}

function viewerBudget(room, viewerId, now, add) {
  const row = room._bytes.get(viewerId) || { t: now, n: 0 };
  if (now - row.t > 50) { row.t = now; row.n = 0; }
  row.n += add; room._bytes.set(viewerId, row);
  return row.n;
}

function priority(room, viewer, target, tier, now) {
  const key = viewer.id + ':' + target.id;
  const acc = room._prio.get(key) || 0;
  const va = lastPos(viewer, room), vb = lastPos(target, room);
  const dist = va && vb ? Math.hypot(va.x - vb.x, va.z - vb.z) : 80;
  let w = tier === TIER.VISIBLE ? 3 : 1;
  w += Math.max(0, 1 - dist / VISIBLE_R);
  if (vb && !vb.alive) w *= 0.2;
  const next = acc + w;
  room._prio.set(key, next);
  return next;
}

export function relayPose(room, source, d, opts, sendBin) {
  const now = opts.now || Date.now();
  const isBot = !!opts.botId;
  const full = isBot
    ? encodeBotPs({ id: opts.botId, ps: d, round: opts.round, life: opts.life }, source.id)
    : encodePs(d, source.id);
  const near = encodeNearby(d, source.id, opts.botId || '');
  for (const viewer of room.members.values()) {
    if (viewer.id === source.id || !viewer.ws || viewer.ws.closed) continue;
    const tier = aoiTier(room, viewer, source, now);
    if (tier === TIER_DISTANT) continue;
    const pri = priority(room, viewer, source, tier, now);
    if (viewerBudget(room, viewer.id, now, 0) > SNAP_BUDGET && pri < 4) continue;
    if (tier === TIER.NEARBY) {
      const stamp = room._nearAt.get(viewer.id + ':' + source.id) || 0;
      if (now - stamp < 200) continue;
      room._nearAt.set(viewer.id + ':' + source.id, now);
      sendBin(viewer, near, true);
      viewerBudget(room, viewer.id, now, near.byteLength);
    } else {
      sendBin(viewer, full, true);
      viewerBudget(room, viewer.id, now, full.byteLength);
    }
    room._prio.set(viewer.id + ':' + source.id, 0);
  }
}

export function isBattlefield(room) { return room.mode === 'battlefield'; }

function rulesOf(room) {
  const col = room._col;
  return {
    mob: mobOf(room.mob || 'mid'),
    adsSpeed: 100,
    bounds: col?.level?.bounds,
    fallY: col?.level?.fallY,
    conveyors: col?.level?.conveyors,
    fallDamage: !!room.fall,
    maxSprint: (diffOf(room.diff || 'easy').sprint) || 0,
    diff: diffOf(room.diff || 'easy'),
    rings: col?.level?.rings,
    grappleSim: true,
  };
}

function poseOf(sim, extra = {}) {
  const b = sim.body, g = sim.grapple, grappling = g && g.state !== 'idle';
  const out = [
    b.pos.x, b.pos.y, b.pos.z, sim.yaw, sim.pitch, extra.weapon || 0,
    (sim.crouching ? 1 : 0) | (sim.sliding ? 2 : 0) | (sim._aiming ? 8 : 0) | (b.onGround ? 16 : 0) | (sim.alive ? 64 : 0) | (grappling ? 128 : 0),
    Math.round(sim.hp), b.vel.x, b.vel.y, b.vel.z,
  ];
  if (grappling) out.push(g.hook.x, g.hook.y, g.hook.z);
  if (Number.isSafeInteger(extra.round) && Number.isSafeInteger(extra.life)) {
    while (out.length < 14) out.push(0);
    out.push(extra.round, extra.life);
  }
  return out;
}

export function startAuth(room) {
  attachMap(room);
  room._auth = { tick: 0, snapAcc: 0, bodies: new Map() };
  for (const m of room.members.values()) spawnBody(room, m);
}

export function stopAuth(room) {
  if (room._authT) { clearInterval(room._authT); room._authT = null; }
  room._auth = null;
}

function spawnBody(room, client) {
  const actor = room.actors.get(client.id);
  const col = room._col;
  let pos = col?.level?.playerStart;
  if (actor?.spawn) pos = { x: actor.spawn[0], y: actor.spawn[1], z: actor.spawn[2] };
  else if (col?.level?.teamSpawns && actor) {
    const spots = col.level.teamSpawns[actor.team || 0];
    if (spots?.[0]) pos = spots[0];
  }
  const sim = makeSimPlayer(pos);
  sim.id = client.id;
  sim.hp = actor?.hp ?? 110;
  sim.alive = actor ? !!actor.alive : true;
  sim.yaw = actor?.yaw || 0;
  sim.inputs = [];
  sim.lastInput = { moveX: 0, moveY: 0, yaw: sim.yaw, pitch: 0 };
  sim.lastApplied = null;
  sim.started = false;
  sim.starve = false;
  sim.starveCount = 0;
  sim._tickSeen = new Set();
  sim.seq = 0;
  room._auth.bodies.set(client.id, sim);
  return sim;
}

export function noteLobbyFields(room, d) {
  if (!d) return;
  if (typeof d.map === 'string') room.map = d.map;
  if (typeof d.mob === 'string') room.mob = d.mob;
  if (d.fall !== undefined) room.fall = !!d.fall;
  if (typeof d.diff === 'string') room.diff = d.diff;
  if (d.mode === 'battlefield') room.max = 128;
  else if (d.mode && d.mode !== 'battlefield') room.max = Math.max(room.members.size + (room.lobbyBots?.size || 0), 32);
  if (typeof d.max === 'number' && d.max >= 2 && d.max <= 128) room.max = d.max;
}

// Client ticks are the client's own counter, not room._auth.tick. Matching those two clocks
// is how the first build starved every frame: the interval starts on `start`, the tab starts
// sending after the first 30 Hz step, and they never shared a number.
function tickAfter(a, b) {
  const d = (a - b + 65536) & 0xffff;
  return d > 0 && d < 32768;
}

export function onInput(room, client, msg) {
  if (!room._auth) return;
  let sim = room._auth.bodies.get(client.id);
  if (!sim) sim = spawnBody(room, client);
  sim.seq = msg.seq;
  sim.peerAck = msg.ack;
  const frames = msg.frames || [];
  const seen = sim._tickSeen || (sim._tickSeen = new Set());
  for (let i = 0; i < frames.length; i++) {
    const tick = (msg.firstTick + i) & 0xffff;
    if (sim.lastApplied != null && !tickAfter(tick, sim.lastApplied)) continue;
    if (seen.has(tick)) continue;
    seen.add(tick);
    sim.inputs.push({ tick, input: unpackInputFrame(frames[i]) });
  }
  if (sim.inputs.length > 32) {
    const drop = sim.inputs.splice(0, sim.inputs.length - 32);
    for (const f of drop) seen.delete(f.tick);
  }
}

function takeInput(sim) {
  const last = sim.lastApplied;
  const want = last == null ? null : (last + 1) & 0xffff;
  let hit = null, hitIdx = -1, oldest = null, oldestIdx = -1;
  for (let i = 0; i < sim.inputs.length; i++) {
    const f = sim.inputs[i];
    if (last != null && !tickAfter(f.tick, last)) continue;
    if (want != null && f.tick === want) { hit = f; hitIdx = i; break; }
    if (!oldest || tickAfter(oldest.tick, f.tick)) { oldest = f; oldestIdx = i; }
  }
  if (!hit && last == null && oldest) { hit = oldest; hitIdx = oldestIdx; }
  // A one-tick hole is loss; waiting forever for it stalls the body. After two starved
  // steps skip to the oldest future frame — the sliding window already repaired what it could.
  if (!hit && (sim.starveCount || 0) >= 2 && oldest) { hit = oldest; hitIdx = oldestIdx; }
  if (hit) {
    sim.inputs.splice(hitIdx, 1);
    sim._tickSeen?.delete(hit.tick);
    sim.lastApplied = hit.tick;
    sim.lastInput = hit.input;
    sim.starve = false;
    sim.starveCount = 0;
    sim.started = true;
    return hit.input;
  }
  if (!sim.started) return null;
  sim.starve = true;
  sim.starveCount = (sim.starveCount || 0) + 1;
  return sim.lastInput;
}

export function tickRoom(room, helpers) {
  if (!room._auth || !isBattlefield(room)) return;
  attachMap(room);
  const rules = rulesOf(room);
  const world = room._col.world;
  const now = Date.now();
  room._auth.tick++;
  for (const client of room.members.values()) {
    if (client.gone) continue;
    let sim = room._auth.bodies.get(client.id);
    if (!sim) sim = spawnBody(room, client);
    const actor = room.actors.get(client.id);
    if (actor) {
      if (actor.alive === false) { sim.alive = false; continue; }
      if (sim._life != null && actor.life !== sim._life) {
        const spawned = spawnBody(room, client);
        spawned._life = actor.life;
        sim = spawned;
      }
      sim._life = actor.life;
      sim.alive = !!actor.alive;
    }
    if (!sim.alive) continue;
    const input = takeInput(sim);
    if (!input) continue;
    const ev = step(sim, input, STEP_DT, world, rules);
    if (ev.fell) {
      // The client already treats a team-mode fall as a death. Teleporting and
      // replaying lastInput here left a living body at spawn for the rewind.
      sim.alive = false;
      sim.hp = 0;
      sim.body.vel.set(0, 0, 0);
    }
    if (ev.fallDamage) sim.hp = Math.max(0, sim.hp - ev.fallDamage);
    helpers.noteMove(client, poseOf(sim, { round: room.combat?.round, life: actor?.life }), now);
  }
  const L = room._col?.level;
  if (typeof L?.update === 'function') {
    const movers = [];
    for (const sim of room._auth.bodies.values()) if (sim.alive) movers.push(sim);
    L.update(STEP_DT, { remote: movers, targets: () => movers });
  }
  room._auth.snapAcc += STEP_DT;
  if (room._auth.snapAcc >= 0.05) {
    room._auth.snapAcc -= 0.05;
    sendSnaps(room, helpers, now);
  }
}

function snapCost(e) {
  const idn = 1 + Math.min(96, String(e.id || '').length);
  return idn + 1 + (e.tier === TIER.NEARBY ? 8 : poseBytes(e.d));
}

function sendSnaps(room, helpers, now) {
  const auth = room._auth, tick = auth.tick;
  for (const viewer of room.members.values()) {
    if (viewer.gone || !viewer.ws || viewer.ws.closed) continue;
    const list = [];
    for (const [id, sim] of auth.bodies) {
      const src = id === viewer.id ? viewer : (room.members.get(id) || room.bots.get(id));
      if (!src) continue;
      const tier = id === viewer.id ? TIER.VISIBLE : aoiTier(room, viewer, src, now);
      if (tier === TIER_DISTANT) continue;
      const actor = room.actors.get(id);
      const d = poseOf(sim, { round: room.combat?.round, life: actor?.life });
      const pri = priority(room, viewer, src, tier, now);
      list.push({ id, tier, d, pri, src });
    }
    const mine = list.find((e) => e.id === viewer.id);
    const others = list.filter((e) => e.id !== viewer.id).sort((a, b) => b.pri - a.pri);
    const keep = [];
    let bytes = 40;
    if (mine) { keep.push(mine); bytes += snapCost(mine); room._prio.set(viewer.id + ':' + mine.id, 0); }
    for (const e of others) {
      if (e.tier === TIER.NEARBY) {
        const stamp = room._nearAt.get(viewer.id + ':' + e.id) || 0;
        if (now - stamp < 200) continue;
      }
      const add = snapCost(e);
      if (bytes + add > SNAP_BUDGET) continue;
      keep.push(e); bytes += add;
      if (e.tier === TIER.NEARBY) room._nearAt.set(viewer.id + ':' + e.id, now);
      room._prio.set(viewer.id + ':' + e.id, 0);
    }
    if (now - (room._cullLog || 0) > 4000 && viewer.id === room.hostId) {
      room._cullLog = now;
      const vis = list.filter((e) => e.tier === TIER.VISIBLE).length;
      const near = list.filter((e) => e.tier === TIER.NEARBY).length;
      console.log('NET cull kept=' + keep.length + ' visible=' + vis + ' nearby=' + near + ' bytes=' + bytes);
    }
    const vSim = auth.bodies.get(viewer.id);
    const buf = encodeSnap(keep, vSim?.lastApplied || 0, tick & 0xffff, vSim?.seq || 0, 0, { starve: !!(vSim && vSim.starve), from: 'server' });
    helpers.sendBin(viewer, buf, true);
  }
}

export function syncCombat(room) {
  if (!room._auth) return;
  for (const [id, actor] of room.actors) {
    const client = room.members.get(id);
    if (!client) continue;
    let sim = room._auth.bodies.get(id);
    if (!sim || sim._life !== actor.life) {
      sim = spawnBody(room, client);
      sim._life = actor.life;
    }
    sim.alive = !!actor.alive;
    sim.hp = actor.hp ?? sim.hp;
  }
}

export function selfCheck() {
  const world = new World();
  const level = buildCollision(world, 'district', { arena: true });
  world.finalize();
  const rules = { mob: MOB_FULL, adsSpeed: 100, bounds: level.bounds, fallY: level.fallY, conveyors: level.conveyors, fallDamage: false, maxSprint: 0, diff: diffOf('easy'), rings: level.rings, grappleSim: true };
  const a = makeSimPlayer(level.playerStart), b = makeSimPlayer(level.playerStart);
  const seq = [];
  for (let i = 0; i < 90; i++) {
    const input = { moveX: 0.4, moveY: 1, yaw: i * 0.02, pitch: -0.1, jumpPressed: i === 20, sprintDown: true, crouchDown: false };
    seq.push(input);
    step(a, input, STEP_DT, world, rules);
    step(b, input, STEP_DT, world, rules);
  }
  const dx = Math.hypot(a.body.pos.x - b.body.pos.x, a.body.pos.y - b.body.pos.y, a.body.pos.z - b.body.pos.z);
  const bits = packInputFrame(seq[20]);
  const back = unpackInputFrame(bits);
  if (dx > 1e-9) throw new Error('step diverged from itself: ' + dx);
  if (Math.abs(back.moveY - 1) > 0.05) throw new Error('input pack missed forward');
  const pvs = bakePvs(world, level.bounds);
  if (!pvsVisible(pvs, level.playerStart.x, level.playerStart.z, level.playerStart.x + 1, level.playerStart.z + 1)) {
    throw new Error('PVS rejected a sector seeing itself');
  }
  copyMove(b, a);
  const inBuf = encodeInput([bits], 7, 3, 2, 0);
  const inMsg = decodePacket(inBuf);
  if (!inMsg || inMsg.firstTick !== 7 || inMsg.frames.length !== 1) throw new Error('input wire roundtrip failed');
  const pose = poseOf(a, { round: 1, life: 2 });
  const snapBuf = encodeSnap([{ id: 'p1', tier: TIER.VISIBLE, d: pose }], 12, 4, 3, 0, { from: 'server' });
  const snapMsg = decodePacket(snapBuf);
  if (!snapMsg || snapMsg.tick !== 12 || snapMsg.entities[0]?.id !== 'p1' || snapMsg.entities[0].d[15] !== 2) throw new Error('snap wire roundtrip failed');
  const ghost = makeSimPlayer(level.playerStart);
  for (let i = 0; i < 40; i++) step(ghost, seq[i], STEP_DT, world, rules);
  const mid = makeSimPlayer(level.playerStart);
  for (let i = 0; i < 20; i++) step(mid, seq[i], STEP_DT, world, rules);
  copyMove(ghost, mid);
  for (let i = 20; i < 40; i++) step(ghost, seq[i], STEP_DT, world, rules);
  const end = makeSimPlayer(level.playerStart);
  for (let i = 0; i < 40; i++) step(end, seq[i], STEP_DT, world, rules);
  const rx = Math.hypot(ghost.body.pos.x - end.body.pos.x, ghost.body.pos.y - end.body.pos.y, ghost.body.pos.z - end.body.pos.z);
  if (rx > 1e-9) throw new Error('replay after snap diverged: ' + rx);
  const far = { id: 'far', hist: [{ x: a.body.pos.x + 220, y: 1, z: a.body.pos.z, alive: true }] };
  const near = { id: 'near', hist: [{ x: a.body.pos.x, y: 1, z: a.body.pos.z, alive: true }] };
  const members = new Map([['near', near], ['far', far]]);
  for (let i = 0; i < 6; i++) members.set('pad' + i, { id: 'pad' + i, hist: [{ x: 0, y: 1, z: 0, alive: true }] });
  const room = { mode: 'battlefield', members, bots: new Map(), actors: new Map(), _los: new Map(), _nearAt: new Map(), _prio: new Map(), _bytes: new Map(), map: 'district' };
  if (aoiTier(room, near, far, Date.now()) !== TIER_DISTANT) throw new Error('AoI sent a 220 m stranger');
  return { ok: true, pos: [a.body.pos.x, a.body.pos.y, a.body.pos.z], sectors: pvs.n };
}
