// First-person player: movement (sprint/slide/wall-jump/mantle/air dash), swing-grapple, camera feel, health, weapons.
import * as THREE from 'three';
import { makeBody } from './physics.js';
import { makeInkMaterial, INK } from './render.js';
import { Rifle, Shotgun, Sniper, Katana, Rocket, Grenade } from './weapons.js';
// the dome shell and anything else flagged this way cannot be hooked
const NO_GRAPPLE = (b) => !!b.data.noGrapple;
const STAM_FIRE = 0.09, STAM_DRAIN = 0.08, STAM_GROUND = 0.4, STAM_AIR = 0.2, STAM_MIN = 0.18, STAM_PAUSE = 0.5, PARRY_WINDOW = 0.55;
import { clamp, damp, rand, Spring, alignYAxis } from './util.js';
import { audio } from './audio.js';
import { OPT_DEFAULTS, diffOf, mobOf, MOB_FULL, weaponModeOf } from './settings.js';

const G = 26, WALK = 6.6, SPRINT = 10.6, CROUCH = 3.6, ACCEL = 140, FRICTION = 8, AIR_ACCEL = 36, AIR_CAP = 7.5, JUMP = 9.6;
const STAND_H = 1.75, CROUCH_H = 1.05, EYE_STAND = 1.6, EYE_CROUCH = 0.88;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _d = new THREE.Vector3(), _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _down = new THREE.Vector3(0, -1, 0);

export class Player {
  constructor(ctx) {
    this.ctx = ctx; this.camera = ctx.camera; this.camera.rotation.order = 'YXZ';
    // The config panel owns this object and edits it in place, so every read below is live. The
    // fallback is for benches and tools that build a Player without a config attached.
    this.opt = ctx.opt || (ctx.opt = { ...OPT_DEFAULTS });
    this.body = makeBody(ctx.level.playerStart, 0.35, STAND_H, 0.55);
    this.yaw = 0; this.pitch = 0; this.maxHp = 120; this.hp = 120; this.alive = true; this.regenDelay = 4.5; this.regenRate = 11; this.maxSprint = 0; this.sprintStam = 0; this.sprintPause = 0; this.sprintLock = false; this.nadeCharge = 0; this._nadeHeld = false; this.grapStam = 1; this.blockHeld = 0; this.stamPause = 0;
    this.eye = new THREE.Vector3(); this.center = new THREE.Vector3(); this.forward = new THREE.Vector3(0, 0, -1); this.right = new THREE.Vector3(1, 0, 0);
    // Where the camera actually ended up last frame, recoil springs and shake included. `forward`
    // is the clean look direction and drives movement; this is the one the crosshair sits on, so
    // it is the one shots have to use or the reticle is lying about where the bullet goes.
    this.aimOrigin = new THREE.Vector3(); this.aimFwd = new THREE.Vector3(0, 0, -1); this.aimRight = new THREE.Vector3(1, 0, 0);
    this.speed = 0; this.hurtFx = 0; this.flashFx = 0; this.lastDamageT = 10;
    this.rig = new THREE.Group(); this.camera.add(this.rig); ctx.scene.add(this.camera);
    // Keep these indices stable: snapshots and the numbered keys share them. Grenades get their
    // own hand model for grenade-only matches; in ordinary matches they remain a side action.
    this.weapons = [new Rifle(ctx), new Shotgun(ctx), new Sniper(ctx), new Katana(ctx), new Rocket(ctx), new Grenade(ctx)]; this.katanaIndex = 3; this.rocketIndex = 4; this.grenadeIndex = 5;
    this.weaponRules = weaponModeOf();
    for (const w of this.weapons) { this.rig.add(w.root); if (w.isGun) w.startReserve = w.reserve; }
    this.weaponIndex = 0; this.weapon = this.weapons[0]; this.weapon.equip(); this.returnT = 0; this.prevWeaponIndex = 0;
    this.recoilPitch = new Spring(190, 17); this.recoilYaw = new Spring(190, 17); this.fovKick = new Spring(220, 14); this.landDip = new Spring(170, 15);
    this.roll = 0; this.fov = this.opt.fov; this.bobPhase = 0; this.bobAmt = 0; this.stepDist = 0; this.eyeH = EYE_STAND;
    this.crouching = false; this.sliding = false; this.slideT = 0; this.coyote = 0; this.jumpBuffer = 0; this.wallTouch = 9; this.wallN = new THREE.Vector3(); this.wallJumpCd = 0; this.mantleCd = 0;
    this.dashCd = 0; this.airJumps = 1; this.blockCd = 0; this.landGraceT = 0; this.sprintToggle = false; this.lastGround = true; this.airT = 0; this._sprinting = false; this._aiming = false; this._mv = { x: 0, y: 0 };
    this.grapple = { state: 'idle', anchor: new THREE.Vector3(), hook: new THREE.Vector3(), from: new THREE.Vector3(), flyT: 0, flyDur: 0, len: 0, cd: 0, enemy: null, mover: null, blockedT: 0, t: 0, swingT: 0, hopT: 0 };
    this.deathT = 0; this.gravityScale = 1; this.dashLock = false; this.mob = MOB_FULL;
    this.recoilAcc = { p: 0, y: 0 }; this.recoilRecT = 0; this.sprintFireLock = 0;
    this.isLocal = true; this.team = 0; this.name = 'you'; this.grenades = 3; this.maxGrenades = 5; this.nades = []; this.nadeCd = 0; this.firing = false; this.onThrow = null;
    const rm = makeInkMaterial({ ink: INK.BLUE, fill: false, shadeBias: -0.3 });
    this.rope = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 6), rm); this.rope.visible = false; ctx.scene.add(this.rope);
    const hm = makeInkMaterial({ ink: INK.BLUE }); this.hookMesh = new THREE.Group();
    this.hookMesh.add(new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.05, 6, 10), hm)); const hb = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.08), hm); hb.position.y = -0.2; this.hookMesh.add(hb);
    this.hookMesh.visible = false; ctx.scene.add(this.hookMesh);
  }
  reset(pos) {
    this.nadeCharge = 0; this._nadeHeld = false; if (this._arc) this.updateNadeArc(-1); this.grapStam = 1; this.blockHeld = 0;
    const b = this.body; b.pos.copy(pos); b.vel.set(0, 0, 0); b.onGround = false; b.height = STAND_H;
    this.recoilAcc.p = 0; this.recoilAcc.y = 0; this.recoilRecT = 0; this.sprintFireLock = 0;
    this.hp = this.maxHp; this.alive = true; this.yaw = 0; this.pitch = 0; this.roll = 0; this.hurtFx = 0; this.flashFx = 0; this.crouching = false; this.sliding = false; this.deathT = 0; this.lastDamageT = 10; this.dashCd = 0; this.airJumps = 1; this.gravityScale = 1; this.dashLock = false;
    this.detachGrapple(false);
    for (const w of this.weapons) if (w.isGun) { w.mag = w.magSize; w.reserve = w.startReserve; w.reloading = false; w.pumpT = 0; w.relock(); }
    this.returnT = 0; this.nadeCd = 0; this.nadeCharge = 0; this._nadeHeld = false; if (this._arc) this.updateNadeArc(-1); this._aiming = false; this.firing = false;
    const blade = this.weapons[this.katanaIndex]; blade.slashT = 0; blade.blocking = false; blade.blockAmt = 0; blade.cooldown = 0;
    this.switchTo(this.weapons.findIndex((w, i) => !w.locked && this.weaponAllowed(i)), true); this.rig.visible = true; this.eyeH = EYE_STAND; this.grenades = this.grenadesAllowed ? 3 : 0; this.clearNades();
  }
  clearNades() { for (const n of this.nades) this.ctx.scene.remove(n.mesh); this.nades.length = 0; }
  get isBlocking() { return this.weapon.kind === 'katana' && this.weapon.blocking; }
  aimDir(spread = 0) { const d = this.aimFwd.clone(); if (spread > 0) { d.addScaledVector(this.aimRight, rand(-spread, spread)); d.y += rand(-spread, spread); d.normalize(); } return d; }
  // Recoil moves the aim for real - the spring is only the flourish on top - and until now that
  // displacement was permanent: empty a magazine and your view was left pointing at the sky, with
  // nothing to do but drag it back by hand. Battlefield's answer is to remember what the gun took
  // and give it back once the trigger is released, so a burst returns to where it started. What is
  // remembered is only what actually moved (the pitch clamp can eat some of it), and any of it the
  // player fights off by pulling down is spent rather than returned - see `_recoilRecover`.
  recoil(p, y) {
    // and it levels off: the further the muzzle has already walked, the less each further round
    // moves it, so a held trigger climbs hard for the first handful and then settles around nine
    // degrees instead of ending up pointed at the sky. Tapping stays exact, spraying stays fightable.
    p *= 0.28 + 0.72 * clamp(1 - this.recoilAcc.p / 0.16, 0, 1);
    const was = this.pitch; this.pitch = clamp(this.pitch + p * 0.55, -1.5, 1.5); this.recoilAcc.p += this.pitch - was;
    const dy = y * 0.35; this.yaw += dy; this.recoilAcc.y += dy;
    this.recoilRecT = 0.34;
    this.recoilPitch.kick(p * 22); this.recoilYaw.kick(y * 30);
  }
  // Called with the raw look input, before it is added to the view. Correcting downward against the
  // climb eats the stored climb first: without this a player who fights the gun by hand gets yanked
  // below the target the instant they stop firing, which is the single worst thing recovery can do.
  _recoilFight(dPitch, dYaw) {
    const a = this.recoilAcc;
    if (a.p > 0 && dPitch < 0) a.p = Math.max(0, a.p + dPitch);
    if (a.y > 0 && dYaw < 0) a.y = Math.max(0, a.y + dYaw); else if (a.y < 0 && dYaw > 0) a.y = Math.min(0, a.y + dYaw);
  }
  _recoilRecover(dt) {
    const a = this.recoilAcc; if (!a.p && !a.y) return;
    if ((this.recoilRecT -= dt) > 0) return;      // a beat of hang time first, so it is not rubber
    const k = 1 - Math.exp(-8 * dt);
    const dp = a.p * k, dy = a.y * k; a.p -= dp; a.y -= dy;
    this.pitch = clamp(this.pitch - dp, -1.5, 1.5); this.yaw -= dy;
    if (Math.abs(a.p) < 1e-4) a.p = 0; if (Math.abs(a.y) < 1e-4) a.y = 0;
  }
  kickFov(v) { this.fovKick.kick(v * 30); }
  lunge(speed) {
    const d = this.forward.clone(); d.y = clamp(d.y, -0.2, 0.5); d.normalize(); const b = this.body;
    b.vel.addScaledVector(d, speed); if (b.onGround) { b.vel.y = Math.max(b.vel.y, 2.5); b.onGround = false; }
    audio.dash(); this.kickFov(3);
  }
  switchTo(i, silent = false) {
    if (!Number.isInteger(i) || !this.weaponAllowed(i) || this.weapons[i].locked) return; if (i === this.weaponIndex && !silent) return;
    if (this.weapon.kind !== 'katana') this.prevWeaponIndex = this.weaponIndex;
    this.weapon.unequip(); this.weaponIndex = i; this.weapon = this.weapons[i]; this.weapon.equip(); if (!silent) audio.switchWeapon();
    this.ctx.hud.setWeapon(this.weapon.name, this.weapon.hint); this.ctx.hud.setCrosshairMode(this.weapon.kind === 'katana' ? 'katana' : '');
  }
  cycleWeapon(step) {
    const n = this.weapons.length;
    for (let k = 1; k <= n; k++) { const i = (this.weaponIndex + step * k + n * n) % n; if (!this.weapons[i].locked && this.weaponAllowed(i)) { this.switchTo(i); return; } }
  }
  weaponAllowed(indexOrKind) { const kind = typeof indexOrKind === 'number' ? this.weapons[indexOrKind]?.kind : indexOrKind; return this.weaponRules.weapons.includes(kind); }
  get availableWeapons() { return this.weapons.filter((w, i) => !w.locked && this.weaponAllowed(i)); }
  get grenadesAllowed() { return this.weaponRules.grenades; }
  get infiniteGrenades() { return this.weaponRules.infiniteGrenades; }
  applyWeaponMode(key) {
    const next = weaponModeOf(key); if (next === this.weaponRules) return;
    const previous = this.weaponRules; this.weaponRules = next;
    this.weapons[this.grenadeIndex].locked = !this.weaponAllowed('grenade');
    // A room rule change must cancel a charged throw, queued quick slash and scoped pose too.
    this.nadeCharge = 0; this._nadeHeld = false; if (this._arc) this.updateNadeArc(-1);
    this.returnT = 0; this.firing = false; this._aiming = false;
    for (const w of this.weapons) { w.aimAmt = 0; if (w.isGun && !this.weaponAllowed(w.kind)) w.reloading = false; }
    const blade = this.weapons[this.katanaIndex]; blade.slashT = 0; blade.blocking = false; blade.blockAmt = 0;
    if (!this.grenadesAllowed) this.grenades = 0;
    else if (!previous.grenades || this.infiniteGrenades) this.grenades = 3;
    if (!this.weaponAllowed(this.weaponIndex) || this.weapon.locked) this.switchTo(this.weapons.findIndex((w, i) => !w.locked && this.weaponAllowed(i)), true);
    this.prevWeaponIndex = this.weaponIndex;
    this.ctx.hud.setAds(false); this.ctx.hud.setScope(false);
  }
  addAmmoAll(frac = 0.5) { for (const w of this.availableWeapons) if (w.isGun) w.addAmmo(Math.round(w.maxReserve * frac)); }
  // The whole difficulty ladder lands here: how fast and how late you heal, and whether your legs
  // run out. `sprint: 0` is EASY - unlimited, and the meter never appears.
  applyDifficulty(key) {
    const D = this.diff = diffOf(key);
    this.regenDelay = D.regenDelay; this.regenRate = D.regenRate;
    this.maxSprint = D.sprint; this.sprintStam = D.sprint; this.sprintPause = 0; this.sprintLock = false;
    this.ctx.hud.setSprintStamina(D.sprint > 0 ? 1 : null);
  }
  // Versus only: how much of the movement kit you are allowed. Every branch below reads `this.mob`,
  // so this is a live switch - the host can change it between rounds and the next tick obeys.
  applyMobility(key) {
    const M = this.mob = key ? mobOf(key) : MOB_FULL;
    if (!M.grapple && this.grapple.state !== 'idle') this.detachGrapple(false);
    if (!M.doubleJump) this.airJumps = 0;
  }
  takeDamage(amount, fromPos) {
    if (!this.alive) return;
    this.hp -= amount; this.lastDamageT = 0; this.hurtFx = Math.min(1, this.hurtFx + amount / 40);
    this.ctx.effects.shakeAmt += 0.2 + amount / 80; audio.hurt(); this.ctx.input.rumble(0.8, 0.5, 160);
    if (fromPos) { _v.subVectors(fromPos, this.eye); const x = _v.dot(this.right), f = _v.dot(this.forward); this.ctx.hud.damageFrom(Math.atan2(x, f)); }
    if (this.hp <= 0) { this.hp = 0; this.die(); }
  }
  knockback(dir, amount) { const b = this.body; b.vel.addScaledVector(dir, amount); b.vel.y += amount * 0.5; b.onGround = false; }
  // The guard only covers what is right in front of the blade: a modest reach and a narrow
  // cone, so shots from your flank still land and holding block is not a free win.
  get blockRadius() { return this.isBlocking && this.blockCd <= 0 ? 0.95 : 0; }
  tryDeflect(proj) {
    if (!this.alive || !this.isBlocking || this.blockCd > 0) return false;
    // block only what is flying in at you from the front; flank and back shots get through
    _v.copy(proj.vel).normalize().negate();
    if (_v.dot(this.forward) < 0.55) return false;
    const perfect = this.weapon.blockT < 0.26;
    const ctx = this.ctx;
    // only a well timed guard sends it back; otherwise the round is simply knocked out of the air
    const ret = perfect || Math.random() < 0.35;
    this.blockCd = 0.19;                                        // the blade has to come back before the next parry
    this.weapon.onDeflect(perfect);
    if (perfect) audio.perfectParry(); else audio.parry();
    ctx.effects.sparks(proj.pos, _v2.copy(proj.vel).normalize().negate(), INK.ORANGE, perfect ? 14 : 8, 10);
    ctx.effects.strokeBurst(proj.pos, INK.BLUE, perfect ? 8 : 5, 4.5, { life: 0.2, size: 0.028 });
    ctx.input.rumble(0.4, 0.6, 70); ctx.game.hitstop(perfect ? 0.07 : 0.025, 0.18);
    ctx.effects.shakeAmt += 0.06; this.flashFx = perfect ? 0.35 : 0.1;
    ctx.game.addScore(perfect ? 60 : 15, perfect ? 'PERFECT PARRY' : 'BLOCKED');
    return { perfect, ret };
  }
  get parryWindow() { return this.isBlocking && this.blockHeld < PARRY_WINDOW; }
  tryBlockMelee(e) {
    if (!this.alive || !this.parryWindow || this.blockCd > 0) return false;
    _v.subVectors(e.center, this.eye).normalize(); if (_v.dot(this.forward) < 0.35) return false;
    this.weapon.onDeflect(true); audio.parry(); this.ctx.game.hitstop(0.06, 0.15);
    this.ctx.effects.sparks(_v2.copy(this.eye).addScaledVector(this.forward, 0.8), this.forward.clone().negate(), INK.ORANGE, 12, 8);
    this.ctx.game.addScore(40, 'BLOCKED'); this.ctx.input.rumble(0.6, 0.6, 100); return true;
  }
  die() { this.alive = false; this.deathT = 0; audio.death(); this.detachGrapple(false); this.ctx.game.onPlayerDeath(); }
  idleCam(t) {
    const c = this.camera; c.position.set(Math.sin(t * 0.08) * 70, 30 + Math.sin(t * 0.23) * 4, Math.cos(t * 0.08) * 70); c.lookAt(0, 10, 0); this.rig.visible = false;
    this.eye.copy(c.position); this.center.copy(c.position); c.getWorldDirection(this.forward); this.right.set(this.forward.z, 0, -this.forward.x).normalize();
    this.aimOrigin.copy(c.position); this.aimFwd.copy(this.forward); this.aimRight.copy(this.right);
    if (Math.abs(c.fov - 70) > 0.01) { c.fov = 70; c.updateProjectionMatrix(); }
  }

  update(dt) {
    const ctx = this.ctx, inp = ctx.input, b = this.body;
    this.lastDamageT += dt;
    if (!this.alive) {
      this.deathT += dt; this.eyeH = damp(this.eyeH, 0.35, 3, dt); this.roll = damp(this.roll, 0.9, 3, dt); this.pitch = damp(this.pitch, -0.35, 3, dt);
      b.vel.x = damp(b.vel.x, 0, 4, dt); b.vel.z = damp(b.vel.z, 0, 4, dt); b.vel.y -= G * dt; ctx.world.moveBody(b, dt);
      this.forward.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)); this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      this.updateNades(dt); this._updateCamera(dt); this.weapon.animate(dt, this._weaponState(false, false, 0)); return;
    }
    this.rig.visible = true;
    // ---- look ----
    // the sight multipliers are the config panel's, and its defaults are the 0.62 / 0.38 that used
    // to be written here, so an untouched install looks around exactly as it always did
    const opt = this.opt;
    const lookMul = this._aiming ? (this.weapon.scope ? opt.scopeSens : opt.adsSens) / 100 : 1;
    let dYaw = inp.look.x * lookMul, dPitch = inp.look.y * lookMul;
    if (inp.usingTouch && this.weapon.isGun) {
      const a = this._aimAssist(dt);
      if (a) {
        dYaw *= a.slow; dPitch *= a.slow;
        if (Math.abs(inp.look.x) + Math.abs(inp.look.y) > 1e-5) { dYaw += a.yaw; dPitch += a.pitch; }
      }
    }
    this._recoilFight(dPitch, dYaw);
    this.yaw += dYaw; this.pitch = clamp(this.pitch + dPitch, -1.5, 1.5);
    this._recoilRecover(dt);
    this.forward.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); this.right.copy(_right);
    if (this.dashLock) {
      // the focus dash is sprinting the body across the level itself; don't fight it with gravity
      b.vel.set(0, 0, 0); b.onGround = false; this.coyote = 0.13;
      this._updateCamera(dt); this.weapon.animate(dt, this._weaponState(false, false, 0));
      return;
    }
    // ---- movement input ----
    const mv = inp.move; this._mv = mv;
    const wish = _v.set(0, 0, 0).addScaledVector(_fwd, mv.y).addScaledVector(_right, mv.x); let wishLen = wish.length(); if (wishLen > 1e-4) wish.divideScalar(wishLen); wishLen = Math.min(1, wishLen);
    if (inp.usingGamepad) { if (inp.pressed('sprint')) this.sprintToggle = !this.sprintToggle; if (mv.y < 0.1) this.sprintToggle = false; } else this.sprintToggle = inp.down('sprint');
    const aiming = this._aiming = inp.down('aim') && this.weapon.isGun;
    const hspeed = Math.hypot(b.vel.x, b.vel.z);
    const crouchDown = inp.down('crouch');
    if (inp.pressed('crouch') && b.onGround && hspeed > 6.3 && !this.sliding && this.mob.slide) this._startSlide(hspeed);
    if (this.sliding) { this.slideT += dt; if (!crouchDown || hspeed < 3.5 || this.airT > 0.35) this.sliding = false; }
    let wantCrouch = (crouchDown && b.onGround) || this.sliding;
    if (!wantCrouch && this.crouching) { b.height = STAND_H; if (ctx.world.overlapsBody(b)) wantCrouch = true; }
    this.crouching = wantCrouch; b.height = this.crouching ? CROUCH_H : STAND_H;
    const sprinting = this._sprinting = this.sprintToggle && mv.y > 0.1 && !this.crouching && !aiming && !this.sprintLock;
    // Coming out of a run the gun has to come back up before it will go off. A fifth of a second is
    // short enough to read as weight rather than as a trigger that ignored you - and it is the thing
    // that stops a deathmatch being decided by who sprinted around the corner first.
    this.sprintFireLock = sprinting ? 0.2 : Math.max(0, this.sprintFireLock - dt);
    // Aiming has never actually slowed you down here, so 100% - the top of the slider - is the old
    // behaviour. Only the ground-accel branch reads maxSpeed, so a slide keeps its momentum either way.
    // `mob.speed` is 1 outside versus, so this reads exactly as it always did in solo and co-op.
    const maxSpeed = (this.crouching && !this.sliding ? CROUCH : sprinting ? SPRINT : WALK) * (aiming ? opt.adsSpeed / 100 : 1) * this.mob.speed;
    this.landGraceT -= dt; this.dashCd -= dt; this.blockCd -= dt;
    // ---- ground / air accel ----
    if (b.onGround) {
      this.coyote = 0.13; this.airT = 0; this.airJumps = 1;
      if (this.sliding) {
        const sp = hspeed; if (sp > 0) { const ns = Math.max(0, sp - 6.5 * dt) / sp; b.vel.x *= ns; b.vel.z *= ns; }
        if (wishLen > 0) { b.vel.x += wish.x * 6 * dt; b.vel.z += wish.z * 6 * dt; const n2 = Math.hypot(b.vel.x, b.vel.z); if (n2 > sp && n2 > 0) { b.vel.x *= sp / n2; b.vel.z *= sp / n2; } }
      } else {
        const fr = FRICTION * (this.landGraceT > 0 ? 0.25 : 1);
        const sp = hspeed; if (sp > 0) { const ns = Math.max(0, sp - sp * fr * dt) / sp; b.vel.x *= ns; b.vel.z *= ns; }
        if (wishLen > 0) { const cur = b.vel.x * wish.x + b.vel.z * wish.z; const add = Math.min(maxSpeed * wishLen - cur, ACCEL * dt); if (add > 0) { b.vel.x += wish.x * add; b.vel.z += wish.z * add; } }
      }
    } else {
      this.coyote -= dt; this.airT += dt;
      const air = this.mob.air;
      if (wishLen > 0) { const cur = b.vel.x * wish.x + b.vel.z * wish.z; const add = Math.min(AIR_CAP * air * wishLen - cur, AIR_ACCEL * air * dt); if (add > 0) { b.vel.x += wish.x * add; b.vel.z += wish.z * add; } }
    }
    // ---- jumping / wall jump / air dash ----
    if (inp.pressed('jump')) this.jumpBuffer = 0.15; else this.jumpBuffer -= dt;
    this.wallJumpCd -= dt; this.mantleCd -= dt;
    if (b.hitWall && !b.onGround) { this.wallTouch = 0; this.wallN.copy(b.wallNormal); } else this.wallTouch += dt;
    if (this.jumpBuffer > 0) {
      if (this.grapple.state === 'on') { this.jumpBuffer = 0; this.detachGrapple(true); }
      else if (b.onGround || this.coyote > 0) {
        this.jumpBuffer = 0; this.coyote = 0; b.vel.y = JUMP * this.mob.jump; b.onGround = false; this.airJumps = this.mob.doubleJump ? 1 : 0;
        if (this.sliding) { b.vel.x *= 1.06; b.vel.z *= 1.06; this.sliding = false; }
        audio.jump(); this.landDip.kick(-1.2);
      } else if (this.wallTouch < 0.12 && this.wallJumpCd <= 0 && b.vel.y < 7 && this.mob.wallJump) {
        this.jumpBuffer = 0; this.wallJumpCd = 0.35; const n = this.wallN;
        b.vel.x = n.x * 7.5 + b.vel.x * 0.35 + _fwd.x * 2.5; b.vel.z = n.z * 7.5 + b.vel.z * 0.35 + _fwd.z * 2.5; b.vel.y = 9.2 * this.mob.jump;
        audio.wallJump(); this.roll += n.dot(_right) > 0 ? -0.1 : 0.1; this.kickFov(2); this.landDip.kick(-1.5);
        this.airJumps = this.mob.doubleJump ? 1 : 0;
      } else if (this.airJumps > 0 && this.mob.doubleJump) {
        // double jump: a second beat of height, and it redirects toward where you are steering
        this.jumpBuffer = 0; this.airJumps--;
        b.vel.y = JUMP * 0.92 * this.mob.jump;
        if (wishLen > 0) { const cur = b.vel.x * wish.x + b.vel.z * wish.z; const add = Math.max(0, 7.5 * wishLen - cur); b.vel.x += wish.x * add; b.vel.z += wish.z * add; }
        audio.jump(); this.kickFov(1.6); this.landDip.kick(-1.4);
        _v2.copy(this.center); _v2.y -= 0.7;
        this.ctx.effects.strokeBurst(_v2, INK.BLUE, 9, 4.5, { life: 0.28, size: 0.028, gravity: -2 });
      }
    }
    if ((inp.pressed('dash') || (inp.pressed('crouch') && !b.onGround)) && !b.onGround && this.dashCd <= 0 && this.grapple.state !== 'on' && this.mob.dash) this._dash(wishLen > 0 ? wish : _fwd);
    // ---- gravity, grapple, mantle, integrate ----
    b.vel.y -= G * this.gravityScale * (this.grapple.state === 'on' ? 0.88 : 1) * dt;
    this._updateGrapple(dt);
    if (!b.onGround && this.mantleCd <= 0 && mv.y > 0.3 && b.vel.y < 8 && this.grapple.state !== 'on') this._tryMantle(_fwd);
    b.noSnap = this.grapple.state === 'on' || b.vel.y > 0.5;
    const spd = b.vel.length(); if (spd > 48) b.vel.multiplyScalar(48 / spd);
    ctx.world.moveBody(b, dt);
    if (b.pos.y < -12 || Math.abs(b.pos.x) > 95 || Math.abs(b.pos.z) > 95) {
      this.detachGrapple(false); b.pos.copy(ctx.level.playerStart); b.vel.set(0, 0, 0); this.takeDamage(20, null); if (this.onFall) this.onFall();
      ctx.hud.message('OFF THE PAGE', 'redrawn at the start', 1.8);
    }
    if (b.onGround && !this.lastGround) {
      const impact = clamp(-b.landVel / 14, 0, 1.5); this.landDip.kick(-impact * 6 - 0.5); audio.land(impact);
      if (impact > 0.8) { ctx.effects.shakeAmt += impact * 0.15; ctx.input.rumble(impact * 0.4, 0.2, 80); }
      if (Math.hypot(b.vel.x, b.vel.z) > 9) this.landGraceT = 0.4;
    }
    this.lastGround = b.onGround;
    // ---- regen, bob, footsteps ----
    if (this.regenRate > 0 && this.lastDamageT > this.regenDelay && this.hp < this.maxHp && !this._sprinting && this.grapple.state === 'idle') this.hp = Math.min(this.maxHp, this.hp + this.regenRate * dt);
    // ---- sprint stamina (MEDIUM and up; maxSprint 0 means EASY and this whole block is off) ----
    if (this.maxSprint > 0) {
      const D = this.diff;
      if (this._sprinting) {
        this.sprintStam -= dt; this.sprintPause = D.sprintPause;
        if (this.sprintStam <= 0) { this.sprintStam = 0; this.sprintLock = true; this.sprintToggle = false; ctx.hud.tip('out of breath · walk it off', 1.2); }
      } else if ((this.sprintPause -= dt) <= 0) {
        this.sprintStam = Math.min(this.maxSprint, this.sprintStam + this.maxSprint * D.sprintRegen * dt);
        // a third of the tank back before the legs unlock, so an empty meter is not a one-step stutter
        if (this.sprintLock && this.sprintStam > this.maxSprint * 0.3) this.sprintLock = false;
      }
      ctx.hud.setSprintStamina(this.sprintStam / this.maxSprint);
    }
    this.blockHeld = this.isBlocking ? this.blockHeld + dt : 0;
    // the grapple runs on breath: hanging drains it, feet on the ground bring it back fast
    this.stamPause -= dt;
    if (this.grapple.state !== 'idle') this.grapStam -= STAM_DRAIN * dt; else if (this.stamPause <= 0) this.grapStam += (b.onGround ? STAM_GROUND : STAM_AIR) * dt;
    this.grapStam = clamp(this.grapStam, 0, 1);
    if (this.grapple.state === 'on' && this.grapStam <= 0) { this.detachGrapple(false); ctx.hud.tip('out of breath · land to recover', 1.4); }
    const hs2 = Math.hypot(b.vel.x, b.vel.z); const moving = b.onGround && hs2 > 0.6 && !this.sliding;
    this.bobAmt = damp(this.bobAmt, moving ? clamp(hs2 / 7, 0.3, 1.4) : 0, 8, dt);
    if (moving) { this.bobPhase += dt * (7 + hs2 * 0.5); this.stepDist += hs2 * dt; if (this.stepDist > (sprinting ? 2.5 : 2.0)) { this.stepDist = 0; audio.footstep(clamp(hs2 / 8, 0.3, 1)); } }
    this._updateCamera(dt);
    // ---- grenades ----
    this.nadeCd -= dt;
    const grenadeHeld = inp.down('grenade') || (this.weapon.kind === 'grenade' && inp.down('fire'));
    const canThrow = this.grenadesAllowed && (this.infiniteGrenades || this.grenades > 0) && this.nadeCd <= 0;
    if (grenadeHeld && canThrow && !this.dashLock) { this.nadeCharge = Math.min(1, this.nadeCharge + dt / 1.1); this._nadeHeld = true; }
    else if (this._nadeHeld) { this._nadeHeld = false; if (!grenadeHeld && canThrow) this.throwGrenade(null, this.nadeCharge); this.nadeCharge = 0; }
    this.updateNadeArc(this._nadeHeld ? this.nadeCharge : -1);
    this.updateNades(dt);
    // ---- weapons ----
    for (let i = 0; i < 5; i++) if (inp.pressed('slot' + (i + 1))) this.switchTo(Math.min(i, this.weapons.length - 1));
    // the wheel steps over anything still locked rather than stopping dead on it
    if (inp.pressed('nextWeapon')) this.cycleWeapon(1);
    if (inp.pressed('prevWeapon')) this.cycleWeapon(-1);
    const st = this._weaponState(sprinting, aiming, hs2);
    if (inp.pressed('melee') && this.weapon.kind !== 'katana' && this.weaponAllowed(this.katanaIndex)) { this.switchTo(this.katanaIndex); this.returnT = 0.85; this.weapons[this.katanaIndex].startSlash(st); st.meleePressed = false; }
    if (this.returnT > 0) { if (this.weapon.kind === 'katana' && (st.firePressed || st.aim || st.meleePressed)) this.returnT = 0; else { this.returnT -= dt; if (this.returnT <= 0) this.switchTo(this.prevWeaponIndex); } }
    this.firing = st.fire && this.weapon.isGun;
    this.weapon.animate(dt, st);
    ctx.hud.setAds(this.weapon.isGun && this.weapon.aimAmt > 0.55);
    ctx.hud.setScope(!!this.weapon.scope && this.weapon.aimAmt > 0.62);
  }
  // ---- grenades: a lobbed ink bomb with a short fuse and a big orange blast ----
  // where a throw starts and how fast it leaves, for a given charge (0 = flick, 1 = full wind-up)
  _nadeLaunch(charge, pos, vel) {
    pos.copy(this.eye).addScaledVector(this.right, 0.25).addScaledVector(this.forward, 0.6); pos.y -= 0.15;
    vel.copy(this.forward).multiplyScalar(9 + 20 * charge).addScaledVector(this.body.vel, 0.5); vel.y += 3.5 + 2.5 * charge;
  }
  throwGrenade(remote = null, charge = 0) {
    if (!this.grenadesAllowed || (!remote && (!this.alive || this.dashLock || this.nadeCd > 0 || (!this.infiniteGrenades && this.grenades <= 0)))) return false;
    const ctx = this.ctx; let pos, vel;
    if (remote) { pos = new THREE.Vector3().fromArray(remote.pos); vel = new THREE.Vector3().fromArray(remote.vel); }
    else {
      if (!this.infiniteGrenades) this.grenades--; this.nadeCd = 0.55; pos = new THREE.Vector3(); vel = new THREE.Vector3(); this._nadeLaunch(clamp(charge, 0, 1), pos, vel);
      this.weapon.recoil.kick(-0.4, 0.5, 1.2); this.weapon.recoilRot.kick(-3, 0, -1.5); audio.grappleFire(); ctx.input.rumble(0.2, 0.4, 50);
      if (this.onThrow) this.onThrow({ pos: pos.toArray().map((v) => +v.toFixed(2)), vel: vel.toArray().map((v) => +v.toFixed(2)) });
    }
    // Infinite supplies must not allocate a fresh set of GPU resources for every throw.
    const visual = this._nadeVisual || (this._nadeVisual = {
      body: new THREE.SphereGeometry(0.16, 8, 6), pin: new THREE.TorusGeometry(0.07, 0.02, 4, 8), cap: new THREE.CylinderGeometry(0.06, 0.06, 0.1, 6),
      black: makeInkMaterial({ ink: INK.BLACK }), orange: makeInkMaterial({ ink: INK.ORANGE }),
    });
    const g = new THREE.Group();
    g.add(new THREE.Mesh(visual.body, visual.black));
    const pin = new THREE.Mesh(visual.pin, visual.orange); pin.position.y = 0.2; g.add(pin);
    const cap = new THREE.Mesh(visual.cap, visual.orange); cap.position.y = 0.17; g.add(cap);
    g.position.copy(pos); ctx.scene.add(g);
    this.nades.push({ mesh: g, pos, vel, ang: new THREE.Vector3(rand(-6, 6), rand(-6, 6), rand(-6, 6)), fuse: 1.7, mine: !remote, rest: false, tick: 0 });
    return true;
  }
  updateNadeArc(charge) {
    if (!this._arc) {
      const dots = []; const mat = makeInkMaterial({ ink: INK.BLACK, fill: true });
      for (let i = 0; i < 26; i++) { const m = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 5), mat); m.visible = false; this.ctx.scene.add(m); dots.push(m); }
      const mark = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.05, 5, 18), makeInkMaterial({ ink: INK.ORANGE })); mark.rotation.x = Math.PI / 2; mark.visible = false; this.ctx.scene.add(mark);
      this._arc = { dots, mark };
    }
    const A = this._arc;
    if (charge < 0) { if (A.shown) { for (const d of A.dots) d.visible = false; A.mark.visible = false; A.shown = false; } return; }
    A.shown = true; const world = this.ctx.world; this._nadeLaunch(charge, _ap, _av); let n = 0; const step = 1 / 30;
    for (let i = 0; i < 52 && n < A.dots.length; i++) {
      _av.y -= 22 * step; _aprev.copy(_ap); _ap.addScaledVector(_av, step); _ad.subVectors(_ap, _aprev); const len = _ad.length();
      if (len > 1e-6) { _ad.divideScalar(len); const hit = world.raycast(_aprev, _ad, len + 0.16); if (hit) { _ap.copy(hit.point).addScaledVector(hit.normal, 0.16); const vn = _av.dot(hit.normal); if (vn < 0) { _av.addScaledVector(hit.normal, -1.45 * vn); _av.multiplyScalar(0.55); } if (_av.length() < 1.2 && hit.normal.y > 0.5) break; } }
      if (i % 2 === 0 && i >= 6) { const d = A.dots[n++]; d.position.copy(_ap); d.visible = true; const k = 0.8 + charge * 0.6; d.scale.setScalar(k); }
    }
    for (let i = n; i < A.dots.length; i++) A.dots[i].visible = false;
    A.mark.position.copy(_ap); A.mark.position.y += 0.02; A.mark.visible = true; A.mark.scale.setScalar(0.8 + charge * 0.5);
  }
  updateNades(dt) {
    const ctx = this.ctx, world = ctx.world;
    for (let i = this.nades.length - 1; i >= 0; i--) {
      const n = this.nades[i]; n.fuse -= dt; n.tick += dt;
      if (!n.rest) {
        n.vel.y -= 22 * dt; _v2.copy(n.pos); n.pos.addScaledVector(n.vel, dt);
        _d.subVectors(n.pos, _v2); const len = _d.length();
        if (len > 1e-6) {
          _d.divideScalar(len); const hit = world.raycast(_v2, _d, len + 0.16);
          if (hit) {
            n.pos.copy(hit.point).addScaledVector(hit.normal, 0.16);
            const vn = n.vel.dot(hit.normal); if (vn < 0) { n.vel.addScaledVector(hit.normal, -1.45 * vn); n.vel.multiplyScalar(0.55); n.ang.multiplyScalar(0.6); audio.shell(); }
            if (n.vel.length() < 1.2 && hit.normal.y > 0.5) { n.rest = true; n.vel.set(0, 0, 0); }
          }
        }
        n.mesh.rotation.x += n.ang.x * dt; n.mesh.rotation.y += n.ang.y * dt; n.mesh.rotation.z += n.ang.z * dt;
        n.mesh.position.copy(n.pos);
      }
      // the fuse sparks faster as it runs out
      if (Math.floor(n.tick * (n.fuse < 0.8 ? 14 : 5)) !== Math.floor((n.tick - dt) * (n.fuse < 0.8 ? 14 : 5))) ctx.effects.strokeBurst(n.pos.clone().add(_v.set(0, 0.22, 0)), INK.ORANGE, 2, 2.5, { life: 0.12, size: 0.02 });
      if (n.fuse <= 0) { this.explodeNade(n); ctx.scene.remove(n.mesh); this.nades.splice(i, 1); }
    }
  }
  // One blast, whatever set it off. `mine` is the authority question and not a cosmetic one: the
  // client that owns the thing decides what it did to bots, props and other players, while everyone
  // sees the boom and everyone's own body takes its own damage from it locally.
  explode(pos, o = {}) {
    const ctx = this.ctx, R = o.R || 6.4, hurtR = R * 0.95, c = pos.clone(); c.y += o.lift === undefined ? 0.25 : o.lift;
    ctx.effects.boom(c, R); audio.explosion(c); ctx.input.rumble(0.9, 0.9, 220); ctx.effects.shakeAmt += 0.1 + R * 0.03;
    const mine = o.mine !== false;
    if (mine) { ctx.enemies.blastEnemies(c, R, o.enemyDmg || 120, null); if (ctx.blastBreakables) ctx.blastBreakables(c, R); }
    // me: my own explosion, or anyone else's that went off on my screen
    const d = this.center.distanceTo(c);
    if (this.alive && d < hurtR) { this.takeDamage((o.selfBase ?? 10) + (o.selfMax ?? 34) * (1 - d / hurtR), c); this.knockback(_v.subVectors(this.center, c).normalize(), o.push || 9); }
    // other players in a versus match, decided by whoever set it off
    if (mine && ctx.targets) for (const t of ctx.targets()) { if (t.isLocal || !t.alive || (ctx.canHurt && !ctx.canHurt(t))) continue; const dd = t.center.distanceTo(c); if (dd < hurtR) t.takeDamage((o.pvpBase ?? 12) + (o.pvpMax ?? 50) * (1 - dd / hurtR), c); }
  }
  explodeNade(n) { this.explode(n.pos, { mine: n.mine }); }
  _weaponState(sprinting, aiming, hs) {
    const inp = this.ctx.input, b = this.body;
    return { fire: inp.down('fire'), firePressed: inp.pressed('fire'), aim: aiming || (inp.down('aim') && this.weapon.kind === 'katana'), reloadPressed: inp.pressed('reload'), meleePressed: inp.pressed('melee') && this.weapon.kind === 'katana',
      sprinting, grounded: b.onGround, speed: hs, sliding: this.sliding, lookDelta: inp.look, strafe: this._mv.x, bobPhase: this.bobPhase, bobAmt: this.bobAmt, landDip: clamp(-this.landDip.value * 0.08, -0.5, 0.5), slideTilt: this.sliding ? 1 : 0, blockFire: !this.alive || this.sprintFireLock > 0 };
  }
  _startSlide(hs) {
    this.sliding = true; this.slideT = 0; const b = this.body; const boost = clamp(12.8 - hs, 0, 4.5);
    b.vel.x += b.vel.x / hs * boost; b.vel.z += b.vel.z / hs * boost; audio.slide(); this.kickFov(2.5); this.landDip.kick(-2.5);
  }
  _dash(dir) {
    const b = this.body; this.dashCd = 1.3; const cur = b.vel.x * dir.x + b.vel.z * dir.z; const target = Math.max(cur + 6, 14);
    b.vel.x += dir.x * (target - cur); b.vel.z += dir.z * (target - cur); b.vel.y = Math.max(b.vel.y, 2);
    audio.dash(); this.kickFov(4); this.ctx.input.rumble(0.3, 0.6, 70); this.roll += (dir.x * this.right.x + dir.z * this.right.z) * 0.08;
    _v2.copy(this.center).addScaledVector(dir, -0.6); this.ctx.effects.strokeBurst(_v2, INK.BLUE, 10, 5, { life: 0.25, size: 0.03 });
  }
  _tryMantle(fwd) {
    const b = this.body, world = this.ctx.world;
    _v2.set(b.pos.x, b.pos.y + 1.0, b.pos.z); if (!world.raycast(_v2, fwd, 0.95)) return;
    _v2.set(b.pos.x + fwd.x * 0.95, b.pos.y + 2.75, b.pos.z + fwd.z * 0.95);
    const top = world.raycast(_v2, _down, 2.25); if (!top || top.normal.y < 0.5) return;
    const dy = top.point.y - b.pos.y; if (dy < 0.5 || dy > 2.4) return;
    const hw = b.halfW; if (world.overlapsAABB({ x: _v2.x - hw, y: top.point.y + 0.08, z: _v2.z - hw }, { x: _v2.x + hw, y: top.point.y + CROUCH_H, z: _v2.z + hw })) return;
    b.vel.y = Math.min(11, Math.sqrt(2 * G * (dy + 0.45))); b.vel.x = fwd.x * 3.2; b.vel.z = fwd.z * 3.2; this.mantleCd = 0.7; audio.mantle(); this.landDip.kick(-2.5); this.kickFov(1.5);
  }
  _handPos(out) { out.copy(this.eye).addScaledVector(this.right, -0.55).addScaledVector(this.forward, 0.9); out.y -= 0.42; return out; }
  // Aim assist, touch only. Two small effects, both deliberately weak: near a target the drag slows
  // down, and while a thumb is actually moving the view it drifts toward them a little. The pull
  // rides on the drag, so a reticle left alone never creeps onto anyone by itself - a thumb has no
  // wrist behind it, and this is meant to take the edge off that, not to do the aiming.
  _aimAssist(dt) {
    const ctx = this.ctx, o = this.aimOrigin, d = this.aimFwd;
    const CONE = 0.105, MAXD = 90;                     // about six degrees of help, and no further
    let best = null, bestAng = CONE;
    const consider = (c, los) => {
      _v.subVectors(c, o); const t = _v.dot(d);
      if (t < 1.5 || t > MAXD) return;
      const ang = Math.acos(clamp(t / Math.max(1e-4, _v.length()), -1, 1));
      if (ang >= bestAng) return;
      if (los && !ctx.world.hasLineOfSight(o, c)) return;
      bestAng = ang; best = c;
    };
    for (const e of ctx.enemies.enemies) if (e.alive && e.state !== 'spawn') consider(e.center, true);
    // playersInArc has already done line of sight and the friend/foe check
    if (ctx.playersInArc) for (const p of ctx.playersInArc(o, d, MAXD, Math.cos(CONE))) consider(p.center, false);
    if (!best) return null;
    const aa = this.opt.aimAssist / 100;
    const w = 1 - bestAng / CONE;                      // 1 dead on the target, 0 at the edge of the cone
    _v.subVectors(best, o).normalize();
    const ty = Math.atan2(-_v.x, -_v.z), tp = Math.asin(clamp(_v.y, -1, 1));
    const TAU = Math.PI * 2;
    let dy = ty - this.yaw; dy -= Math.round(dy / TAU) * TAU;   // shortest way round
    const k = Math.min(1, 2.4 * dt) * w * w * 0.5;
    // The slow is deliberately shallow. Halving the look speed over a target does help a thumb hold
    // still, but it also reads as the screen catching on something, and scoped it stacked with the
    // 0.38 sight multiplier down to a fifth of the drag - which feels broken, not helpful.
    return { slow: 1 - 0.28 * w * w * Math.min(1, aa), yaw: dy * k * aa, pitch: (tp - this.pitch) * k * aa };
  }

  // What the crosshair is on wins. Enemies and rings only get a small amount of assist, and
  // only when they are genuinely near the aim line and not behind whatever you are pointing at,
  // so the hook stops jumping to rings above your head that you never aimed at.
  _findGrappleTarget() {
    const ctx = this.ctx, o = this.aimOrigin, d = this.aimFwd, maxD = 75;
    const hitW = ctx.world.raycast(o, d, maxD, NO_GRAPPLE);
    const wallDist = hitW ? hitW.dist : maxD;
    // exact hit on an enemy
    const hitE = ctx.enemies.raycast(o, d, Math.min(50, wallDist + 0.5));
    if (hitE) return { point: hitE.point.clone(), enemy: hitE.enemy, dist: hitE.dist };
    // things that move and can be swung from (paper planes): a forgiving sphere test
    let mBest = null, mLat = Infinity;
    for (const mv of ctx.level.grappleMovers || []) {
      _v.subVectors(mv.mesh.position, o); const t = _v.dot(d); if (t < 2 || t > Math.min(maxD, wallDist + 1)) continue;
      const lat = Math.sqrt(Math.max(0, _v.lengthSq() - t * t)); if (lat < mv.radius + 0.3 + t * 0.012 && lat < mLat) { mLat = lat; mBest = { point: mv.mesh.position.clone(), mover: mv, dist: t }; }
    }
    if (mBest) return mBest;
    // near miss on an enemy: forgiving, but it has to be roughly where you are pointing
    let best = null, bestLat = Infinity;
    for (const e of ctx.enemies.enemies) {
      if (!e.alive || e.state === 'spawn') continue;
      _v.subVectors(e.center, o); const t = _v.dot(d);
      if (t < 1.5 || t > Math.min(45, wallDist + 1.5)) continue;
      const lat = Math.sqrt(Math.max(0, _v.lengthSq() - t * t));
      const tol = 1.1 + t * 0.06;                      // a few degrees of help, no more
      if (lat > tol || lat >= bestLat) continue;
      if (!ctx.world.hasLineOfSight(o, e.center)) continue;
      best = { point: e.center.clone(), enemy: e, dist: t }; bestLat = lat;
    }
    if (best) return best;
    // grapple rings: only a slim amount of magnetism, and never through a wall
    let ring = null, ringT = Infinity, ringLat = Infinity;
    for (const r of ctx.level.rings) {
      _v.subVectors(r, o); const t = _v.dot(d); if (t < 2 || t > Math.min(maxD, wallDist + 1.5)) continue;
      const lat = Math.sqrt(Math.max(0, _v.lengthSq() - t * t));
      if (lat > 0.8 + t * 0.02) continue;
      if (lat < ringLat) { ring = r; ringT = t; ringLat = lat; }
    }
    if (ring) return { point: ring.clone(), enemy: null, dist: ringT };
    if (hitW) return { point: hitW.point.clone().addScaledVector(hitW.normal, 0.12), enemy: null, dist: hitW.dist };
    return null;
  }
  _fireGrapple() {
    if (this.grapStam < STAM_MIN) { audio.winded(); this.ctx.hud.tip('grapple needs a breather', 0.9); return; }
    const t = this._findGrappleTarget(); if (!t) { audio.empty(); return; }
    this.grapStam -= STAM_FIRE; this.stamPause = STAM_PAUSE;
    const g = this.grapple; g.state = 'fly'; g.anchor.copy(t.point); this._handPos(g.from); g.hook.copy(g.from); g.flyT = 0; g.flyDur = clamp(t.dist / 110, 0.04, 0.6); g.enemy = t.enemy || null; g.mover = t.mover || null; g.t = 0;
    audio.grappleFire(); this.ctx.input.rumble(0.15, 0.4, 40); this.weapon.recoil.kick(-0.3, 0.2, 0.5);
  }
  detachGrapple(boost) {
    const g = this.grapple; if (g.state === 'idle') return; const was = g.state; g.state = 'idle'; g.cd = Math.max(0.12, this.mob.grapCd); g.enemy = null; g.mover = null; this.stamPause = STAM_PAUSE;
    this.rope.visible = false; this.hookMesh.visible = false; audio.reelLoop(false); this.ctx.hud.grappleTarget(0);
    if (was === 'on') { const b = this.body; if (boost) { b.vel.y = Math.max(b.vel.y, 0) + 8; b.vel.x *= 1.12; b.vel.z *= 1.12; audio.jump(); this.kickFov(3); } else { b.vel.y += 2.5; audio.grappleRelease(); } }
  }
  _updateGrapple(dt) {
    const g = this.grapple, inp = this.ctx.input, b = this.body, ctx = this.ctx; g.cd -= dt;
    if (g.state === 'idle') {
      // On HARD there is no hook at all, so don't even paint the target ring: a reticle that lights
      // up on something you cannot reach is worse than no reticle.
      if (!this.mob.grapple) { if (inp.pressed('grapple')) { audio.empty(); ctx.hud.tip('no grapple in this match', 0.9); } ctx.hud.grappleTarget(0); return; }
      if (inp.pressed('grapple') && g.cd <= 0) this._fireGrapple();
      g.t += dt; if (g.t > 0.08) { g.t = 0; ctx.hud.grappleTarget(this._findGrappleTarget() ? 1 : 0); }
    } else if (g.state === 'fly') {
      if (g.mover) g.anchor.copy(g.mover.mesh.position);
      g.flyT += dt; const f = Math.min(1, g.flyT / g.flyDur); g.hook.lerpVectors(g.from, g.anchor, f);
      if (f >= 1) {
        if (g.enemy) { if (g.enemy.alive) { ctx.enemies.yank(g.enemy, this.center); ctx.game.addScore(30, 'YANKED'); audio.grappleHit(); ctx.input.rumble(0.5, 0.5, 90); } this.detachGrapple(false); }
        else { g.state = 'on'; g.len = Math.max(1.5, this.center.distanceTo(g.anchor) * 0.94); g.blockedT = 0; g.t = 0; g.swingT = 0; audio.grappleHit(); audio.reelLoop(true); ctx.hud.grappleTarget(2); ctx.input.rumble(0.3, 0.6, 60); if (b.onGround) { b.vel.y = Math.max(b.vel.y, 5); b.onGround = false; } }
      }
    } else if (g.state === 'on') {
      if (g.mover) g.anchor.copy(g.mover.mesh.position);
      g.hook.copy(g.anchor); g.swingT += dt; const c = this.center; _d.subVectors(g.anchor, c); const dist = _d.length(); if (dist > 0.01) _d.divideScalar(dist);
      const reeling = inp.down('grapple'); const vAlong = b.vel.dot(_d);
      if (reeling) { g.len = Math.max(1.5, g.len - 14 * dt); if (vAlong < 22) b.vel.addScaledVector(_d, 42 * dt); }
      else {
        if (vAlong < 6) b.vel.addScaledVector(_d, 3 * dt);
        // swing pump: holding forward adds energy along the view direction (Spider-Man style)
        if (this._mv.y > 0.3 && c.y < g.anchor.y - 1) { _v2.copy(this.forward); _v2.y = 0; if (_v2.lengthSq() > 0.01) { _v2.normalize(); b.vel.addScaledVector(_v2, 10 * dt); } }
      }
      if (dist > g.len) {
        const vn = b.vel.dot(_d); if (vn < 0) b.vel.addScaledVector(_d, -vn);
        const excess = Math.min(dist - g.len, 0.35) * 0.85; b.pos.addScaledVector(_d, excess);
        if (ctx.world.overlapsBody(b)) b.pos.addScaledVector(_d, -excess);
      }
      if (b.onGround && reeling && _d.y > 0.2) { b.vel.y = Math.max(b.vel.y, 4.5); b.onGround = false; }
      g.t += dt; if (g.t > 0.15) { g.t = 0; if (!ctx.world.hasLineOfSight(this.eye, g.anchor)) g.blockedT += 0.15; else g.blockedT = 0; }
      if (inp.pressed('grapple') || dist < 1.3 || g.blockedT > 0.3 || dist > 90 || (b.onGround && g.swingT > 0.6 && !reeling)) this.detachGrapple(dist < 1.3);
    }
    if (g.state !== 'idle') {
      this._handPos(_v3); alignYAxis(this.rope, _v3, g.hook, 0.008); this.rope.visible = true;
      this.hookMesh.visible = true; this.hookMesh.position.copy(g.hook); this.hookMesh.quaternion.copy(this.rope.quaternion);
    }
  }
  _updateCamera(dt) {
    const b = this.body, cam = this.camera, mv = this._mv;
    const targetEye = this.crouching ? EYE_CROUCH : EYE_STAND; this.eyeH = this.alive ? damp(this.eyeH, targetEye, 14, dt) : this.eyeH;
    this.recoilPitch.update(dt); this.recoilYaw.update(dt); this.fovKick.update(dt); this.landDip.update(dt);
    if (this.alive) this.roll = damp(this.roll, -mv.x * 0.022 + (this.sliding ? -0.08 : 0), 9, dt);
    const sh = this.ctx.effects.shakeAmt; this.ctx.effects.shakeAmt = damp(sh, 0, 7, dt); const shk = Math.min(sh, 1.2) * this.opt.shake / 100;
    const bobAmt = this.bobAmt * this.opt.bob / 100;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * 0.03 * bobAmt, bobX = Math.cos(this.bobPhase * 0.5) * 0.018 * bobAmt;
    this.eye.set(b.pos.x, b.pos.y + this.eyeH + this.landDip.value * 0.07 + bobY, b.pos.z);
    this.center.set(b.pos.x, b.pos.y + b.height * 0.55, b.pos.z);
    cam.position.copy(this.eye).addScaledVector(this.right, bobX + (Math.random() - 0.5) * shk * 0.07); cam.position.y += (Math.random() - 0.5) * shk * 0.07;
    const aimP = this.pitch + this.recoilPitch.value + (Math.random() - 0.5) * shk * 0.035;
    const aimY = this.yaw + this.recoilYaw.value + (Math.random() - 0.5) * shk * 0.035;
    cam.rotation.set(aimP, aimY, this.roll + Math.sin(this.bobPhase * 0.5) * 0.004 * bobAmt);
    // The gun fires along this, not along `forward`: same pitch and yaw the camera was just given,
    // so whatever the crosshair is covering is what the ray hits. (Euler order is YXZ, and the
    // roll term is a rotation about the view axis, so neither of them bends this direction.)
    this.aimOrigin.copy(cam.position);
    this.aimFwd.set(-Math.sin(aimY) * Math.cos(aimP), Math.sin(aimP), -Math.cos(aimY) * Math.cos(aimP));
    this.aimRight.set(Math.cos(aimY), 0, -Math.sin(aimY));
    const sp3 = b.vel.length();
    let fov = this.opt.fov + clamp((sp3 - 7) / 16, 0, 1) * 8 + (this._sprinting ? 3 : 0) + (this.sliding ? 4 : 0) + (this.grapple.state === 'on' ? 3 : 0) + this.fovKick.value;
    if (this._aiming) fov = this.weapon.adsFov;
    this.fov = damp(this.fov, fov, this._aiming ? 16 : 8, dt); if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
    this.hurtFx = damp(this.hurtFx, 0, 3, dt); this.flashFx = damp(this.flashFx, 0, 10, dt); this.speed = sp3;
  }
}
const _ap = new THREE.Vector3(), _av = new THREE.Vector3(), _ad = new THREE.Vector3(), _aprev = new THREE.Vector3();
