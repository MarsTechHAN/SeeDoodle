// Game bootstrap: solo waves, deathmatch and squad lobbies, checkpoints, scoring, screens, the loop.
// Online play is relayed by the server in ../server.js rather than peered: one player in each room
// is the host and owns the enemies, the waves and the pickups, every player runs their own body,
// and hits between players are judged by the server with the latency rewound out of them.
import * as THREE from 'three';
import { InkRenderer, INK, makeInkMaterial } from './render.js';
import { World } from './physics.js';
import { Input } from './input.js';
import { buildLevel, LEVELS } from './level.js';
import { NavGrid } from './nav.js';
import { Effects } from './effects.js';
import { EnemyManager, BOSSES } from './enemies.js';
import { Player } from './player.js';
import { Bullets } from './bullets.js';
import { RemotePlayer, encodeLocal, PLAYER_INKS, validPlayerColor, playerInk, playerColorCSS } from './players.js';
import { Net } from './net.js';
import { HUD, CONTROLS_HTML } from './hud.js';
import { isTouchDevice, TouchControls, TOUCH_CONTROLS_HTML } from './touch.js';
import { t, ts, trDom, getLang, setLang, LANGS } from './i18n.js';
import { audio } from './audio.js';
import { SETTINGS, DIFFICULTY, MOBILITY, WEAPON_MODES, diffOf, mobOf, weaponModeOf, loadSettings, saveSettings } from './settings.js';
import { rand, choose, clamp } from './util.js';

const canvas = document.getElementById('c');
const R = new InkRenderer(canvas);
const world = new World();
const knownMap = (k) => (LEVELS.some((m) => m.key === k) ? k : 'district');
// A pvp-only map is built for hunting people in the dark: no room for a wave of thirty, and nowhere
// for them to come from. It is offered in a deathmatch lobby and nowhere else, and this is the one
// gate that decides it - every path into the level goes through here, so a stale localStorage key or
// a host who switches to squad survival with it picked both land back on the district.
const arenaMaps = (ffa) => LEVELS.filter((m) => ffa || !m.pvpOnly);
const playable = (k, ffa) => (arenaMaps(ffa).some((m) => m.key === k) ? k : 'district');
let mapKey = playable(localStorage.getItem('doodle_map') || 'district', false);
let level = buildLevel(R.scene, world, mapKey, { arena: false });
let nav = new NavGrid(world, level.bounds, 1).build();
let loadedKey = mapKey, arenaLoaded = false;
audio.setTune(mapKey === 'mexico' ? 'mexico' : 'district');
// the map in play: solo uses the picked map, a match uses the host's choice; a rebuild wipes broken props
function setLevel(key, on, force = false) {
  if (!force && key === loadedKey && on === arenaLoaded) return; loadedKey = key; arenaLoaded = on;
  for (const m of level.meshes) { R.scene.remove(m); if (m.geometry) m.geometry.dispose(); if (m.traverse) m.traverse((o) => { if (o !== m && o.geometry) o.geometry.dispose(); }); }
  level.animated.length = 0; world.clear();
  level = buildLevel(R.scene, world, key, { arena: on }); nav = new NavGrid(world, level.bounds, 1).build();
  ctx.level = level; ctx.nav = nav; if (window.__game) { window.__game.level = level; window.__game.nav = nav; }
  audio.setTune(key === 'mexico' ? 'mexico' : 'district');
}
const setArena = (on) => setLevel(playable(net.active ? (lobby.map || mapKey) : mapKey, on), on);
const input = new Input(canvas);
const hud = new HUD(document.getElementById('hud'));
// A phone goes straight into touch controls - the decision is made once, here, on the way in.
const hudEl = document.getElementById('hud');
const touchMode = isTouchDevice();
const touch = touchMode ? new TouchControls(hudEl, input) : null;
if (touchMode) { hudEl.classList.add('touch'); document.body.classList.add('touch'); input.usingTouch = true; hud.setTouch(true); }
const effects = new Effects(R.scene, world);
const ctx = { scene: R.scene, camera: R.camera, world, level, nav, input, hud, effects, audio, renderer: R };

// ---------------- persistent bits ----------------
let best = Number(localStorage.getItem('doodle_best') || 0);
let musicWanted = localStorage.getItem('doodle_music') !== '0';
let checkpoint = Number(localStorage.getItem('doodle_checkpoint') || 0);
let myName = (localStorage.getItem('doodle_name') || '').slice(0, 14) || 'doodle' + Math.floor(Math.random() * 90 + 10);
// The config panel writes straight into this object and the player reads it live off ctx.opt, so a
// slider moves the game under you rather than on the next round.
const settings = ctx.opt = loadSettings();
function applySettings() {
  input.mouseSens = 0.0022 * settings.sens / 100; input.padSensX = 3.4 * settings.sens / 100; input.padSensY = 2.6 * settings.sens / 100; input.invertY = settings.invert;
  applyRules();
  saveSettings(settings);
}
// ---------------- game state ----------------
const FFA_TARGET = 20, FFA_TIME = 600, RESPAWN = 2.5;
let matchLeft = FFA_TIME, clockT = 0, clockRunning = false;
const mmss = (t) => { t = Math.max(0, Math.ceil(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
const game = ctx.game = {
  state: 'start', mode: 'solo', menu: false, time: 0, hitstopT: 0, hitstopScale: 1, wave: 0, score: 0, combo: 0, comboT: 0, kills: 0, intermission: 0, queue: [], spawnT: 0, maxAlive: 6, deathT: 0,
  focus: { active: false, t: 0, chain: 0, target: null, dash: null, arm: 0, ready: false }, katanaStreak: 0, rocketDropped: false, boss: null, respawnT: 0, matchT: 0, over: null, overT: 0,
  hitstop(d, s) { this.hitstopT = Math.max(this.hitstopT, d); this.hitstopScale = s; },
  addScore(pts, label) { const mult = 1 + Math.min(this.combo, 9) * 0.25; const p = Math.round(pts * mult); this.score += p; if (label) hud.kill(label, p); hud.setScore(this.score, this.combo); },
  onPlayerDeath() { endFocus(); onLocalDeath(); },
};
// 'ffa' is players against each other; 'coop' is the whole lobby against the waves.
const online = () => game.mode === 'ffa' || game.mode === 'coop';
const coop = () => game.mode === 'coop';
const versus = () => game.mode === 'ffa';
const enemies = ctx.enemies = new EnemyManager(ctx);
const player = ctx.player = new Player(ctx);
const bullets = ctx.bullets = new Bullets(ctx);
player.name = myName;
const net = new Net();
const remote = new Map();      // peer id -> RemotePlayer
const lobby = { players: new Map(), hostId: null, isPublic: true, status: '', code: '', map: null, gameMode: 'ffa', ballistics: false, diff: 'easy', mob: 'mid', weaponMode: 'normal' };
const colorSeats = new Map(); // recently departed ids -> { color, until }, shared with the next host
const scores = new Map();      // peer id -> { name, kills, deaths }
let screen = 'main';           // which start-screen panel is showing: main | online | lobby
window.__game = { ctx, game, player, enemies, nav, world, level, hud, effects, input, net, remote, lobby, scores };

// Whose call it is, following the map: alone it is your own setting, in a lobby it is the host's,
// so everybody in a match is shooting the same physics.
ctx.ballistics = () => (net.active ? !!lobby.ballistics : settings.ballistics);
ctx.difficulty = () => (net.active ? lobby.diff : settings.difficulty) || 'easy';
// The movement ladder is a deathmatch rule and nothing else: solo and squad play get `null`, which
// is the full kit. In versus it is the host's pick, same as the map and the ballistics.
ctx.mobility = () => (versus() ? lobby.mob || 'mid' : null);
ctx.weaponMode = () => net.connected ? weaponModeOf(lobby.weaponMode).key : 'normal';
function applyRules() { player.applyDifficulty(ctx.difficulty()); player.applyMobility(ctx.mobility()); player.applyWeaponMode(ctx.weaponMode()); if (touch) touch.setWeaponMode(ctx.weaponMode()); }
// anything a bullet or a blade can hit besides enemies
ctx.targets = () => [player, ...remote.values()];
// co-op is one team: your shots pass through your friends and only the enemies bleed
ctx.canHurt = (t) => versus() && t !== player;
ctx.raycastPlayers = (o, d, maxDist) => {
  let best = null;
  for (const t of remote.values()) {
    if (!t.alive || !ctx.canHurt(t)) continue;
    for (let i = 0; i < t.hit.length; i++) {
      const c = t.hitSpheres[i], r = t.hit[i][1];
      _v.subVectors(c, o); const tca = _v.dot(d); if (tca < 0 || tca > maxDist) continue;
      const d2 = _v.lengthSq() - tca * tca; if (d2 > r * r) continue;
      const tt = tca - Math.sqrt(r * r - d2); if (tt < 0) continue;
      if (!best || tt < best.dist) best = { player: t, part: t.hit[i][0], dist: tt, point: new THREE.Vector3(o.x + d.x * tt, o.y + d.y * tt, o.z + d.z * tt) };
    }
    // a raised katana sits in front of the chest: a ray that reaches it before the body is turned aside
    if (t.blocking) {
      _bc.set(t.center.x + t.forward.x * 0.5, t.center.y + 0.3, t.center.z + t.forward.z * 0.5); const r = 0.42;
      _v.subVectors(_bc, o); const tca = _v.dot(d);
      if (tca > 0 && tca <= maxDist) { const d2 = _v.lengthSq() - tca * tca; if (d2 <= r * r) { const tt = tca - Math.sqrt(r * r - d2); if (tt >= 0 && (!best || best.player !== t || tt < best.dist)) best = { player: t, part: 'blade', dist: tt, point: new THREE.Vector3(o.x + d.x * tt, o.y + d.y * tt, o.z + d.z * tt) }; } }
    }
  }
  return best;
};
const _bc = new THREE.Vector3();
ctx.playersInArc = (pos, dir, range, cosHalf) => { const out = []; for (const t of remote.values()) { if (!t.alive || !ctx.canHurt(t)) continue; _v.subVectors(t.center, pos); const d = _v.length(); if (d > range + 0.3) continue; if (d > 0.3 && _v.normalize().dot(dir) < cosHalf) continue; if (!world.hasLineOfSight(pos, t.center)) continue; out.push(t); } return out; };
ctx.hitPlayer = (t, dmg, info) => {
  if (!ctx.canHurt(t) || !t.alive) return;
  // a raised katana facing you parries a slash outright and turns some bullets aside
  // the bullet met the blade itself: it glances off, and now and then comes straight back at you
  if (info.part === 'blade') {
    effects.strokeBurst(info.point, INK.ORANGE, 8, 6, { life: 0.22, size: 0.035 }); audio.shieldHit(t.center);
    const ret = Math.random() < 0.4;
    if (ret) {
      effects.tracer(info.point, player.eye, INK.RED, 0.03, 0.08); hud.tip('RETURNED', 0.9); input.rumble(0.5, 0.4, 90);
      player.lastHitBy = t.id; player.lastHit = { from: t.center.toArray(), crit: false, amount: dmg * 0.6, src: 'deflect' }; player.takeDamage(dmg * 0.6, t.center);
    } else hud.tip('DEFLECTED', 0.7);
    net.sendTo(t.id, 'parry', { ret, by: net.id });
    return;
  }
  const facing = t.blocking ? _v.subVectors(player.center, t.center).normalize().dot(t.forward) : -1;
  const frontHit = /^(head|torso|arm|fore)/.test(info.part || '');
  // a slash is only parried by a guard that just came up and faces you
  if (facing > 0.6 && frontHit && info.source === 'katana' && t.parryWindow) { effects.strokeBurst(info.point, INK.ORANGE, 10, 6, { life: 0.25, size: 0.04 }); audio.shieldHit(t.center); game.hitstop(0.08, 0.15); player.weapons[player.katanaIndex].cooldown = Math.max(player.weapons[player.katanaIndex].cooldown, 0.6); input.rumble(0.6, 0.3, 90); hud.tip('PARRIED', 0.9); return; }
  effects.blood(info.point, info.dir, clamp(0.4 + dmg / 80, 0.4, 1.6), { ink: INK.RED }); hud.hitmarker(false, info.crit); audio.hitEnemy(t.center); t.flash();
  // We show the hit at once - the shot landed on our screen and that is what the player judges us by -
  // but we do not get to tell the other end it was hurt. The claim goes to the server, which winds
  // that player back to where our screen had them and decides. Send the ray we actually fired so
  // there is something to check it against; the katana has no ray, only a reach.
  const claim = { k: info.source, dmg: Math.round(dmg), crit: !!info.crit, part: info.part || null };
  if (info.tof > 0 && info.muzzle) {
    // A round that fell on the way there did not travel in a straight line, so there is no ray to
    // hand over. Send where it left from, where it landed and how long it was in the air instead
    // (`ft`, not `t` - `t` is the message type this claim is spread into).
    // The flight time buys nothing: the rewind is the round trip either way (see server.js).
    claim.ft = +info.tof.toFixed(3);
    claim.p = [+info.point.x.toFixed(2), +info.point.y.toFixed(2), +info.point.z.toFixed(2)];
    claim.o = [+info.muzzle.x.toFixed(2), +info.muzzle.y.toFixed(2), +info.muzzle.z.toFixed(2)];
    claim.r = +info.dist.toFixed(2);
  } else if (info.dir && info.dist > 0) {
    claim.r = +info.dist.toFixed(2);
    claim.d = [+info.dir.x.toFixed(4), +info.dir.y.toFixed(4), +info.dir.z.toFixed(4)];
    claim.o = [+(info.point.x - info.dir.x * info.dist).toFixed(2), +(info.point.y - info.dir.y * info.dist).toFixed(2), +(info.point.z - info.dir.z * info.dist).toFixed(2)];
  }
  net.hit(t.id, claim);
};
// a slash through another player's rope cuts it: their client drops the hook
const _rp = new THREE.Vector3(), _rq = new THREE.Vector3();
ctx.cutRopes = (eye, dir, range) => {
  let cut = false;
  for (const r of remote.values()) {
    if (!r.alive || !r.grappling) continue;
    _rp.set(r.body.pos.x + r.right.x * 0.35, r.body.pos.y + 1.25, r.body.pos.z + r.right.z * 0.35);
    for (let i = 0; i <= 14; i++) {
      _rq.lerpVectors(_rp, r.gPoint, i / 14).sub(eye); const t = _rq.dot(dir); if (t < 0.3 || t > range) continue;
      const lat = Math.sqrt(Math.max(0, _rq.lengthSq() - t * t)); if (lat > 0.9) continue;
      _rq.add(eye); effects.strokeBurst(_rq, INK.ORANGE, 10, 5, { life: 0.25, size: 0.035 }); net.sendTo(r.id, 'cut', {}); hud.tip('ROPE CUT', 0.9); cut = true; break;
    }
  }
  return cut;
};
const _v = new THREE.Vector3();
// breakable props: bullets, blades and blasts break them, and everyone in a match sees it go
ctx.breakHit = (br, dmg, point, dir) => {
  if (!br.alive) return; br.hp -= dmg;
  if (br.hp <= 0) breakProp(br, dir, true); else { effects.strokeBurst(point, br.ink, 5, 4, { life: 0.2, size: 0.03 }); audio.shieldHit(point); }
};
ctx.breakablesInArc = (pos, dir, range, cosHalf) => level.breakables.filter((br) => { if (!br.alive) return false; _v.subVectors(br.pos, pos); const d = _v.length(); return d < range + 0.5 && (d < 0.4 || _v.divideScalar(d).dot(dir) > cosHalf); });
ctx.blastBreakables = (c, R) => { for (const br of level.breakables) if (br.alive && br.pos.distanceTo(c) < R * 0.9) breakProp(br, br.pos.clone().sub(c).normalize(), true); };
function breakProp(br, dir, local, quiet = false) {
  if (!br.alive) return; br.alive = false; world.removeBox(br.box);
  const g = br.group, pos = br.pos; const d = dir && dir.lengthSq() > 0.01 ? dir.clone().normalize() : new THREE.Vector3(rand(-1, 1), 1, rand(-1, 1)).normalize();
  if (quiet) { R.scene.remove(g); return; }
  g.updateMatrixWorld(true);
  for (const child of [...g.children]) {
    child.updateWorldMatrix(true, false); R.scene.attach(child);
    const v = d.clone().multiplyScalar(rand(2, 6)); v.x += rand(-3, 3); v.z += rand(-3, 3); v.y += rand(2.5, 6.5);
    effects.debris(child, child.position, v, new THREE.Vector3(rand(-9, 9), rand(-9, 9), rand(-9, 9)), { radius: 0.14, blood: false, life: rand(6, 9) });
  }
  R.scene.remove(g);
  const up = new THREE.Vector3(0, 1, 0);
  if (br.kind === 'pinata') {
    for (const ink of [INK.PINK, INK.ORANGE, INK.GREEN]) effects.strokeBurst(pos, ink, 16, 7, { life: 0.7, size: 0.05 });
    effects.explosion(pos, 2.5, INK.PINK); if (!net.active || net.isHost) for (let i = 0; i < 2; i++) spawnPickup('health', pos.clone().add(new THREE.Vector3(rand(-1.2, 1.2), 0, rand(-1.2, 1.2))));
    if (game.mode === 'solo') game.addScore(25, 'PIÑATA');
  } else if (br.kind === 'cactus') { effects.blood(pos, d, 1.4, { ink: INK.GREEN }); effects.bloodPool(new THREE.Vector3(pos.x, 0, pos.z), 1.1, INK.GREEN); }
  else { effects.strokeBurst(pos, br.ink, 12, 5, { life: 0.35, size: 0.04 }); effects.smoke(pos, up, 3); }
  audio.smash(pos, br.kind === 'barrel' || br.kind === 'crate' || br.kind === 'cactus');
  if (local && net.active) net.broadcast('brk', { id: br.id });
}
// every ray a gun fires this tick is sent to the others, who draw it as a tracer from the shooter's gun
const shotQueue = [];
ctx.onShot = (end) => { if (net.active && inMatch()) shotQueue.push(+end.x.toFixed(1), +end.y.toFixed(1), +end.z.toFixed(1)); };
// a round with flight time has no end point to send yet, so send where it started and which way it
// went: the others fly the same arc on their own screens, for the look of it only
const bulletQueue = [];
ctx.onBullet = (b) => {
  if (!net.active || !inMatch()) return;
  const mv = b.vel.length();
  bulletQueue.push(+b.origin.x.toFixed(2), +b.origin.y.toFixed(2), +b.origin.z.toFixed(2),
    +(b.vel.x / mv).toFixed(4), +(b.vel.y / mv).toFixed(4), +(b.vel.z / mv).toFixed(4));
};
const TRACER_THICK = { rifle: 0.02, shotgun: 0.014, sniper: 0.03, revolver: 0.026, rocket: 0.085 };
// how somebody else's round flies on this screen, keyed off the weapon kind the `shots` message
// already carries -- a rocket has to droop and bang like one or it reads as a stray tracer
const REMOTE_ROUND = { shotgun: { maxRange: 80 }, rocket: { maxRange: 160, grav: 2.2, explosive: true, blastR: 5.6 } };
const _sm = new THREE.Vector3(), _se = new THREE.Vector3();

// ---------------- pickups ----------------
const pickups = []; let pickupId = 1;
const pmat = { ammo: makeInkMaterial({ ink: INK.BLUE }), health: makeInkMaterial({ ink: INK.GREEN }), cap: makeInkMaterial({ ink: INK.BLACK }), shell: makeInkMaterial({ ink: INK.ORANGE }), rocket: makeInkMaterial({ ink: INK.ORANGE }) };
const PICKUP_INK = { ammo: INK.BLUE, rocket: INK.ORANGE, health: INK.GREEN };
function makePickup(kind) {
  const g = new THREE.Group();
  if (kind === 'rocket') {
    // a tube with a round beside it: orange so it reads as "the special one" from across a street
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.9, 10), pmat.rocket); t.rotation.z = Math.PI / 2; g.add(t);
    const w = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.22, 8), pmat.cap); w.rotation.z = -Math.PI / 2; w.position.set(0.53, 0, 0); g.add(w);
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.2, 8, 1, true), pmat.cap); c.rotation.z = Math.PI / 2; c.position.set(-0.52, 0, 0); g.add(c);
    const gr = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.07), pmat.cap); gr.position.set(-0.1, -0.16, 0); g.add(gr);
  }
  else if (kind === 'ammo') { g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.5, 10), pmat.ammo)); const c = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.16, 8), pmat.cap); c.position.y = 0.33; g.add(c); const l = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.02), pmat.cap); l.position.set(0, 0, 0.24); g.add(l); }
  else if (level.key === 'mexico') { const sh = new THREE.CylinderGeometry(0.42, 0.42, 0.22, 12, 1, false, 0, Math.PI); sh.rotateZ(Math.PI / 2); sh.rotateX(-Math.PI / 2); g.add(new THREE.Mesh(sh, pmat.shell)); const f = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.1, 0.2), pmat.health); f.position.y = 0.02; g.add(f); const m = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.08, 0.14), pmat.cap); m.position.y = 0.1; g.add(m); }
  else { g.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.2, 0.2), pmat.health), new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), pmat.health)); }
  return g;
}
// A flyer dies over the street and its ammo box used to hang there in mid-air. Drops now fall to
// whatever is under them. Both ends run this same snap against the same level geometry, so the
// host keeps broadcasting the death point and the wire format does not change - the client sees
// the fall too. No floor within 60m (shot down over the edge of the page) means no floor at all:
// leave it where it died and let `life` retire it, rather than dropping forever.
function pickupAllowed(kind) { return kind === 'rocket' ? player.weaponAllowed('rocket') : kind !== 'ammo' || player.weapons.some((w) => w.isGun && player.weaponAllowed(w.kind)) || (player.grenadesAllowed && !player.infiniteGrenades); }
function spawnPickup(kind, pos, id = null) {
  if (!pickupAllowed(kind)) return null;
  const m = makePickup(kind); m.position.copy(pos); m.position.y += 0.6; R.scene.add(m);
  const gy = world.groundBelow(pos.x, pos.y + 1.2, pos.z, 60), rest = gy + 0.45;
  const grounded = gy > pos.y + 1.2 - 60 && rest < m.position.y - 0.02;
  const p = { id: id ?? pickupId++, kind, mesh: m, base: grounded ? rest : m.position.y, t: rand(0, 6), life: 45, vy: grounded ? 0 : null };
  pickups.push(p);
  if (net.isHost) net.send('pickup', { id: p.id, kind, pos: pos.toArray() });
  return p;
}
function removePickup(p) { R.scene.remove(p.mesh); const i = pickups.indexOf(p); if (i >= 0) pickups.splice(i, 1); }
function collectPickup(p) {
  if (p.kind === 'rocket') {
    const rl = player.weapons[player.rocketIndex];
    const first = rl.unlock(2);
    hud.kill(first ? '+ROCKET LAUNCHER · SLOT 5' : '+ROCKET ×2', 0);
    if (first) hud.tip('rocket launcher · slot 5 · armour comes apart', 4);
  }
  else if (p.kind === 'ammo') { player.addAmmoAll(0.4); if (player.grenadesAllowed && !player.infiniteGrenades) player.grenades = Math.min(player.maxGrenades, player.grenades + 1); hud.kill('+AMMO · +GRENADE', 0); } else { player.hp = Math.min(player.maxHp, player.hp + 35); hud.kill(level.key === 'mexico' ? 'TACO · +35 HP' : '+35 HP', 0); }
  audio.pickup(); effects.strokeBurst(p.mesh.position, PICKUP_INK[p.kind] || INK.GREEN, 12, 4, { life: 0.3 });
}
function updatePickups(dt) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i]; p.t += dt;
    if (p.vy !== null) {
      // still falling: gravity until it reaches the rest height worked out at spawn
      p.vy -= 24 * dt; p.mesh.position.y += p.vy * dt;
      if (p.mesh.position.y <= p.base) {
        p.mesh.position.y = p.base; p.vy = null; p.t = 0;
        effects.strokeBurst(p.mesh.position, p.kind === 'health' ? INK.GREEN : INK.BLUE, 7, 3, { life: 0.22 });
      }
    } else p.mesh.position.y = p.base + Math.sin(p.t * 2.5) * 0.12;
    p.mesh.rotation.y += dt * 1.8;
    if (player.alive && pickupAllowed(p.kind) && p.mesh.position.distanceTo(player.center) < 1.5) {
      collectPickup(p); removePickup(p);
      if (net.active) net.send(net.isHost ? 'taken' : 'take', { id: p.id });
      continue;
    }
    if (!net.active || net.isHost) { p.life -= dt; if (p.life <= 0) { removePickup(p); if (net.isHost) net.send('taken', { id: p.id }); } }
  }
}
// Where to put the next crate. Eight darts at the map's pickup spots, throwing away any that would
// land on top of a crate already there or in the lap of somebody standing on the spot, and keeping
// the one furthest from everyone alive - so supply pulls people out of where they are rather than
// rewarding whoever happens to be standing on the spawner.
function supplySpot() {
  const spots = level.pickups; if (!spots || !spots.length) return null;
  let best = null, bestD = -1;
  for (let n = 0; n < 8; n++) {
    const s = choose(spots);
    if (pickups.some((p) => p.mesh.position.distanceTo(s) < 3)) continue;
    let d = 99;
    for (const t of ctx.targets()) if (t.alive) d = Math.min(d, t.center.distanceTo(s));
    if (d < 6) continue;
    if (d > bestD) { bestD = d; best = s; }
  }
  return best;
}
// Two clocks rather than one roll: an arena runs out of ammo often and out of health rarely, and a
// single weighted roll can leave a whole match with no medkit on the floor. If there is nowhere
// sensible to put it this second, wait a moment and look again instead of burning the interval.
let ammoClock = 0, healthClock = 20;
function updateArenaPickups(dt) {
  if (!net.isHost) return;
  if ((ammoClock -= dt) <= 0 && pickups.length < 10) { const s = supplySpot(); if (s) { ammoClock = 7; spawnPickup('ammo', s); } else ammoClock = 1.5; }
  // Health is a versus rule. In squad survival the waves already drop medkits, and adding a second
  // source would quietly rebalance a mode nobody asked me to touch.
  if (!versus()) return;
  if ((healthClock -= dt) <= 0 && pickups.reduce((n, p) => n + (p.kind === 'health'), 0) < 3) {
    const s = supplySpot(); if (s) { healthClock = 13; spawnPickup('health', s); } else healthClock = 2;
  }
}

// ---------------- solo waves ----------------
const ROSTER = [
  { t: 'grunt', from: 1, w: 10 }, { t: 'rusher', from: 2, w: 6 }, { t: 'bomber', from: 3, w: 3 },
  { t: 'sniper', from: 3, w: 4 }, { t: 'flyer', from: 4, w: 4 }, { t: 'heavy', from: 5, w: 4 }, { t: 'shield', from: 6, w: 4 },
  // The armoured pair arrive late and thin on the ground. They are not meant to be the wave -- one
  // of them in among the grunts is the whole idea, because it is the one you cannot just shoot.
  { t: 'warden', from: 8, w: 2 }, { t: 'siege', from: 10, w: 2 },
];
const MODIFIERS = [
  { name: '', apply: () => { enemies.mods.speed = 1; enemies.mods.damage = 1; } },
  { name: 'CAFFEINATED · they move fast', apply: () => { enemies.mods.speed = 1.35; enemies.mods.damage = 0.85; } },
  { name: 'HEAVY INK · they hit harder', apply: () => { enemies.mods.speed = 0.9; enemies.mods.damage = 1.4; } },
  { name: 'SWARM · more of them, thinner', apply: () => { enemies.mods.speed = 1.15; enemies.mods.damage = 0.9; } },
];
const tips = () => [
  t`hold <b>${hud.key('grapple')}</b> to reel in · tap it again to let go mid-swing`,
  player.weaponAllowed('katana') ? t`block with <b>${hud.key('block')}</b> and some of their bullets go back at them` : ts('hold fire or grenade to aim - release to throw'),
  ts('kills in the air are worth more · stay off the floor'),
  player.infiniteGrenades ? ts('unlimited grenades - hold fire and release to throw') : player.grenadesAllowed ? t`<b>${hud.key('grenade')}</b> lobs a grenade · pickups give you more` : ts('slash · hold aim to block & return bullets'),
  t`press <b>${hud.key('jump')}</b> again in the air for a double jump`,
];
const bossFor = (n) => BOSSES[(Math.floor(n / 5) - 1) % BOSSES.length];
const enemyName = (kind) => ts(({ boss: 'THE DOODLER', eraser: 'THE ERASER', inkblot: 'THE INKBLOT' })[kind] || kind.toUpperCase());
function startWave(n) {
  game.wave = n; game.queue = []; game.spawnT = 2; game.intermission = 0; game.boss = null; hud.setBoss(null, null);
  const boss = n > 0 && n % 5 === 0;
  const allowed = boss || n < 4 ? 1 : n < 6 ? 3 : MODIFIERS.length; const mod = MODIFIERS[Math.floor(Math.random() * allowed)];
  mod.apply(); enemies.mods.damage *= 1.2; hud.setModifier(mod.name);
  const swarm = mod.name.startsWith('SWARM');
  // Squad survival is meant to be harder than the solo run: a flat step up, and more on top of
  // that for every extra pair of guns, so a full lobby never just walks through a wave.
  const squad = coop() ? 1.45 + 0.5 * (teamSize() - 1) : 1;
  if (coop()) enemies.mods.damage *= 1.15;
  // the crowd on screen and the wave size both keep growing with the wave number
  game.maxAlive = Math.round(Math.min(4 + Math.floor(n * 0.9) + (swarm ? 3 : 0), (swarm ? 22 : 18) + Math.floor(n / 3)) * squad);
  let count = Math.round(Math.min(5 + n * 2.0, 32 + n) * (swarm ? 1.35 : 1) * squad);
  if (boss) { count = Math.round((7 + n) * squad); game.maxAlive += Math.round((2 + Math.floor(n / 5)) * squad); game.queue.push(bossFor(n)); }
  const pool = ROSTER.filter((r) => n >= r.from).map((r) => ({ t: r.t, w: r.w * Math.min(1, 0.3 + 0.25 * (n - r.from)) }));
  const total = pool.reduce((a, r) => a + r.w, 0);
  for (let i = 0; i < count; i++) { let r = Math.random() * total, t = pool[0].t; for (const c of pool) { r -= c.w; if (r <= 0) { t = c.t; break; } } game.queue.push(t); }
  const sub = boss ? t`${enemyName(bossFor(n))} IS COMING`
    : n === 1 ? (coop() ? t`${teamSize()} of you · they come harder in a crowd` : ts('they are crawling off the page'))
      : mod.name || choose(['ink harder', 'keep scribbling', 'stay off the ground', 'swing for it', 'return their bullets']);
  hud.message(t`WAVE ${n}`, sub, boss ? 3 : 2.6);
  if (boss) audio.bossRoar(player.center);
  audio.wave();
  if (coopHost()) coopBroadcastWave({ banner: sub, mod: mod.name, boss });
  if (n <= tips().length) hud.tip(tips()[n - 1], 7);
  if (player.grenadesAllowed && !player.infiniteGrenades) player.grenades = Math.min(player.maxGrenades, player.grenades + 1);
  const drops = coop() ? 5 + 2 * teamSize() : 7;
  for (let i = 0; i < drops; i++) spawnPickup(i < Math.ceil(drops * 0.7) ? 'ammo' : 'health', choose(level.pickups));
  if (n >= 5 && n % 5 === 0 && n > checkpoint) { checkpoint = n; localStorage.setItem('doodle_checkpoint', String(n)); hud.kill(t`CHECKPOINT · WAVE ${n}`, 0); }
}
function pickSpawn(type) {
  const spots = type === 'sniper' ? level.snipers : level.spawns; const pp = player.body.pos;
  if (type === 'flyer') { const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 10; return new THREE.Vector3(clamp(pp.x + Math.cos(a) * r, level.bounds.minX + 4, level.bounds.maxX - 4), pp.y + 12 + Math.random() * 6, clamp(pp.z + Math.sin(a) * r, level.bounds.minZ + 4, level.bounds.maxZ - 4)); }
  if (BOSSES.includes(type)) {
    const fits = (sp) => !world.overlapsAABB({ x: sp.x - 1.1, y: sp.y + 0.1, z: sp.z - 1.1 }, { x: sp.x + 1.1, y: sp.y + 5.2, z: sp.z + 1.1 });
    const open = spots.filter((sp) => fits(sp)); const far = open.filter((sp) => sp.distanceTo(pp) > 20);
    if (far.length) return choose(far).clone(); if (open.length) return choose(open).clone();
    for (let i = 0; i < 200; i++) { const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 18; const c = new THREE.Vector3(clamp(pp.x + Math.cos(a) * r, -44, 44), 0, clamp(pp.z + Math.sin(a) * r, -44, 44)); c.y = world.groundBelow(c.x, 30, c.z, 40); if (c.y > -3 && fits(c)) return c; }
    return level.playerStart.clone();
  }
  let cands = spots.filter((s) => { const d = s.distanceTo(pp); return d > 14 && d < 48; });
  if (cands.length < 2) cands = spots.filter((s) => s.distanceTo(pp) > 14);
  const hidden = cands.filter((s) => !world.hasLineOfSight(player.eye, new THREE.Vector3(s.x, s.y + 1.2, s.z)));
  return (choose(hidden.length ? hidden : cands.length ? cands : spots)).clone();
}
function updateWaves(dt) {
  if (game.intermission > 0) {
    game.intermission -= dt; hud.setTimer(t`next wave in ${Math.ceil(game.intermission)}`);
    if (game.intermission <= 0) { hud.setTimer(''); startWave(game.wave + 1); }
    return;
  }
  if (game.queue.length && enemies.alive < game.maxAlive) {
    game.spawnT -= dt;
    if (game.spawnT <= 0) {
      game.spawnT = Math.max(0.7, 2.9 - game.wave * 0.13); const t = game.queue.shift(); const e = enemies.spawn(t, pickSpawn(t));
      if (e.T.boss) { const mul = 1 + 0.35 * Math.floor((game.wave - 5) / 15); e.hp = e.maxHp = Math.round(e.T.hp * mul); }
    }
  }
  if (!game.queue.length && enemies.alive === 0) {
    game.intermission = 8; hud.message(t`WAVE ${game.wave} CLEARED`, t`catch your breath · +${200 * game.wave}`, 2.5);
    game.addScore(200 * game.wave, null); audio.waveClear(); player.hp = Math.min(player.maxHp, player.hp + 40);
    if (coopHost()) coopBroadcastWave({ cleared: true, heal: 40 });
  }
  hud.setWave(game.wave, enemies.alive + game.queue.length);
}
enemies.onKill = (e, info, over) => {
  if (coopHost()) {
    net.send('ekill', { id: e.id, src: info.source || 'gun', crit: !!info.crit, p: arr3(info.point || e.center), d: arr3(info.dir || _nd), by: info.by || net.id });
    // the kill goes on the board of whoever landed the shot, wherever they are sitting
    const sc = scores.get(info.by || net.id); if (sc) { sc.kills++; coopScoreT = Math.min(coopScoreT, 0.4); }
  }
  game.kills++; game.combo++; game.comboT = 3.5;
  let label = e.T.name, pts = e.T.score;
  if (info.crit) { label = 'HEADSHOT'; pts += 60; }
  if (info.source === 'katana') { label = over ? 'SLICED' : 'CUT DOWN'; pts += 50; }
  if (info.source === 'focus') { label = 'EXECUTED'; pts += 150; }
  if (info.source === 'katana' || info.source === 'focus') { game.katanaStreak++; player.weapons[player.katanaIndex].addBlood(0.42); if (game.katanaStreak >= KATANA_CHARGE_KILLS) enterFocus(); }
  else if (info.source !== 'blast') game.katanaStreak = 0;
  if (info.source === 'deflect') { label = 'RETURN TO SENDER'; pts += 120; }
  if (info.source === 'fall') label = 'FELL OFF THE PAGE';
  else if (!player.body.onGround && info.source !== 'deflect') { label = ts(label) + ts(' · AIRBORNE'); pts += 40; }
  game.addScore(pts, label); audio.kill(!!info.crit || e.T.boss);
  // Armour rolls its own table, and the first one you ever bring down always pays out a tube --
  // otherwise the answer to armour is locked behind killing armour, which is a door with the key
  // on the far side of it. (You can still open it with grenades; this just stops it being luck.)
  if (e.T.armored) {
    const r = Math.random(), first = !game.rocketDropped;
    if (first || r < 0.4) { game.rocketDropped = true; spawnPickup('rocket', e.body.pos); }
    else if (r < 0.75) spawnPickup('ammo', e.body.pos);
    else spawnPickup('health', e.body.pos);
  } else { const r = Math.random(); if (r < 0.5) spawnPickup('ammo', e.body.pos); else if (r < 0.62) spawnPickup('health', e.body.pos); }
};
enemies.onBoss = (e) => { if (!e.alive) { hud.setBoss(null, null); game.boss = null; } else { game.boss = e; hud.setBoss(e.T.name, e.hp / e.maxHp); } };
player.onThrow = (d) => { if (net.active) net.broadcast('nade', d); };

// ---------------- focus slash (solo only) ----------------
const FOCUS_TIME = 2.6, FOCUS_SCALE = 0.26, FOCUS_RANGE = 24, FOCUS_MAX_CHAIN = 2, FOCUS_ARM = 0.18, DASH_SPEED = 46, KATANA_CHARGE_KILLS = 3;
const _fv = new THREE.Vector3();
function focusCandidate() {
  let best = null, bestScore = -1;
  for (const e of enemies.enemies) {
    if (!e.alive || e.state === 'spawn') continue;
    _fv.subVectors(e.center, player.eye); const d = _fv.length(); if (d > FOCUS_RANGE || d < 0.5) continue;
    const aim = _fv.divideScalar(d).dot(player.forward); if (aim < 0.4) continue;
    if (!world.hasLineOfSight(player.eye, e.center)) continue;
    const score = aim * 3 - d / FOCUS_RANGE; if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}
function enterFocus() {
  if (online() || !player.weaponAllowed('katana') || game.focus.chain >= FOCUS_MAX_CHAIN || !focusCandidate()) return;
  const fresh = !game.focus.active;
  game.focus.active = true; game.focus.t = FOCUS_TIME; game.focus.chain++; game.focus.arm = FOCUS_ARM; game.focus.ready = false;
  if (fresh) { audio.focusIn(); hud.tip(t`<b>SLASH READY</b> · hold ${hud.key('focus')} to dash`, 2.2); }
}
function endFocus() { if (!game.focus.active && !game.focus.dash) return; game.focus.active = false; game.focus.target = null; game.focus.chain = 0; game.focus.dash = null; game.katanaStreak = 0; player.dashLock = false; hud.setFocusMark(null); }
function startFocusDash(target) { game.focus.dash = { target, t: 0, trail: player.center.clone(), lastTrail: 0 }; player.dashLock = true; player.body.vel.set(0, 0, 0); audio.dash(); player.kickFov(5); input.rumble(0.5, 0.4, 120); hud.setFocusMark(null); }
function marchBody(b, nx, nz, dist) {
  let moved = 0;
  for (let step = Math.min(0.22, dist); moved + 1e-4 < dist;) { const s2 = Math.min(step, dist - moved); b.pos.x += nx * s2; b.pos.z += nz * s2; if (world.overlapsBody(b)) { b.pos.y += 0.65; if (world.overlapsBody(b)) { b.pos.y -= 0.65; b.pos.x -= nx * s2; b.pos.z -= nz * s2; return moved; } } moved += s2; }
  return moved;
}
function updateFocusDash(dt) {
  const d = game.focus.dash; if (!d) return true;
  const target = d.target; d.t += dt;
  if (!target.alive || d.t > 1.2) { endDash(false); return true; }
  const b = player.body; const dx = target.body.pos.x - b.pos.x, dz = target.body.pos.z - b.pos.z; const flat = Math.hypot(dx, dz); const nx = dx / (flat || 1), nz = dz / (flat || 1);
  player.yaw = Math.atan2(-dx, -dz); _fv.subVectors(target.center, player.eye); player.pitch = clamp(Math.atan2(_fv.y, Math.hypot(_fv.x, _fv.z)), -1.2, 1.2);
  const want = Math.max(0, flat - 1.1); const moved = marchBody(b, nx, nz, Math.min(DASH_SPEED * dt, want));
  const aimY = target.body.pos.y + (target.T.flying ? 0.2 : 0); const dy = aimY - b.pos.y;
  if (Math.abs(dy) > 0.05) { const y = b.pos.y; b.pos.y += clamp(dy, -DASH_SPEED * dt, DASH_SPEED * dt); if (world.overlapsBody(b)) { b.pos.y = y; d.stuckY = (d.stuckY || 0) + dt; } else d.stuckY = 0; }
  d.lastTrail += dt; if (d.lastTrail > 0.02) { d.lastTrail = 0; effects.tracer(d.trail, player.center, INK.BLUE, 0.045, 0.28); d.trail.copy(player.center); effects.strokeBurst(player.center, INK.BLUE, 2, 5, { life: 0.22, size: 0.03 }); }
  const reach = Math.hypot(flat, Math.max(0, Math.abs(dy) - 0.6));
  if (reach <= 1.5) { focusExecute(target); return true; }
  if (moved < 1e-4 && want > 0.05 && (d.stuckY || 0) > 0.08) { endDash(true); return true; }
  return false;
}
function endDash(blocked) { player.dashLock = false; game.focus.dash = null; player.body.vel.set(0, 0, 0); if (blocked) { player.weapons[player.katanaIndex].startSlash(player._weaponState(false, false, 0)); audio.katanaSwing(); hud.tip('blocked · the dash did not reach', 1.2); } }
function focusExecute(target) {
  if (!player.weaponAllowed('katana')) { endFocus(); return; }
  player.dashLock = false; game.focus.dash = null; player.body.vel.set(0, 0, 0);
  player.weapons[player.katanaIndex].startSlash(player._weaponState(false, false, 0));
  _fv.subVectors(target.center, player.eye); const dir = _fv.clone().normalize(); const chainBefore = game.focus.chain;
  enemies.damage(target, 100000, { point: target.center.clone(), dir, part: 'head', source: 'focus', crit: true });
  audio.focusSlash(); game.hitstop(0.1, 0.08); effects.shakeAmt += 0.35; input.rumble(0.9, 0.7, 140); player.kickFov(6); player.hp = Math.min(player.maxHp, player.hp + 6);
  if (game.focus.chain === chainBefore) game.focus.t = Math.min(game.focus.t, 0.35);
  game.focus.target = null; hud.setFocusMark(null);
}
function updateFocus(dt) {
  const f = game.focus; if (!f.active) return;
  if (f.dash) { updateFocusDash(dt); return; }
  f.t -= dt; f.arm -= dt; if (f.t <= 0 || !player.alive) { endFocus(); return; }
  const combo = (input.down('aim') && input.down('fire')) || input.down('dash'); if (!combo) f.ready = true;
  const target = focusCandidate(); f.target = target;
  if (!target) { hud.setFocusMark(null); return; }
  _fv.copy(target.center).project(R.camera);
  if (_fv.z < 1) hud.setFocusMark((_fv.x * 0.5 + 0.5) * window.innerWidth, (-_fv.y * 0.5 + 0.5) * window.innerHeight); else hud.setFocusMark(null);
  if (combo && f.ready && f.arm <= 0) { input.consume('fire'); startFocusDash(target); }
}

// ---------------- free for all: spawning, death, scoring ----------------
const HOW = { rifle: 'rifle', shotgun: 'shotgun', sniper: 'sniper', katana: 'katana', grenade: 'grenade', deflect: 'their own bullet' };
const howWord = (src) => HOW[src] || null;
const spawnSpots = () => (level.arenaSpawns && level.arenaSpawns.length ? level.arenaSpawns : level.spawns);
function arenaSpawn() {
  const spots = spawnSpots(); const others = [...remote.values()].filter((r) => r.alive && r.root && r.root.visible);
  const scored = spots.map((s) => ({ s, d: others.reduce((a, r) => Math.min(a, r.body.pos.distanceTo(s)), 999) }));
  scored.sort((a, b) => b.d - a.d);
  return choose(scored.slice(0, Math.min(3, scored.length))).s.clone();
}
// a spot for a late joiner: the one farthest from everybody already in the match
function farthestSpawnIndex() {
  const spots = spawnSpots(); const bodies = [player, ...remote.values()].filter((r) => r.alive); let best = 0, bd = -1;
  spots.forEach((s, i) => { const d = bodies.reduce((a, r) => Math.min(a, r.body.pos.distanceTo(s)), 999); if (d > bd) { bd = d; best = i; } });
  return best;
}
function onLocalDeath() {
  if (!online()) { game.state = 'dying'; game.deathT = 0; return; }
  const killer = player.lastHitBy || null; const h = player.lastHit || {};
  const dir = h.from ? player.center.clone().sub(new THREE.Vector3().fromArray(h.from)).normalize().toArray().map((v) => +v.toFixed(2)) : null;
  const how = killer ? howWord(h.src) : null;
  net.broadcast('pdead', { killer, dir, over: !!(h.crit || h.amount >= 90 || h.src === 'katana'), how, crit: !!h.crit });
  if (net.isHost) tallyDeath(net.id, killer);
  game.respawnT = RESPAWN; game.state = 'dying'; game.deathT = 0;
  const kn = killer && scores.get(killer) ? scores.get(killer).name : null;
  const tail = how ? ' · ' + ts(how) + (h.crit ? ts(' headshot') : '') : '';
  hud.kill(kn ? t`erased by ${kn}${tail}` : ts('erased'), 0);
}
function respawnLocal() {
  player.reset(arenaSpawn()); player.name = myName; player.lastHitBy = null; player.lastHit = null; game.state = 'play'; player.shieldT = 2; hud.tip('spawn protection · 2s', 1.6);
  effects.strokeBurst(player.center, INK.BLUE, 24, 6, { life: 0.5, size: 0.03 }); audio.spawn(player.center);
}
function tallyDeath(victim, killer) {
  const v = scores.get(victim); if (v) v.deaths++;
  if (killer && killer !== victim) { const k = scores.get(killer); if (k) k.kills++; }
  sendScores(); checkWin();
}
function sendScores() { const rows = [...scores.entries()].map(([id, s]) => ({ id, ...s })); net.send('score', rows); applyScores(rows); }
function applyScores(rows) { scores.clear(); for (const r of rows) scores.set(r.id, { name: r.name, kills: r.kills, deaths: r.deaths }); refreshScoreHud(); }
function sortedScores() { return [...scores.entries()].sort((a, b) => b[1].kills - a[1].kills || a[1].deaths - b[1].deaths); }
function playerNameHTML(id, name, markMe = false) { return `<span class="player-name" style="--player-color:${playerColorCSS(lobby.players.get(id)?.color)}"><i class="player-swatch" aria-hidden="true"></i>${esc(name)}${markMe && id === net.id ? ts(' (you)') : ''}</span>`; }
function refreshScoreHud() {
  if (!online()) return;
  // co-op keeps its own panel: one team score, and who is still on their feet
  if (coop()) { coopHudTick(0); if (!hud.el.board.hidden) hud.setBoard(boardHTML()); return; }
  const rows = sortedScores(); const top = rows.slice(0, 3); const myIdx = rows.findIndex(([id]) => id === net.id);
  if (myIdx >= 3) top.push(rows[myIdx]);
  hud.setPvpScore(top.map(([id, sc]) => `<div class="row${id === net.id ? ' me' : ''}"><span class="rank">${rows.findIndex(([x]) => x === id) + 1}.</span>${playerNameHTML(id, sc.name, true)}<b>${sc.kills}</b></div>`).join('') + `<div class="target">${t`first to ${FFA_TARGET}`}</div>`);
  hud.setModifier('');
  if (!hud.el.board.hidden) hud.setBoard(boardHTML());
}
// The round trip the server measured for each player, not one they told us about, so this column
// is the same number the hit rewind is working from. A quiet seat reads "--" rather than freezing
// on its last good value and pretending the link is fine.
function pingCell(id) {
  const ms = net.active ? net.pings[id] : undefined;
  if (ms == null) return '<i class="pg">--</i>';
  if (ms < 0) return '<i class="pg bad">quiet</i>';
  return `<i class="pg ${ms < 70 ? 'good' : ms < 160 ? '' : 'bad'}">${ms}<small>ms</small></i>`;
}
function boardHTML(title = null) {
  const rows = sortedScores(); const code = String(net.aliasCode || net.code || '').replace(/-\d+$/, '');
  const line = (id, s, tail) => `<div class="${id === net.id ? 'me' : ''}">${playerNameHTML(id, s.name, true)}<span class="tail">${tail}</span>${pingCell(id)}</div>`;
  if (coop()) {
    return `<h3>${ts(title || 'SQUAD SURVIVAL')}</h3>${rows.map(([id, s]) => line(id, s, t`${s.kills} kills · ${s.deaths} downs`)).join('')}<div class="foot">${t`wave ${game.wave} · ${game.score} points · ${enemies.alive + game.queue.length} left · lobby ${code}`}</div>`;
  }
  return `<h3>${ts(title || 'FREE FOR ALL')}</h3>${rows.map(([id, s]) => line(id, s, t`${s.kills} kills · ${s.deaths} deaths`)).join('')}<div class="foot">${t`first to ${FFA_TARGET} · ${mmss(matchLeft)} left · lobby ${code}`}</div>`;
}
function checkWin() {
  if (!net.isHost || !versus() || game.over) return;
  let winner = null;
  for (const [id, s] of scores) if (s.kills >= FFA_TARGET) winner = { id, name: s.name };
  if (winner) { net.send('end', winner); endMatch(winner); }
}
function endMatch(winner) {
  game.over = winner; game.overT = 0; game.state = 'over'; endFocus(); input.exitLock(); hud.setBoard(null);
  const title = winner.coop ? ts('SQUAD WIPED') : winner.id === net.id ? ts('YOU WIN') : t`${winner.name || ts('someone')} WINS`;
  const sub = winner.coop ? `<div class="go">${t`you held the page to wave ${winner.wave || game.wave} · ${winner.score ?? game.score} points`}</div>` : '';
  const tail = winner.coop ? (s) => t`${s.kills} kills · ${s.deaths} downs` : (s) => t`${s.kills} K · ${s.deaths} D`;
  hud.setGameplayVisible(false); hud.showScreen(`<h1>${title}</h1>${sub}<div class="scoreboard">${sortedScores().map(([id, s]) => `<div class="${id === net.id ? 'me' : ''}">${playerNameHTML(id, s.name)}<span>${tail(s)}</span></div>`).join('')}</div><div class="go" id="overGo">${ts('back to the lobby in a moment…')}</div>`);
}

// ---------------- networking ----------------
function addRemote(id, name, color) {
  if (remote.has(id)) { const r = remote.get(id); r.name = name; r.setInk(playerInk(color)); return r; }
  const rp = new RemotePlayer(ctx, id, name, 0, playerInk(color));
  rp.onDamage = (t, amount, fromPos) => {
    if (!t.alive || amount <= 0) return;
    const at = fromPos ? fromPos.toArray().map((v) => +v.toFixed(1)) : null;
    // co-op: nothing of mine can hurt a teammate, but the enemies I am simulating can.
    // Their melee and stomps only exist on the host, so the host tells you that you were hit.
    if (coop()) { if (net.isHost) net.sendTo(t.id, 'pdmg', { amount: Math.round(amount), from: at, by: null, src: 'enemy' }); return; }
    if (!ctx.canHurt(t)) return;
    hud.hitmarker(false, false);
    // A blast is claimed by where it went off, not by a ray - the server checks that they were
    // standing inside it a round trip ago, and that we were near enough to have thrown it.
    net.hit(t.id, { k: 'grenade', dmg: Math.round(amount), at });
  };
  remote.set(id, rp); return rp;
}
function removeRemote(id) {
  const p = lobby.players.get(id); if (p && validPlayerColor(p.color)) colorSeats.set(id, { color: p.color, until: Date.now() + 60000 });
  const r = remote.get(id); if (r) { r.dispose(); remote.delete(id); } lobby.players.delete(id); scores.delete(id); stalled.delete(id);
}
function lobbyRows() { return [...lobby.players.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color })); }
function reservedColors() { for (const [id, seat] of colorSeats) if (seat.until <= Date.now()) colorSeats.delete(id); return [...colorSeats.entries()].map(([id, seat]) => ({ id, ...seat })); }
// Leaving never renumbers the remaining seats. Keep a departed colour warm for automatic rejoin,
// including when that player was the host; reservations travel with the roster to its successor.
function assignPlayerColor(id, prev) {
  const used = new Set([...lobby.players.entries()].filter(([pid]) => pid !== id && pid !== prev).map(([, p]) => p.color));
  const held = new Set(reservedColors().map((p) => p.color));
  const preferred = lobby.players.get(id)?.color ?? colorSeats.get(id)?.color ?? lobby.players.get(prev)?.color ?? colorSeats.get(prev)?.color;
  if (validPlayerColor(preferred) && !used.has(preferred)) return preferred;
  const fresh = PLAYER_INKS.findIndex((_, slot) => !used.has(slot) && !held.has(slot));
  return fresh >= 0 ? fresh : PLAYER_INKS.findIndex((_, slot) => !used.has(slot));
}
function applyLobbyPlayers(rows, reservations) {
  const ids = new Set(rows.map((p) => p.id));
  for (const id of [...lobby.players.keys()]) if (!ids.has(id)) removeRemote(id);
  if (Array.isArray(reservations)) { colorSeats.clear(); for (const p of reservations) if (validPlayerColor(p.color) && p.until > Date.now()) colorSeats.set(p.id, { color: p.color, until: p.until }); }
  const previous = new Map(lobby.players); lobby.players.clear(); lobby.order = rows.map((p) => p.id);
  for (const p of rows) lobby.players.set(p.id, { name: p.name, color: validPlayerColor(p.color) ? p.color : previous.get(p.id)?.color ?? 0 });
  for (const [id, p] of lobby.players) {
    colorSeats.delete(id);
    if (id !== net.id) addRemote(id, p.name, p.color);
    else { player.color = p.color; player.ink = playerInk(p.color); }
  }
  for (const id of [...remote.keys()]) if (!lobby.players.has(id) || id === net.id) { const r = remote.get(id); r.dispose(); remote.delete(id); }
}
function broadcastLobby() { net.send('lobby', { players: lobbyRows(), colors: reservedColors(), hostId: net.id, isPublic: lobby.isPublic, map: lobby.map || mapKey, mode: lobby.gameMode, bal: !!lobby.ballistics, diff: ctx.difficulty(), mob: lobby.mob, weaponMode: ctx.weaponMode(), shown: net.aliasCode || net.code }); renderLobby(); }
const inMatch = () => ['play', 'dying', 'over'].includes(game.state);
let boardT = 0;   // seconds since the open scoreboard was last redrawn
net.onPeerLeave = (id) => { const nm = (lobby.players.get(id) || {}).name; removeRemote(id); broadcastLobby(); if (inMatch()) { hud.kill(t`${nm || ts('someone')} left`, 0); sendScores(); } };
net.onDisconnect = (reason) => leaveOnline(reason || 'lost the connection to the server');
// A link going quiet is no longer the end of anybody's match. The server holds the seat for a few
// seconds while the socket is rebuilt, so the figure stays standing and we just say what happened;
// only when the seat really expires does `gone` arrive and the ordinary leave path run.
const stalled = new Set();
net.onStall = (quiet, res) => {
  if (inMatch() || game.state === 'lobby') hud.kill(quiet ? 'connection lost — reconnecting…' : 'reconnected', 0);
  if (quiet || !res) return;
  if (net.isHost) {
    const members = res?.members || [];
    for (const id of [...lobby.players.keys()]) if (!members.some((p) => p.id === id)) removeRemote(id);
    for (const p of members) if (p.id !== net.id && !lobby.players.has(p.id)) net.onPeerJoin(p.id, { name: p.name });
    broadcastLobby();
  } else net.send('lobbyreq', {});
};
net.on('lobbyreq', () => { if (net.isHost) broadcastLobby(); });
net.onPeerStall = (id, quiet) => {
  const nm = (lobby.players.get(id) || {}).name || 'someone';
  if (quiet) stalled.add(id); else stalled.delete(id);
  if (inMatch()) hud.kill(quiet ? t`${nm} has gone quiet` : t`${nm} is back`, 0);
};
// ---- host transfer ----
// The room lives on the server, so a host walking out is a promotion, not a reconnect: the server
// hands the job to whoever has been in the longest and tells everyone. The old peer-to-peer version
// had to open a fresh lobby on a generation code and drag everybody across; none of that is needed.
let hostQuiet = false;        // set once when the host stops sending, so we only say it once
net.onHostChange = (id, becameHost) => {
  hostQuiet = false;
  const oldHost = lobby.hostId; lobby.hostId = id;
  if (oldHost && oldHost !== id) removeRemote(oldHost);
  if (becameHost) {
    net.accepting = true; net.hostName = myName; lobby.isPublic = net.isPublic;
    game.clockStarted = clockRunning || matchLeft < FFA_TIME;
    if (coop()) {
      // the enemies standing here were somebody else's puppets a moment ago; they are mine now,
      // and they carry on from wherever the last snapshot left them
      enemies.mirror = false; enemies.nextId = Math.max(enemies.nextId, ...[...enemies.byId.keys()], 0) + 1;
      game.queue = []; game.spawnT = 1;
    }
    if (inMatch()) { refreshScoreHud(); sendScores(); }
    broadcastLobby();
  }
  hud.message('HOST LEFT', becameHost ? 'you are hosting now' : 'someone else is hosting now', 2.4);
  renderLobby();
};
net.on('refused', (d) => leaveOnline(d.reason));
net.hostName = myName;
net.onPeerJoin = (from, meta) => {
  const name = String(meta && meta.name || 'doodle').slice(0, 14);
  const prev = meta && meta.prev !== from && !net.conns.has(meta.prev) ? meta.prev : null;
  const color = assignPlayerColor(from, prev);
  if (prev) { const sc = scores.get(prev); if (sc) { scores.delete(prev); scores.set(from, sc); } const r = remote.get(prev); if (r) r.dispose(); remote.delete(prev); lobby.players.delete(prev); colorSeats.delete(prev); if (lobby.order) lobby.order = lobby.order.filter((id) => id !== prev); }
  colorSeats.delete(from); lobby.players.set(from, { name, color }); addRemote(from, name, color); broadcastLobby();
  if (game.state === 'play' || game.state === 'dying') {
    if (!scores.has(from)) scores.set(from, { name, kills: 0, deaths: 0 });
    net.sendTo(from, 'start', { late: true, players: lobbyRows(), colors: reservedColors(), spawn: farthestSpawnIndex(), map: lobby.map || mapKey, mode: game.mode, bal: !!lobby.ballistics, diff: ctx.difficulty(), mob: lobby.mob, weaponMode: ctx.weaponMode(), broken: level.breakables.filter((b) => !b.alive).map((b) => b.id) });
    // a latecomer has an empty world until it is told what is already standing in it
    if (coopHost()) setTimeout(() => sendCoopCatchUp(from), 350);
    sendScores(); hud.kill(t`${name} joined`, 0);
  }
};
net.on('lobby', (d, from) => {
  if (net.isHost || from !== net.hostId || !Array.isArray(d.players)) return;
  lobby.hostId = d.hostId; lobby.isPublic = !!d.isPublic; lobby.code = net.code; lobby.shown = d.shown || net.code; if (d.map) lobby.map = knownMap(d.map); lobby.gameMode = d.mode === 'coop' ? 'coop' : 'ffa'; lobby.ballistics = !!d.bal; if (d.mob) lobby.mob = d.mob; if (d.diff) lobby.diff = d.diff; lobby.weaponMode = weaponModeOf(d.weaponMode).key; applyRules();
  applyLobbyPlayers(d.players, d.colors);
  if (inMatch()) { for (const p of d.players) if (!scores.has(p.id)) scores.set(p.id, { name: p.name, kills: 0, deaths: 0 }); refreshScoreHud(); }
  renderLobby();
});
net.on('leave', (d) => { const nm = (lobby.players.get(d.id) || {}).name; removeRemote(d.id); if (inMatch()) hud.kill(t`${nm || ts('someone')} left`, 0); renderLobby(); });
net.on('start', (d, from) => { if (net.isHost || from !== net.hostId) return; if (d.players) applyLobbyPlayers(d.players, d.colors); if (d.map) lobby.map = knownMap(d.map); if (d.bal !== undefined) lobby.ballistics = !!d.bal; if (d.diff) lobby.diff = d.diff; if (d.mob) lobby.mob = d.mob; lobby.weaponMode = weaponModeOf(d.weaponMode).key; startMatch(!!d.late, d.spawns ? d.spawns[net.id] : d.spawn, d.mode === 'coop' ? 'coop' : 'ffa'); if (d.broken) for (const id of d.broken) { const br = level.breakables[id]; if (br) breakProp(br, null, false, true); } });
net.on('startreq', () => { if (net.isHost && game.state === 'lobby') hostStart(); });

// ---------------- co-op: the host owns the enemies, everyone else mirrors them ----------------
// Waves, AI, pathing and enemy health all run on the host. Clients render from snapshots and
// report the hits they land; the host decides what those hits actually did. That is the authority
// split EnemyManager's mirror mode was already built for, so none of the AI had to change.
//
// Damage taken is the other way round: enemy bullets are replayed on every client and each one
// applies the hurt to its own player. That keeps taking a hit honest to what you saw on screen.
const _np = new THREE.Vector3(), _nd = new THREE.Vector3(0, 1, 0);
const coopHost = () => coop() && net.isHost;
const coopClient = () => coop() && !net.isHost;
const teamSize = () => (net.active ? Math.max(1, lobby.players.size) : 1);
const arr3 = (v) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
let snapT = 0, coopScoreT = 0, coopSyncT = 0;

enemies.onSpawn = (e) => { if (coopHost()) net.send('espawn', { id: e.id, t: e.type, p: arr3(e.body.pos), hp: e.hp }); };
enemies.projectiles.onFire = (p) => { if (coopHost()) net.send('eshot', { id: p.id, p: arr3(p.pos), v: arr3(p.vel), dmg: p.dmg, ink: p.ink, thick: p.thick, blast: p.blast }); };
// a client landed a shot: tell the host, which owns the health bar
enemies.onClientHit = (e, amount, info) => {
  if (!coopClient()) return;
  net.send('ehit', { id: e.id, a: Math.round(amount), part: info.part || 'torso', src: info.source || 'gun', crit: !!info.crit, p: arr3(info.point || e.center), d: arr3(info.dir || _nd) });
};
net.on('ehit', (d, from) => {
  if (!coopHost()) return;
  const e = enemies.byId.get(d.id); if (!e || !e.alive) return;
  enemies.damage(e, d.a, { point: _np.fromArray(d.p).clone(), dir: new THREE.Vector3().fromArray(d.d), part: d.part, source: d.src, crit: !!d.crit, by: from });
});
net.on('espawn', (d) => {
  if (!coopClient() || enemies.byId.has(d.id)) return;
  const e = enemies.spawn(d.t, _np.fromArray(d.p).clone(), d.id); e.hp = e.maxHp = d.hp;
});
net.on('esnap', (a) => { if (coopClient() && Array.isArray(a)) enemies.applySnapshot(a, performance.now() / 1000); });
net.on('ekill', (d) => { if (coopClient()) enemies.killMirror(d.id, { source: d.src, crit: !!d.crit, point: d.p, dir: d.d }); });
net.on('eshot', (d) => {
  if (!coopClient()) return;
  enemies.projectiles.fire(_np.fromArray(d.p), new THREE.Vector3().fromArray(d.v).normalize(), new THREE.Vector3().fromArray(d.v).length(), d.dmg, null, d.ink, d.thick, d.blast, d.id);
});
// the wave banner, the counter and the intermission clock are the host's to call
net.on('ewave', (d) => {
  if (!coopClient()) return;
  game.wave = d.n; game.maxAlive = d.maxAlive || game.maxAlive; game.intermission = d.inter || 0;
  if (d.left != null) coopLeft = d.left;
  if (d.banner) { hud.message(t`WAVE ${d.n}`, d.banner, d.boss ? 3 : 2.6); audio.wave(); if (d.boss) audio.bossRoar(player.center); }
  if (d.mod != null) hud.setModifier(d.mod);
  if (d.cleared) { hud.message(t`WAVE ${d.n} CLEARED`, 'catch your breath', 2.5); audio.waveClear(); }
  if (d.heal) player.hp = Math.min(player.maxHp, player.hp + d.heal);
  coopHudTick(0);
});
net.on('escore', (d) => { game.score = d.score; game.kills = d.kills; hud.setScore(game.score, game.combo); });
// the wave clock and the counter belong to the host, but they have to keep moving between syncs
let coopLeft = 0;
function coopHudTick(dt) {
  if (!coop()) return;
  if (coopClient()) {
    if (game.intermission > 0) { game.intermission = Math.max(0, game.intermission - dt); hud.setTimer(game.intermission > 0 ? t`next wave in ${Math.ceil(game.intermission)}` : ''); }
    else hud.setTimer('');
    hud.setWave(game.wave, Math.max(enemies.alive, coopLeft));
  }
  hud.setPvpScore(coopBoardRows());
}
// one team, one score: who is up, who is down, and how many each of you has put away
function coopBoardRows() {
  const rows = [...scores.entries()].sort((a, b) => b[1].kills - a[1].kills);
  const down = (id) => (id === net.id ? !player.alive : !(remote.get(id) || { alive: true }).alive);
  return rows.slice(0, 4).map(([id, sc]) => `<div class="row${id === net.id ? ' me' : ''}${down(id) ? ' down' : ''}"><span class="rank">${down(id) ? '✕' : '·'}</span>${playerNameHTML(id, sc.name, true)}<b>${sc.kills}</b></div>`).join('')
    + `<div class="target">wave ${game.wave} · ${game.score} pts</div>`;
}
// everything already standing, for someone who just walked in
function sendCoopCatchUp(id) {
  if (!coopHost()) return;
  for (const e of enemies.enemies) if (e.alive) net.sendTo(id, 'espawn', { id: e.id, t: e.type, p: arr3(e.body.pos), hp: e.hp });
  net.sendTo(id, 'ewave', { n: game.wave, maxAlive: game.maxAlive, inter: game.intermission });
  net.sendTo(id, 'esnap', enemies.snapshot());
}
function coopBroadcastWave(extra = {}) { if (coopHost()) net.send('ewave', { n: game.wave, maxAlive: game.maxAlive, inter: game.intermission, ...extra }); }
net.on('end', (d) => endMatch(d));
net.on('backtolobby', () => { if (!net.isHost) toLobbyScreen(); });
net.on('pickup', (d) => { if (!net.isHost) spawnPickup(d.kind, new THREE.Vector3().fromArray(d.pos), d.id); });
net.on('taken', (d) => { const p = pickups.find((x) => x.id === d.id); if (p) removePickup(p); });
net.on('take', (d) => { if (!net.isHost) return; const p = pickups.find((x) => x.id === d.id); if (p) { removePickup(p); net.send('taken', { id: d.id }); } });
net.on('ps', (d, from) => { const r = remote.get(from); if (r) { r.push(d, performance.now() / 1000); r.lastSeen = performance.now(); } });
net.on('pdmg', (d) => {
  if (!player.alive || game.state !== 'play' || player.shieldT > 0) return; player.lastHitBy = d.by || null; player.lastHit = { from: d.from || null, crit: !!d.crit, amount: d.amount, src: d.src };
  player.takeDamage(d.amount, d.from ? new THREE.Vector3().fromArray(d.from) : null);
});
net.on('pdead', (d, from) => {
  const r = remote.get(from); const vn = r ? r.name : 'someone'; const kn = d.killer && scores.get(d.killer) ? scores.get(d.killer).name : null;
  if (r) { r.ragdoll(d.dir ? new THREE.Vector3().fromArray(d.dir) : null, !!d.over); audio.enemyDie(r.center); }
  const how = d.how ? ' · ' + ts(d.how) + (d.crit ? ts(' headshot') : '') : '';
  if (coop()) hud.kill(t`${vn} is down`, 0);
  else if (d.killer === net.id) { game.kills++; game.addScore(100, t`ERASED ${vn}${how}`); audio.kill(true); }
  else hud.kill(kn ? t`${kn} erased ${vn}${how}` : t`${vn} fell off the page`, 0);
  if (net.isHost) tallyDeath(from, d.killer);
});
net.on('nade', (d) => player.throwGrenade(d));
net.on('brk', (d) => { const br = level.breakables[d.id]; if (br) breakProp(br, null, false); });
net.on('parry', (d) => { audio.shieldHit(player.center); input.rumble(0.35, 0.3, 60); effects.strokeBurst(player.eye.clone().addScaledVector(player.forward, 0.5), INK.ORANGE, 8, 5, { life: 0.2, size: 0.03 }); hud.kill(d.ret ? 'RETURN TO SENDER' : 'DEFLECTED', d.ret ? 25 : 0); });
net.on('shots', (d, from) => {
  const r = remote.get(from); if (!r || !r.root || !r.alive) return;
  const th = TRACER_THICK[d.k] || 0.02;
  if (d.b && d.b.length) {
    // their rounds, flown here for the look of them: they stop at walls and nothing else, because
    // whether they hit anybody was settled on the machine that fired them
    for (let i = 0; i + 5 < d.b.length; i += 6) {
      _sm.set(d.b[i], d.b[i + 1], d.b[i + 2]); _se.set(d.b[i + 3], d.b[i + 4], d.b[i + 5]);
      if (_se.lengthSq() > 1e-6) bullets.fire(null, _sm, _se, { cosmetic: true, mv: d.mv || 330, thick: th, maxRange: 300, ...(REMOTE_ROUND[d.k] || {}) });
    }
    r.flash(); audio.remoteShot(d.k, _sm); return;
  }
  _sm.set(r.body.pos.x + r.right.x * 0.3 + r.forward.x * 0.8, r.body.pos.y + 1.35 + r.forward.y * 0.8, r.body.pos.z + r.right.z * 0.3 + r.forward.z * 0.8);
  const e = d.e || [];
  for (let i = 0; i + 2 < e.length; i += 3) { _se.set(e[i], e[i + 1], e[i + 2]); effects.tracer(_sm, _se, INK.BLUE, th, 0.06); }
  r.flash(); audio.remoteShot(d.k, _sm);
});
net.on('cut', () => { if (player.grapple.state !== 'idle') { player.detachGrapple(false); effects.strokeBurst(player.center, INK.ORANGE, 8, 4, { life: 0.25, size: 0.03 }); hud.tip('your rope got cut', 1.3); input.rumble(0.5, 0.3, 80); } });
net.on('score', (rows) => { if (!net.isHost) applyScores(rows); });
net.on('fell', (d, from) => { if (!net.isHost) return; const sc = scores.get(from); if (sc) { sc.kills = Math.max(0, sc.kills - 1); sendScores(); net.send('feed', { text: sc.name + ' fell off the page · -1' }); hud.kill(t`${sc.name} fell off the page · -1`, 0); } });
net.on('feed', (d) => hud.kill(String(d.text || ''), 0));
player.onFall = () => {
  if (!online() || !inMatch()) return;
  hud.kill('fell off the page · -1 kill', 0);
  if (net.isHost) { const sc = scores.get(net.id); if (sc) { sc.kills = Math.max(0, sc.kills - 1); sendScores(); net.send('feed', { text: sc.name + ' fell off the page · -1' }); } }
  else net.send('fell', {});
};
net.on('clock', (d) => { if (!net.isHost) { matchLeft = d.left; clockRunning = !!d.on; } });

// ---- idle players: a warning, then out; a lobby with nobody active in it shuts down ----
const IDLE_FLAG = 30, IDLE_MATCH = 150, IDLE_LOBBY = 300, IDLE_WARN = 20;
let idleWarned = false, idleCheckT = 0;
function idleUpdate(dt) {
  if (!net.active) { idleWarned = false; return; }
  idleCheckT -= dt; if (idleCheckT > 0) return; idleCheckT = 1;
  const limit = inMatch() ? IDLE_MATCH : IDLE_LOBBY; const idle = input.idleSeconds;
  const othersActive = [...remote.values()].some((r) => !r.idle);
  // a host that still has active players stays; kicking it would end their match
  const canDrop = !net.isHost || !othersActive;
  if (idle > limit - IDLE_WARN && !idleWarned && canDrop) { idleWarned = true; hud.message('STILL THERE?', 'move or you get kicked for inactivity', 3); audio.empty(); }
  if (idle <= limit - IDLE_WARN) idleWarned = false;
  if (idle > limit && canDrop) { const back = net.isHost ? null : String(net.aliasCode || net.code || '').replace(/-\d+$/, ''); leaveOnline(net.isHost ? 'lobby closed: everyone was idle' : 'kicked for inactivity'); lobby.rejoinCode = back; if (back) showStart(); return; }
  // the host also clears out a client that has sat idle past the limit, in case its tab cannot do it itself
  if (net.isHost) for (const [id, r] of remote) if (r.idle && r.idleSince && performance.now() / 1000 - r.idleSince > limit - IDLE_FLAG + 15) { net.sendTo(id, 'kick', { reason: 'kicked for inactivity' }); const c = net.conns.get(id); setTimeout(() => { try { c && c.close(); } catch (e) { /* ignore */ } }, 500); }
}
net.on('kick', (d) => { const back = String(net.aliasCode || net.code || '').replace(/-\d+$/, ''); leaveOnline(d && d.reason || 'kicked'); lobby.rejoinCode = back; if (back) showStart(); });
let syncTick = 0;
function netUpdate(dt) {
  idleUpdate(dt);
  if (!net.active) return; const now = performance.now() / 1000; syncTick++;
  for (const r of remote.values()) r.update(dt, now);
  // a connection that died without saying so leaves a figure standing around: drop anyone silent too long
  if (inMatch()) for (const [id, r] of remote) {
    if (!r.lastSeen || performance.now() - r.lastSeen <= 9000) continue;
    if (stalled.has(id)) continue;   // the server says they are coming back; wait for it to say otherwise
    // a quiet host is not a dead lobby any more: the room is on the server, which will hand the job
    // on if the host really is gone. Leave the figure standing and say so rather than tearing down.
    if (!net.isHost && id === net.hostId) { if (!hostQuiet) { hostQuiet = true; hud.kill('the host has gone quiet', 0); } continue; }
    const nm = r.name; removeRemote(id); hud.kill(t`${nm} lost connection`, 0);
    if (net.isHost) { const c = net.conns.get(id); if (c) { try { c.close(); } catch (e) { /* ignore */ } net.conns.delete(id); } net.send('leave', { id }); broadcastLobby(); sendScores(); }
  }
  hostQuiet = hostQuiet && !!remote.get(net.hostId) && performance.now() - (remote.get(net.hostId).lastSeen || 0) > 9000;
  if (syncTick % 3 === 0 && inMatch()) net.send('ps', encodeLocal(player, player.weaponIndex, { firing: player.firing, idle: input.idleSeconds > IDLE_FLAG }), true);
  if (shotQueue.length) net.broadcast('shots', { k: player.weapon.kind, e: shotQueue.splice(0) });
  if (bulletQueue.length) net.broadcast('shots', { k: player.weapon.kind, mv: player.weapon.mv || 330, b: bulletQueue.splice(0) });
  if (coop()) { coopUpdate(dt); return; }
  if (net.isHost && inMatch() && remote.size > 0) game.clockStarted = true;
  const clockOn = inMatch() && !game.over && (net.isHost ? !!game.clockStarted : clockRunning);
  if (inMatch() && !game.over) { if (clockOn) matchLeft = Math.max(0, matchLeft - dt); if (net.isHost) { clockT -= dt; if (clockT <= 0) { clockT = 2; net.send('clock', { left: Math.round(matchLeft), on: clockOn }); } } hud.setTimer(clockOn ? mmss(matchLeft) : 'clock starts when someone joins'); }
  if (net.isHost && clockOn) { game.matchT += dt; if (matchLeft <= 0) { const rows = sortedScores(); const w = rows.length ? { id: rows[0][0], name: rows[0][1].name } : { id: net.id, name: myName }; net.send('end', w); endMatch(w); } }
}
// there is no clock and nobody to beat in squad survival: the run just has to keep flowing
function coopUpdate(dt) {
  coopHudTick(dt);
  if (!coopHost() || !inMatch() || game.over) return;
  game.matchT += dt;
  snapT -= dt;
  if (snapT <= 0 && enemies.alive) { snapT = 0.1; net.send('esnap', enemies.snapshot()); }
  coopSyncT -= dt;
  if (coopSyncT <= 0) { coopSyncT = 1; coopBroadcastWave({ left: enemies.alive + game.queue.length }); }
  coopScoreT -= dt;
  if (coopScoreT <= 0) { coopScoreT = 1.5; net.send('escore', { score: game.score, kills: game.kills }); sendScores(); }
  // everyone on the floor at once is where a run ends
  const bodies = [player, ...remote.values()];
  if (bodies.length && bodies.every((p) => !p.alive)) { const w = { id: null, name: null, coop: true, wave: game.wave, score: game.score }; net.send('end', w); endMatch(w); }
}
function leaveOnline(reason) {
  net.leave(); for (const id of [...remote.keys()]) removeRemote(id); lobby.players.clear(); colorSeats.clear(); scores.clear(); hud.setBoard(null);
  player.applyWeaponMode('normal'); if (touch) touch.setWeaponMode('normal');
  if (game.state !== 'start') { game.state = 'start'; game.mode = 'solo'; setArena(false); resetGame(); hud.setGameplayVisible(false); }
  game.menu = false; lobby.status = reason || ''; screen = 'online'; showStart();
}
async function createLobby(isPublic) {
  setStatus('opening a lobby…');
  try { await net.host({ isPublic }); }
  catch (err) { setStatus(friendlyError(err)); unlockButtons(); return; }
  lobby.isPublic = isPublic; lobby.map = mapKey; lobby.ballistics = settings.ballistics; lobby.diff = settings.difficulty; lobby.mob = lobby.mob || 'mid'; lobby.players.clear(); colorSeats.clear(); lobby.players.set(net.id, { name: myName, color: 0 }); player.color = 0; player.ink = playerInk(0); lobby.hostId = net.id; lobby.status = ''; lobby.weaponMode = 'normal'; applyRules();
  game.state = 'lobby'; screen = 'lobby'; showStart();
}
async function joinLobby(code) {
  setStatus('connecting…');
  try { await net.join(code, { name: myName }); } catch (err) { setStatus(friendlyError(err)); unlockButtons(); return; }
  lobby.isPublic = net.isPublic; lobby.status = ''; game.state = 'lobby'; screen = 'lobby'; showStart();
}
async function quickPlay() {
  try { await net.quickJoin({ name: myName }, setStatus); lobby.isPublic = true; lobby.status = ''; game.state = 'lobby'; screen = 'lobby'; showStart(); return; }
  catch (err) { if (!/no open public/.test(String(err.message))) { setStatus(friendlyError(err)); unlockButtons(); return; } }
  setStatus('no open lobbies · opening a public one for you…');
  await createLobby(true);
}
function friendlyError(err) {
  const m = String(err && err.message || err || ''); if (!m) return 'something went wrong';
  if (/not reachable|could not reach|did not answer|lost the connection|disconnected/.test(m)) {
    return `could not reach ${sameOrigin()} · the server that handed you this page is not answering right now`;
  }
  if (/no lobby with that code/.test(m)) return 'no lobby with that code · check it with your friend';
  if (/full/.test(m)) return 'that lobby is full · try another code';
  if (/leave the lobby/.test(m)) return 'leave your lobby first';
  return m;
}
function setStatus(msg) { lobby.status = msg; const el = hud.el.panel.querySelector('#status'); if (el) el.textContent = ts(msg); }

// ---------------- screens ----------------
// "CLICK ANYWHERE (or press Space)" is nonsense on a phone, so the prompt follows the device.
const goText = (verb) => (touchMode ? t`TAP TO ${verb}` : t`CLICK ANYWHERE (or press ${hud.key('confirm')}) TO ${verb}`);
// which screen is up, so the language toggle can redraw it in the new language
let redraw = null;
function redrawScreen() { if (redraw) redraw(); }
// Settings used to be a stack of four controls sitting under every menu. That was the right shape
// for four; it is the wrong shape for a real FPS config, and on a phone it was most of the reason
// the start screen needed scrolling. So the menus carry a door and the knobs live behind it.
function settingsHTML() {
  return `<div class="settings" id="settings"><button type="button" class="cfgopen" id="cfgBtn">SETTINGS<i>sensitivity · field of view · aim · language</i></button></div>`;
}
function wireSettings() {
  const box = hud.el.panel.querySelector('#settings'); if (!box) return;
  box.addEventListener('click', (e) => e.stopPropagation());
  box.querySelector('#cfgBtn').addEventListener('click', () => openConfig());
}

// ---------------- config ----------------
// Which screen the config was opened over. It doubles as the "config is up" flag: while it is set,
// a click on the backdrop or a tap of space backs out of here instead of starting a round.
let cfgBack = null;
function openConfig() { cfgBack = redraw || showStart; showConfig(); }
function closeConfig() { const back = cfgBack || showStart; cfgBack = null; back(); }
function showConfig() { redraw = showConfig; hud.showScreen(configHTML()); wireConfig(); }

// Range rows carry their own key, so the whole panel is one delegated `input` listener and adding a
// knob is one line here plus one line in settings.js.
function cfgRow(k, label, note) {
  const d = SETTINGS[k], v = settings[k];
  return `<label class="cfgrow"><span class="cfgname">${label}${note ? `<i>${note}</i>` : ''}</span>`
    + `<input type="range" data-k="${k}" min="${d.min}" max="${d.max}" step="${d.step}" value="${v}"><b data-v="${k}">${v}${d.unit}</b></label>`;
}
function cfgCheck(id, on, label, note) {
  return `<label class="cfgrow chk"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="cfgname">${label}${note ? `<i>${note}</i>` : ''}</span></label>`;
}
function configHTML() {
  return `<h1>CONFIG</h1><h2>every knob is live · move one and the game moves with it</h2>
  <div class="config" id="config">
    <div class="cfgcol"><div class="cfghead">LOOK</div>
      ${cfgRow('sens', 'look sensitivity', touchMode ? 'how far the view turns per inch of thumb' : 'how far the view turns per inch of mouse')}
      ${cfgRow('adsSens', 'aim sensitivity', 'share of the above while sighted down a gun')}
      ${cfgRow('scopeSens', 'scope sensitivity', 'share of the above through the sniper scope')}
      ${cfgRow('fov', 'field of view', 'wider sees more of the fight · narrower reads further down the street')}
      ${cfgCheck('setInv', settings.invert, 'invert vertical look')}
    </div>
    <div class="cfgcol"><div class="cfghead">FEEL</div>
      ${cfgRow('adsSpeed', 'move speed while aiming', '100% is full walking speed, the same as not aiming')}
      ${touchMode ? cfgRow('aimAssist', 'aim assist', 'how hard the view leans toward what it thinks you meant') : ''}
      ${cfgRow('shake', 'screen shake', 'how hard an explosion kicks the camera')}
      ${cfgRow('bob', 'view bob', 'how much the view rocks as you run')}
    </div>
    <div class="cfgcol"><div class="cfghead">GAME</div>
      ${cfgCheck('setMus', musicWanted, 'music', '(M)')}
      ${cfgCheck('setBal', settings.ballistics, 'bullet drop &amp; travel time', '(solo · in a lobby the host decides)')}
      <label class="cfgrow seg"><span class="cfgname">difficulty<i>${ts('how fast you heal and how long your legs last')} · ${ts('(solo · in a lobby the host decides)')}</i></span><span class="langsel" id="setDiff">${Object.entries(DIFFICULTY).map(([k, d]) => `<button type="button" class="langbtn${k === settings.difficulty ? ' on' : ''}" data-diff="${k}" title="${ts(d.blurb)}">${ts(d.name)}</button>`).join('')}</span></label>
      <div class="cfgnote" id="diffNote">${ts(diffOf(settings.difficulty).blurb)}</div>
      <label class="cfgrow lang"><span class="cfgname">language</span><span class="langsel" id="setLang">${Object.entries(LANGS).map(([k, n]) => `<button type="button" class="langbtn${k === getLang() ? ' on' : ''}" data-lang="${k}">${n}</button>`).join('')}</span></label>
    </div>
  </div>
  <div class="online cfgfoot"><div class="row"><button type="button" class="alt" id="cfgReset">RESET TO DEFAULTS</button><button type="button" id="cfgBack">BACK</button><span class="hint">language and music stay as you left them</span></div></div>`;
}
function wireConfig() {
  const p = hud.el.panel, box = p.querySelector('#config'); if (!box) return;
  // one guard for the whole panel: a click that reaches #screen resumes the game
  p.addEventListener('click', (e) => e.stopPropagation()); p.addEventListener('keydown', (e) => e.stopPropagation());
  box.addEventListener('input', (e) => {
    const r = e.target.closest('input[type=range]'); if (!r) return;
    const k = r.dataset.k; settings[k] = Number(r.value);
    box.querySelector(`b[data-v="${k}"]`).textContent = settings[k] + SETTINGS[k].unit;
    applySettings();
  });
  p.querySelector('#setInv').addEventListener('change', (e) => { settings.invert = e.target.checked; applySettings(); });
  p.querySelector('#setMus').addEventListener('change', (e) => { musicWanted = e.target.checked; localStorage.setItem('doodle_music', musicWanted ? '1' : '0'); audio.musicOn(musicWanted); });
  p.querySelector('#setBal').addEventListener('change', (e) => { settings.ballistics = e.target.checked; applySettings(); });
  p.querySelector('#setDiff').addEventListener('click', (e) => {
    const b = e.target.closest('.langbtn'); if (!b) return;
    settings.difficulty = b.dataset.diff; applySettings();
    for (const x of p.querySelectorAll('#setDiff .langbtn')) x.classList.toggle('on', x.dataset.diff === settings.difficulty);
    p.querySelector('#diffNote').textContent = ts(diffOf(settings.difficulty).blurb);
  });
  p.querySelector('#setLang').addEventListener('click', (e) => { const b = e.target.closest('.langbtn'); if (b) { setLang(b.dataset.lang); redrawScreen(); } });
  p.querySelector('#cfgReset').addEventListener('click', () => { for (const k in SETTINGS) settings[k] = SETTINGS[k].def; applySettings(); showConfig(); });
  p.querySelector('#cfgBack').addEventListener('click', () => closeConfig());
}
function wireName(box) {
  const nb = box.querySelector('#setName'); if (!nb) return;
  nb.addEventListener('input', (e) => { myName = e.target.value.trim().slice(0, 14) || myName; localStorage.setItem('doodle_name', myName); player.name = myName; net.hostName = myName; });
}
function checkpointHTML() {
  if (checkpoint < 5) return '';
  let h = '<div class="checkpoints"><span>checkpoints</span>';
  for (let w = 5; w <= checkpoint; w += 5) h += `<button type="button" data-cp="${w}">${t`WAVE ${w}`}</button>`;
  return h + '</div>';
}
function wireCheckpoints(onGo) { const box = hud.el.panel.querySelector('.checkpoints'); if (!box) return; box.addEventListener('click', (e) => { e.stopPropagation(); const b = e.target.closest('button'); if (b) onGo(Number(b.dataset.cp)); }); }
const mapName = (k) => (LEVELS.find((m) => m.key === k) || LEVELS[0]).name;
function mapHTML(sel, canPick, ffa = false) { const list = arenaMaps(ffa); if (list.length < 2) return ''; return `<div class="mapsel" id="mapsel"><span>map</span>${list.map((m) => `<button type="button" class="mapbtn${m.key === sel ? ' on' : ''}" data-map="${m.key}" ${canPick ? '' : 'disabled'}>${m.name}<i>${m.blurb}</i></button>`).join('')}</div>`; }
function wireMap(onPick) { const box = hud.el.panel.querySelector('#mapsel'); if (!box) return; box.addEventListener('click', (e) => { e.stopPropagation(); const b = e.target.closest('.mapbtn'); if (b && !b.disabled) onPick(b.dataset.map); }); }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function mainHTML() {
  return `<h1>DOODLE DISTRICT</h1><h2>a scribbled survival shooter</h2>
    <div class="mainbtns"><button type="button" class="start" id="soloBtn">START<i>solo · survive the waves</i></button><button type="button" id="onlineBtn">PLAY ONLINE<i>free for all or squad survival · up to 10 players</i></button></div>
    ${mapHTML(mapKey, true)}${touchMode ? TOUCH_CONTROLS_HTML : CONTROLS_HTML}${settingsHTML()}${checkpointHTML()}${best ? `<div class="beststat">${t`best score: ${best}`}</div>` : ''}`;
}
const sameOrigin = () => (typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? location.host : 'localhost:8080');
function onlineHTML() {
  return `<h1>PLAY ONLINE</h1><h2>free for all or squad survival · up to 10 players on your network</h2>
    <div class="online" id="online">
      <div class="row"><span>your name</span><input type="text" class="namebox" id="setName" maxlength="14" value="${esc(myName)}"></div>
      <div class="row"><button type="button" class="big" id="quickBtn">QUICK PLAY</button><span class="hint">jumps into an open public lobby, or opens one for you</span></div>
      <div class="row split"><span>or</span></div>
      <div class="row"><button type="button" id="createBtn">CREATE LOBBY</button><div class="radio"><label><input type="radio" name="vis" value="public" ${lobby.isPublic ? 'checked' : ''}> public</label><label><input type="radio" name="vis" value="private" ${lobby.isPublic ? '' : 'checked'}> private · friends only</label></div></div>
      <div class="row"><span>have a code?</span><input type="text" id="codeBox" placeholder="CODE" maxlength="5" autocomplete="off"><button type="button" id="joinBtn">JOIN</button></div>
      <div class="lobbylist" id="lobbylist"><div class="row"><span>public lobbies</span><button type="button" class="alt" id="refreshBtn">REFRESH</button></div><div class="rows" id="lobbyRows">${lobbyListHTML()}</div></div>
      <div class="status" id="status">${esc(lobby.status || '')}</div>
      ${lobby.rejoinCode ? `<div class="row"><button type="button" class="big" id="rejoinBtn">${t`REJOIN ${esc(lobby.rejoinCode)}`}</button></div>` : ''}
      <div class="row"><button type="button" class="alt" id="backBtn">BACK</button></div>
    </div>`;
}
function modeHTML(sel, canPick) {
  const modes = [
    { key: 'ffa', name: 'FREE FOR ALL', blurb: t`everyone against everyone · first to ${FFA_TARGET}` },
    { key: 'coop', name: 'SQUAD SURVIVAL', blurb: 'all of you against the waves · bigger the squad, bigger the waves' },
  ];
  return `<div class="modesel" id="modesel"><span>mode</span>${modes.map((m) => `<button type="button" class="modebtn${m.key === sel ? ' on' : ''}" data-mode="${m.key}" ${canPick ? '' : 'disabled'}>${m.name}<i>${m.blurb}</i></button>`).join('')}</div>`;
}
function diffHTML(sel, canPick) {
  return `<div class="modesel" id="diffsel"><span>difficulty</span>${Object.entries(DIFFICULTY).map(([k, d]) => `<button type="button" class="modebtn${k === sel ? ' on' : ''}" data-diff="${k}" ${canPick ? '' : 'disabled'}>${ts(d.name)}<i>${ts(d.blurb)}</i></button>`).join('')}</div>`;
}
// Versus only. In squad survival you are fighting the waves and you need every bit of the kit, so
// this row is simply not there.
function mobHTML(sel, canPick) {
  return `<div class="modesel" id="mobsel"><span>${ts('movement')}</span>${Object.entries(MOBILITY).map(([k, m]) => `<button type="button" class="modebtn${k === sel ? ' on' : ''}" data-mob="${k}" ${canPick ? '' : 'disabled'}>${ts(m.name)}<i>${ts(m.blurb)}</i></button>`).join('')}</div>`;
}
function ballHTML(sel, canPick) {
  const opts = [
    { on: false, name: 'INSTANT', blurb: 'a shot lands where you aimed, the moment you fire' },
    { on: true, name: 'BALLISTIC', blurb: 'rounds fly and fall · lead them, hold over them' },
  ];
  return `<div class="modesel" id="ballsel"><span>shots</span>${opts.map((o) => `<button type="button" class="modebtn${o.on === !!sel ? ' on' : ''}" data-bal="${o.on ? '1' : '0'}" ${canPick ? '' : 'disabled'}>${o.name}<i>${o.blurb}</i></button>`).join('')}</div>`;
}
function weaponModeHTML(selected, canPick) {
  return `<div class="modesel weapon-modes" id="weaponsel"><span>${ts('weapon mode')}</span>${Object.entries(WEAPON_MODES).map(([key, rule]) => `<button type="button" class="modebtn${key === selected ? ' on' : ''}" data-weapons="${key}" aria-pressed="${key === selected}" ${canPick ? '' : 'disabled'}>${ts(rule.name)}<i>${ts(rule.blurb)}</i></button>`).join('')}</div>`;
}
function lobbyHTML() {
  const rows = lobbyRows(); const host = net.isHost; const n = rows.length; const isCoop = lobby.gameMode === 'coop';
  const blurb = isCoop ? ts('squad survival · you against the page') : t`free for all · first to ${FFA_TARGET}`;
  return `<h1>LOBBY</h1><h2>${t`${blurb} · ${n}/${net.maxPlayers} players`}</h2>
    <div class="online" id="online">
      <div class="row"><span>code</span><span class="code">${String(net.isHost ? (net.aliasCode || net.code) : (lobby.shown || net.code) || '').replace(/-\d+$/, '')}</span></div>
      ${modeHTML(lobby.gameMode, host)}
      ${weaponModeHTML(ctx.weaponMode(), host)}
      ${mapHTML(playable(lobby.map || mapKey, !isCoop), host, !isCoop)}
      ${ballHTML(lobby.ballistics, host)}
      ${diffHTML(ctx.difficulty(), host)}
      ${isCoop ? '' : mobHTML(lobby.mob || 'mid', host)}
      <div class="hint">${lobby.isPublic ? 'this lobby is public: anyone can quick play in, or type the code' : 'private lobby: friends type this code under PLAY ONLINE → JOIN'}</div>
      <div class="plist">${rows.map((p) => `<div class="${p.id === lobby.hostId ? 'host' : ''}${p.id === net.id ? ' me' : ''}">${playerNameHTML(p.id, p.name)}<span>${p.id === net.id ? 'you' : ''}</span></div>`).join('')}</div>
      <div class="row"><button type="button" class="big" id="startBtn">START MATCH</button><button type="button" class="alt" id="leaveBtn">LEAVE</button></div>
      <div class="status" id="status">${esc(lobby.status || '')}</div><div class="hint">${(() => { const tail = n < 2 ? ts('people can still join once it is running') : t`${n} players in`; return host ? t`anyone can start · ${tail}` : t`anyone can start · only the host picks the mode and map · ${tail}`; })()}</div>
    </div>`;
}
let lobbyList = null, listBusy = false;
function lobbyListHTML() {
  if (listBusy) return '<div class="hint">looking…</div>';
  if (!lobbyList) return '<div class="hint">press refresh to look for open lobbies</div>';
  if (!lobbyList.length) return '<div class="hint">hit QUICK PLAY to join a lobby</div>';
  return lobbyList.map((l) => `<div class="lobbyrow"><span class="code">${esc(l.code)}</span><span>${t`${esc(l.hostName || ts('someone'))}'s lobby`}</span><span>${l.inMatch ? t`${l.players}/${l.max} · in a match` : `${l.players}/${l.max}`}</span>${l.full ? '<span class="status">full</span>' : `<button type="button" data-join="${esc(l.code)}">JOIN</button>`}</div>`).join('');
}
async function refreshLobbies() {
  if (listBusy || net.active) return; listBusy = true; const box = hud.el.panel.querySelector('#lobbyRows'); if (box) { box.innerHTML = lobbyListHTML(); trDom(box); }
  let err = null; try { lobbyList = await net.listLobbies({ name: myName }); } catch (e) { lobbyList = []; err = e; }
  listBusy = false; const rows = hud.el.panel.querySelector('#lobbyRows'); if (rows) rows.innerHTML = err ? `<div class="hint">${t`could not look: ${esc(friendlyError(err))}`}</div>` : lobbyListHTML(); if (rows) trDom(rows);
}
function wireOnline() {
  const box = hud.el.panel.querySelector('#online'); if (!box) return;
  box.addEventListener('click', (e) => e.stopPropagation()); box.addEventListener('keydown', (e) => e.stopPropagation());
  const q = (id) => box.querySelector('#' + id); wireName(box);
  if (q('quickBtn')) q('quickBtn').addEventListener('click', () => { lockButtons(box); quickPlay(); });
  if (q('createBtn')) q('createBtn').addEventListener('click', () => { lockButtons(box); createLobby(box.querySelector('input[name=vis]:checked').value === 'public'); });
  if (q('joinBtn')) { q('joinBtn').addEventListener('click', () => { const c = q('codeBox').value.trim().toUpperCase(); if (!c) { setStatus('type the code your friend gave you'); return; } lockButtons(box); joinLobby(c); }); q('codeBox').addEventListener('keydown', (e) => { if (e.key === 'Enter') q('joinBtn').click(); }); }
  if (q('modesel')) q('modesel').addEventListener('click', (e) => { const b = e.target.closest('.modebtn'); if (!b || b.disabled || !net.isHost) return; lobby.gameMode = b.dataset.mode === 'coop' ? 'coop' : 'ffa'; lobby.map = playable(lobby.map || mapKey, lobby.gameMode !== 'coop'); broadcastLobby(); });
  if (q('weaponsel')) q('weaponsel').addEventListener('click', (e) => { const b = e.target.closest('.modebtn'); if (!b || b.disabled || !net.isHost || game.state !== 'lobby') return; lobby.weaponMode = weaponModeOf(b.dataset.weapons).key; applyRules(); broadcastLobby(); });
  if (q('ballsel')) q('ballsel').addEventListener('click', (e) => { const b = e.target.closest('.modebtn'); if (!b || b.disabled || !net.isHost) return; lobby.ballistics = b.dataset.bal === '1'; broadcastLobby(); });
  if (q('diffsel')) q('diffsel').addEventListener('click', (e) => { const b = e.target.closest('.modebtn'); if (!b || b.disabled || !net.isHost) return; lobby.diff = b.dataset.diff; applyRules(); broadcastLobby(); });
  if (q('mobsel')) q('mobsel').addEventListener('click', (e) => { const b = e.target.closest('.modebtn'); if (!b || b.disabled || !net.isHost) return; lobby.mob = b.dataset.mob; applyRules(); broadcastLobby(); });
  if (q('rejoinBtn')) q('rejoinBtn').addEventListener('click', () => { const c = lobby.rejoinCode; lobby.rejoinCode = null; lockButtons(box); joinLobby(c); });
  if (q('backBtn')) q('backBtn').addEventListener('click', () => { lobby.status = ''; lobby.rejoinCode = null; screen = 'main'; showStart(); });
  if (q('refreshBtn')) { q('refreshBtn').addEventListener('click', () => refreshLobbies()); if (!lobbyList && !listBusy) refreshLobbies(); }
  if (q('lobbyRows')) q('lobbyRows').addEventListener('click', (e) => { const b = e.target.closest('button[data-join]'); if (b) { lockButtons(box); joinLobby(b.dataset.join); } });
  wireMap((k) => { if (net.isHost) { lobby.map = k; broadcastLobby(); } });
  if (q('startBtn')) q('startBtn').addEventListener('click', () => { if (net.isHost) hostStart(); else { net.send('startreq', {}); setStatus('asking the host to start…'); } });
  if (q('leaveBtn')) q('leaveBtn').addEventListener('click', () => { lobby.rejoinCode = null; leaveOnline(''); });
}
function lockButtons(box) { for (const b of box.querySelectorAll('button')) if (b.id !== 'backBtn') b.disabled = true; }
function unlockButtons() { const box = hud.el.panel.querySelector('#online'); if (box) for (const b of box.querySelectorAll('button')) b.disabled = false; }
function renderLobby() { if (game.state === 'lobby') showStart(); }
function showStart() {
  redraw = showStart; cfgBack = null; hud.setGameplayVisible(false);
  if (game.state === 'lobby') screen = 'lobby';
  const html = screen === 'lobby' ? lobbyHTML() : screen === 'online' ? onlineHTML() : mainHTML();
  hud.showScreen(html);
  const p = hud.el.panel;
  if (screen === 'main') {
    wireSettings(); wireCheckpoints((w) => beginAtWave(w)); wireMap((k) => { mapKey = k; localStorage.setItem('doodle_map', k); showStart(); });
    p.querySelector('#soloBtn').addEventListener('click', (e) => { e.stopPropagation(); begin(); });
    p.querySelector('#onlineBtn').addEventListener('click', (e) => { e.stopPropagation(); screen = 'online'; showStart(); });
  } else wireOnline();
}
function showPause() {
  redraw = showPause; cfgBack = null;
  if (online()) {
    hud.showScreen(`<h1>MENU</h1><h2>${t`free for all · lobby ${String(net.aliasCode || net.code || '').replace(/-\d+$/, '')}`}</h2><div class="scoreboard">${sortedScores().map(([id, s]) => `<div class="${id === net.id ? 'me' : ''}">${playerNameHTML(id, s.name)}<span>${t`${s.kills} K · ${s.deaths} D`}</span></div>`).join('')}</div>${CONTROLS_HTML}${settingsHTML()}<div class="online" id="online"><div class="row"><button type="button" class="alt" id="leaveBtn">LEAVE MATCH</button></div></div><div class="go">${goText(ts('KEEP PLAYING'))}</div>`);
    wireSettings(); wireOnline(); return;
  }
  hud.showScreen(`<h1>PAUSED</h1><h2>${t`wave ${game.wave} · score ${game.score}`}</h2>${CONTROLS_HTML}${settingsHTML()}${menuBtnHTML()}<div class="go">${goText(ts('RESUME'))}</div>`);
  wireSettings(); wireMenuBtn();
}
function showClickToPlay() { redraw = showClickToPlay; cfgBack = null; hud.showScreen(`<h1>MATCH ON</h1><h2>${t`free for all · first to ${FFA_TARGET}`}</h2><div class="go">${goText(ts('PLAY'))}</div>`); }
function showDead() {
  redraw = showDead; cfgBack = null; hud.setGameplayVisible(false); const nb = game.score > best; if (nb) { best = game.score; localStorage.setItem('doodle_best', String(best)); }
  const endTail = nb ? ts(' · <b>NEW BEST</b>') : t` · best ${best}`;
  hud.showScreen(`<h1>ERASED</h1><div class="stats">${t`you survived <b>${game.wave}</b> wave${game.wave === 1 ? '' : 's'} · <b>${game.kills}</b> kills · score <b>${game.score}</b>`}${endTail}</div>${checkpointHTML()}${menuBtnHTML()}<div class="go">${goText(ts('DRAW AGAIN'))}</div>`);
  wireCheckpoints((w) => beginAtWave(w)); wireMenuBtn();
}
function menuBtnHTML() { return '<div class="online menubtn"><div class="row"><button type="button" class="alt" id="menuBtn">MAIN MENU</button></div></div>'; }
function wireMenuBtn() { const b = hud.el.panel.querySelector('#menuBtn'); if (b) b.addEventListener('click', (e) => { e.stopPropagation(); toMainMenu(); }); }
function toMainMenu() { game.state = 'start'; game.mode = 'solo'; game.menu = false; setArena(false); resetGame(); audio.reelLoop(false); input.exitLock(); hud.setGameplayVisible(false); screen = 'main'; showStart(); }
function toLobbyScreen() { net.inMatch = false; for (const r of remote.values()) r.lastSeen = performance.now(); setArena(true); resetGame(); game.state = 'lobby'; game.over = null; game.menu = false; hud.setGameplayVisible(false); hud.setBoard(null); screen = 'lobby'; showStart(); }

// ---------------- run control ----------------
function resetGame() {
  if (level.breakables.some((b) => !b.alive)) setLevel(loadedKey, arenaLoaded, true);
  enemies.clear(); effects.clear(); bullets.clear(); for (const p of pickups) R.scene.remove(p.mesh); pickups.length = 0; ammoClock = 0; healthClock = 20;
  // whoever hosts next owns its own enemies again; startMatch turns mirroring back on if it has to
  enemies.mirror = false; enemies.nextId = 1; snapT = 0; coopScoreT = 0; coopSyncT = 0; coopLeft = 0;
  player.maxHp = online() ? 110 : 120;
  // The difficulty owns the two regen numbers now, so it has to be applied after the reset rather
  // than before it. Online keeps its old edge over solo as a ratio on top of whatever tier is set --
  // at EASY that lands back on exactly the 4s/14hp it has always used, and EXTREME still never heals.
  applyRules();
  if (online() && player.regenRate > 0) { player.regenDelay *= 4 / 4.5; player.regenRate *= 14 / 11; }
  player.reset(level.playerStart); player.name = myName; player.lastHitBy = null; player.lastHit = null; enemies.mods.speed = 1; enemies.mods.damage = 1; hud.setModifier(''); hud.setBoss(null, null); game.boss = null; endFocus(); game.katanaStreak = 0; game.rocketDropped = false;
  game.score = 0; game.kills = 0; game.combo = 0; game.wave = 0; game.intermission = 0; game.queue = []; game.time = 0; game.over = null; game.matchT = 0; hud.setScore(0, 0); hud.setTimer(''); hud.setPvpScore(null); hud.setWave(1, 0); hud.setBoard(null);
}
function beginCommon() { audio.init(); audio.resume(); if (!input.usingGamepad && !touchMode) input.requestLock(); if (musicWanted && !audio.musicPlaying) audio.musicOn(true); hud.hideScreen(); hud.setGameplayVisible(true); game.menu = false; }
function begin() { game.mode = 'solo'; setArena(false); beginCommon(); if (game.state === 'start' || game.state === 'dead') { resetGame(); startWave(1); } game.state = 'play'; }
function beginAtWave(n) { game.mode = 'solo'; setArena(false); beginCommon(); resetGame(); startWave(n); game.state = 'play'; }
function jumpToWave(n) { enemies.clear(); effects.clear(); bullets.clear(); enemies.mods.speed = 1; enemies.mods.damage = 1; endFocus(); game.intermission = 0; game.queue = []; startWave(n); hud.hideScreen(); hud.setGameplayVisible(true); game.state = 'play'; game.menu = false; audio.reelLoop(false); }
function hostStart() {
  scores.clear(); for (const [id, p] of lobby.players) scores.set(id, { name: p.name, kills: 0, deaths: 0 });
  const mode = lobby.gameMode === 'coop' ? 'coop' : 'ffa';
  // deal everyone a different spot, shuffled so the same people do not always start together
  setArena(mode === 'ffa'); const order = spawnSpots().map((_, i) => i); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const spawns = {}; [...lobby.players.keys()].forEach((id, i) => { spawns[id] = order[i % order.length]; });
  net.send('start', { spawns, players: lobbyRows(), colors: reservedColors(), map: lobby.map || mapKey, mode, bal: !!lobby.ballistics, diff: ctx.difficulty(), mob: lobby.mob, weaponMode: ctx.weaponMode() }); startMatch(false, spawns[net.id], mode); sendScores();
  if (mode === 'coop') startWave(1);
}
function startMatch(late, spawnIdx, mode = 'ffa') {
  const isCoop = mode === 'coop';
  net.inMatch = true; game.mode = isCoop ? 'coop' : 'ffa'; setArena(!isCoop); resetGame(); matchLeft = FFA_TIME; clockT = 0; game.clockStarted = false;
  // the host owns the waves; everyone else renders the enemies it sends
  enemies.mirror = isCoop && !net.isHost; enemies.nextId = 1;
  // nobody sends snapshots in the lobby, so the silence clock restarts here or the sweep would drop everyone
  for (const r of remote.values()) r.lastSeen = performance.now();
  if (!scores.size) for (const [id, p] of lobby.players) scores.set(id, { name: p.name, kills: 0, deaths: 0 });
  const spots = spawnSpots(); player.reset(spawnIdx != null && spots[spawnIdx] ? spots[spawnIdx].clone() : arenaSpawn()); beginCommon(); game.state = 'play'; screen = 'lobby'; player.shieldT = 2;
  refreshScoreHud();
  if (isCoop) hud.message('SQUAD SURVIVAL', late ? 'you joined a run in progress' : teamSize() + ' of you against the page · they come harder in a crowd', 3);
  else hud.message('FREE FOR ALL', late ? 'you joined a match in progress' : 'first to ' + FFA_TARGET + ' · ' + Math.round(FFA_TIME / 60) + ' minutes · everyone is fair game', 3);
  const rule = weaponModeOf(ctx.weaponMode());
  hud.tip(rule.key === 'normal' ? `hold <b>${hud.key('score')}</b> for the scoreboard` : `${ts(rule.name)} · ${ts(rule.blurb)}`, 5);
  // Say out loud what the legs can do this match. A dash that silently does nothing reads as a bug.
  if (!isCoop) setTimeout(() => { if (game.state === 'play') hud.tip(ts('movement') + ': <b>' + ts(mobOf(ctx.mobility()).name) + '</b> · ' + ts(mobOf(ctx.mobility()).blurb), 4); }, 5200);
  // a match started by someone else's click cannot grab the mouse: ask for a click
  setTimeout(() => { if (game.state === 'play' && !input.pointerLocked && !input.usingGamepad) { game.menu = true; showClickToPlay(); } }, 250);
}
function pause() { if ((game.state !== 'play' && !(game.state === 'dying' && online())) || game.menu) return; if (!online()) game.state = 'pause'; game.menu = true; showPause(); audio.reelLoop(false); }
function resume() { if (online()) { game.menu = false; if (game.state === 'dying' && game.respawnT <= 0) game.respawnArm = input.lastActive; hud.hideScreen(); hud.setGameplayVisible(true); if (!input.usingGamepad && !touchMode) input.requestLock(); return; } begin(); }
Object.assign(window.__game, { startWave, updateWaves, begin, beginAtWave, jumpToWave, resetGame, spawnPickup, updatePickups, updateArenaPickups, supplySpot, pickups, applyRules, focusCandidate, enterFocus, pickSpawn, startMatch, createLobby, joinLobby, quickPlay, leaveOnline, hostStart });
hud.onScreenClick = () => {
  // the config sits on top of whatever screen opened it, so anything that would have dismissed that
  // screen dismisses the config first - backdrop, space bar, escape
  if (cfgBack) { closeConfig(); return; }
  const st = game.state;
  if (st === 'over') { if (net.isHost) { net.send('backtolobby', {}); toLobbyScreen(); } return; }
  if (st === 'lobby') return;
  if (st === 'start') { if (screen === 'main') begin(); return; }
  if ((st === 'play' || st === 'dying') && game.menu) { resume(); return; }
  if (st === 'pause' || st === 'dead') resume();
};
canvas.addEventListener('click', () => { if (game.state === 'play' && !game.menu && !input.pointerLocked && !input.usingGamepad && !touchMode) input.requestLock(); });
input.onLockChange = (locked) => { if (!locked && !touchMode && (game.state === 'play' || (game.state === 'dying' && online())) && !game.menu && !input.usingGamepad) pause(); };
input.onDeviceChange = (pad) => { hud.setDevice(pad); hud.setWeapon(player.weapon.name, player.weapon.hint); };
window.addEventListener('pagehide', () => { if (net.active) net.leave(); });
// browsers only let audio start on a gesture; any press wakes the context if it went to sleep
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => { audio.init(); audio.resume(); }, { passive: true });
hud.setDevice(input.usingGamepad); applySettings(); hud.setWeapon(player.weapon.name, player.weapon.hint); showStart();

// ---------------- loop ----------------
let last = performance.now(), boardToggle = false, lockTipT = 0.5, musicHealT = 2;
function tick(now) { requestAnimationFrame(tick); step(now); }
// browsers starve animation frames in hidden tabs; a host that alt-tabs would freeze everyone's
// match, so a coarse timer runs extra steps (never extra frame chains) while that happens
setInterval(() => { if (net.active && performance.now() - last > 300) step(performance.now()); }, 250);
function step(now) {
  // never more than 50 ms a step: a bigger jump (a tab coming back) makes the springs in the view model fly apart
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  // the thumbs are folded in first so Input.update sees them alongside the keyboard and the pad
  if (touch) { touch.setActive((game.state === 'play' || game.state === 'dying') && !game.menu); touch.update(); }
  input.update(dt);
  const st = game.state; const playing = st === 'play' || st === 'dying';
  // the config screen eats every key that would otherwise dismiss the screen underneath it
  if (cfgBack) { if (input.pressed('jump') || input.pressed('confirm') || input.pressed('pause')) closeConfig(); }
  else if (st === 'start' || st === 'pause' || st === 'dead' || st === 'over') { if (input.pressed('jump') || input.pressed('confirm') || (st === 'pause' && input.pressed('pause'))) hud.onScreenClick(); }
  else if ((st === 'play' || (st === 'dying' && online())) && input.pressed('pause')) { if (game.menu) resume(); else { pause(); input.exitLock(); } }
  else if ((st === 'play' || st === 'dying') && game.menu && (input.pressed('jump') || input.pressed('confirm'))) resume();
  if (input.pressed('music')) { musicWanted = !musicWanted; localStorage.setItem('doodle_music', musicWanted ? '1' : '0'); audio.musicOn(musicWanted); hud.tip(musicWanted ? 'music on' : 'music off', 1.5); const mc = hud.el.panel.querySelector('#setMus'); if (mc) mc.checked = musicWanted; }
  if (online() && playing) {
    if (input.usingGamepad && input.pressed('score')) boardToggle = !boardToggle;
    const want = ((input.down('score') && !input.usingGamepad) || boardToggle) && !game.menu;
    // the board is not a snapshot while it is held open: the ping column is live, and a column
    // that froze on whatever it read the instant you pressed Tab would be worse than none
    if (want !== !hud.el.board.hidden) { hud.setBoard(want ? boardHTML() : null); boardT = 0; }
    else if (want) { boardT += dt; if (boardT > 0.5) { boardT = 0; hud.setBoard(boardHTML()); } }
  } else boardToggle = false;
  if (st === 'play' && !game.menu && !input.pointerLocked && !input.usingGamepad && !touchMode) { lockTipT -= dt; if (lockTipT <= 0) { lockTipT = 2.5; hud.tip('click the page to grab the mouse', 2); } }
  let scale = 1;
  if (game.hitstopT > 0) { game.hitstopT -= dt; scale = game.hitstopScale; }
  else if (game.focus.active) scale = FOCUS_SCALE;
  const sdt = dt * scale;
  if (st === 'play' && !online()) updateFocus(dt); else endFocus();
  if (playing) {
    game.time += sdt; if (player.shieldT > 0) player.shieldT -= dt;
    musicHealT -= dt; if (musicHealT <= 0) { musicHealT = 2; if (musicWanted && st === 'play' && !audio.musicPlaying && audio.ctx) audio.musicOn(true); if (input.anyInput) audio.resume(); }
    { const B = level.bounds, bp = player.body.pos; if (bp.x < B.minX - 8 || bp.x > B.maxX + 8 || bp.z < B.minZ - 8 || bp.z > B.maxZ + 8 || bp.y > 150) bp.y = -100; }
    player.update(sdt); bullets.update(sdt); enemies.update(sdt); effects.update(sdt); updatePickups(sdt); netUpdate(dt);
    // the co-op host runs the waves for the whole lobby; clients get told what came out of them
    if (st === 'play' && (!online() || coopHost())) updateWaves(sdt);
    if (online()) updateArenaPickups(dt);
    if (game.comboT > 0) { game.comboT -= sdt; if (game.comboT <= 0) { game.combo = 0; hud.setScore(game.score, 0); } }
    if (st === 'dying') {
      game.deathT += dt;
      if (online()) {
        const before = Math.ceil(game.respawnT); game.respawnT -= dt; const left = Math.ceil(game.respawnT);
        if (left > 0) { if (left !== before || game.deathT <= dt) hud.message(String(left), 'back on the page in', 1.1); }
        else if (before > 0) { game.respawnArm = input.lastActive; game.promptT = 0; }
        else if (!game.menu) {
          // waiting on a press: any key, button or click brings you back; pause opens the menu instead
          game.promptT -= dt; if (game.promptT <= 0) { game.promptT = 1.4; hud.message('READY', `press ${hud.key('confirm')} · any button or click to respawn`, 1.5); }
          if (input.lastActive !== game.respawnArm && !input.pressed('pause') && !input.down('pause')) respawnLocal();
        }
      }
      else if (game.deathT > 1.7) { game.state = 'dead'; showDead(); input.exitLock(); }
    }
  } else {
    game.time += dt; if (st === 'start' || st === 'dead' || st === 'lobby' || st === 'over') player.idleCam(game.time); effects.update(dt); if (net.active) netUpdate(dt);
    if (st === 'over') { game.overT += dt; if (net.isHost && game.overT > 8) { net.send('backtolobby', {}); toLobbyScreen(); } else if (!net.isHost && game.overT > 15) { toLobbyScreen(); } }
  }
  for (const a of level.animated) a.update(game.time);
  audio.setListener(player.eye, player.right);
  const w = player.weapon; if (w.isGun) hud.setAmmo(w.mag, w.reserve, w.magSize, w.reloading); else hud.setKatana();
  if (touch && !w.isGun) touch.clearAim();   // the katana has nothing to scope, so drop the toggle
  // the ring by the crosshair, reading whichever wait the gun is currently in
  if (w.isGun && w.reloading) hud.setCycle(w.reloadT / w.reloadDur, 'reload');
  else if (w.isGun && w.pumpT > 0) hud.setCycle(1 - w.pumpT / w.pumpDur, 'cycle');
  else hud.setCycle(0, '');
  // A weapon you have not found yet has no slot. The rocket is last in the list, so dropping it
  // leaves every other slot on the number it has always been on.
  const slotState = player.weapons.map((wp, i) => ({ slot: i + 1, key: wp.kind === 'grenade' ? hud.key('grenade') : String(i + 1), name: wp.name, active: i === player.weaponIndex, ammo: wp.isGun ? wp.mag + '/' + wp.reserve : '∞', empty: wp.isGun && wp.mag === 0 && wp.reserve === 0, locked: wp.locked || !player.weaponAllowed(i) })).filter((s) => !s.locked);
  hud.setSlots(slotState); if (touch) touch.setSlots(slotState);
  hud.setWeaponMode(online() ? weaponModeOf(ctx.weaponMode()).name : null);
  hud.setGrenades(player.infiniteGrenades ? Infinity : player.grenadesAllowed ? player.grenades : 0); hud.setGrappleStamina(player.grapStam); hud.setHealth(player.hp, player.maxHp); hud.setSpread(w.spreadPx); hud.update(dt);
  if (online()) hud.setFocusMeter(playing, player.grapStam, false, 'GRAPPLE');
  else hud.setFocusMeter(playing && (w.kind === 'katana' || game.katanaStreak > 0 || game.focus.active), game.focus.active ? 1 : clamp(game.katanaStreak / KATANA_CHARGE_KILLS, 0, 1), game.focus.active, 'KATANA');
  if (game.boss) { if (game.boss.alive) hud.setBoss(game.boss.T.name, game.boss.hp / game.boss.maxHp); else { hud.setBoss(null, null); game.boss = null; } }
  audio.setIntensity(clamp((enemies.alive + game.queue.length + remote.size * 2) / 12, 0, 1) * (game.intermission > 0 ? 0.25 : 1));
  R.render(game.time, { hurt: player.hurtFx, flash: player.flashFx, slow: scale < 1 ? 1 : 0, lowHp: player.alive && player.hp < 30 ? 1 - player.hp / 30 : 0 });
  const showNames = online() && inMatch() && !game.menu && !hud.el.screen.classList.contains('show') && hud.el.board.hidden;
  for (const r of remote.values()) r.updateNameTag(showNames, now / 1000);
}
requestAnimationFrame(tick);
