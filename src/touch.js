import { ts, onLangChange } from './i18n.js';

// Touch controls. A phone opens straight into these: the left thumb sits on a stick that appears
// wherever it lands, the right thumb drags the view, and everything else is a pen-drawn button.
// Nothing downstream knows they exist - it all ends up in the same Input.state the keyboard writes.

// A phone is a coarse pointer that cannot hover. A laptop with a touchscreen reports coarse *and*
// hover, so it keeps the mouse. ?touch=1 / ?touch=0 force the decision either way for testing.
export function isTouchDevice() {
  const m = /[?&]touch=([01])/.exec(location.search);
  if (m) return m[1] === '1';
  try {
    if (!navigator.maxTouchPoints) return false;
    return matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;
  } catch (e) { return false; }
}

// action, face, css class. Order is paint order, so the big fire button is drawn last and wins.
// There used to be a second trigger on the left edge. FIRE is already a look pad you can drag off,
// which is the thing the left one existed to allow, so it was one more ring in a picture that had
// too many - and it sat exactly where the movement stick wants to be.
const BTNS = [
  ['score', 'TAB', 'b-score'], ['pause', '❚❚', 'b-pause'],
  ['slot1', '1', 'b-s1'], ['slot2', '2', 'b-s2'], ['slot3', '3', 'b-s3'], ['slot4', '4', 'b-s4'], ['slot5', '5', 'b-s5'],
  ['grenade', 'NADE', 'b-nade'], ['grapple', 'HOOK', 'b-hook'], ['melee', 'SLASH', 'b-melee'], ['crouch', 'SLIDE', 'b-slide'],
  ['reload', 'RELOAD', 'b-reload'], ['jump', 'JUMP', 'b-jump'], ['aim', 'AIM', 'b-aim'],
  ['fire', 'FIRE', 'b-fire'],
];

export class TouchControls {
  constructor(root, input) {
    this.input = input; this.root = root;
    this.active = false;              // main.js turns this on only while a round is actually running
    this.frames = {};                 // action -> {down, n}: a fast tap still has to survive two frames
    this.ptrs = new Map();
    this.aimOn = false;               // aim is a toggle here; holding a second thumb down to scope is misery
    this.sens = 2.2;                  // multiplies the shared mouse sensitivity
    this.stick = null;

    const wrap = document.createElement('div');
    wrap.className = 'tc';
    wrap.innerHTML = '<div class="tc-stick" id="tcstick"><i></i><b></b></div>'
      + BTNS.map(([a, face, cls]) => `<div class="tb ${cls}" data-a="${a}">${ts(face)}</div>`).join('');
    root.appendChild(wrap);
    // the face is rewritten rather than re-rendered: the stick and the live pointer state live in here
    this._faces = [...wrap.querySelectorAll('.tb')];
    onLangChange(() => {
      this._faces.forEach((el, i) => { el.textContent = ts(BTNS[i][1]); });
      const mode = this._weaponMode || 'normal'; this._weaponMode = null; this.setWeaponMode(mode);
      const m = this.rotEl && this.rotEl.querySelector('.rotmsg'); if (m) m.textContent = ts('turn your phone sideways');
    });
    // shown by CSS only while the phone is upright; it sits outside .tc so a menu cannot hide it
    const rot = document.createElement('div');
    rot.className = 'tc-rot'; rot.innerHTML = `<span>▯</span><div class="rotmsg">${ts('turn your phone sideways')}</div>`;
    root.appendChild(rot); this.rotEl = rot;
    this.wrap = wrap; this.stickEl = wrap.querySelector('#tcstick');
    this.btnEls = {}; for (const el of wrap.querySelectorAll('.tb')) (this.btnEls[el.dataset.a] ||= []).push(el);

    const opt = { passive: false };
    addEventListener('pointerdown', (e) => this._down(e), opt);
    addEventListener('pointermove', (e) => this._move(e), opt);
    for (const t of ['pointerup', 'pointercancel']) addEventListener(t, (e) => this._up(e), opt);
    // a phone that scrolls, zooms or fires the browser's own context menu mid-fight is unplayable
    for (const t of ['gesturestart', 'gesturechange', 'contextmenu']) addEventListener(t, (e) => e.preventDefault(), opt);
  }

  // main.js flips this per frame; releasing everything on the way out stops a button sticking down
  // when a pause screen swallows the pointerup that would have cleared it.
  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    if (!on) { this.ptrs.clear(); this.stick = null; this.frames = {}; this.aimOn = false; this._syncBtns(); this._syncStick(); }
  }

  _btnAt(e) { return e.target && e.target.closest ? e.target.closest('.tb') : null; }
  _onMenu(e) { return e.target && e.target.closest ? !!e.target.closest('#screen') : false; }

  _down(e) {
    if (!this.active || this._onMenu(e)) return;
    const btn = this._btnAt(e);
    if (btn) {
      e.preventDefault();
      const a = btn.dataset.a;
      if (a === 'aim') { this.aimOn = !this.aimOn; btn.classList.toggle('on', this.aimOn); this.ptrs.set(e.pointerId, { kind: 'tap' }); return; }
      this._press(a); btn.classList.add('on');
      // the fire button doubles as a look pad: one thumb has to be able to shoot and track at once
      this.ptrs.set(e.pointerId, { kind: 'btn', a, btn, x: e.clientX, y: e.clientY, look: a === 'fire' });
      return;
    }
    e.preventDefault();
    if (e.clientX < innerWidth * 0.45) {
      this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: 0, y: 0 };
      this.ptrs.set(e.pointerId, { kind: 'stick' });
      this._syncStick();
    } else {
      this.ptrs.set(e.pointerId, { kind: 'look', x: e.clientX, y: e.clientY });
    }
  }

  _move(e) {
    const p = this.ptrs.get(e.pointerId); if (!p) return;
    e.preventDefault();
    if (p.kind === 'stick') {
      const s = this.stick; if (!s) return;
      const R = 52; let dx = e.clientX - s.ox, dy = e.clientY - s.oy;
      const l = Math.hypot(dx, dy);
      // dragging past the ring drags the ring along, so the stick never runs out from under a thumb
      if (l > R) { s.ox += dx * (1 - R / l); s.oy += dy * (1 - R / l); dx *= R / l; dy *= R / l; }
      s.x = dx / R; s.y = -dy / R;   // screen y grows downward; forward is -y
      this._syncStick();
      return;
    }
    if (p.kind === 'look' || (p.kind === 'btn' && p.look)) {
      // straight into the same accumulator the mouse feeds, so one sensitivity setting covers both
      this.input.mx += (e.clientX - p.x) * this.sens;
      this.input.my += (e.clientY - p.y) * this.sens;
      p.x = e.clientX; p.y = e.clientY;
      this.input.usingTouch = true; this.input.lastActive = performance.now(); this.input.anyInput = true;
    }
  }

  _up(e) {
    const p = this.ptrs.get(e.pointerId); if (!p) return;
    this.ptrs.delete(e.pointerId);
    if (p.kind === 'stick') { this.stick = null; this._syncStick(); }
    else if (p.kind === 'btn') { this._release(p.a); p.btn.classList.remove('on'); }
  }

  _press(a) { const f = (this.frames[a] ||= { down: 0, n: 0 }); f.down++; f.n = 0; }
  _release(a) { const f = this.frames[a]; if (f) f.down = Math.max(0, f.down - 1); }

  _syncStick() {
    const s = this.stick, el = this.stickEl;
    el.classList.toggle('on', !!s);
    if (!s) return;
    el.style.transform = `translate(${s.ox.toFixed(0)}px, ${s.oy.toFixed(0)}px)`;
    el.querySelector('b').style.transform = `translate(${(s.x * 52).toFixed(0)}px, ${(-s.y * 52).toFixed(0)}px)`;
  }
  _syncBtns() { for (const a in this.btnEls) for (const el of this.btnEls[a]) el.classList.remove('on'); }

  // The weapon list in the corner of the HUD is off on a phone - four buttons already say what you
  // are carrying, so the buttons carry the readout instead: the one in your hands is inked in, one
  // that is dry goes red, and a slot you do not own yet is not drawn at all.
  setSlots(slots) {
    const key = slots.map((s, i) => `${s.slot ?? i + 1}:${s.active ? 'a' : s.empty ? 'e' : 'o'}`).join('|');
    if (key === this._slotKey) return; this._slotKey = key;
    for (let i = 0; i < 5; i++) {
      const el = (this.btnEls['slot' + (i + 1)] || [])[0]; if (!el) continue;
      const s = slots.find((s, index) => (s.slot ?? index + 1) === i + 1);
      el.classList.toggle('gone', !s);
      el.classList.toggle('cur', !!(s && s.active));
      el.classList.toggle('dry', !!(s && s.empty));
    }
  }

  setWeaponMode(mode) {
    if (mode === this._weaponMode) return; this._weaponMode = mode; this.clearAim();
    const grenades = mode === 'grenades', knives = mode === 'knives';
    for (const action of ['grenade', 'melee', 'reload', 'aim']) {
      const hidden = action === 'grenade' ? false : action === 'melee' || action === 'aim' ? grenades : grenades || knives;
      for (const el of this.btnEls[action] || []) el.classList.toggle('gone', hidden);
      if (hidden) delete this.frames[action];
    }
    for (const el of this.btnEls.fire || []) el.textContent = ts(grenades ? 'THROW' : knives ? 'SLASH' : 'FIRE');
  }

  // called once per frame, before Input.update folds everything together
  update() {
    const k = {};
    for (const a in this.frames) {
      const f = this.frames[a];
      if (f.down > 0 || f.n < 2) { k[a] = true; f.n++; } else delete this.frames[a];
    }
    if (this.aimOn) k.aim = true;
    const s = this.stick, mv = this.input.tmove;
    if (s) {
      mv.x = s.x; mv.y = s.y;
      if (s.y > 0.62 && Math.hypot(s.x, s.y) > 0.9) k.sprint = true;   // pushed all the way forward is a sprint
      this.input.usingTouch = true;
    } else { mv.x = 0; mv.y = 0; }
    this.input.touchKeys = k;
  }

  // the aim toggle has to come back off when the gun goes away, or a katana walks around scoped
  clearAim() { if (!this.aimOn) return; this.aimOn = false; for (const el of this.btnEls.aim || []) el.classList.remove('on'); }
}

export const TOUCH_CONTROLS_HTML = `
<div class="cols">
  <div><div class="colhead">THUMBS</div>
    <div><b>Left half</b> drag to move · push all the way forward to sprint</div>
    <div><b>Right half</b> drag to look around</div>
    <div><b>FIRE</b> hold to shoot — drag off it to keep aiming while you do</div>
    <div><b>AIM</b> is a toggle: tap once to sight in, again to come out</div>
  </div>
  <div><div class="colhead">BUTTONS</div>
    <div><b>JUMP</b> again in the air = double jump · at a wall = wall jump</div>
    <div><b>SLIDE</b> on the ground · air dash in the air</div>
    <div><b>HOOK</b> tap to swing, hold to reel, JUMP to launch</div>
    <div><b>SLASH</b> quick katana · <b>NADE</b> hold to throw further</div>
    <div><b>AIM + FIRE</b> dash-slash once the katana gauge is lit</div>
    <div><b>1-4</b> along the bottom pick a weapon</div>
  </div>
</div>`;

export const TOUCH_KEYS = {
  fire: 'FIRE', aim: 'AIM', block: 'AIM', jump: 'JUMP', sprint: 'push the stick forward', slide: 'SLIDE', dash: 'SLIDE',
  grapple: 'HOOK', melee: 'SLASH', reload: 'RELOAD', grenade: 'NADE', focus: 'AIM + FIRE', next: 'the weapon numbers',
  pause: '❚❚', confirm: 'tap the screen', score: 'TAB',
};
