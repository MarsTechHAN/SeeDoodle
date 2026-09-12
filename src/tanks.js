import * as THREE from 'three';
import { makeBody, SEE_THROUGH } from './physics.js';
import { makeInkMaterial, INK } from './render.js';

export const TANK_HP = 88888;
const HALF = 1.5, HEIGHT = 2.2, ENTER = 3.5, STOP = .35, PULL = 1.5, FIRE_TIME = 1.5;
const DAMAGE = { rifle: 35, shotgun: 190, sniper: 225, revolver: 154, katana: 225, grenadeBash: 75, grenade: 93, rocket: 480, tank: 250 };
const RATE = { rifle: .065, shotgun: .55, sniper: .8, revolver: .2, katana: .25, grenadeBash: .3, grenade: .05, rocket: .55, tank: 1.35 };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const vec = a => new THREE.Vector3().fromArray(a);
const xyz = a => Array.isArray(a) && a.length === 3 && a.every(n => Number.isFinite(n) && Math.abs(n) < 10000);
const angle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const clone = s => JSON.parse(JSON.stringify(s));
const transparent = b => SEE_THROUGH(b) || b.data.tankHull === true;

// One seat and one simulation belong to the host. Peers send intentions; snapshots also carry
// ejection/destruction events so a missed packet cannot leave a passenger trapped or invulnerable.
export class TankSystem {
  constructor(ctx, { net, remote, match, lobby }) {
    Object.assign(this, { ctx, net, remote, match, lobby });
    ctx.tanks = this;
    this.root = this._model(); ctx.scene.add(this.root); this.root.visible = false;
    this.display = new THREE.Vector3(); this.prediction = null; this.state = null;
    this.inputs = new Map(); this.pulls = new Map(); this.lockouts = new Map(); this.damageClock = new Map(); this.blasts = new Map();
    this.sendAt = 0; this.inputAt = 0; this.syncAt = 0; this.fireAt = 0; this.serial = 0;
    this.stillSince = performance.now(); this.exitSeen = null; this.killSeen = null; this.fireSeen = null; this.fireUnlocked = false;
    this.localHold = 0; this._held = false; this._seat = false; this._round = null; this._dirty = false;
    net.on('tankreq', (d, from) => { if (this.authority) this._request(d, from); });
    net.on('tankstate', (d, from) => { if (!this.authority && from === net.hostId) this.receive(d); });
    net.on('tankfire', (d, from) => { if (from === net.hostId) this._fireEvent(d); });
    this.reset();
  }
  get authority() { return !this.net.connected || this.net.isHost; }
  get id() { return this.net.id || 'local'; }
  get round() { return this.match?.active() ? this.match.state?.round ?? 0 : 0; }
  get map() { return this.ctx.level.key || 'district'; }
  now() { return performance.now(); }
  active() { return ['play', 'dying'].includes(this.ctx.game.state) && !this.ctx.game.over && (!this.match?.active() || this.match.canFight()); }
  controlsAllowed() {
    const input = this.ctx.input;
    return this.active() && !this.ctx.game.menu && this.ctx.hud.el?.board?.hidden !== false && (input.pointerLocked || input.usingTouch || input.usingGamepad);
  }
  reset() {
    if (this._seat && this.ctx.player) this.ctx.player.rig.visible = true;
    this.inputs.clear(); this.pulls.clear(); this.lockouts.clear(); this.damageClock.clear(); this.blasts.clear();
    this._seat = false; this._held = false; this.localHold = 0; this.prediction = null; this._lastDriver = null; this._holdStart = null;
    for (const p of this.remote.values()) if (p.vehicleHidden) {
      p.vehicleHidden = false; if (p.root && p.alive && !p.away && !p.viewHidden) p.root.visible = true;
    }
    this.exitSeen = this.killSeen = this.fireSeen = null; this.fireAt = 0; this.serial = 0;
    this._round = this.round; this._level = this.ctx.level; this._egg = this.ctx.level.tankEgg;
    this._restoreEgg();
    const egg = this._egg, pos = xyz(egg?.spawn) ? egg.spawn.slice() : [0, -100, 0];
    this.state = { epoch: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, map: this.map, round: this.round,
      spawned: false, hp: TANK_HP, pos, yaw: Number(egg?.yaw) || 0, turret: Number(egg?.yaw) || 0, pitch: 0,
      driver: null, speed: 0, rev: 0, fireSerial: 0, exit: null, killed: null };
    this.body = makeBody(vec(pos), HALF, HEIGHT, .62); this.display.copy(this.body.pos); this.displayYaw = this.state.yaw; this.root.visible = false;
    this._dirty = true; this.syncAt = 0; this.stillSince = this.now(); this._ui(null);
    if (this.collider) this.collider.data.disabled = true;
    if (this.authority) this.publish(); else this._send({ op: 'sync' });
  }
  onHost() {
    this.inputs.clear(); this.pulls.clear(); this.damageClock.clear(); this.blasts.clear();
    this.fireAt = this.now() + FIRE_TIME * 1000;
    if (this.authority) {
      this.body.pos.fromArray(this.state.pos); this.body.vel.set(0, 0, 0); this.state.speed = 0;
      this.serial = Math.max(this.serial, this.state.fireSerial || 0); this.stillSince = this.now(); this.publish();
    } else this._send({ op: 'sync' });
  }
  publish() {
    if (!this.authority || !this.state) return;
    this.state.rev++; this._dirty = false; this.sendAt = this.now() + 100;
    if (this.net.connected) this.net.send('tankstate', clone(this.state));
    this._events();
  }
  receive(d) {
    if (!d || d.map !== this.map || d.round !== this.round || typeof d.epoch !== 'string' || d.epoch.length > 80 || !xyz(d.pos) ||
      !Number.isFinite(d.hp) || d.hp < 0 || d.hp > TANK_HP || ![d.yaw, d.turret, d.pitch, d.speed].every(Number.isFinite) ||
      !Number.isSafeInteger(d.rev) || (d.driver !== null && typeof d.driver !== 'string')) return;
    const fresh = !this.state || d.epoch !== this.state.epoch;
    if (!fresh && d.rev <= this.state.rev) return;
    const wasSpawned = this.state?.spawned;
    this.state = clone(d); this.body.pos.fromArray(d.pos); this.serial = Math.max(this.serial, d.fireSerial || 0);
    if (Math.abs(d.speed) >= STOP) this.stillSince = this.now();
    if (fresh || !wasSpawned || this.display.distanceToSquared(this.body.pos) > 225) this.display.copy(this.body.pos);
    if (d.spawned) this._breakEgg();
    this.syncAt = this.now() + 3000; this._events();
  }
  _send(d, owner = this.id) {
    d.epoch = this.state.epoch; d.round ??= this.round;
    if (d.op !== 'sync') d.life ??= this.match?.active() ? this.match.actor(owner)?.life : 0;
    if (this.authority) this._request(d, owner); else if (this.net.active) this.net.send('tankreq', d);
  }
  actor(id) {
    if (id === this.id) return this.ctx.player;
    return this.remote.get(id);
  }
  _alive(id) {
    const p = this.actor(id), a = this.match?.active() ? this.match.actor(id) : null;
    return !!p?.alive && !p.away && (!this.match?.active() || !!a?.alive) &&
      (id === this.id || !this.net.connected || !!this.lobby.players.get(id));
  }
  occupied(id = this.id) {
    return !!this.state?.spawned && this.state.hp > 0 && this.state.driver === id &&
      (!this.match?.active() || this.state.driverLife === this.match.actor(id)?.life);
  }
  _near(id, distance = ENTER) {
    const p = this.actor(id); if (!p?.body) return false;
    const hatch = vec(this.state.pos); hatch.y += 1.25;
    const center = p.center || p.body.pos.clone().add(new THREE.Vector3(0, 1, 0));
    return center.distanceTo(hatch) <= distance && this.ctx.world.hasLineOfSight(center, hatch, transparent);
  }
  _stopped() { return Math.abs(this.state.speed) < STOP && this.now() - this.stillSince >= 400; }
  hitEgg(br) {
    if (!br?.tankEgg || this.state.spawned || !this.active()) return false;
    this._send({ op: 'egg', id: br.id }); return true;
  }
  _breakEgg() {
    const br = this.ctx.level.breakables?.find(b => b.tankEgg);
    if (br?.alive) this.ctx.breakTankEgg?.(br);
  }
  _restoreEgg() {
    const br = this.ctx.level.breakables?.find(b => b.tankEgg); if (!br) return;
    if (this._templateEgg !== this._egg) { this._templateEgg = this._egg; this.eggTemplate = br.group.clone(true); return; }
    if (br.alive || !this.eggTemplate) return;
    const old = br.group; br.group = this.eggTemplate.clone(true); br.alive = true; br.hp = 1;
    const index = this.ctx.level.meshes.indexOf(old);
    if (index >= 0) this.ctx.level.meshes[index] = br.group; else this.ctx.level.meshes.push(br.group);
    this.ctx.scene.add(br.group);
    if (!this.ctx.world.boxes.includes(br.box)) { this.ctx.world.boxes.push(br.box); this.ctx.world.finalize(); }
  }
  _spawn() {
    const egg = this._egg; if (!egg || !xyz(egg.spawn)) return;
    this.body.pos.fromArray(egg.spawn); this.body.vel.set(0, 0, 0);
    if (this.ctx.world.overlapsBody(this.body)) return;
    const pos = this.body.pos;
    for (const actor of [this.ctx.player, ...this.remote.values()]) {
      if (!actor.alive || !actor.body) continue;
      const b = actor.body, width = b.halfW ?? .35, height = b.height ?? 1.75;
      if (Math.abs(b.pos.x - pos.x) < HALF + width && Math.abs(b.pos.z - pos.z) < HALF + width && b.pos.y < pos.y + HEIGHT && b.pos.y + height > pos.y) return;
    }
    this.state.spawned = true; this.state.hp = TANK_HP; this.state.pos = this.body.pos.toArray();
    this.display.copy(this.body.pos); this.stillSince = this.now(); this._breakEgg(); this.publish();
  }
  _request(d, from) {
    if (!d || typeof d.op !== 'string') return;
    if (d.op === 'sync') { if (this.net.connected) this.net.sendTo(from, 'tankstate', clone(this.state)); return; }
    const currentLife = this.match?.active() ? this.match.actor(from)?.life : 0;
    const delayedBlast = d.op === 'hit' && d.blast && ['grenade', 'rocket'].includes(d.source) && this.actor(from) &&
      (!this.match?.active() || (Number.isSafeInteger(d.life) && d.life >= 0 && d.life <= currentLife));
    if (d.epoch !== this.state.epoch || d.round !== this.round || !this.active() || (!this._alive(from) && !delayedBlast)) return;
    if (this.match?.active() && d.life !== currentLife && !delayedBlast) return;
    const s = this.state, now = this.now();
    if (d.op === 'egg') {
      if (s.spawned || !this._egg) return;
      const p = this.actor(from), br = this.ctx.level.breakables?.find(b => b.tankEgg);
      if (!br || d.id !== br.id || p.body.pos.distanceTo(vec(this._egg.spawn)) > 300) return;
      this._spawn(); return;
    }
    if (!s.spawned || s.hp <= 0) return;
    if (d.op === 'enter') {
      if (s.driver || !this._near(from) || (this.lockouts.get(from) || 0) > now || !this._stopped()) return;
      s.driver = from; s.driverLife = this.match?.actor(from)?.life ?? 0;
      this.inputs.clear(); this.pulls.clear(); this.fireAt = now + 350; this.fireUnlocked = false;
      s.turret = this.actor(from).yaw || s.yaw; s.pitch = 0; this.ctx.onTankEnter?.(from); this.publish();
    } else if (d.op === 'exit') {
      if (s.driver === from && this._stopped()) this._eject(from);
    } else if (d.op === 'pull') {
      if (!d.held) { this.pulls.delete(from); return; }
      if (!s.driver || s.driver === from || !this._stopped() || !this._near(from)) { this.pulls.delete(from); return; }
      const hold = this.pulls.get(from), token = Number.isFinite(d.hold) ? d.hold : 0;
      if (hold && now - hold.seen < 350 && hold.token === token) hold.seen = now;
      else this.pulls.set(from, { start: now, seen: now, driver: s.driver, token });
    } else if (d.op === 'drive') {
      if (s.driver !== from || ![d.throttle, d.steer, d.yaw, d.pitch].every(Number.isFinite)) return;
      if (!d.fire) this.fireUnlocked = true;
      this.inputs.set(from, { throttle: clamp(d.throttle, -1, 1), steer: clamp(d.steer, -1, 1),
        yaw: Math.atan2(Math.sin(d.yaw), Math.cos(d.yaw)), pitch: clamp(d.pitch, -.55, .65), brake: !!d.brake, fire: !!d.fire, at: now });
    } else if (d.op === 'hit') this._damage(d, from);
  }
  _exitPosition(id) {
    const s = this.state, start = s.yaw;
    for (const radius of [2.8, 3.6, 4.6]) for (const offset of [Math.PI / 2, -Math.PI / 2, Math.PI, 0, .75, -.75, 2.4, -2.4]) {
      const pos = vec(s.pos); pos.x += Math.sin(start + offset) * radius; pos.z += Math.cos(start + offset) * radius;
      const ground = this.ctx.world.groundBelow(pos.x, pos.y + 2, pos.z, 6);
      if (ground < s.pos[1] - 2.5 || ground > s.pos[1] + 1.8 || ground < (this.ctx.level.fallY ?? -15)) continue;
      pos.y = ground + .03;
      const b = makeBody(pos, .36, 1.75, .55);
      if (this.ctx.world.overlapsBody(b)) continue;
      const hatch = vec(s.pos).add(new THREE.Vector3(0, 1.6, 0)), eye = pos.clone().add(new THREE.Vector3(0, 1.5, 0));
      if (!this.ctx.world.hasLineOfSight(hatch, eye, transparent)) continue;
      let occupied = false;
      for (const [other, actor] of this.remote) if (other !== id && actor.alive && actor.body.pos.distanceTo(pos) < .85) { occupied = true; break; }
      if (id !== this.id && this.ctx.player.alive && this.ctx.player.body.pos.distanceTo(pos) < .85) occupied = true;
      if (!occupied) return pos;
    }
    return null;
  }
  _eject(id) {
    const pos = this._exitPosition(id); if (!pos) return false;
    const s = this.state;
    s.exit = { id, pos: pos.toArray(), seq: (s.exit?.seq || 0) + 1, life: s.driverLife || 0 };
    s.driver = null; s.speed = 0; this.body.vel.set(0, 0, 0); this.lockouts.set(id, this.now() + 2000);
    this.inputs.clear(); this.pulls.clear(); this.publish(); return true;
  }
  _destroy(by) {
    if (this.state.hp <= 0) return;
    const s = this.state, id = s.driver; s.hp = 0; s.speed = 0; s.driver = null;
    if (id) s.killed = { id, by: by || null, seq: (s.killed?.seq || 0) + 1, life: s.driverLife || 0 };
    this.body.vel.set(0, 0, 0); this.inputs.clear(); this.pulls.clear(); this.publish();
  }
  _events() {
    const s = this.state;
    const exit = s.exit, killed = s.killed;
    if (exit && this.exitSeen !== `${s.epoch}:${exit.seq}` && xyz(exit.pos)) {
      this.exitSeen = `${s.epoch}:${exit.seq}`;
      if (exit.id === this.id && (this._seat || this._lastDriver === this.id) && (!this.match?.active() || exit.life === this.match.actor(this.id)?.life)) {
        const p = this.ctx.player; p.body.pos.fromArray(exit.pos); p.body.vel.set(0, 0, 0); p.body.onGround = true;
        p._stepOffset = 0; p.rig.visible = true; p.shieldT = 0; this._seat = false; this.prediction = null; this._lastDriver = null;
      }
    }
    if (killed && this.killSeen !== `${s.epoch}:${killed.seq}`) {
      const local = killed.id === this.id && (this._seat || this._lastDriver === this.id) &&
        (!this.match?.active() || killed.life === this.match.actor(this.id)?.life);
      // A pause can outlive a destruction notification. Consume it only when the death hook can
      // apply it, or when this player has already died; a later life must never inherit the event.
      if (!local || !this.ctx.player.alive || this.ctx.game.state === 'play') {
        this.killSeen = `${s.epoch}:${killed.seq}`;
        if (local) { if (this.ctx.player.alive) this.ctx.forceTankDeath?.(killed.by); this._lastDriver = null; }
      }
    }
    if (s.spawned && s.hp <= 0 && this.boomSeen !== s.epoch) {
      this.boomSeen = s.epoch; this.ctx.effects.boom(vec(s.pos).add(new THREE.Vector3(0, 1, 0)), 8); this.ctx.audio.explosion?.(vec(s.pos));
    }
    if (s.driver) this._lastDriver = s.driver;
  }
  raycast(o, d, maxDist = 1000) {
    const s = this.state; if (!s?.spawned || s.hp <= 0) return null;
    const p = this.root.position, min = [p.x - HALF, p.y + .15, p.z - HALF], max = [p.x + HALF, p.y + HEIGHT, p.z + HALF];
    let lo = 0, hi = maxDist, axis = 1, sign = 1;
    for (let a = 0; a < 3; a++) {
      const key = ['x', 'y', 'z'][a], origin = o[key], dir = d[key];
      if (Math.abs(dir) < 1e-8) { if (origin < min[a] || origin > max[a]) return null; continue; }
      let near = (min[a] - origin) / dir, far = (max[a] - origin) / dir, n = -1;
      if (near > far) { [near, far] = [far, near]; n = 1; }
      if (near > lo) { lo = near; axis = a; sign = n; }
      hi = Math.min(hi, far); if (lo > hi) return null;
    }
    const normal = new THREE.Vector3(); normal.setComponent(axis, sign);
    return { dist: lo, point: new THREE.Vector3().copy(o).addScaledVector(d, lo), normal, tank: true };
  }
  hit(amount, info = {}) {
    if (!this.state.spawned || this.state.hp <= 0 || !this.active()) return false;
    const point = info.point?.toArray?.() || info.point || this.state.pos;
    this._send({ op: 'hit', amount, source: info.source || 'rifle', point, center: info.center?.toArray?.() || info.center,
      radius: info.radius, blast: info.blast, token: (info.gid ?? info.id) == null ? undefined : String(info.gid ?? info.id),
      life: info.life, round: info.round, dir: info.dir?.toArray?.() || info.dir, origin: info.origin?.toArray?.() || info.origin }, this.authority ? info.owner || this.id : this.id);
    return true;
  }
  blast(center, radius, amount, info = {}) {
    if (!this.state.spawned || this.state.hp <= 0 || !Number.isFinite(radius) || radius <= 0) return false;
    const p = this.root.position, point = new THREE.Vector3(clamp(center.x, p.x - HALF, p.x + HALF), clamp(center.y, p.y + .15, p.y + HEIGHT), clamp(center.z, p.z - HALF, p.z + HALF));
    const d = point.distanceTo(center); if (d > radius || !this.ctx.world.hasLineOfSight(center, point, transparent)) return false;
    return this.hit(amount * (1 - .6 * d / radius), { ...info, source: info.source || 'grenade', point, center, radius, blast: true });
  }
  melee(pos, dir, range, amount, info = {}) {
    const hit = this.raycast(pos, dir, range); if (!hit || !this.ctx.world.hasLineOfSight(pos, hit.point, transparent)) return false;
    return this.hit(amount, { ...info, source: info.source || 'katana', point: hit.point });
  }
  absorbDamage(amount, from) {
    if (!this.occupied() || !this.ctx.player.alive) return false;
    if (this.authority && this.active() && Number.isFinite(amount) && amount > 0) {
      const loss = Math.min(amount, 480);
      if (this.state.hp <= loss) this._destroy(null); else { this.state.hp -= loss; this._dirty = true; }
    } else if (this.net.active) this._send({ op: 'hit', source: 'enemy', amount, point: this.state.pos, origin: from?.toArray?.() });
    return true;
  }
  _damage(d, from) {
    const s = this.state, now = this.now(), enemy = d.source === 'enemy' && (this.ctx.game.mode === 'coop' || this.ctx.game.mode === 'solo');
    if (!Number.isFinite(d.amount) || d.amount <= 0 || (!enemy && !DAMAGE[d.source])) return;
    if (s.driver && s.driver !== from && this.match?.active() && this.match.actor(from) && this.match.actor(s.driver) && this.match.team(from) === this.match.team(s.driver)) return;
    if (s.driver === from && !enemy && !d.blast) return;
    const p = this.actor(from), point = xyz(d.point) ? vec(d.point) : null;
    if (!point || point.distanceTo(vec(s.pos).add(new THREE.Vector3(0, 1, 0))) > 5) return;
    const radius = d.source === 'grenade' ? 9.6 : 12;
    let origin = p.eye || p.body.pos;
    if (xyz(d.origin) && vec(d.origin).distanceTo(origin) < 3) origin = vec(d.origin);
    if (enemy) { if (s.driver !== from) return; }
    else if (d.blast) {
      if (!xyz(d.center) || !Number.isFinite(d.radius) || d.radius <= 0 || d.radius > radius + .1) return;
      origin = vec(d.center); if (origin.distanceTo(point) > d.radius + 2 || origin.distanceTo(p.body.pos) > 160) return;
    } else if (origin.distanceTo(point) > (d.source === 'katana' || d.source === 'grenadeBash' ? 7 : 300)) return;
    if (!enemy && !this.ctx.world.hasLineOfSight(origin, point, transparent)) return;
    const key = `${from}:${d.source}`, last = this.damageClock.get(key);
    const pellet = d.source === 'shotgun' && last && now - last.at < 45 && last.amount < DAMAGE.shotgun;
    if (!pellet && last && now - last.at < (RATE[d.source] || .04) * 1000) return;
    if (d.blast) {
      const token = typeof d.token === 'string' && d.token.length < 120 ? d.token : `${d.center.map(n => Math.round(n * 4)).join(',')}:${Math.floor(now / 500)}`;
      const seen = `${from}:${d.source}:${token}`; if (this.blasts.has(seen)) return;
      this.blasts.set(seen, now + 15000);
    }
    const amount = Math.min(d.amount, enemy ? 480 : DAMAGE[d.source], pellet ? DAMAGE.shotgun - last.amount : Infinity);
    this.damageClock.set(key, { at: pellet ? last.at : now, amount: (pellet ? last.amount : 0) + amount });
    if (s.hp <= amount) this._destroy(from); else { s.hp -= amount; this._dirty = true; }
  }
  action() {
    if (!this.controlsAllowed() || !this.ctx.player.alive) return;
    if (this.occupied()) this._send({ op: 'exit' });
    else if (this.state.spawned && this.state.hp > 0 && !this.state.driver) this._send({ op: 'enter' });
  }
  cancelInput() {
    this.localHold = 0; this._held = false;
    this._send({ op: 'pull', held: false });
    if (this.occupied()) this._send({ op: 'drive', throttle: 0, steer: 0, yaw: this.ctx.player.yaw, pitch: this.ctx.player.pitch, brake: true, fire: false });
  }
  updatePlayer(p, dt) {
    if (!this.occupied() || !p.alive) { if (this._seat) { p.rig.visible = true; this._seat = false; this.prediction = null; } return false; }
    const inp = this.ctx.input, now = this.now(), enabled = this.controlsAllowed() && (!this.ctx.combatInputAllowed || this.ctx.combatInputAllowed());
    if (!this._seat) {
      p.cancelGrenade?.(); p.cancelKnife?.(); p.detachGrapple?.(false); p._stepOffset = 0; p.sliding = false; p.crouching = false;
      p.pitch = this.state.pitch; p.yaw = this.state.turret; this._seat = true; this.inputAt = 0; this.localFireReady = !inp.down('fire');
    }
    if (enabled) { p.yaw += inp.look.x; p.pitch = clamp(p.pitch + inp.look.y, -.55, .65); }
    if (!inp.down('fire')) this.localFireReady = true;
    this.localControl = { throttle: enabled ? inp.move.y : 0, steer: enabled ? inp.move.x : 0, yaw: p.yaw, pitch: p.pitch,
      brake: !enabled || inp.down('jump'), fire: enabled && this.localFireReady && inp.down('fire'), at: now };
    if (now >= this.inputAt) { this._send({ op: 'drive', ...this.localControl }); this.inputAt = now + 100; }
    if (this.authority) { this.inputs.set(this.id, this.localControl); if (!this.localControl.fire) this.fireUnlocked = true; }
    this._seatPose(p); return true;
  }
  _seatPose(p) {
    const pos = this.display, motion = !this.authority && this.prediction ? this.prediction.state : this.state;
    p.body.pos.copy(pos); p.body.vel.set(-Math.sin(motion.yaw) * motion.speed, this.body.vel.y, -Math.cos(motion.yaw) * motion.speed);
    p.body.onGround = true; p.speed = Math.abs(motion.speed);
    p.eye.copy(pos).add(new THREE.Vector3(0, 2.4, 0)); p.center.copy(pos).add(new THREE.Vector3(0, 1.25, 0));
    p.forward.set(-Math.sin(p.yaw) * Math.cos(p.pitch), Math.sin(p.pitch), -Math.cos(p.yaw) * Math.cos(p.pitch));
    p.right.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw)); p.camera.position.copy(p.eye); p.camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
    p.aimOrigin.copy(p.eye); p.aimFwd.copy(p.forward); p.aimRight.copy(p.right); p.rig.visible = false; p.firing = false; p._aiming = false;
    p.ctx.hud.setScope(false); p.ctx.hud.setAds(false);
    if (Math.abs(p.camera.fov - p.opt.fov) > .1) { p.camera.fov = p.opt.fov; p.camera.updateProjectionMatrix(); }
  }
  _simulate(body, s, control, dt) {
    const c = control || { throttle: 0, steer: 0, brake: true }, target = c.brake ? 0 : c.throttle * (c.throttle < 0 ? 4 : 8);
    s.speed += clamp(target - s.speed, -(c.brake ? 18 : 7) * dt, (c.brake ? 18 : 7) * dt);
    if (Math.abs(s.speed) < .02) s.speed = 0;
    s.yaw -= c.steer * 1.15 * dt * (s.speed < -.1 ? -1 : 1);
    body.vel.x = -Math.sin(s.yaw) * s.speed; body.vel.z = -Math.cos(s.yaw) * s.speed; body.vel.y -= 26 * dt;
    const previous = body.pos.clone(), disabled = this.collider?.data.disabled;
    if (this.collider) this.collider.data.disabled = true;
    try { this.ctx.world.moveBody(body, dt); } finally { if (this.collider) this.collider.data.disabled = disabled; }
    const bounds = this.ctx.level.bounds;
    if (bounds) for (const axis of ['x', 'z']) {
      const suffix = axis.toUpperCase(), min = bounds[`min${suffix}`], max = bounds[`max${suffix}`];
      if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
      const position = clamp(body.pos[axis], min + HALF, max - HALF);
      if (position !== body.pos[axis]) { body.pos[axis] = position; body.vel[axis] = 0; s.speed = 0; }
    }
    const moved = Math.hypot(body.pos.x - previous.x, body.pos.z - previous.z);
    if (moved < Math.abs(s.speed) * dt * .25) s.speed *= .5;
    s.pos = body.pos.toArray();
  }
  update(dt) {
    dt = Math.min(.05, Math.max(0, dt));
    if (this._level !== this.ctx.level || this._egg !== this.ctx.level.tankEgg || this._round !== this.round) this.reset();
    const now = this.now(), s = this.state;
    this._events();
    if (!this.authority && this.net.active && now >= this.syncAt) { this._send({ op: 'sync' }); this.syncAt = now + 3000; }
    if (this.authority && s.spawned && s.hp > 0) {
      if (s.driver && (!this._alive(s.driver) || (this.match?.active() && s.driverLife !== this.match.actor(s.driver)?.life))) {
        s.driver = null; s.speed = 0; this.inputs.clear(); this.pulls.clear(); this._dirty = true;
      }
      const input = this.inputs.get(s.driver), valid = this.active() && input && now - input.at <= 350;
      const pausedOffline = !this.net.connected && (this.ctx.game.state === 'pause' || this.ctx.game.menu);
      if (pausedOffline) { s.speed = 0; this.body.vel.x = 0; this.body.vel.z = 0; }
      else this._simulate(this.body, s, valid ? input : null, dt);
      if (Math.abs(s.speed) >= STOP || (valid && Math.abs(input.steer) > .1)) { this.stillSince = now; this.pulls.clear(); }
      if (valid) { s.turret = input.yaw; s.pitch = input.pitch; }
      if (!pausedOffline && this.body.pos.y < (this.ctx.level.fallY ?? -15)) this._destroy(s.driver);
      if (s.hp > 0 && valid && input.fire && this.fireUnlocked && now >= this.fireAt) this._fire();
      for (const [id, hold] of this.pulls) {
        if (!this.active() || !this._stopped() || hold.driver !== s.driver || now - hold.seen > 350 || !this._alive(id) || !this._near(id)) this.pulls.delete(id);
        else if (now - hold.start >= PULL * 1000) { this._eject(s.driver); break; }
      }
      for (const [key, until] of this.blasts) if (now > until) this.blasts.delete(key);
      if (this._dirty || now >= this.sendAt) this.publish();
      this.display.lerp(this.body.pos, 1 - Math.exp(-24 * dt));
    } else if (!this.authority && this.occupied() && this.localControl) {
      if (!this.prediction) this.prediction = { body: makeBody(vec(s.pos), HALF, HEIGHT, .62), state: { ...s } };
      const p = this.prediction, difference = p.body.pos.distanceTo(this.body.pos);
      if (difference > 4) p.body.pos.copy(this.body.pos); else p.body.pos.lerp(this.body.pos, 1 - Math.exp(-5 * dt));
      p.state.yaw = angle(p.state.yaw, s.yaw, 1 - Math.exp(-5 * dt));
      this._simulate(p.body, p.state, this.active() ? this.localControl : null, dt);
      this.display.lerp(p.body.pos, 1 - Math.exp(-24 * dt));
    } else this.display.lerp(this.body.pos, 1 - Math.exp(-14 * dt));
    if (this.authority && !s.spawned && now >= this.sendAt) { this.publish(); this.sendAt = now + 1000; }
    this.root.visible = !!s.spawned && s.hp > 0 && ['play', 'dying', 'pause', 'over'].includes(this.ctx.game.state);
    const heading = !this.authority && this.occupied() && this.prediction ? this.prediction.state.yaw : s.yaw;
    this.displayYaw = angle(this.displayYaw, heading, 1 - Math.exp(-20 * dt));
    this.root.position.copy(this.display); this.root.rotation.y = this.displayYaw;
    this.turret.rotation.y = (this.occupied() ? this.ctx.player.yaw : s.turret) - this.displayYaw;
    this.barrel.rotation.x = this.occupied() ? this.ctx.player.pitch : s.pitch;
    this._collider();
    if (this.occupied() && this.ctx.player.alive && this._seat) this._seatPose(this.ctx.player);
    for (const [id, p] of this.remote) {
      const wasHidden = p.vehicleHidden; p.vehicleHidden = this.occupied(id);
      if (p.vehicleHidden) { if (p.root) p.root.visible = false; if (p.nameTag) p.nameTag.hidden = true; p.rope.visible = false; p.hook.visible = false; }
      else if (wasHidden && p.root && p.alive && !p.away && !p.viewHidden) p.root.visible = true;
    }
    this._interaction(dt, now);
  }
  _interaction(dt, now) {
    const inp = this.ctx.input, s = this.state, playing = this.controlsAllowed() && this.ctx.player.alive;
    const near = s.spawned && s.hp > 0 && this._near(this.id), driving = this.occupied();
    if (playing && inp.pressed('vehicle')) this.action();
    const timing = inp.holdTiming?.('vehicle'), held = playing && near && !driving && !!s.driver && this._stopped() && inp.down('vehicle') && timing?.held !== false;
    if (held) {
      const start = timing?.start ?? this._holdStart ?? now;
      if (this._holdStart !== start) { this.localHold = 0; this._held = false; this._holdStart = start; }
      this.localHold = Math.min(PULL, this.localHold + dt);
      if (!this._held || now >= this.pullAt) { this._send({ op: 'pull', held: true, hold: this._holdStart }); this.pullAt = now + 100; }
    } else { this.localHold = 0; this._holdStart = null; if (this._held) this._send({ op: 'pull', held: false }); }
    this._held = held;
    if (!playing || (!near && !driving) || this.ctx.hud.el?.board?.hidden === false) { this._ui(null); return; }
    const stopped = this._stopped(), action = driving ? (stopped ? 'exit' : null) : stopped ? (s.driver ? 'hijack' : 'enter') : null;
    this._ui({ hp: Math.ceil(s.hp), maxHp: TANK_HP, driving, speed: Math.abs(s.speed), action, stopped,
      progress: this.localHold / PULL, cooldown: Math.max(0, (this.fireAt - now) / 1000) });
  }
  _ui(status) { this.ctx.hud.setTank?.(status); this.ctx.touch?.setVehicle?.(status); }
  _collider() {
    const world = this.ctx.world;
    if (this.collider && world.dynamicBoxes && !world.dynamicBoxes.includes(this.collider)) this.collider = null;
    if (!this.collider && world.addDynamicBox) this.collider = world.addDynamicBox(new THREE.Vector3(), new THREE.Vector3(), { tankHull: true, noNav: true, noGrapple: true, noShoot: true, disabled: true });
    if (!this.collider) return;
    const p = this.root.position;
    Object.assign(this.collider.min, { x: p.x - HALF, y: p.y + .15, z: p.z - HALF });
    Object.assign(this.collider.max, { x: p.x + HALF, y: p.y + HEIGHT, z: p.z + HALF });
    this.collider.data.disabled = !this.root.visible;
  }
  _fire() {
    const s = this.state; this.fireAt = this.now() + FIRE_TIME * 1000;
    const dir = new THREE.Vector3(-Math.sin(s.turret) * Math.cos(s.pitch), Math.sin(s.pitch), -Math.cos(s.turret) * Math.cos(s.pitch));
    const pos = vec(s.pos).add(new THREE.Vector3(0, 2.4, 0)), wall = this.ctx.world.raycast(pos, dir, 1.7, transparent);
    pos.addScaledVector(dir, wall ? Math.max(0, wall.dist - .04) : 1.7);
    s.fireSerial = ++this.serial;
    const event = { serial: this.serial, driver: s.driver, epoch: s.epoch, round: s.round, life: s.driverLife || 0, pos: pos.toArray(), dir: dir.toArray() };
    if (this.net.connected) this.net.send('tankfire', event);
    this._fireEvent(event);
  }
  _fireEvent(d) {
    if (!d || d.epoch !== this.state.epoch || d.round !== this.round || !xyz(d.pos) || !xyz(d.dir) || !Number.isSafeInteger(d.serial)) return;
    const key = `${d.epoch}:${d.serial}`; if (key === this.fireSeen || (this.fireEpoch === d.epoch && d.serial <= this.seenSerial)) return;
    this.fireSeen = key; this.fireEpoch = d.epoch; this.seenSerial = d.serial; this.serial = Math.max(this.serial, d.serial);
    this.fireAt = this.now() + FIRE_TIME * 1000;
    this.ctx.fireTankCannon?.(d);
  }
  _model() {
    const root = new THREE.Group(), armor = makeInkMaterial({ ink: INK.OLIVE, surface: 'metal', shadeBias: .08 }); root.userData.noSun = true;
    const dark = makeInkMaterial({ ink: INK.BLACK, surface: 'metal', shadeBias: -.25 }), edge = makeInkMaterial({ ink: INK.BROWN, surface: 'metal' });
    const box = (parent, x, y, z, w, h, d, mat) => { const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); mesh.position.set(x, y, z); parent.add(mesh); return mesh; };
    box(root, 0, .9, 0, 2.35, .8, 3, armor); box(root, 0, 1.35, -.1, 2.08, .2, 2.65, armor);
    for (const x of [-1.16, 1.16]) {
      box(root, x, .55, .08, .5, .78, 3.15, dark);
      for (let i = 0; i < 5; i++) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(.28, .28, .53, 10), edge);
        wheel.rotation.z = Math.PI / 2; wheel.position.set(x, .54, -1.12 + i * .59); root.add(wheel);
      }
      box(root, x, 1.05, -.02, .57, .12, 3.2, armor);
    }
    const turret = this.turret = new THREE.Group(); turret.position.y = 1.47; root.add(turret);
    box(turret, 0, .25, .05, 1.6, .57, 1.65, armor); box(turret, 0, .59, .2, .82, .13, .78, dark);
    box(turret, .18, .7, .2, .35, .1, .22, edge);
    const barrel = this.barrel = new THREE.Group(); barrel.position.set(0, .3, -.75); turret.add(barrel);
    const cannon = new THREE.Mesh(new THREE.CylinderGeometry(.105, .15, 1.95, 10), armor); cannon.rotation.x = Math.PI / 2; cannon.position.z = -.82; barrel.add(cannon);
    box(barrel, 0, 0, -1.78, .33, .25, .26, dark);
    for (const x of [-.87, .87]) box(root, x, 1.01, -1.53, .24, .16, .1, edge);
    return root;
  }
}
