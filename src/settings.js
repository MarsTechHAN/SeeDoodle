// Every knob the config panel exposes, in one place.
//
// The `def` values are not neutral middles picked to look tidy - they are the numbers the game
// shipped with and the ones the feel was tuned against. That is deliberate: RESET TO DEFAULTS puts
// you back on the tuning, and a fresh install plays exactly like it did before the panel existed.
// So `adsSens` is 62 because the code used to say 0.62, `fov` is 82 because it used to say 82, and
// `adsSpeed` is 100 because aiming never actually slowed you down.
//
// player.js reads these live off `ctx.opt`, so a slider moves while you are standing in the level.
export const SETTINGS = {
  sens:       { def: 100, min: 25, max: 250, step: 5, unit: '%' },
  adsSens:    { def: 62, min: 20, max: 120, step: 1, unit: '%' },
  scopeSens:  { def: 38, min: 10, max: 120, step: 1, unit: '%' },
  adsSpeed:   { def: 100, min: 40, max: 100, step: 5, unit: '%' },
  fov:        { def: 82, min: 70, max: 110, step: 1, unit: '' },
  aimAssist:  { def: 100, min: 0, max: 150, step: 10, unit: '%' },
  shake:      { def: 100, min: 0, max: 150, step: 10, unit: '%' },
  bob:        { def: 100, min: 0, max: 150, step: 10, unit: '%' },
  invert:     { def: false },
  ballistics: { def: false },
  difficulty: { def: 'easy', choices: ['easy', 'medium', 'hard', 'extreme'] },
};

// The ladder. EASY is not a setting so much as a name for what the game already did - its two
// numbers are the ones player.js shipped with - so a player who never opens this menu notices
// nothing. Everything above it takes something away, monotonically: MEDIUM slows the healing and
// puts a limit on how long you can run, HARD slows it further AND makes you wait longer before it
// starts, EXTREME never heals you at all. `sprint: 0` means unlimited, and hides the meter.
export const DIFFICULTY = {
  easy:    { name: 'EASY',    blurb: 'heals fast · run forever',            regenDelay: 4.5,      regenRate: 11,  sprint: 0,   sprintRegen: 0,    sprintPause: 0 },
  medium:  { name: 'MEDIUM',  blurb: 'heals slowly · legs get tired',       regenDelay: 4.5,      regenRate: 6.5, sprint: 5.2, sprintRegen: 0.5,  sprintPause: 0.9 },
  hard:    { name: 'HARD',    blurb: 'heals late and slowly · short legs',  regenDelay: 7.5,      regenRate: 4,   sprint: 3.8, sprintRegen: 0.38, sprintPause: 1.1 },
  extreme: { name: 'EXTREME', blurb: 'no healing at all · find a medkit',   regenDelay: Infinity, regenRate: 0,   sprint: 3.2, sprintRegen: 0.34, sprintPause: 1.3 },
};
export const diffOf = (k) => DIFFICULTY[k] || DIFFICULTY.easy;

// Room weapon rules are independent of survival/deathmatch and never change the solo loadout.
export const WEAPON_MODES = {
  normal: { key: 'normal', name: 'NORMAL', blurb: 'all weapons and grenades', weapons: ['rifle', 'shotgun', 'sniper', 'katana', 'rocket', 'revolver'], grenades: true, infiniteGrenades: false },
  no_sniper: { key: 'no_sniper', name: 'NO SNIPERS', blurb: 'all weapons except the sniper rifle', weapons: ['rifle', 'shotgun', 'katana', 'rocket', 'revolver'], grenades: true, infiniteGrenades: false },
  grenades: { key: 'grenades', name: 'GRENADES ONLY', blurb: 'unlimited grenades - no guns or knives', weapons: ['grenade'], grenades: true, infiniteGrenades: true },
  knives: { key: 'knives', name: 'KNIVES ONLY', blurb: 'katana and unlimited grenades - no guns', weapons: ['katana'], grenades: true, infiniteGrenades: true },
};
export const weaponModeOf = (k) => Object.hasOwn(WEAPON_MODES, k) ? WEAPON_MODES[k] : WEAPON_MODES.normal;

// Versus only, and the host's call. A wave of enemies needs a player who can wall-jump out of a
// corner and dash across a street; another player does not, and a duel decided by who is airborne
// is not the game this map was drawn for. So a deathmatch runs on its own movement ladder, every
// rung of it slower than the campaign - EASY included, which is the "整体降低" part - and the
// rungs above it take the aerial toys away one at a time rather than nerfing numbers further.
// `speed` scales the walk/sprint ceiling, `air` the steering you have while off the ground.
export const MOBILITY = {
  easy: { name: 'EASY', blurb: 'everything, a little heavier', speed: 0.94, jump: 0.97, air: 0.92, dash: true, doubleJump: true, wallJump: true, grapple: true, slide: true, grapCd: 0.6 },
  mid:  { name: 'MID',  blurb: 'feet matter · no second jump', speed: 0.88, jump: 0.94, air: 0.78, dash: true, doubleJump: false, wallJump: true, grapple: true, slide: true, grapCd: 2.2 },
  hard: { name: 'HARD', blurb: 'boots on the ground · no grapple, no dash', speed: 0.82, jump: 0.9, air: 0.62, dash: false, doubleJump: false, wallJump: false, grapple: false, slide: true, grapCd: 0 },
};
// What solo and squad play run on: the movement the game was built with, nothing taken away.
export const MOB_FULL = { name: 'FULL', blurb: '', speed: 1, jump: 1, air: 1, dash: true, doubleJump: true, wallJump: true, grapple: true, slide: true, grapCd: 0 };
export const mobOf = (k) => MOBILITY[k] || MOB_FULL;

// what player.js falls back to if it is ever built without a config attached (benches, tools)
export const OPT_DEFAULTS = /* @__PURE__ */ (() => { const o = {}; for (const k in SETTINGS) o[k] = SETTINGS[k].def; return o; })();

// `sens`/`invert`/`ballistics` were already stored under these exact names, so an existing player
// keeps their sensitivity across this change.
const key = (k) => 'doodle_' + k.toLowerCase();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function loadSettings() {
  const s = {};
  for (const k in SETTINGS) {
    const d = SETTINGS[k], raw = localStorage.getItem(key(k));
    if (typeof d.def === 'boolean') { s[k] = raw === null ? d.def : raw === '1'; continue; }
    if (d.choices) { s[k] = d.choices.includes(raw) ? raw : d.def; continue; }
    const n = Number(raw);
    // a missing or junk entry is not worth arguing with; a stale one from an older range is clamped
    s[k] = raw === null || !Number.isFinite(n) ? d.def : clamp(n, d.min, d.max);
  }
  return s;
}

export function saveSettings(s) {
  for (const k in SETTINGS) localStorage.setItem(key(k), typeof SETTINGS[k].def === 'boolean' ? (s[k] ? '1' : '0') : String(s[k]));
}
