// Unified keyboard/mouse + gamepad (PS5 DualSense / standard mapping) input.
import { clamp } from './util.js';

const KEYMAP = {
  KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right', ArrowUp: 'forward', ArrowDown: 'back', ArrowLeft: 'left', ArrowRight: 'right',
  Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint', ControlLeft: 'crouch', KeyC: 'crouch',
  KeyR: 'reload', KeyQ: 'grapple', KeyE: 'grapple', KeyF: 'melee', KeyV: 'melee', KeyB: 'interact', KeyN: 'bombDrop',
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Digit4: 'slot4', Digit5: 'slot5', Escape: 'pause', KeyP: 'pause', Enter: 'confirm', KeyG: 'grenade', KeyX: 'dash', AltLeft: 'dash', KeyM: 'music', KeyT: 'talk', Tab: 'score',
};
const MOUSEMAP = { 0: 'fire', 2: 'aim', 1: 'grapple', 3: 'grapple', 4: 'melee' };
// Standard gamepad mapping (DualSense): 0 cross,1 circle,2 square,3 triangle,4 L1,5 R1,6 L2,7 R2,8 create,9 options,10 L3,11 R3,12-15 dpad
const PADMAP = { 0: 'jump', 1: 'crouch', 2: 'reload', 3: 'nextWeapon', 4: 'grapple', 5: 'melee', 6: 'aim', 7: 'fire', 9: 'pause', 10: 'sprint', 11: 'grenade', 12: 'grenade', 13: 'slot5', 14: 'prevWeapon', 15: 'nextWeapon', 8: 'score', 17: 'confirm' };
const TIMED_ACTIONS = new Set(['fire', 'grenade', 'reload', 'aim', 'melee', 'nadeCancel', 'interact']);

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = {}; this.prev = {}; this.frameState = {};
    this.keys = {}; this.mouseBtns = {}; this.pressQueue = {}; this.framePresses = {};
    // written by TouchControls (src/touch.js) and read below like any other device
    this.touchKeys = {}; this.tmove = { x: 0, y: 0 }; this.usingTouch = false;
    this.move = { x: 0, y: 0 };
    this.look = { x: 0, y: 0 };
    this.mx = 0; this.my = 0; this.wheel = 0;
    this.mouseSens = 0.0022; this.padSensX = 3.4; this.padSensY = 2.6;
    this.usingGamepad = false; this.gamepadIndex = -1; this.padHoldTime = 0;
    this.pointerLocked = false; this.anyInput = false; this.lastPadButtons = [];
    this.onLockChange = null; this.onAnyInput = null; this.lastActive = performance.now();
    this.invertY = false; this.onDeviceChange = null; this.onControlCancel = null;
    this.holdTimes = {}; this.holdSources = {}; this.timedTouch = new Set();
    this.holdEvents = []; this.holdEventSeq = 0;
    const cancelControls = () => {
      this.keys = {}; this.mouseBtns = {}; this.pressQueue = {}; this.framePresses = {};
      if (this.onControlCancel) this.onControlCancel();
      for (const a of Object.keys(this.holdSources)) for (const source of [...this.holdSources[a]]) this.markHold(a, false, source);
    };

    window.addEventListener('keydown', (e) => {
      // Tab belongs to the held map only during play. Repeats must also suppress native focus
      // traversal; otherwise a long hold escapes the game after the first keydown.
      if (e.code === 'Tab') {
        if (!(this.captureScore?.() ?? this.pointerLocked) || e.altKey || e.ctrlKey || e.metaKey) return;
        e.preventDefault();
      } else if (e.code !== 'Escape' && !this.pointerLocked && e.target?.closest?.('input, textarea, select, button, summary, a[href], [contenteditable]:not([contenteditable="false"])')) return;
      if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.lastActive = performance.now(); const a = KEYMAP[e.code]; if (a) { this.keys[a] = true; if (this.usingGamepad && this.onDeviceChange) this.onDeviceChange(false); this.usingGamepad = false; }
      if (a) this.pressQueue[a] = true;
      if (a) this.markHold(a, true, 'key:' + e.code);
      if (!e.shiftKey) this.keys.sprint = false;
      this.anyInput = true;
    });
    window.addEventListener('keyup', (e) => { const a = KEYMAP[e.code]; if (a) { this.keys[a] = false; this.markHold(a, false, 'key:' + e.code); } if (!e.shiftKey) this.keys.sprint = false; });
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancelControls(); });
    window.addEventListener('blur', cancelControls);
    this.padState = {}; this.padPrev = {};
    document.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      let dx = e.movementX, dy = e.movementY;
      // guard against pointer-lock spikes
      if (Math.abs(dx) > 400) dx = 0; if (Math.abs(dy) > 400) dy = 0;
      if (this.usingGamepad && this.onDeviceChange) this.onDeviceChange(false);
      this.mx += dx; this.my += dy; this.usingGamepad = false; this.lastActive = performance.now();
    });
    document.addEventListener('mousedown', (e) => {
      // Touch-scrolling the map can emit compatibility mouse events; those are UI, not fire.
      if (e.target?.closest?.('.board')) return;
      const a = MOUSEMAP[e.button]; if (a) this.mouseBtns[a] = true;
      if (a && this.pointerLocked) this.pressQueue[a] = true;
      if (a) this.markHold(a, true, 'mouse:' + e.button);
      if (this.usingGamepad && this.onDeviceChange) this.onDeviceChange(false);
      this.usingGamepad = false; this.anyInput = true; this.lastActive = performance.now();
      if (e.button === 1 || e.button === 3 || e.button === 4) e.preventDefault();
    });
    document.addEventListener('mouseup', (e) => { const a = MOUSEMAP[e.button]; if (a) { this.mouseBtns[a] = false; this.markHold(a, false, 'mouse:' + e.button); } });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('wheel', (e) => {
      if (this.onWheel?.(e)) { e.preventDefault(); return; }
      this.wheel += Math.sign(e.deltaY);
    }, { passive: false });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) cancelControls();
      if (this.onLockChange) this.onLockChange(this.pointerLocked);
    });
    window.addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
  }

  // browsers refuse a new pointer lock for about a second after Esc released the last one, so a
  // failed request is retried until it takes or the game stops wanting it
  requestLock() {
    this.wantLock = true; if (this.pointerLocked) return;
    const attempt = (opts) => { try { const p = this.canvas.requestPointerLock(opts); return p && p.catch ? p : Promise.resolve(); } catch (err) { return Promise.reject(err); } };
    attempt({ unadjustedMovement: true }).catch(() => attempt()).catch(() => {
      clearTimeout(this._lockRetry); this._lockRetry = setTimeout(() => { if (this.wantLock && !this.pointerLocked) this.requestLock(); }, 1200);
    });
  }
  exitLock() { this.wantLock = false; clearTimeout(this._lockRetry); if (document.pointerLockElement) document.exitPointerLock(); }

  _getPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (this.gamepadIndex >= 0 && pads[this.gamepadIndex]) return pads[this.gamepadIndex];
    for (const p of pads) if (p && p.connected) { this.gamepadIndex = p.index; return p; }
    return null;
  }

  update(dt) {
    // rotate button states
    this.prev = this.state; this.state = {};
    // Keep fast taps alive for one frame so a complete press/release cannot disappear.
    this.framePresses = this.pressQueue; this.pressQueue = {};
    const s = this.state;
    for (const k in this.framePresses) s[k] = true;
    for (const k in this.keys) if (this.keys[k]) s[k] = true;
    for (const k in this.mouseBtns) if (this.mouseBtns[k]) s[k] = true;
    for (const k in this.touchKeys) if (this.touchKeys[k]) s[k] = true;
    if (this.wheel > 0) s.nextWeapon = true; else if (this.wheel < 0) s.prevWeapon = true; this.wheel = 0;

    // movement from keys
    let mx = (s.right ? 1 : 0) - (s.left ? 1 : 0);
    let my = (s.forward ? 1 : 0) - (s.back ? 1 : 0);
    // look from mouse
    let lx = -this.mx * this.mouseSens, ly = -this.my * this.mouseSens; this.mx = 0; this.my = 0;

    const pad = this._getPad(); const padS = {};
    if (pad) {
      const dz = (v) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);
      const ax = dz(pad.axes[0] || 0), ay = dz(pad.axes[1] || 0), rx = dz(pad.axes[2] || 0), ry = dz(pad.axes[3] || 0);
      let padActive = false;
      if (Math.abs(ax) > 0 || Math.abs(ay) > 0) { mx = ax; my = -ay; padActive = true; }
      if (Math.abs(rx) > 0 || Math.abs(ry) > 0) {
        padActive = true;
        const mag = Math.hypot(rx, ry);
        if (mag > 0.94) this.padHoldTime += dt; else this.padHoldTime = 0;
        const accel = 1 + clamp((this.padHoldTime - 0.25) / 0.6, 0, 1) * 0.9;
        const curve = (v) => Math.sign(v) * Math.pow(Math.abs(v), 1.8);
        lx += -curve(rx) * this.padSensX * accel * dt;
        ly += -curve(ry) * this.padSensY * accel * dt;
      } else this.padHoldTime = 0;
      for (const idx in PADMAP) {
        const b = pad.buttons[idx]; if (!b) continue;
        const pressed = b.pressed || b.value > 0.35;
        const action = idx === '13' && this.objectiveMode ? 'interact' : PADMAP[idx];
        if (pressed) { s[action] = true; padS[action] = true; padActive = true; }
      }
      if (padActive) { if (!this.usingGamepad && this.onDeviceChange) this.onDeviceChange(true); this.usingGamepad = true; this.anyInput = true; this.lastActive = performance.now(); }
      this._pad = pad;
    } else this._pad = null;
    this.padPrev = this.padState; this.padState = padS;
    for (const a of ['fire', 'grenade', 'reload', 'aim', 'melee', 'nadeCancel', 'pause', 'interact']) {
      this.markHold(a, !!padS[a], 'pad');
      if (!this.timedTouch.has(a)) this.markHold(a, !!this.touchKeys[a], 'touch');
    }

    // a thumb on the stick outranks both: on a phone there is nothing else driving these
    if (this.tmove.x || this.tmove.y) { mx = this.tmove.x; my = this.tmove.y; }

    const ml = Math.hypot(mx, my); if (ml > 1) { mx /= ml; my /= ml; }
    this.move.x = mx; this.move.y = my;
    this.look.x = lx; this.look.y = this.invertY ? -ly : ly;
  }

  // Input events preserve real press/release times even when rendering misses the whole hold.
  markHold(a, down, source = 'touch') {
    const sources = this.holdSources[a] ||= new Set(), wasHeld = sources.size > 0;
    if (down) sources.add(source); else sources.delete(source);
    const held = sources.size > 0; if (held === wasHeld) return;
    const now = performance.now();
    if (held) this.holdTimes[a] = { start: now, end: null, held: true };
    else if (this.holdTimes[a]) { this.holdTimes[a].end = now; this.holdTimes[a].held = false; }
    // A release and re-press between frames must interrupt both grenades and objective holds.
    if (TIMED_ACTIONS.has(a)) {
      this.holdEvents.push({ action: a, down: held, time: now, seq: ++this.holdEventSeq });
      if (this.holdEvents.length > 256) this.holdEvents.splice(0, this.holdEvents.length - 256);
    }
  }
  markTouchHold(a, down) { this.timedTouch.add(a); this.markHold(a, down, 'touch'); }
  holdTiming(a) { return this.holdTimes[a] || null; }
  holdEventsAfter(seq, until = performance.now()) { return this.holdEvents.filter((event) => event.seq > seq && event.time <= until); }
  down(a) { return !!this.state[a]; }
  get idleSeconds() { return (performance.now() - this.lastActive) / 1000; }
  pressed(a) { return !!this.framePresses[a] || (!!this.state[a] && !this.prev[a]) || (!!this.padState[a] && !this.padPrev[a]); }
  released(a) { return !this.state[a] && !!this.prev[a]; }
  consume(a) { this.state[a] = false; delete this.framePresses[a]; }
  anyPressed() { for (const k in this.state) if (this.state[k] && !this.prev[k]) return true; return false; }

  rumble(strong = 0.5, weak = 0.5, ms = 80) {
    const pad = this._pad; if (!pad) return;
    const act = pad.vibrationActuator || (pad.hapticActuators && pad.hapticActuators[0]);
    if (!act || !act.playEffect) return;
    try { act.playEffect('dual-rumble', { duration: ms, strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1) }); } catch (e) { /* ignore */ }
  }
}
