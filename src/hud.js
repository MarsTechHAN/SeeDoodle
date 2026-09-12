// DOM heads-up display drawn in "pen" style (multiplied over the paper canvas).
import { TOUCH_KEYS } from './touch.js';
import { ts, trDom } from './i18n.js';
export class HUD {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="scope" id="scope"><div class="mask"></div><div class="ring"></div><div class="cx"></div><div class="cy"></div><div class="dot"></div></div>
      <div class="focus-meter" id="focusmeter"><div class="fm-label">KATANA</div><div class="fm-tube"><div class="fm-fill" id="fmfill"></div><i class="fm-f1"></i><i class="fm-f2"></i><i class="fm-f3"></i></div><div class="fm-ready" id="fmready">SLASH READY</div></div>
      <div class="focus-mark" id="focusmark"><i></i><i></i><i></i><i></i></div>
      <div class="crosshair" id="crosshair"><i class="ch-t"></i><i class="ch-b"></i><i class="ch-l"></i><i class="ch-r"></i><i class="ch-dot"></i></div>
      <div class="cyc" id="cyc" hidden><i></i></div>
      <div class="nade-state" id="nadestate" hidden><div class="nade-readout"><span id="nadelabel"></span><b id="nadevalue"></b></div><div class="nade-charge"><i id="nadecharge"></i></div><small id="nadehint"></small></div>
      <div class="nade-state knife-state" id="knifestate" hidden><div class="nade-readout"><span>SLASH CHARGE</span><b id="knifevalue"></b></div><div class="nade-charge"><i id="knifecharge"></i></div><small id="knifehint"></small></div>
      <div class="grapple-ret" id="gret"></div><div class="gstam" id="gstam" hidden><i id="gstamfill"></i></div>
      <div class="hitmarker" id="hitmarker"><i></i><i></i></div>
      <div class="dmg-ind" id="dmg"></div>
      <div class="hud-tl"><div class="score">SCORE <b id="score">0</b></div><div class="combo" id="combo"></div></div>
      <div class="hud-tr"><div class="wave">WAVE <b id="wave">1</b></div><div class="modifier" id="modifier"></div><div class="left"><b id="left">0</b> enemies left</div><div class="timer" id="timer"></div><div class="weapon-rule" id="weaponrule" hidden></div><div class="pvpscore" id="pvpscore" hidden></div></div>
      <div class="wayfinder" id="wayfinder" hidden><b id="heading"></b><span id="area"></span><small id="mapkey"></small></div>
      <div class="minimap" id="minimap" hidden><canvas id="minimapcanvas" role="img"></canvas></div>
      <div class="board" id="board" hidden><section class="tactical-map"><h3 id="maptitle"></h3><canvas id="mapcanvas"></canvas><p id="maplegend"></p></section><section class="board-scores" id="boardscores"></section></div>
      <div class="bossbar" id="bossbar"><div class="bossname" id="bossname"></div><div class="bar big"><div class="fill red" id="bossfill"></div></div></div>
      <div class="hud-bl">
        <div class="health"><span>HP</span><div class="bar"><div class="fill" id="hpfill"></div></div><span id="hpnum">100</span></div>
        <div class="stam" id="stam" hidden><span>LEGS</span><div class="bar"><div class="fill" id="stamfill"></div></div></div>
        <div class="ammo"><b id="mag">30</b><span id="reserve">/120</span><span class="reloading" id="reloading"></span><span class="nades" id="nades" title="grenades"></span></div>
        <div class="tally" id="tally"></div>
      </div>
      <div class="hud-br"><div class="slots" id="slots"></div><div class="weapon" id="weapon">RIFLE</div><div class="hint" id="hint"></div></div>
      <div class="tip" id="tip"></div>
      <div class="message"><div class="msg-main" id="msg"></div><div class="msg-sub" id="msgsub"></div></div>
      <div class="killfeed" id="killfeed"></div>
      <div class="screen" id="screen"><div class="panel" id="panel"></div></div>`;
    trDom(root);
    const q = (id) => root.querySelector('#' + id);
    this.el = { crosshair: q('crosshair'), gret: q('gret'), hitmarker: q('hitmarker'), dmg: q('dmg'), score: q('score'), combo: q('combo'), wave: q('wave'), modifier: q('modifier'), left: q('left'), timer: q('timer'), hpfill: q('hpfill'), hpnum: q('hpnum'), mag: q('mag'), reserve: q('reserve'), reloading: q('reloading'), tally: q('tally'), weapon: q('weapon'), hint: q('hint'), slots: q('slots'), tip: q('tip'), msg: q('msg'), msgsub: q('msgsub'), killfeed: q('killfeed'), screen: q('screen'), panel: q('panel'), nades: q('nades'), scope: q('scope'), focusmark: q('focusmark'), focusmeter: q('focusmeter'), fmfill: q('fmfill'), bossbar: q('bossbar'), bossname: q('bossname'), bossfill: q('bossfill'), pvpscore: q('pvpscore'), board: q('board'), gstam: q('gstam'), gstamfill: q('gstamfill'), cyc: q('cyc'), stam: q('stam'), stamfill: q('stamfill') };
    for (const id of ['nadestate', 'nadelabel', 'nadevalue', 'nadecharge', 'nadehint', 'knifestate', 'knifevalue', 'knifecharge', 'knifehint']) this.el[id] = q(id);
    for (const id of ['wayfinder', 'heading', 'area', 'mapkey', 'maptitle', 'mapcanvas', 'maplegend', 'boardscores', 'minimap', 'minimapcanvas']) this.el[id] = q(id);
    this._msgT = 0; this._scope = false; this._nades = -1; this._pad = false; this.onDevice = null; this._fmShow = false; this._fmFrac = -1; this._fmReady = false; this._lastTally = -1; this._lastSlots = ''; this._ads = false; this._mode = ''; this.onScreenClick = null; this._tipT = 0; this._cycKind = ''; this._cycFrac = -1; this._touch = false; this._stamF = -1;
    this.el.screen.addEventListener('click', () => { if (this.onScreenClick) this.onScreenClick(); });
  }
  // katana charge gauge: fills with katana kills, catches fire when a focus slash is ready
  setFocusMeter(show, frac, ready, label = 'KATANA') {
    const m = this.el.focusmeter;
    if (show !== this._fmShow) { this._fmShow = show; m.classList.toggle('on', show); }
    if (!show) return;
    if (label !== this._fmLabel) { this._fmLabel = label; m.querySelector('.fm-label').textContent = ts(label); }
    const f = Math.max(0, Math.min(1, frac));
    if (Math.abs(f - (this._fmFrac ?? -1)) > 0.005) { this._fmFrac = f; this.el.fmfill.style.height = (f * 100).toFixed(1) + '%'; }
    if (ready !== this._fmReady) { this._fmReady = ready; m.classList.toggle('ready', ready); }
  }
  setGrenades(n) { if (n === this._nades) return; this._nades = n; let h = ''; if (n === Infinity) h = '<b class="infinite">∞</b>'; else for (let i = 0; i < Math.min(5, Math.max(0, n)); i++) h += '<i></i>'; this.el.nades.innerHTML = h; this.el.nades.hidden = n === 0; this.el.nades.title = ts(n === Infinity ? 'unlimited grenades' : 'grenades'); }
  setGrenadeState(status) {
    const el = this.el, state = status?.state || 'idle';
    el.nadestate.hidden = state === 'idle' || this.root.classList.contains('nogame') || el.screen.classList.contains('show');
    if (el.nadestate.hidden) return;
    const armed = state === 'armed', charge = Math.round(Math.max(0, Math.min(1, status.charge || 0)) * 100);
    const remaining = Math.max(0, status.remaining || 0);
    el.nadestate.classList.toggle('armed', armed); el.nadestate.classList.toggle('urgent', armed && remaining <= 2);
    const label = ts(armed ? 'LIVE GRENADE' : 'SAFE AIM'), value = armed ? ts('{} s left', remaining.toFixed(1)) : charge >= 100 ? ts('CHARGED') : ts('POWER {}%', charge);
    const hint = armed ? this._touch ? ts('release: throw - slide + release: DROP') : ts('{}: drop - release to throw', this.key('nadeCancel'))
      : status.autoPin ? this._touch ? ts('auto pin when full - slide + release: CANCEL') : ts('auto pin at full charge - {}: pin now - {}: cancel', this.key('nadePin'), this.key('nadeCancel'))
      : this._touch ? ts('release: throw - slide + release: CANCEL') : ts('release to throw - {}: pull pin - {}: cancel', this.key('nadePin'), this.key('nadeCancel'));
    if (el.nadelabel.textContent !== label) el.nadelabel.textContent = label;
    if (el.nadevalue.textContent !== value) el.nadevalue.textContent = value;
    if (el.nadehint.textContent !== hint) el.nadehint.textContent = hint;
    const meter = armed ? Math.round(Math.min(1, remaining / 7) * 1000) / 10 : charge;
    if (meter !== this._nadeCharge) { this._nadeCharge = meter; el.nadecharge.style.width = meter + '%'; }
    const meterTitle = ts(armed ? 'fuse remaining' : 'throw power'); if (el.nadecharge.parentElement.title !== meterTitle) el.nadecharge.parentElement.title = meterTitle;
  }
  setKnifeState(status) {
    const el = this.el;
    el.knifestate.hidden = status?.state !== 'charging' || this.root.classList.contains('nogame') || el.screen.classList.contains('show');
    if (el.knifestate.hidden) return;
    const fraction = Math.max(0, Math.min(1, status.charge || 0)), charge = Math.round(fraction * 100);
    const multiplier = Math.max(1, Math.min(3, status.multiplier ?? 1 + 2 * fraction)).toFixed(1).replace(/\.0$/, '');
    const value = ts('{}% · {}x', charge, multiplier);
    const hint = this._touch ? ts('release to slash - full charge: 3x damage') : ts('release to slash - full charge: 3x damage - {}: cancel', this.key('block'));
    const label = el.knifestate.querySelector('span'); if (label.textContent !== ts('SLASH CHARGE')) label.textContent = ts('SLASH CHARGE');
    if (el.knifevalue.textContent !== value) el.knifevalue.textContent = value;
    if (el.knifehint.textContent !== hint) el.knifehint.textContent = hint;
    if (charge !== this._knifeCharge) { this._knifeCharge = charge; el.knifecharge.style.width = charge + '%'; }
  }
  // control labels follow whatever you touched last
  setDevice(pad) { if (pad === this._pad) return; this._pad = pad; this.root.classList.toggle('pad', pad); if (this.onDevice) this.onDevice(pad); }
  // a phone never grows a keyboard, so touch labels win outright once we are in that mode
  setTouch(on) { this._touch = on; this.root.classList.toggle('touch', on); }
  key(action) { return ts((this._touch ? TOUCH_KEYS : this._pad ? PAD_KEYS : KB_KEYS)[action] || action); }
  setScope(on) { if (on === this._scope) return; this._scope = on; this.el.scope.classList.toggle('on', on); }
  setFocusMark(x, y) {
    const m = this.el.focusmark;
    if (x == null) { m.classList.remove('on'); return; }
    m.classList.add('on'); m.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
  }
  setSpread(px) { const value = px.toFixed(1) + 'px'; if (value !== this._spread) { this._spread = value; this.el.crosshair.style.setProperty('--s', value); } }
  setCrosshairMode(mode) { this._mode = mode; this._applyCross(); }
  setAds(on) { if (on === this._ads) return; this._ads = on; this._applyCross(); }
  _applyCross() { this.el.crosshair.className = 'crosshair ' + this._mode + (this._ads ? ' ads' : ''); }
  setGrappleStamina(f) { const show = f < 0.995; if (this.el.gstam.hidden === show) this.el.gstam.hidden = !show; if (show) { this.el.gstamfill.style.width = (f * 100).toFixed(0) + '%'; this.el.gstam.classList.toggle('low', f < 0.2); } }
  // How much run is left in your legs. `null` is EASY - there is no limit, so there is no meter,
  // and a player who never opens the difficulty menu never sees this element at all.
  setSprintStamina(f) {
    if (f === null) { if (!this.el.stam.hidden) this.el.stam.hidden = true; this._stamF = -1; return; }
    if (this.el.stam.hidden) this.el.stam.hidden = false;
    if (Math.abs(f - this._stamF) < 0.004) return;
    this._stamF = f; this.el.stamfill.style.width = (f * 100).toFixed(0) + '%'; this.el.stam.classList.toggle('low', f < 0.25);
  }
  // The ring by the crosshair: how far along the gun is through a pump or a reload. The gun model
  // says the same thing by hand, but a scoped rifle hides its own model (weapons.js), so without
  // this a bolt action gives you nothing but a click and a wait.
  setCycle(frac, kind) {
    if (kind !== this._cycKind) {
      this._cycKind = kind; this.el.cyc.hidden = !kind;
      if (kind) this.el.cyc.className = 'cyc ' + kind;
    }
    if (!kind) return;
    const p = Math.max(0, Math.min(1, frac));
    if (Math.abs(p - this._cycFrac) > 0.004) { this._cycFrac = p; this.el.cyc.style.setProperty('--p', p.toFixed(3)); }
  }
  grappleTarget(state) { this.el.gret.className = 'grapple-ret' + (state === 1 ? ' on' : state === 2 ? ' on attached' : ''); }
  hitmarker(kill = false, crit = false) { const h = this.el.hitmarker; h.className = 'hitmarker' + (kill ? ' kill' : '') + (crit ? ' crit' : ''); void h.offsetWidth; h.classList.add('show'); }
  setAmmo(mag, reserve, magSize, reloading = false) {
    const values = [String(mag), '/' + reserve, reloading ? ts(' reloading…') : ''];
    for (const [i, id] of ['mag', 'reserve', 'reloading'].entries()) if (this.el[id].textContent !== values[i]) this.el[id].textContent = values[i];
    if (mag !== this._lastTally) { this._lastTally = mag; let s = ''; for (let i = 0; i < Math.min(mag, 40); i++) s += '<i></i>'; this.el.tally.innerHTML = s; }
  }
  setKatana() { if (this.el.mag.textContent !== '∞') this.el.mag.textContent = '∞'; if (this.el.reserve.textContent) this.el.reserve.textContent = ''; if (this.el.reloading.textContent) this.el.reloading.textContent = ''; if (this._lastTally !== -1) { this.el.tally.innerHTML = ''; this._lastTally = -1; } }
  setSlots(slots) {
    const key = slots.map((s) => `${s.slot}|${s.key}|${s.name}|${s.active ? 1 : 0}|${s.ammo}`).join(';'); if (key === this._lastSlots) return; this._lastSlots = key;
    this.el.slots.innerHTML = slots.map((s, i) => `<div class="slot${s.active ? ' active' : ''}${s.empty ? ' empty' : ''}"><span class="num">${s.key ?? s.slot ?? i + 1}</span>${s.name}<span class="sammo">${s.ammo}</span></div>`).join('');
    trDom(this.el.slots);
  }
  setHealth(hp, max) {
    const f = Math.max(0, Math.min(1, hp / max)), width = (f * 100).toFixed(1) + '%', number = String(Math.ceil(hp));
    if (width !== this._hpWidth) { this._hpWidth = width; this.el.hpfill.style.width = width; }
    if (this.el.hpnum.textContent !== number) this.el.hpnum.textContent = number;
    if ((f < .3) !== this._lowHP) { this._lowHP = f < .3; this.root.classList.toggle('low', this._lowHP); }
  }
  setBoard(html, mapOnly = false) {
    const on = !!html || mapOnly; this.el.board.hidden = !on; this.root.classList.toggle('board-open', on);
    this.el.board.classList.toggle('map-only', mapOnly); this.el.boardscores.hidden = mapOnly;
    if (on && html !== this._boardHTML) { this._boardHTML = html; this.el.boardscores.innerHTML = html || ''; trDom(this.el.boardscores); }
    if (!on) this._mapDrawAt = 0;
  }
  scrollBoard(event) {
    if (this.el.board.hidden) return false;
    const scores = this.el.boardscores;
    if (!scores.hidden) scores.scrollTop += event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? scores.clientHeight : 1);
    return true;
  }
  setNavigation(info) {
    const el = this.el, visible = !!info && !this.root.classList.contains('nogame') && !el.screen.classList.contains('show');
    el.wayfinder.hidden = !visible || !el.board.hidden;
    el.minimap.hidden = !visible || !info?.minimap || !el.board.hidden;
    this.root.classList.toggle('minimap-on', !el.minimap.hidden);
    if (el.minimap.hidden) this._minimapDrawAt = 0;
    if (!visible) return;
    const { level, pos, heading } = info;
    const zones = (level.zones || []).filter(z => {
      const b = z.bounds;
      return b ? pos.x >= b.minX && pos.x <= b.maxX && pos.z >= b.minZ && pos.z <= b.maxZ : Math.hypot(pos.x - z.x, pos.z - z.z) < (z.radius || 22);
    }).sort((a, b) => {
      const area = z => z.bounds ? (z.bounds.maxX - z.bounds.minX) * (z.bounds.maxZ - z.bounds.minZ) : (z.radius || 22) ** 2;
      return area(a) - area(b);
    });
    const direction = ['NORTH', 'NORTHEAST', 'EAST', 'SOUTHEAST', 'SOUTH', 'SOUTHWEST', 'WEST', 'NORTHWEST'][Math.round(heading / 45) % 8];
    const text = ts(direction) + ' ' + String(Math.round(heading) % 360).padStart(3, '0');
    if (el.heading.textContent !== text) el.heading.textContent = text;
    const place = ts(zones[0]?.name || info.name);
    if (el.area.textContent !== place) el.area.textContent = place;
    const key = this._touch ? ts('MAP / SCORE') : ts('{}: map / score', this.key('score'));
    if (el.mapkey.textContent !== key) el.mapkey.textContent = key;
    if (!el.minimap.hidden && performance.now() >= (this._minimapDrawAt || 0)) {
      this._minimapDrawAt = performance.now() + 80;
      this._drawTactical(info, true);
    }
    if (el.board.hidden || performance.now() < (this._mapDrawAt || 0)) return;
    this._mapDrawAt = performance.now() + 100;
    this._drawTactical(info);
  }
  _drawTactical(info, compact = false) {
    const el = this.el, canvas = compact ? el.minimapcanvas : el.mapcanvas, width = Math.round(canvas.clientWidth), height = Math.round(canvas.clientHeight);
    if (!width || !height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2), level = info.level, B = level.bounds;
    const key = `${width}/${height}/${ratio}/${document.documentElement.lang}/${info.skin}/${info.sites.length}`;
    const scale = Math.min((width - (compact ? 20 : 28)) / (B.maxX - B.minX), (height - (compact ? 24 : 34)) / (B.maxZ - B.minZ));
    const x = v => width / 2 + (v - (B.minX + B.maxX) / 2) * scale;
    const z = v => height / 2 + (v - (B.minZ + B.maxZ) / 2) * scale;
    // Each view keeps its own static terrain; moving players only repaint the small overlay.
    const cache = compact ? (this._minimapCache ||= {}) : (this._tacticalCache ||= {});
    if (cache.level !== level || cache.key !== key) {
      cache.level = level; cache.key = key;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      const base = cache.base = document.createElement('canvas'); base.width = canvas.width; base.height = canvas.height;
      const g = base.getContext('2d'); g.scale(ratio, ratio);
      g.fillStyle = 'rgba(203,218,198,.25)'; g.fillRect(x(B.minX), z(B.minZ), (B.maxX - B.minX) * scale, (B.maxZ - B.minZ) * scale);
      const polygon = (points, fill) => { if (!points.length) return; g.beginPath(); points.forEach(([px, pz], i) => i ? g.lineTo(x(px), z(pz)) : g.moveTo(x(px), z(pz))); g.closePath(); g.fillStyle = fill; g.fill(); };
      for (const water of level.tactical?.water || []) polygon(water, 'rgba(76,146,155,.45)');
      for (const path of level.tactical?.paths || []) polygon(path, 'rgba(246,235,208,.42)');
      const buildings = level.tactical?.buildings || info.world.boxes.filter(b => b.max.y - b.min.y > 2.5 && b.max.x - b.min.x > .6 && b.max.z - b.min.z > .6).map(b => ({ x1: b.min.x, z1: b.min.z, x2: b.max.x, z2: b.max.z }));
      g.fillStyle = 'rgba(72,91,102,.43)'; g.strokeStyle = 'rgba(236,245,242,.55)'; g.lineWidth = .65;
      for (const b of buildings) { const w = (b.x2 - b.x1) * scale, h = (b.z2 - b.z1) * scale; g.fillRect(x(b.x1), z(b.z1), w, h); g.strokeRect(x(b.x1), z(b.z1), w, h); }
      g.strokeStyle = 'rgba(236,245,242,.4)'; g.strokeRect(x(B.minX), z(B.minZ), (B.maxX - B.minX) * scale, (B.maxZ - B.minZ) * scale);
      const fontSize = width < 300 ? 9 : 10;
      g.fillStyle = '#edf5ee'; g.font = `${fontSize}px "Trebuchet MS", "Noto Sans CJK SC", sans-serif`; g.textAlign = 'center';
      g.shadowColor = 'rgba(18,34,41,.95)'; g.shadowBlur = 3;
      const occupied = info.sites.map(site => ({ left: x(site.pos.x) - 13, right: x(site.pos.x) + 13, top: z(site.pos.z) - 13, bottom: z(site.pos.z) + 13 }));
      // Place landmark names around objective markers, keeping small maps readable in either language.
      for (const label of (compact ? [] : [...level.tactical?.labels || []]).sort((a, b) => Number(!!a.small) - Number(!!b.small))) {
        if (label.small && width < 240) continue;
        const text = ts(label.name), tw = Math.min(g.measureText(text).width, width * .46);
        const px = Math.max(tw / 2 + 4, Math.min(width - tw / 2 - 4, x(label.x)));
        for (const dy of [0, -14, 14, -28, 28]) {
          const py = z(label.z) + dy, box = { left: px - tw / 2 - 3, right: px + tw / 2 + 3, top: py - fontSize - 2, bottom: py + 3 };
          if (box.top < 16 || box.bottom > height - 24 || occupied.some(b => b.left < box.right && b.right > box.left && b.top < box.bottom && b.bottom > box.top)) continue;
          occupied.push(box); g.fillText(text, px, py, width * .46); break;
        }
      }
      g.shadowBlur = 0; g.textAlign = 'left'; g.fillText(ts(compact ? 'N' : 'NORTH'), 8, 12);
      if (!compact) {
        const metres = (B.maxX - B.minX) > 150 ? 50 : 20, sx = width - metres * scale - 12, sy = height - 9;
        g.beginPath(); g.moveTo(sx, sy - 3); g.lineTo(sx, sy); g.lineTo(sx + metres * scale, sy); g.lineTo(sx + metres * scale, sy - 3); g.stroke();
        g.textAlign = 'center'; g.fillText(metres + ' m', sx + metres * scale / 2, sy - 5);
      }
    }
    const g = canvas.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, canvas.width, canvas.height); g.drawImage(cache.base, 0, 0); g.scale(ratio, ratio);
    // Only teammates supplied by main.js reach this layer. Enemy positions never enter the map.
    const marker = (p, color, radius, stroke = 'rgba(13,32,38,.85)') => { g.beginPath(); g.arc(x(p.x), z(p.z), radius, 0, Math.PI * 2); g.fillStyle = color; g.fill(); g.strokeStyle = stroke; g.lineWidth = 1.2; g.stroke(); };
    g.font = `bold ${compact ? 10 : 12}px "Trebuchet MS", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (compact) for (const site of info.sites) marker(site.pos, 'rgba(242,206,126,.28)', 7, 'rgba(242,206,126,.8)');
    for (const mate of info.teammates) marker(mate.pos, mate.color, compact ? 3.3 : 3, 'rgba(231,244,248,.85)');
    if (!compact) for (const site of info.sites) { marker(site.pos, 'rgba(242,206,126,.85)', 9); g.fillStyle = '#26383f'; g.fillText(site.id, x(site.pos.x), z(site.pos.z)); }
    if (info.bomb && !compact) {
      const p = info.bomb.pos; g.save(); g.translate(x(p.x), z(p.z)); g.rotate(Math.PI / 4);
      g.fillStyle = info.bomb.planted ? '#f29368' : '#f5dfa3'; g.strokeStyle = '#293b43'; g.lineWidth = 1.5; g.fillRect(-4, -4, 8, 8); g.strokeRect(-4, -4, 8, 8); g.restore();
    }
    if (info.alive) {
      const p = info.pos; g.save(); g.translate(x(p.x), z(p.z)); g.rotate(info.heading * Math.PI / 180);
      if (compact) g.scale(.8, .8);
      g.fillStyle = info.spectating ? '#a8e3ed' : '#fff5d1'; g.strokeStyle = '#243e48'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(0, -8); g.lineTo(5, 6); g.lineTo(0, 3); g.lineTo(-5, 6); g.closePath(); g.fill(); g.stroke(); g.restore();
    }
    if (compact) {
      // Offset site letters so a player standing on the objective leaves both symbols readable.
      g.fillStyle = '#ffe3a4'; g.shadowColor = 'rgba(13,32,38,.95)'; g.shadowBlur = 3;
      for (const site of info.sites) g.fillText(site.id, Math.min(width - 6, x(site.pos.x) + 10), Math.max(7, z(site.pos.z) - 8));
      g.shadowBlur = 0;
      const label = ts(info.spectating ? 'Minimap - spectating teammate' : 'Minimap - you and teammates') + (info.sites.length ? ' - A / B' : '');
      if (canvas.getAttribute('aria-label') !== label) canvas.setAttribute('aria-label', label);
      return;
    }
    const title = ts(info.name), legend = ts(info.sites.length ? 'You - teammates - objective sites' : info.teammates.length ? 'You - teammates - map routes' : 'You - map routes');
    if (el.maptitle.textContent !== title) el.maptitle.textContent = title;
    if (el.maplegend.textContent !== legend) el.maplegend.textContent = legend;
    canvas.setAttribute('aria-label', ts('Tactical map'));
  }
  setPvpScore(html) { const on = !!html; this.el.pvpscore.hidden = !on; if (on) this.el.pvpscore.innerHTML = html; this.el.wave.parentElement.hidden = on; this.el.left.parentElement.hidden = on; }
  setWave(n, left) { this.el.wave.textContent = n; this.el.left.textContent = left; }
  setModifier(text) { this.el.modifier.textContent = text ? ts(text) : ''; }
  setTimer(text) { this.el.timer.textContent = text ? ts(text) : ''; }
  setScore(score, combo) { this.el.score.textContent = score; this.el.combo.textContent = combo > 1 ? ts('combo x{}', combo) : ''; }
  setWeapon(name, hint) { this.el.weapon.textContent = ts(name); this.el.hint.textContent = hint ? ts(hint) : ''; }
  setWeaponMode(name) { const el = this.root.querySelector('#weaponrule'), text = name ? ts(name) : ''; if (el.textContent !== text) el.textContent = text; el.hidden = !name; }
  setBoss(name, frac) { if (frac == null) { this.el.bossbar.classList.remove('show'); return; } this.el.bossbar.classList.add('show'); this.el.bossname.textContent = ts(name); this.el.bossfill.style.width = (Math.max(0, frac) * 100).toFixed(1) + '%'; }
  tip(text, dur = 5) { this.el.tip.innerHTML = ts(text); this.el.tip.classList.add('show'); this._tipT = dur; }
  message(main, sub = '', dur = 2.2) { const m = this.el.msg; m.textContent = ts(main); m.classList.remove('show'); void m.offsetWidth; m.classList.add('show'); this.el.msgsub.textContent = sub ? ts(sub) : ''; this._msgT = dur; }
  kill(text, pts) {
    const d = document.createElement('div'); const txt = ts(text); d.innerHTML = pts > 0 ? `${txt} <span class="pts">+${pts}</span>` : txt; this.el.killfeed.appendChild(d);
    setTimeout(() => d.remove(), 1700); while (this.el.killfeed.children.length > 6) this.el.killfeed.firstChild.remove();
  }
  damageFrom(angle) { const i = document.createElement('i'); i.style.transform = `rotate(${(angle * 180 / Math.PI).toFixed(1)}deg)`; this.el.dmg.appendChild(i); setTimeout(() => i.remove(), 1000); }
  showScreen(html) { this.el.screen.inert = false; this.el.panel.innerHTML = html; trDom(this.el.panel); this.el.screen.classList.add('show'); this.el.nadestate.hidden = true; this.el.knifestate.hidden = true; this.el.minimap.hidden = true; this.root.classList.remove('minimap-on'); }
  hideScreen() { if (this.el.screen.contains(document.activeElement)) document.activeElement.blur(); this.el.screen.inert = true; this.el.screen.classList.remove('show'); }
  setGameplayVisible(v) { this.root.classList.toggle('nogame', !v); }
  update(dt) {
    if (this._msgT > 0) { this._msgT -= dt; if (this._msgT <= 0) { this.el.msg.classList.remove('show'); this.el.msgsub.textContent = ''; } }
    if (this._tipT > 0) { this._tipT -= dt; if (this._tipT <= 0) this.el.tip.classList.remove('show'); }
  }
}

export const KB_KEYS = { fire: 'LMB', aim: 'RMB', block: 'RMB', jump: 'Space', sprint: 'Shift', slide: 'C', dash: 'C', grapple: 'Q', melee: 'F', reload: 'R', grenade: 'G', focus: 'both mouse buttons (or X)', next: 'wheel', pause: 'Esc', confirm: 'Space', score: 'Tab', nadePin: 'R', nadeCancel: 'RMB / V', interact: 'B', bombDrop: 'N' };
export const PAD_KEYS = { fire: 'R2', aim: 'L2', block: 'L2', jump: '✕', sprint: 'L3', slide: '○', dash: '○', grapple: 'L1', melee: 'R1', reload: '□', grenade: 'R3', focus: 'L2 + R2', next: '△', pause: 'Options', confirm: '✕', score: 'Create', nadePin: '□', nadeCancel: 'L2 / R1', interact: 'D-pad down', bombDrop: 'N' };
export const CONTROLS_HTML = `
<div class="cols">
  <div><div class="colhead">MOUSE + KEYBOARD</div>
    <div><b>WASD</b> move &nbsp; <b>Mouse</b> look &nbsp; <b>Shift</b> sprint</div>
    <div><b>LMB</b> fire / hold to charge a slash, release to strike &nbsp; <b>RMB</b> aim down sights / block</div>
    <div><b>KATANA</b> full charge in 0.8 seconds = 3x damage</div>
    <div><b>Space</b> jump (again on a wall = wall jump)</div>
    <div><b>Space</b> again in the air = double jump</div>
    <div><b>C / Ctrl</b> slide on the ground · air dash in the air</div>
    <div><b>Q / E</b> grapple: tap to swing, hold to reel, jump to launch</div>
    <div><b>F</b> quick katana slash &nbsp; <b>R</b> reload &nbsp; <b>M</b> music</div>
    <div><b>G</b> grenade · hold it to throw further</div>
    <div><b>LMB / G</b> in grenades only: hold to charge, release to throw</div>
    <div><b>R</b> pulls the pin while holding: 7-second fuse, current throw power locked</div>
    <div><b>Full charge</b> stays safe by default; automatic pin pull is optional in settings</div>
    <div><b>RMB / V</b> cancels before pulling the pin; drops a live grenade</div>
    <div><b>Tab</b> hold for map and scores; wheel scrolls players &nbsp; <b>Esc</b> pause</div>
    <div><b>Both mouse buttons</b> dash-slash once the gauge is lit</div>
    <div><b>1-4 / wheel</b> rifle · shotgun · sniper · katana</div>
  </div>
  <div><div class="colhead">PS5 CONTROLLER</div>
    <div><b>L stick</b> move &nbsp; <b>R stick</b> look &nbsp; <b>L3</b> sprint</div>
    <div><b>R2</b> fire / hold to charge a slash, release to strike &nbsp; <b>L2</b> aim / block</div>
    <div><b>KATANA</b> full charge in 0.8 seconds = 3x damage</div>
    <div><b>✕</b> jump &nbsp; <b>○</b> slide · air dash</div>
    <div><b>L1</b> grapple (hold to reel, ✕ to launch)</div>
    <div><b>L2 + R2</b> dash-slash once the katana gauge is lit</div>
    <div><b>R1</b> quick katana slash, then back to your gun</div>
    <div><b>□</b> reload &nbsp; <b>△</b> next weapon</div>
    <div><b>R3 / d-pad up</b> grenade · hold to throw further</div>
    <div><b>R2 / R3</b> in grenades only: hold to charge, release to throw</div>
    <div><b>□</b> pulls the pin while holding: 7-second fuse, current throw power locked</div>
    <div><b>Full charge</b> stays safe by default; automatic pin pull is optional in settings</div>
    <div><b>L2 / R1</b> cancels or drops the grenade</div>
    <div><b>Create</b> toggle map and scores &nbsp; <b>Options</b> pause</div>
  </div>
</div>`;
