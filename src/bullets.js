// Player bullets that actually have to get there.
//
// Hitscan resolves a shot in the frame it is fired: the ray is instant, so aim is the whole of it.
// With this on, a round leaves the muzzle at a few hundred metres a second and falls at 9.8 the
// whole way, which puts a lead and a hold on any shot far enough out to notice - and makes a sniper
// duel about where somebody will be rather than where they are.
//
// The pool is the one `Projectiles` in enemies.js already proves out: a single InstancedMesh of
// unit boxes stretched along the velocity, `instanceColor` carrying [ink, filled, 0]. What differs
// is the resolve: an enemy bullet only ever looks for the local player, while these go through
// `Gun.resolveShot` and so hit enemies, players, breakables and walls exactly as an instant shot
// would - the same code path, just handed one step of the arc at a time.
import * as THREE from 'three';
import { makeInkMaterial, INK } from './render.js';
import { SEE_THROUGH } from './physics.js';
import { clamp } from './util.js';

const _d = new THREE.Vector3(), _v = new THREE.Vector3();
const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const G = 9.8;

export class Bullets {
  constructor(ctx) {
    this.ctx = ctx; this.list = []; this.max = 256;
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), makeInkMaterial({ ink: INK.BLUE, fill: true }), this.max);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 3), 3);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.mesh.frustumCulled = false; this.mesh.count = 0;
    ctx.scene.add(this.mesh);
  }
  // `gun` is what resolves the hit, so it is only optional for a cosmetic round - somebody else's
  // shot, drawn on this screen so the flight is visible, but settled entirely on their machine.
  fire(gun, origin, dir, opts = {}) {
    if (this.list.length >= this.max) this.list.shift();
    const mv = opts.mv || (gun && gun.mv) || 330;
    const b = {
      gun, pos: origin.clone(), prev: origin.clone(), origin: origin.clone(),
      vel: dir.clone().normalize().multiplyScalar(mv),
      travelled: 0, t: 0, life: 4, cosmetic: !!opts.cosmetic,
      thick: opts.thick || (gun && gun.tracer) || 0.02,
      maxRange: opts.maxRange || (gun && gun.maxRange) || 300,
      ink: opts.ink === undefined ? INK.BLUE : opts.ink,
      // A rocket motor holds the round up: it droops enough to need a hold at range, nowhere near
      // enough to fall like a bullet. Zero direct damage — the blast is the whole of the weapon.
      grav: opts.grav ?? (gun && gun.grav) ?? G,
      explosive: opts.explosive ?? !!(gun && gun.explosive),
      blastR: opts.blastR || (gun && gun.blastR) || 5.6,
      blastDmg: (gun && gun.blastDmg) || 0,
    };
    this.list.push(b);
    if (!b.cosmetic && opts.notify !== false && this.ctx.onBullet) this.ctx.onBullet(b);
    return b;
  }
  clear() { this.list.length = 0; this.mesh.count = 0; }
  // Somebody else's rocket flown here for the look of it still has to make a bang -- `mine: false`
  // gives the boom and the shove without letting this machine decide what it killed.
  _detonate(b, point) {
    this.ctx.player.explode(point, { R: b.blastR, enemyDmg: b.blastDmg, mine: !b.cosmetic, selfDamage: !b.invalidMatchLife, lift: 0, push: 11, selfBase: 12, selfMax: 58, pvpBase: 25, pvpMax: 115 });
  }
  update(dt) {
    const ctx = this.ctx, world = ctx.world, list = this.list;
    let n = 0, pelletHit = false;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      // A delayed local bullet may still be drawn after a round/life reset, but its old
      // firing input must never become damage credited to the player's new life.
      if (b.matchRound != null && (ctx.match?.state?.round !== b.matchRound || ctx.match.actor(ctx.match.net.id)?.life !== b.matchLife)) { b.cosmetic = true; b.invalidMatchLife = true; }
      b.life -= dt; if (b.life <= 0) { if (b.explosive) this._detonate(b, b.pos); continue; }
      b.prev.copy(b.pos); b.vel.y -= b.grav * dt; b.pos.addScaledVector(b.vel, dt); b.t += dt;
      _d.subVectors(b.pos, b.prev); const len = _d.length();
      if (len < 1e-6) { list[n++] = b; continue; }
      _d.divideScalar(len);
      if (b.explosive) {
        // A warhead does not care what it met, only where. Take the nearest of wall, bot and player
        // and go off there -- no direct-hit damage path at all, so a rocket that clips a shoulder
        // and one that lands at your feet do the same thing.
        const hw = world.raycast(b.prev, _d, len, SEE_THROUGH);
        let best = hw ? { d: hw.dist, p: hw.point } : null;
        if (!b.cosmetic) {
          const he = ctx.enemies.raycast(b.prev, _d, len);
          if (he && (!best || he.dist < best.d)) best = { d: he.dist, p: he.point };
          const hp = ctx.raycastPlayers ? ctx.raycastPlayers(b.prev, _d, len) : null;
          if (hp && (!best || hp.dist < best.d)) best = { d: hp.dist, p: hp.point };
        }
        if (best) { this._detonate(b, best.p); continue; }
      } else if (b.cosmetic) {
        const hw = world.raycast(b.prev, _d, len, SEE_THROUGH);
        if (hw) { ctx.effects.bulletImpact(hw.point, hw.normal, b.ink); continue; }
      } else {
        const r = b.gun.resolveShot(b.prev, _d, len, b.travelled, b.origin, b.t);
        if (r.hit && b.gun.kind === 'shotgun') pelletHit = true;
        if (r.stopped) continue;
      }
      b.travelled += len;
      if (b.travelled > b.maxRange) { if (b.explosive) this._detonate(b, b.pos); continue; }
      list[n++] = b;
    }
    list.length = n;
    for (let i = 0; i < n; i++) {
      const b = list[i]; const sp = b.vel.length(); _v.copy(b.vel).divideScalar(sp); _q.setFromUnitVectors(_up, _v);
      _s.set(b.thick, clamp(sp * 0.02, 0.35, 0.9), b.thick); _m.compose(b.pos, _q, _s); this.mesh.setMatrixAt(i, _m);
      const c = this.mesh.instanceColor.array; c[i * 3] = b.ink; c[i * 3 + 1] = 1; c[i * 3 + 2] = 0;
    }
    this.mesh.count = n; this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor.needsUpdate = true;
    // a shotgun landing anything is worth a beat of hitstop, the way the instant version gets one
    // from its own return value - here the pellets land over several frames, so it is once per frame
    if (pelletHit) ctx.game.hitstop(0.03, 0.3);
  }
}
