// Pure movement step. player.js used to own this, but a battlefield server cannot load
// that file (audio, view models, HUD). Both sides import this and pass difficulty /
// mobility as arguments so a lobby change cannot make them disagree. MOB_FULL (every
// flag on, every scale 1) is the solo/squad kit — feeding it here is a no-op versus
// the numbers that used to be hardcoded in player.update.

import * as THREE from '../vendor/three.module.js';
import { makeBody } from './physics.js';
import { clamp } from './util.js';

export const G = 26, WALK = 6.6, SPRINT = 10.6, CROUCH = 3.6, ACCEL = 140, FRICTION = 8, AIR_ACCEL = 36, AIR_CAP = 7.5, JUMP = 9.6;
export const STAND_H = 1.75, CROUCH_H = 1.05, EYE_STAND = 1.6, EYE_CROUCH = 0.88;
export const STEP_HZ = 30, STEP_DT = 1 / STEP_HZ;
export const STAM_FIRE = 0.09, STAM_DRAIN = 0.08, STAM_GROUND = 0.4, STAM_AIR = 0.2, STAM_MIN = 0.18, STAM_PAUSE = 0.5;

const NO_GRAPPLE = (b) => !!b.data.noGrapple;
const FULL = { speed: 1, jump: 1, air: 1, dash: true, doubleJump: true, wallJump: true, grapple: true, slide: true, grapCd: 0 };

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0), _d = new THREE.Vector3();
const _look = new THREE.Vector3();

export function makeSimPlayer(pos) {
  const p = pos && pos.clone ? pos.clone() : new THREE.Vector3(pos?.x || 0, pos?.y || 0, pos?.z || 0);
  return {
    body: makeBody(p, 0.35, STAND_H, 0.55),
    yaw: 0, pitch: 0,
    crouching: false, sliding: false, slideT: 0,
    coyote: 0, jumpBuffer: 0, wallTouch: 9, wallN: new THREE.Vector3(),
    wallJumpCd: 0, mantleCd: 0, dashCd: 0, airJumps: 1,
    landGraceT: 0, sprintToggle: false, lastGround: true, airT: 0,
    _sprinting: false, _aiming: false, _mv: { x: 0, y: 0 },
    sprintLock: false, sprintStam: 0, sprintPause: 0, sprintFireLock: 0,
    grapStam: 1, stamPause: 0, gravityScale: 1, dashLock: false,
    grapple: { state: 'idle', anchor: new THREE.Vector3(), hook: new THREE.Vector3(), from: new THREE.Vector3(), flyT: 0, flyDur: 0, len: 0, cd: 0, enemy: null, mover: null, blockedT: 0, t: 0, swingT: 0, hopT: 0 },
    hp: 110, maxHp: 110, alive: true, lastDamageT: 10,
    eye: new THREE.Vector3(), center: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0),
  };
}

export function copyMove(dst, src) {
  const db = dst.body, sb = src.body;
  db.pos.copy(sb.pos); db.vel.copy(sb.vel); db.onGround = sb.onGround; db.height = sb.height;
  db.hitWall = sb.hitWall; db.wallNormal.copy(sb.wallNormal); db.landVel = sb.landVel; db.noSnap = sb.noSnap;
  dst.yaw = src.yaw; dst.pitch = src.pitch;
  dst.crouching = src.crouching; dst.sliding = src.sliding; dst.slideT = src.slideT;
  dst.coyote = src.coyote; dst.jumpBuffer = src.jumpBuffer; dst.wallTouch = src.wallTouch; dst.wallN.copy(src.wallN);
  dst.wallJumpCd = src.wallJumpCd; dst.mantleCd = src.mantleCd; dst.dashCd = src.dashCd; dst.airJumps = src.airJumps;
  dst.landGraceT = src.landGraceT; dst.sprintToggle = src.sprintToggle; dst.lastGround = src.lastGround; dst.airT = src.airT;
  dst._sprinting = src._sprinting; dst._aiming = src._aiming;
  dst.sprintLock = src.sprintLock; dst.sprintStam = src.sprintStam; dst.sprintPause = src.sprintPause; dst.sprintFireLock = src.sprintFireLock;
  dst.grapStam = src.grapStam; dst.stamPause = src.stamPause; dst.gravityScale = src.gravityScale; dst.dashLock = src.dashLock;
  const dg = dst.grapple, sg = src.grapple;
  dg.state = sg.state; dg.anchor.copy(sg.anchor); dg.hook.copy(sg.hook); dg.from.copy(sg.from);
  dg.flyT = sg.flyT; dg.flyDur = sg.flyDur; dg.len = sg.len; dg.cd = sg.cd; dg.blockedT = sg.blockedT; dg.t = sg.t; dg.swingT = sg.swingT;
  dst.hp = src.hp; dst.alive = src.alive;
}

export function readButtons(inp, aiming) {
  return {
    moveX: inp.move?.x || 0, moveY: inp.move?.y || 0,
    jumpPressed: !!inp.pressed?.('jump'),
    crouchDown: !!inp.down?.('crouch'),
    crouchPressed: !!inp.pressed?.('crouch'),
    sprintDown: !!inp.down?.('sprint'),
    sprintPressed: !!inp.pressed?.('sprint'),
    dashPressed: !!inp.pressed?.('dash'),
    aimDown: !!aiming,
    usingGamepad: !!inp.usingGamepad,
    fireDown: !!inp.down?.('fire'),
    grappleDown: !!inp.down?.('grapple'),
    grapplePressed: !!inp.pressed?.('grapple'),
    reloadPressed: !!inp.pressed?.('reload'),
    blockDown: !!inp.down?.('block'),
    meleePressed: !!inp.pressed?.('melee'),
    interactDown: !!inp.down?.('interact'),
  };
}

function wishOf(yaw, moveX, moveY) {
  _fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  _right.set(Math.cos(yaw), 0, -Math.sin(yaw));
  const wish = _v.set(0, 0, 0).addScaledVector(_fwd, moveY).addScaledVector(_right, moveX);
  let wishLen = wish.length();
  if (wishLen > 1e-4) wish.divideScalar(wishLen);
  wishLen = Math.min(1, wishLen);
  return { wish, wishLen, fwd: _fwd, right: _right };
}

function startSlide(state, hs) {
  state.sliding = true; state.slideT = 0;
  const b = state.body, boost = clamp(12.8 - hs, 0, 4.5);
  b.vel.x += b.vel.x / hs * boost; b.vel.z += b.vel.z / hs * boost;
}

function dash(state, dir) {
  const b = state.body; state.dashCd = 1.3;
  const cur = b.vel.x * dir.x + b.vel.z * dir.z, target = Math.max(cur + 6, 14);
  b.vel.x += dir.x * (target - cur); b.vel.z += dir.z * (target - cur); b.vel.y = Math.max(b.vel.y, 2);
}

function tryMantle(state, world, fwd) {
  const b = state.body;
  _v2.set(b.pos.x, b.pos.y + 1.0, b.pos.z); if (!world.raycast(_v2, fwd, 0.95)) return false;
  _v2.set(b.pos.x + fwd.x * 0.95, b.pos.y + 2.75, b.pos.z + fwd.z * 0.95);
  const top = world.raycast(_v2, _down, 2.25); if (!top || top.normal.y < 0.5) return false;
  const dy = top.point.y - b.pos.y; if (dy < 0.5 || dy > 2.4) return false;
  const hw = b.halfW;
  if (world.overlapsAABB({ x: _v2.x - hw, y: top.point.y + 0.08, z: _v2.z - hw }, { x: _v2.x + hw, y: top.point.y + CROUCH_H, z: _v2.z + hw })) return false;
  b.vel.y = Math.min(11, Math.sqrt(2 * G * (dy + 0.45))); b.vel.x = fwd.x * 3.2; b.vel.z = fwd.z * 3.2; state.mantleCd = 0.7;
  return true;
}

function findWallHook(world, origin, dir, rings) {
  const maxD = 75;
  const hitW = world.raycast(origin, dir, maxD, NO_GRAPPLE);
  const wallDist = hitW ? hitW.dist : maxD;
  let ring = null, ringT = Infinity, ringLat = Infinity;
  if (rings) for (const r of rings) {
    _v.subVectors(r, origin); const t = _v.dot(dir); if (t < 2 || t > Math.min(maxD, wallDist + 1.5)) continue;
    const lat = Math.sqrt(Math.max(0, _v.lengthSq() - t * t));
    if (lat > 0.8 + t * 0.02) continue;
    if (lat < ringLat) { ring = r; ringT = t; ringLat = lat; }
  }
  if (ring) return { point: ring.clone(), dist: ringT };
  if (hitW) return { point: hitW.point.clone().addScaledVector(hitW.normal, 0.12), dist: hitW.dist };
  return null;
}

export function detachGrapple(state, boost, mob) {
  const g = state.grapple; if (g.state === 'idle') return false;
  const was = g.state; g.state = 'idle'; g.cd = Math.max(0.12, (mob || FULL).grapCd); g.enemy = null; g.mover = null; state.stamPause = STAM_PAUSE;
  if (was === 'on') {
    const b = state.body;
    if (boost) { b.vel.y = Math.max(b.vel.y, 0) + 8; b.vel.x *= 1.12; b.vel.z *= 1.12; }
    else b.vel.y += 2.5;
  }
  return true;
}

// World-only hook. No enemy yank, no moving planes — those stay on the client where the
// entities live. Rings come from the collision build, so a battlefield server can still
// swing from the same hoops the tab can see.
export function stepGrapple(state, input, dt, world, rules) {
  const mob = rules.mob || FULL, g = state.grapple, b = state.body;
  g.cd -= dt;
  const eyeY = b.pos.y + (state.crouching ? EYE_CROUCH : EYE_STAND);
  const eye = state.eye || _look;
  eye.set(b.pos.x, eyeY, b.pos.z);
  const look = _look.set(-Math.sin(state.yaw) * Math.cos(state.pitch), Math.sin(state.pitch), -Math.cos(state.yaw) * Math.cos(state.pitch));
  const ev = {};
  if (g.state === 'idle') {
    if (!mob.grapple) return ev;
    if (input.grapplePressed && g.cd <= 0) {
      if (state.grapStam < STAM_MIN) { ev.winded = true; return ev; }
      const t = input.grapplePoint || findWallHook(world, eye, look, rules.rings);
      if (!t) { ev.empty = true; return ev; }
      state.grapStam -= STAM_FIRE; state.stamPause = STAM_PAUSE;
      g.state = 'fly'; g.anchor.copy(t.point); g.from.copy(eye); g.hook.copy(eye);
      g.flyT = 0; g.flyDur = clamp((t.dist || eye.distanceTo(t.point)) / 110, 0.04, 0.6);
      g.enemy = null; g.mover = null; g.t = 0; ev.grappleFire = true;
    }
  } else if (g.state === 'fly') {
    g.flyT += dt; const f = Math.min(1, g.flyT / g.flyDur); g.hook.lerpVectors(g.from, g.anchor, f);
    if (f >= 1) {
      g.state = 'on'; g.len = Math.max(1.5, (state.center || b.pos).distanceTo(g.anchor) * 0.94);
      g.blockedT = 0; g.t = 0; g.swingT = 0; ev.grappleHit = true;
      if (b.onGround) { b.vel.y = Math.max(b.vel.y, 5); b.onGround = false; }
    }
  } else if (g.state === 'on') {
    g.hook.copy(g.anchor); g.swingT += dt;
    const c = state.center || _v2.set(b.pos.x, b.pos.y + b.height * 0.55, b.pos.z);
    if (state.center) c.set(b.pos.x, b.pos.y + b.height * 0.55, b.pos.z);
    _d.subVectors(g.anchor, c); const dist = _d.length(); if (dist > 0.01) _d.divideScalar(dist);
    const reeling = !!input.grappleDown; const vAlong = b.vel.dot(_d);
    if (reeling) { g.len = Math.max(1.5, g.len - 14 * dt); if (vAlong < 22) b.vel.addScaledVector(_d, 42 * dt); }
    else {
      if (vAlong < 6) b.vel.addScaledVector(_d, 3 * dt);
      if ((state._mv?.y || input.moveY || 0) > 0.3 && c.y < g.anchor.y - 1) {
        _v2.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
        if (_v2.lengthSq() > 0.01) { _v2.normalize(); b.vel.addScaledVector(_v2, 10 * dt); }
      }
    }
    if (dist > g.len) {
      const vn = b.vel.dot(_d); if (vn < 0) b.vel.addScaledVector(_d, -vn);
      const excess = Math.min(dist - g.len, 0.35) * 0.85; b.pos.addScaledVector(_d, excess);
      if (world.overlapsBody(b)) b.pos.addScaledVector(_d, -excess);
    }
    if (b.onGround && reeling && _d.y > 0.2) { b.vel.y = Math.max(b.vel.y, 4.5); b.onGround = false; }
    g.t += dt; if (g.t > 0.15) { g.t = 0; if (!world.hasLineOfSight(eye, g.anchor)) g.blockedT += 0.15; else g.blockedT = 0; }
    if (input.grapplePressed || dist < 1.3 || g.blockedT > 0.3 || dist > 90 || (b.onGround && g.swingT > 0.6 && !reeling)) {
      detachGrapple(state, dist < 1.3, mob); ev.grappleOff = true; ev.grappleBoost = dist < 1.3;
    }
  }
  return ev;
}

export function step(state, input, dt, world, rules = {}, hooks = {}) {
  const b = state.body, ev = {};
  const mob = rules.mob || FULL;
  const adsSpeed = rules.adsSpeed == null ? 100 : rules.adsSpeed;
  if (input.yaw != null) state.yaw = input.yaw;
  if (input.pitch != null) state.pitch = clamp(input.pitch, -1.5, 1.5);
  state.forward.set(-Math.sin(state.yaw) * Math.cos(state.pitch), Math.sin(state.pitch), -Math.cos(state.yaw) * Math.cos(state.pitch));
  state.right.set(Math.cos(state.yaw), 0, -Math.sin(state.yaw));

  const mv = { x: input.moveX || 0, y: input.moveY || 0 };
  state._mv = mv;
  const { wish, wishLen, fwd } = wishOf(state.yaw, mv.x, mv.y);
  if (input.usingGamepad) { if (input.sprintPressed) state.sprintToggle = !state.sprintToggle; if (mv.y < 0.1) state.sprintToggle = false; }
  else state.sprintToggle = !!input.sprintDown;
  const aiming = state._aiming = !!input.aimDown;
  const hspeed = Math.hypot(b.vel.x, b.vel.z);
  const crouchDown = !!input.crouchDown;
  if (input.crouchPressed && b.onGround && hspeed > 6.3 && !state.sliding && mob.slide) { startSlide(state, hspeed); ev.slid = true; }
  if (state.sliding) { state.slideT += dt; if (!crouchDown || hspeed < 3.5 || state.airT > 0.35) state.sliding = false; }
  let wantCrouch = (crouchDown && b.onGround) || state.sliding;
  if (!wantCrouch && state.crouching) { b.height = STAND_H; if (world.overlapsBody(b)) wantCrouch = true; }
  state.crouching = wantCrouch; b.height = state.crouching ? CROUCH_H : STAND_H;
  const sprinting = state._sprinting = state.sprintToggle && mv.y > 0.1 && !state.crouching && !aiming && !state.sprintLock;
  state.sprintFireLock = sprinting ? 0.2 : Math.max(0, state.sprintFireLock - dt);
  const maxSpeed = (state.crouching && !state.sliding ? CROUCH : sprinting ? SPRINT : WALK) * (aiming ? adsSpeed / 100 : 1) * mob.speed;
  state.landGraceT -= dt; state.dashCd -= dt;

  if (b.onGround) {
    state.coyote = 0.13; state.airT = 0; state.airJumps = 1;
    if (state.sliding) {
      const sp = hspeed; if (sp > 0) { const ns = Math.max(0, sp - 6.5 * dt) / sp; b.vel.x *= ns; b.vel.z *= ns; }
      if (wishLen > 0) { b.vel.x += wish.x * 6 * dt; b.vel.z += wish.z * 6 * dt; const n2 = Math.hypot(b.vel.x, b.vel.z); if (n2 > sp && n2 > 0) { b.vel.x *= sp / n2; b.vel.z *= sp / n2; } }
    } else {
      const fr = FRICTION * (state.landGraceT > 0 ? 0.25 : 1);
      const sp = hspeed; if (sp > 0) { const ns = Math.max(0, sp - sp * fr * dt) / sp; b.vel.x *= ns; b.vel.z *= ns; }
      if (wishLen > 0) { const cur = b.vel.x * wish.x + b.vel.z * wish.z; const add = Math.min(maxSpeed * wishLen - cur, ACCEL * dt); if (add > 0) { b.vel.x += wish.x * add; b.vel.z += wish.z * add; } }
    }
  } else {
    state.coyote -= dt; state.airT += dt;
    const air = mob.air;
    if (wishLen > 0) { const cur = b.vel.x * wish.x + b.vel.z * wish.z; const add = Math.min(AIR_CAP * air * wishLen - cur, AIR_ACCEL * air * dt); if (add > 0) { b.vel.x += wish.x * add; b.vel.z += wish.z * add; } }
  }

  if (input.jumpPressed) state.jumpBuffer = 0.15; else state.jumpBuffer -= dt;
  state.wallJumpCd -= dt; state.mantleCd -= dt;
  if (b.hitWall && !b.onGround) { state.wallTouch = 0; state.wallN.copy(b.wallNormal); } else state.wallTouch += dt;
  if (state.jumpBuffer > 0) {
    if (state.grapple.state === 'on') { state.jumpBuffer = 0; detachGrapple(state, true, mob); ev.grappleOff = true; ev.grappleBoost = true; }
    else if (b.onGround || state.coyote > 0) {
      state.jumpBuffer = 0; state.coyote = 0; b.vel.y = JUMP * mob.jump; b.onGround = false; state.airJumps = mob.doubleJump ? 1 : 0;
      if (state.sliding) { b.vel.x *= 1.06; b.vel.z *= 1.06; state.sliding = false; }
      ev.jumped = true;
    } else if (state.wallTouch < 0.12 && state.wallJumpCd <= 0 && b.vel.y < 7 && mob.wallJump) {
      state.jumpBuffer = 0; state.wallJumpCd = 0.35; const n = state.wallN;
      b.vel.x = n.x * 7.5 + b.vel.x * 0.35 + fwd.x * 2.5; b.vel.z = n.z * 7.5 + b.vel.z * 0.35 + fwd.z * 2.5; b.vel.y = 9.2 * mob.jump;
      ev.wallJumped = true; ev.wallSign = n.dot(state.right) > 0 ? -1 : 1;
      state.airJumps = mob.doubleJump ? 1 : 0;
    } else if (state.airJumps > 0 && mob.doubleJump) {
      state.jumpBuffer = 0; state.airJumps--;
      b.vel.y = JUMP * 0.92 * mob.jump;
      if (wishLen > 0) { const cur = b.vel.x * wish.x + b.vel.z * wish.z; const add = Math.max(0, 7.5 * wishLen - cur); b.vel.x += wish.x * add; b.vel.z += wish.z * add; }
      ev.doubleJumped = true;
    }
  }
  if ((input.dashPressed || (input.crouchPressed && !b.onGround)) && !b.onGround && state.dashCd <= 0 && state.grapple.state !== 'on' && mob.dash) {
    dash(state, wishLen > 0 ? wish : fwd); ev.dashed = true; ev.dashDir = { x: (wishLen > 0 ? wish : fwd).x, z: (wishLen > 0 ? wish : fwd).z };
  }

  b.vel.y -= G * (state.gravityScale || 1) * (state.grapple.state === 'on' ? 0.88 : 1) * dt;
  if (hooks.grapple) hooks.grapple(dt);
  else if (rules.grappleSim) Object.assign(ev, stepGrapple(state, input, dt, world, rules));
  if (!b.onGround && state.mantleCd <= 0 && mv.y > 0.3 && b.vel.y < 8 && state.grapple.state !== 'on') {
    if (tryMantle(state, world, fwd)) ev.mantled = true;
  }
  b.noSnap = state.grapple.state === 'on' || b.vel.y > 0.5;
  const spd = b.vel.length(); if (spd > 48) b.vel.multiplyScalar(48 / spd);
  const groundBeforeMove = b.onGround, yBeforeMove = b.pos.y;
  world.moveBody(b, dt);
  if (groundBeforeMove && b.onGround && !b.noSnap) {
    const stepUp = b.pos.y - yBeforeMove;
    if (Math.abs(stepUp) <= b.stepHeight + 1e-3 && state._stepOffset != null) {
      state._stepOffset = clamp(state._stepOffset - stepUp, -b.stepHeight, b.stepHeight);
    }
  }
  const bounds = rules.bounds;
  if (b.onGround && rules.conveyors) {
    for (const c of rules.conveyors) {
      if (b.pos.x < c.min.x || b.pos.x > c.max.x || b.pos.y < c.min.y || b.pos.y > c.max.y || b.pos.z < c.min.z || b.pos.z > c.max.z) continue;
      b.pos.x += c.vx * dt; b.pos.z += c.vz * dt;
    }
  }
  if (bounds && (b.pos.y < (rules.fallY ?? -12) || b.pos.x < bounds.minX - 8 || b.pos.x > bounds.maxX + 8 || b.pos.z < bounds.minZ - 8 || b.pos.z > bounds.maxZ + 8)) {
    ev.fell = true;
  }
  if (b.onGround && !state.lastGround) {
    const impact = clamp(-b.landVel / 14, 0, 1.5);
    ev.landed = true; ev.impact = impact;
    if (Math.hypot(b.vel.x, b.vel.z) > 9) state.landGraceT = 0.4;
    if (state.alive && rules.fallDamage) {
      const drop = -b.landVel;
      if (drop > 16) ev.fallDamage = Math.min(state.maxHp || 110, (drop - 16) * 6.2);
    }
  }
  state.lastGround = b.onGround;

  const maxSprint = rules.maxSprint || 0;
  if (maxSprint > 0 && rules.diff) {
    const D = rules.diff;
    if (state._sprinting) {
      state.sprintStam -= dt; state.sprintPause = D.sprintPause;
      if (state.sprintStam <= 0) { state.sprintStam = 0; state.sprintLock = true; state.sprintToggle = false; ev.outOfBreath = true; }
    } else if ((state.sprintPause -= dt) <= 0) {
      state.sprintStam = Math.min(maxSprint, state.sprintStam + maxSprint * D.sprintRegen * dt);
      if (state.sprintLock && state.sprintStam > maxSprint * 0.3) state.sprintLock = false;
    }
  }
  state.stamPause -= dt;
  if (state.grapple.state !== 'idle') state.grapStam -= STAM_DRAIN * dt;
  else if (state.stamPause <= 0) state.grapStam += (b.onGround ? STAM_GROUND : STAM_AIR) * dt;
  state.grapStam = clamp(state.grapStam, 0, 1);
  if (state.grapple.state === 'on' && state.grapStam <= 0) { detachGrapple(state, false, mob); ev.grappleOff = true; ev.winded = true; }

  if (state.center) state.center.set(b.pos.x, b.pos.y + b.height * 0.55, b.pos.z);
  if (state.eye) state.eye.set(b.pos.x, b.pos.y + (state.crouching ? EYE_CROUCH : EYE_STAND), b.pos.z);
  return ev;
}

// Pack / unpack the 6-byte input frame from NETCODE.md §5.2.
export function packInputFrame(input) {
  const yaw = ((input.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const yq = Math.max(0, Math.min(4095, Math.round(yaw / (Math.PI * 2) * 4095)));
  const pq = Math.max(0, Math.min(1023, Math.round((clamp(input.pitch || 0, -Math.PI / 2, Math.PI / 2) / (Math.PI / 2) + 1) * 0.5 * 1023)));
  const mx = Math.max(-32, Math.min(31, Math.round((input.moveX || 0) * 31)));
  const mz = Math.max(-32, Math.min(31, Math.round((input.moveY || 0) * 31)));
  let buttons = 0;
  if (input.fireDown) buttons |= 1;
  if (input.aimDown) buttons |= 2;
  if (input.jumpPressed) buttons |= 4;
  if (input.crouchDown) buttons |= 8;
  if (input.sprintDown) buttons |= 16;
  if (input.blockDown) buttons |= 32;
  if (input.grappleDown) buttons |= 64;
  if (input.reloadPressed) buttons |= 128;
  if (input.dashPressed) buttons |= 1 << 11;
  if (input.grapplePressed) buttons |= 1 << 12;
  if (input.crouchPressed) buttons |= 1 << 13;
  buttons |= ((input.slot || 0) & 7) << 8;
  const bits = BigInt(yq) | (BigInt(pq) << 12n) | (BigInt(mx + 32) << 22n) | (BigInt(mz + 32) << 28n) | (BigInt(buttons & 0x3fff) << 34n);
  return bits;
}

export function unpackInputFrame(bits) {
  const yq = Number(bits & 0xfffn);
  const pq = Number((bits >> 12n) & 0x3ffn);
  const mx = Number((bits >> 22n) & 0x3fn) - 32;
  const mz = Number((bits >> 28n) & 0x3fn) - 32;
  const buttons = Number((bits >> 34n) & 0x3fffn);
  return {
    yaw: yq / 4095 * Math.PI * 2,
    pitch: (pq / 1023 * 2 - 1) * (Math.PI / 2),
    moveX: mx / 31,
    moveY: mz / 31,
    fireDown: !!(buttons & 1),
    aimDown: !!(buttons & 2),
    jumpPressed: !!(buttons & 4),
    crouchDown: !!(buttons & 8),
    sprintDown: !!(buttons & 16),
    blockDown: !!(buttons & 32),
    grappleDown: !!(buttons & 64),
    reloadPressed: !!(buttons & 128),
    slot: (buttons >> 8) & 7,
    dashPressed: !!(buttons & (1 << 11)),
    grapplePressed: !!(buttons & (1 << 12)),
    crouchPressed: !!(buttons & (1 << 13)),
  };
}
