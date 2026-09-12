// Team match rules are a separate authority domain from survival waves: the host owns lives,
// round deadlines and the single bomb; peers restore that complete state when the host changes.
import * as THREE from 'three';
import { makeInkMaterial, INK } from './render.js';
import { encodeLocal } from './players.js';
import { ArenaBots } from './arena-bots.js';
import { ts } from './i18n.js';

export const isTeamMode = (mode) => mode === 'tdm' || mode === 'demolition';
export const modeOf = (mode) => ['ffa', 'coop', 'tdm', 'demolition'].includes(mode) ? mode : 'ffa';
export const TEAM_COLORS = [0, 2];
export const TEAM_NAMES = ['BLUE TEAM', 'ORANGE TEAM'];
export const MATCH_RULES = { target: 50, time: 480000, respawn: 3000, protect: 2000, prepare: 3000, roundTime: 120000, plant: 5000, defuse: 7000, fuse: 40000, roundBreak: 4000, wins: 5, switchAfter: 4 };
const vec = (p) => new THREE.Vector3().fromArray(p);
const clone = (v) => JSON.parse(JSON.stringify(v));
const clock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

export class TeamMatch {
  constructor(ctx, api) {
    this.ctx = ctx; Object.assign(this, api); this.state = null; this.intents = new Map(); this.applied = new Map(); this.syncAt = 0; this.intentAt = 0; this.spectator = 0;
    this.objectiveSeq = ctx.input.holdEventSeq; this.objectiveSerial = 0; this.objectiveHold = 0; this.objectiveHeld = false;
    this.spectatorPose = { eye: new THREE.Vector3(), yaw: 0, pitch: 0, epoch: 0 };
    this.spectatorView = { position: new THREE.Vector3(), rotation: new THREE.Quaternion(), target: new THREE.Quaternion(), euler: new THREE.Euler(0, 0, 0, 'YXZ'), epoch: null };
    this.bots = new ArenaBots(ctx, this);
    this.panel = document.createElement('div'); this.panel.className = 'objective-hud'; this.panel.hidden = true; ctx.hud.root.appendChild(this.panel);
    this.spectatorPanel = document.createElement('div'); this.spectatorPanel.className = 'spectator-hud'; this.spectatorPanel.hidden = true; ctx.hud.root.appendChild(this.spectatorPanel);
    this.marker = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.18, 0.3), makeInkMaterial({ ink: INK.ORANGE, surface: 'metal' })); this.marker.visible = false; ctx.scene.add(this.marker);
    this.net.on('combatstate', (d, from) => { if (!this.net.isHost && from === this.net.hostId && this.active()) this.receive(d); });
    this.net.on('objective', (d, from) => { if (this.net.isHost) this.intent(from, d); });
    this.net.on('bombdrop', (d, from) => { if (this.net.isHost && d.round === this.state?.round) this.dropBomb(from); });
    this.net.on('bdmg', (d) => this.damageBot(d));
    this.net.on('unshield', (d) => {
      const a = this.actor(d.id); if (!this.net.isHost || !a || d.round !== this.state?.round || d.life !== a.life) return;
      a.protectedUntil = 0; this.publish(true);
    });
    this.net.on('botps', (d, from) => {
      const a = this.actor(d.id);
      if (this.net.isHost || from !== this.net.hostId || !a?.bot || !a.alive || d.round !== this.state?.round || d.life !== a.life) return;
      const r = this.remote.get(d.id); if (r) { r.push(d.ps, performance.now() / 1000); r.lastSeen = performance.now(); }
    });
  }
  active() { return isTeamMode(this.ctx.game.mode) && ['play', 'dying', 'over'].includes(this.ctx.game.state); }
  now() { return this.net.serverNow(); }
  actor(id) { return this.state?.actors.find((a) => a.id === id); }
  body(id) { return id === this.net.id ? this.ctx.player : this.remote.get(id); }
  team(id) { return this.actor(id)?.team ?? this.lobby.players.get(id)?.team ?? 0; }
  canFight() { return !this.active() || this.state?.phase === 'live'; }
  canHurt(id, target) { return this.state?.phase === 'live' && this.team(id) !== this.team(target) && this.actor(target)?.alive && this.actor(target).protectedUntil <= this.now(); }
  clear() { this.restoreSpectator(); this.state = null; this.appliedRound = null; this.explosionRound = null; this.applied.clear(); this.intents.clear(); this.resetObjectiveInput(); this.panel.hidden = true; this.marker.visible = false; this.bots.clear?.(); this.ctx.touch?.setObjective?.(false, null, false); this.ctx.hud.root.classList.remove('team-game', 'team-dead'); }
  resetObjectiveInput() { this.objectiveSeq = this.ctx.input.holdEventSeq; this.objectiveHeld = false; this.intentAt = 0; this.lastObjectiveInput = null; }
  start() {
    this.applied.clear(); this.intents.clear(); this.state = { mode: this.ctx.game.mode, round: 0, phase: 'warmup', endsAt: 0, attackTeam: 0, points: [0, 0], actors: [], bomb: null, interaction: null, reason: '', winner: null };
    this.nextRound();
  }
  spawn(a) {
    const roster = [...this.lobby.players.entries()].filter(([, p]) => p.team === a.team);
    const slot = Math.max(0, roster.findIndex(([id]) => id === a.id));
    const base = this.state.mode === 'demolition' ? (a.team === this.state.attackTeam ? 0 : 1) : a.team;
    const spots = this.ctx.level.teamSpawns[base];
    // A teammate's feet never share the same spawn slot, including bots and respawns.
    const available = spots.map((p, i) => ({ p, i, d: this.state.actors.filter((b) => b.id !== a.id && b.alive).reduce((m, b) => Math.min(m, this.body(b.id)?.body.pos.distanceTo(p) ?? 99), 99) }));
    const preferred = available[slot % spots.length];
    const selected = preferred.d > 1 ? preferred : available.sort((x, y) => y.d - x.d)[0];
    Object.assign(a, { alive: true, hp: 110, life: (a.life || 0) + 1, spawn: selected.p.toArray(), yaw: this.ctx.level.teamFacing?.[base] ?? (base ? Math.PI / 2 : -Math.PI / 2), protectedUntil: this.now() + MATCH_RULES.protect, respawnAt: 0, ps: null });
  }
  nextRound() {
    const s = this.state; s.round++; s.phase = 'warmup'; s.endsAt = this.now() + MATCH_RULES.prepare; s.attackTeam = s.round > MATCH_RULES.switchAfter ? 1 : 0; s.reason = ''; s.interaction = null;
    const old = new Map(s.actors.map((a) => [a.id, a]));
    s.actors = [...this.lobby.players].map(([id, p]) => ({ id, team: p.team ?? 0, bot: !!p.bot, life: old.get(id)?.life || 0 }));
    for (const a of s.actors) this.spawn(a);
    const attackers = s.actors.filter((a) => a.team === s.attackTeam);
    const carrier = attackers[(s.round - 1) % Math.max(1, attackers.length)];
    s.bomb = s.mode === 'demolition' && carrier ? { status: 'carried', carrier: carrier.id, pos: [...carrier.spawn], safePos: [...carrier.spawn], site: null, explodeAt: 0 } : null;
    this.publish(true);
  }
  publish(force = false) {
    if (!this.net.isHost || !this.state) return;
    if (!force && this.now() < this.syncAt) return;
    this.syncAt = this.now() + 250;
    this.applyState();
    for (const a of this.state.actors) { const b = this.body(a.id); if (b && !a.bot && a.alive) { a.hp = b.hp; a.ps = encodeLocal(b, b.weaponIndex, { round: this.state.round, life: a.life }); } }
    this.net.send('combatstate', this.state);
  }
  receive(d) {
    if (!d || !isTeamMode(d.mode) || !Array.isArray(d.actors)) return;
    if (this.state && d.round < this.state.round) return;
    this.state = clone(d); this.applyState();
  }
  applyState() {
    const s = this.state, P = this.ctx.player, game = this.ctx.game;
    if (!s) return;
    if (this.appliedRound !== s.round) {
      this.appliedRound = s.round; this.restoreSpectator(); this.resetObjectiveInput(); this.clearRound?.(); P.clearNades(); this.ctx.bullets.clear(); this.intents.clear(); this.bots.clear?.();
      this.ctx.hud.message(ts(s.mode === 'tdm' ? 'TEAM DEATHMATCH' : 'DEMOLITION'), s.mode === 'demolition' ? ts('ROUND {} - {}', s.round, ts(this.team(this.net.id) === s.attackTeam ? 'ATTACK' : 'DEFEND')) : ts('First to 50 - 8 minutes'), 2.5);
    }
    for (const a of s.actors) {
      const b = this.body(a.id); if (!b) continue;
      b.team = a.team;
      const newLife = this.applied.get(a.id) !== a.life;
      if (newLife) {
        this.applied.set(a.id, a.life);
        if (a.id === this.net.id && a.alive) {
          this.restoreSpectator(); this.resetObjectiveInput(); this.ctx.hud.root.classList.remove('team-dead');
          P.reset(vec(a.spawn), s.mode === 'tdm'); P.yaw = a.yaw; P.pitch = 0; P.hp = a.hp; P.maxHp = 110; P.lastHitBy = null; P.lastHit = null; game.state = 'play';
          P.regenRate = s.mode === 'demolition' ? 0 : P.regenRate;
          P._resetGrenadeInput();
        } else if (a.alive) {
          b.snapA = b.snapB = null; b.push(a.ps || [...a.spawn, a.yaw, 0, 0, 80, a.hp, 0, 0, 0], performance.now() / 1000); b.body.pos.fromArray(a.ps?.slice(0, 3) || a.spawn);
        }
      }
      if (!a.alive) { b.alive = false; if (a.id === this.net.id) { game.state = game.over ? 'over' : 'dying'; P.rig.visible = false; } }
      if (a.bot && !this.net.isHost) {
        // botps owns movement timing. Periodic match state repeats those poses and must
        // only seed a missing/stalled stream, or the extra timestamps make motion stutter.
        if (a.alive && a.ps && !newLife && (!b.snapB || performance.now() / 1000 - b.snapB.t > .35)) b.push(a.ps, performance.now() / 1000);
        b.hp = a.hp;
      }
      if (a.id === this.net.id) P.shieldT = Math.max(0, (a.protectedUntil - this.now()) / 1000);
    }
    if (s.reason === 'BOMB EXPLODED' && s.bomb?.pos && this.explosionRound !== s.round) {
      this.explosionRound = s.round; const pos = vec(s.bomb.pos); this.ctx.effects.boom(pos, 12); this.ctx.audio.explosion(pos);
    }
    if (s.phase === 'over' && !game.over) this.endMatch({ team: s.winner, name: s.winner == null ? ts('DRAW') : ts(TEAM_NAMES[s.winner]), draw: s.winner == null });
  }
  addMember(id) {
    if (!this.net.isHost || !this.state || this.actor(id)) return;
    const p = this.lobby.players.get(id); if (!p) return;
    const a = { id, team: p.team, bot: !!p.bot, alive: false, hp: 0, life: 0, protectedUntil: 0, respawnAt: 0 };
    this.state.actors.push(a);
    if (this.state.mode === 'tdm' && this.state.phase !== 'over') this.spawn(a);
    else { const base = a.team === this.state.attackTeam ? 0 : 1; a.spawn = this.ctx.level.teamSpawns[base][0].toArray(); }
    this.publish(true);
  }
  removeMember(id) {
    if (!this.net.isHost || !this.state) return;
    this.dropBomb(id); this.state.actors = this.state.actors.filter((a) => a.id !== id); this.intents.delete(id); this.publish(true);
  }
  death(id, killer, life, round) {
    const s = this.state, a = this.actor(id); if (!this.net.isHost || !a?.alive || s.phase !== 'live' || (round != null && round !== s.round) || (life != null && life !== a.life)) return false;
    a.alive = false; a.hp = 0; a.respawnAt = this.now() + MATCH_RULES.respawn; a.protectedUntil = 0;
    const b = this.body(id); if (b) b.alive = false;
    const v = this.scores.get(id); if (v) v.deaths++;
    const k = this.actor(killer); if (k && k.id !== id && k.team !== a.team) { const score = this.scores.get(k.id); if (score) score.kills++; if (s.mode === 'tdm') s.points[k.team]++; }
    this.dropBomb(id); if (s.interaction?.id === id) s.interaction = null;
    this.sendScores(); this.publish(true); return true;
  }
  damageBot(d) {
    const a = this.actor(d.id); if (!this.net.isHost || !a?.bot || !a.alive || this.state.phase !== 'live' || d.round !== this.state.round || d.life !== a.life) return;
    a.hp = Math.max(0, a.hp - d.amount); const b = this.body(a.id); if (b) b.hp = a.hp;
    if (!a.hp && this.death(a.id, d.by, a.life, d.round)) {
      b?.ragdoll(d.from ? b.center.clone().sub(vec(d.from)).normalize() : null, d.amount >= 90);
      this.net.send('botdead', { id: a.id, killer: d.by, round: d.round, life: a.life });
      this.ctx.hud.kill(ts('{} eliminated {}', this.lobby.players.get(d.by)?.name || ts('someone'), this.lobby.players.get(a.id)?.name || 'BOT'), 0);
    }
  }
  intent(id, d) {
    const a = this.actor(id); if (!this.net.isHost || !a || !d || d.round !== this.state?.round || d.life !== a.life) return;
    const now = this.now(), prev = this.intents.get(id);
    if (Number.isSafeInteger(d.serial) && Number.isSafeInteger(prev?.serial) && d.serial <= prev.serial) return;
    const intent = { ...d, releasedAt: Number.isFinite(d.releasedAt) ? Math.min(now, d.releasedAt) : null, seen: now };
    this.intents.set(id, intent);
    const pending = this.state.interaction;
    if (pending?.id !== id) return;
    // Process releases when they arrive, before a later press can overwrite the held state.
    // A release after the deadline still finishes a hold that was valid for its full duration.
    if (!intent.held || intent.moving || intent.attacking || (intent.hold != null && pending.hold != null && intent.hold !== pending.hold)) {
      const action = this.actionFor(id);
      if (!intent.held && !intent.moving && !intent.attacking && intent.releasedAt >= pending.endsAt && action?.kind === pending.kind && this.body(id).body.pos.distanceTo(vec(pending.pos)) <= .55) this.completeInteraction(pending, now);
      if (this.state.interaction === pending) this.state.interaction = null;
      this.publish(true);
    }
  }
  actionFor(id) {
    const s = this.state, a = this.actor(id), b = this.body(id); if (!a?.alive || !b || s.mode !== 'demolition' || s.phase !== 'live') return null;
    const bomb = s.bomb; if (!bomb) return null;
    if (bomb.status === 'carried' && bomb.carrier === id) {
      const site = this.ctx.level.bombSites.find((site) => b.body.pos.distanceTo(site.pos) < site.radius && Math.abs(b.body.pos.y - site.pos.y) < 1);
      if (site && b.body.onGround) return { kind: 'plant', site: site.id, pos: b.body.pos.toArray(), duration: MATCH_RULES.plant };
    }
    if (bomb.status === 'planted' && a.team !== s.attackTeam && b.body.pos.distanceTo(vec(bomb.pos)) <= 2.6 && this.ctx.world.hasLineOfSight(b.eye, vec(bomb.pos).add(new THREE.Vector3(0, 0.3, 0)))) return { kind: 'defuse', site: bomb.site, pos: b.body.pos.toArray(), duration: MATCH_RULES.defuse };
    return null;
  }
  dropBomb(id) {
    const b = this.state?.bomb; if (!b || b.status !== 'carried' || b.carrier !== id) return;
    const a = this.actor(id), raw = this.body(id)?.body.pos || vec(a?.spawn || [0, 0, 0]);
    const p = this.bombDropPoint(raw, a, b.safePos);
    b.status = 'dropped'; b.carrier = null; b.pos = p.toArray(); b.pickupAfter = this.now() + 900; this.state.interaction = null; this.publish(true);
  }
  bombDropPoint(raw, actor, safePos = null) {
    const { world, nav, level } = this.ctx, base = level.teamSpawns[0][0];
    // Drop onto a reachable walking surface; an airborne death must not strand C4 in the sky
    // or on an isolated prop. A fall returns it to the last shore before using the base.
    for (const source of [raw, safePos && vec(safePos), actor?.spawn && vec(actor.spawn), base].filter(Boolean)) {
      const hit = world.raycast(source.clone().add(new THREE.Vector3(0, .4, 0)), new THREE.Vector3(0, -1, 0), 200);
      if (!hit || hit.normal.y < .5) continue;
      const node = nav.nodes[nav.nearestNode(hit.point, 3, 2, true)];
      if (!node || node.iso || Math.abs(node.y - hit.point.y) > 1 || Math.hypot(node.x - hit.point.x, node.z - hit.point.z) > 3) continue;
      const reachable = new THREE.Vector3(node.x, node.y, node.z);
      if (!nav.findPath(base, reachable)?.complete) continue;
      if (nav.walkClear(hit.point, reachable) && world.hasLineOfSight(hit.point.clone().add(new THREE.Vector3(0, .3, 0)), reachable.clone().add(new THREE.Vector3(0, .3, 0)))) return hit.point;
      return reachable;
    }
    return base.clone();
  }
  completeInteraction(interaction, now) {
    const s = this.state, bomb = s.bomb;
    if (s.phase !== 'live' || !bomb || now < interaction.endsAt || (bomb.status === 'planted' && interaction.endsAt >= bomb.explodeAt)) return;
    if (interaction.kind === 'plant' && interaction.endsAt <= s.endsAt) {
      bomb.status = 'planted'; bomb.carrier = null; bomb.pos = [...interaction.pos]; bomb.site = interaction.site; bomb.explodeAt = interaction.endsAt + MATCH_RULES.fuse; s.interaction = null;
    } else if (interaction.kind === 'defuse') this.roundWin(1 - s.attackTeam, 'BOMB DEFUSED');
  }
  roundWin(team, reason) {
    const s = this.state; if (s.phase !== 'live') return;
    s.points[team]++; s.reason = reason; s.phase = s.points[team] >= MATCH_RULES.wins ? 'over' : 'roundover'; s.endsAt = this.now() + MATCH_RULES.roundBreak; s.interaction = null; s.winner = team;
    this.ctx.player.cancelGrenade(); this.ctx.player.cancelKnife(); this.publish(true);
  }
  hostTick() {
    const s = this.state, now = this.now();
    const present = [0, 1].map((team) => s.actors.some((a) => a.team === team));
    if (s.phase !== 'over' && (!present[0] || !present[1])) {
      s.emptySince ||= now;
      if (now - s.emptySince >= 5000) { s.phase = 'over'; s.winner = present[0] ? 0 : present[1] ? 1 : null; this.publish(true); }
      return;
    }
    s.emptySince = 0;
    if (s.phase === 'warmup') { if (now >= s.endsAt) { s.phase = 'live'; s.endsAt = now + (s.mode === 'tdm' ? MATCH_RULES.time : MATCH_RULES.roundTime); for (const a of s.actors) a.protectedUntil = now + (s.mode === 'tdm' ? MATCH_RULES.protect : 0); this.publish(true); } return; }
    if (s.phase === 'roundover') { if (now >= s.endsAt) this.nextRound(); return; }
    if (s.phase !== 'live') return;
    if (s.mode === 'tdm') {
      let respawned = false;
      for (const a of s.actors) if (!a.alive && a.respawnAt && now >= a.respawnAt) { this.spawn(a); respawned = true; }
      if (Math.max(...s.points) >= MATCH_RULES.target || now >= s.endsAt) { s.phase = 'over'; s.winner = s.points[0] === s.points[1] ? null : s.points[0] > s.points[1] ? 0 : 1; this.publish(true); }
      // Apply the new body in the same tick as its life. A throttled snapshot leaves the old
      // corpse alive in the roster, so the next frame's death retry would score it again.
      else if (respawned) this.publish(true);
      return;
    }
    const bomb = s.bomb;
    if (bomb?.status === 'carried') {
      const owner = this.body(bomb.carrier);
      if (owner) { bomb.pos = owner.body.pos.toArray(); if (owner.body.onGround) bomb.safePos = [...bomb.pos]; }
    }
    if (bomb?.status === 'dropped' && now >= (bomb.pickupAfter || 0)) {
      const a = s.actors.find((a) => a.alive && a.team === s.attackTeam && this.body(a.id)?.body.pos.distanceTo(vec(bomb.pos)) < 2 && this.ctx.world.hasLineOfSight(this.body(a.id).eye, vec(bomb.pos).add(new THREE.Vector3(0, .3, 0))));
      if (a) { bomb.status = 'carried'; bomb.carrier = a.id; bomb.safePos = [...bomb.pos]; }
    }
    const valid = (a, pending = null) => {
      const intent = this.intents.get(a.id), action = this.actionFor(a.id);
      // A release after completion keeps its result even if the rendering frame arrives late.
      // Earlier releases, stale connections and moving away always reset progress.
      const completedBeforeRelease = pending && now >= pending.endsAt && intent?.releasedAt >= pending.endsAt;
      return (intent?.held || completedBeforeRelease) && !intent.moving && !intent.attacking && now - intent.seen < 1000 && action ? action : null;
    };
    let interaction = s.interaction;
    if (interaction) {
      const action = valid({ id: interaction.id }, interaction);
      if (!action || action.kind !== interaction.kind || this.body(interaction.id).body.pos.distanceTo(vec(interaction.pos)) > 0.55) s.interaction = interaction = null;
    }
    if (!interaction) for (const a of s.actors) { const action = valid(a); if (action) { s.interaction = interaction = { id: a.id, hold: this.intents.get(a.id)?.hold, ...action, startedAt: now, endsAt: now + action.duration }; break; } }
    // Absolute completion times settle near-simultaneous defuses/explosions identically at every FPS.
    if (interaction) this.completeInteraction(interaction, now);
    if (s.phase !== 'live') return;
    if (bomb?.status === 'planted' && now >= bomb.explodeAt) { this.roundWin(s.attackTeam, 'BOMB EXPLODED'); return; }
    const alive = [0, 1].map((team) => s.actors.filter((a) => a.team === team && a.alive).length);
    if (!alive[1 - s.attackTeam]) { this.roundWin(s.attackTeam, 'DEFENDERS ELIMINATED'); return; }
    if (bomb?.status !== 'planted' && !alive[s.attackTeam]) { this.roundWin(1 - s.attackTeam, 'ATTACKERS ELIMINATED'); return; }
    if (bomb?.status !== 'planted' && now >= s.endsAt) this.roundWin(1 - s.attackTeam, 'TIME EXPIRED');
  }
  update(dt) {
    if (!this.active() || !this.state) { this.restoreSpectator(); this.panel.hidden = true; this.marker.visible = false; return; }
    const s = this.state, inp = this.ctx.input, p = this.ctx.player, mine = this.actor(this.net.id), now = this.now();
    if (s.phase === 'live' && mine?.alive && this.applied.get(this.net.id) === mine.life && !p.alive && now >= (this.deathRetryAt || 0)) {
      this.deathRetryAt = now + 750;
      const death = { killer: p.lastHitBy || null, life: mine.life, round: s.round };
      if (this.net.isHost) this.death(this.net.id, death.killer, death.life, death.round); else this.net.broadcast('pdead', death);
    }
    if (s.phase === 'live' && mine?.alive && !this.ctx.game.menu && (p.firing || p._nadeHeld || inp.down('fire') || inp.down('grenade') || inp.down('melee')) && mine.protectedUntil > now) {
      mine.protectedUntil = 0; p.shieldT = 0; this.net.send('unshield', { round: s.round, life: mine.life });
    }
    if (mine) this.updateObjectiveInput(mine, now);
    if (inp.pressed('bombDrop') && !this.ctx.game.menu) { if (this.net.isHost) this.dropBomb(this.net.id); else this.net.send('bombdrop', { round: s.round }); }
    if (this.net.isHost) { this.bots.update(dt); this.hostTick(); this.publish(); }
    this.spectate(dt); this.renderHUD();
  }
  updateObjectiveInput(mine, now) {
    const inp = this.ctx.input, p = this.ctx.player, enabled = mine.alive && !this.ctx.game.menu && this.state.phase === 'live';
    const flags = { moving: Math.abs(inp.move.x) + Math.abs(inp.move.y) > .1, attacking: !!(inp.down('fire') || inp.down('grenade') || inp.down('melee') || p._nadeHeld) };
    const send = (held, releasedAt = null) => {
      if (held && !this.objectiveHeld) this.objectiveHold++;
      this.objectiveHeld = held;
      const data = { held, releasedAt, hold: this.objectiveHold, serial: ++this.objectiveSerial, ...flags, round: this.state.round, life: mine.life };
      if (this.net.isHost) this.intent(this.net.id, data); else this.net.send('objective', data);
      this.lastObjectiveInput = `${held}|${flags.moving}|${flags.attacking}`; this.intentAt = now + 150;
    };
    const stamp = performance.now();
    for (const event of inp.holdEventsAfter(this.objectiveSeq, stamp)) {
      this.objectiveSeq = event.seq;
      if (event.action !== 'interact') continue;
      send(!!(enabled && event.down), !event.down ? now - Math.max(0, stamp - event.time) : null);
    }
    const held = !!(enabled && inp.down('interact')), state = `${held}|${flags.moving}|${flags.attacking}`;
    if (state !== this.lastObjectiveInput || now >= this.intentAt) {
      const timing = inp.holdTiming('interact');
      send(held, !held && timing?.end != null ? now - Math.max(0, stamp - timing.end) : null);
    }
  }
  renderHUD() {
    const s = this.state, now = this.now(), mine = this.actor(this.net.id), bomb = s.bomb, action = this.actionFor(this.net.id), interaction = s.interaction;
    const role = s.mode === 'demolition' ? ts('ROUND {}', s.round) + ' · ' + ts(mine?.team === s.attackTeam ? 'ATTACK' : 'DEFEND') : ts(TEAM_NAMES[mine?.team || 0]);
    let hint = s.mode === 'tdm' ? ts('First to 50 - 8 minutes') : ts('Hold B to plant / defuse - N drops C4');
    if (s.mode === 'demolition') {
      if (bomb?.status === 'planted') hint = ts('BOMB PLANTED AT {}', bomb.site);
      else if (bomb?.carrier === this.net.id) hint = ts('You carry C4 - reach A or B');
      else if (bomb?.status === 'carried' && mine?.team === s.attackTeam) hint = ts('{} carries C4', this.lobby.players.get(bomb.carrier)?.name || '');
      else if (bomb?.status === 'dropped' && mine?.team === s.attackTeam) hint = ts('C4 dropped - walk over it to recover');
      if (action) hint = ts(action.kind === 'plant' ? 'Hold {} to plant (5s)' : 'Hold {} to defuse (7s)', this.ctx.input.usingTouch ? ts(action.kind === 'plant' ? 'PLANT C4' : 'DEFUSE C4') : this.ctx.hud.key('interact'));
    }
    if (!mine?.alive) hint = s.mode === 'demolition' ? ts('Waiting for next round - click to spectate teammate') : ts('Respawning in {}', Math.max(0, Math.ceil(((mine?.respawnAt || now) - now) / 1000)));
    if (s.phase === 'warmup') hint = ts('GET READY - {}', Math.max(0, Math.ceil((s.endsAt - now) / 1000)));
    if (s.phase === 'roundover') hint = ts(TEAM_NAMES[s.winner]) + ' - ' + ts(s.reason);
    const progress = interaction?.id === this.net.id ? Math.min(1, Math.max(0, (now - interaction.startedAt) / interaction.duration)) : 0;
    this.ctx.hud.root.classList.add('team-game'); this.ctx.hud.root.classList.toggle('team-dead', !mine?.alive); this.panel.hidden = this.ctx.game.menu || s.phase === 'over';
    const safeHint = hint.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const html = `<div class="team-totals"><span class="blue">${ts('BLUE TEAM')} <b>${s.points[0]}</b></span><small>${role}</small><span class="orange"><b>${s.points[1]}</b> ${ts('ORANGE TEAM')}</span></div><div class="objective-hint">${safeHint}</div>${progress ? `<div class="objective-progress"><i style="width:${progress * 100}%"></i></div>` : ''}`;
    if (html !== this._html) { this.panel.innerHTML = html; this._html = html; }
    this.ctx.hud.setTimer(clock((bomb?.status === 'planted' && s.phase === 'live' ? bomb.explodeAt : s.endsAt) - now));
    this.ctx.hud.setPvpScore(null);
    this.marker.visible = s.mode === 'demolition' && (bomb?.status === 'dropped' || bomb?.status === 'planted') && s.phase === 'live';
    if (this.marker.visible) { this.marker.position.fromArray(bomb.pos); this.marker.position.y += .15; this.marker.rotation.y = now / 1200; }
    this.ctx.touch?.setObjective?.(!!action && !!mine?.alive && s.phase === 'live', action?.kind, bomb?.carrier === this.net.id && mine?.alive);
  }
  spectate(dt) {
    if (this.state.mode !== 'demolition' || this.actor(this.net.id)?.alive || this.ctx.game.menu || this.state.phase === 'over') { this.restoreSpectator(); return; }
    const mates = this.state.actors.filter((a) => a.id !== this.net.id && a.alive && a.team === this.team(this.net.id) && this.body(a.id));
    const oldIndex = mates.findIndex((a) => a.id === this.spectatedId);
    this.spectator = oldIndex < 0 ? 0 : oldIndex;
    if (this.ctx.input.pressed('fire') && mates.length) this.spectator = (this.spectator + 1) % mates.length;
    const actor = mates[this.spectator], b = actor && this.body(actor.id);
    if (this.spectatedId !== actor?.id || this.hiddenSpectator?.root !== b?.root) this.restoreSpectator();
    this.ctx.hud.root.classList.add('spectating'); this.spectatorPanel.hidden = false;
    for (const el of this.ctx.touch?.btnEls.fire || []) el.dataset.spectateLabel = ts('NEXT TEAMMATE');
    this.ctx.player.rig.visible = false;
    if (!b) { this.spectatorPanel.textContent = ts('No surviving teammates - waiting for next round'); return; }
    this.spectatedId = actor.id;
    if (!this.hiddenSpectator) this.hiddenSpectator = { body: b, root: b.root, visible: b.root?.visible, tagVisibility: b.nameTag?.style.visibility || '' };
    b.viewHidden = true;
    if (b.root) b.root.visible = false;
    if (b.nameTag) b.nameTag.style.visibility = 'hidden';
    const pose = this.spectatorPose, view = this.spectatorView;
    if (!b.sampleView(performance.now() / 1000, pose)) { pose.eye.copy(b.eye); pose.yaw = b.yaw; pose.pitch = b.pitch; pose.epoch = b.viewEpoch; }
    view.target.setFromEuler(view.euler.set(pose.pitch, pose.yaw, 0, 'YXZ'));
    if (view.epoch !== pose.epoch) { view.position.copy(pose.eye); view.rotation.copy(view.target); view.epoch = pose.epoch; }
    else {
      const blend = 1 - Math.exp(-Math.max(0, dt) * 24);
      view.position.lerp(pose.eye, blend); view.rotation.slerp(view.target, blend);
    }
    // The dead local player's update still writes the shared camera each frame. Ease from
    // our own previous pose, never from that corpse camera, including on low-FPS clients.
    this.ctx.camera.position.copy(view.position); this.ctx.camera.quaternion.copy(view.rotation); this.ctx.camera.updateMatrixWorld();
    const hp = Math.max(0, Math.ceil(b.hp ?? actor.hp ?? 0));
    this.spectatorPanel.textContent = ts('SPECTATING {} - {} HP', this.lobby.players.get(actor.id)?.name || b.name, hp) + ' · ' + ts(this.ctx.input.usingTouch ? 'Tap NEXT to switch teammates' : this.ctx.input.usingGamepad ? 'R2 switches teammates' : 'Left click switches teammates');
  }
  restoreSpectator() {
    const hidden = this.hiddenSpectator;
    if (hidden) {
      hidden.body.viewHidden = false;
      if (hidden.body.root) hidden.body.root.visible = !hidden.body.away && (!!hidden.visible || !!hidden.body.snapB);
      if (hidden.body.nameTag) hidden.body.nameTag.style.visibility = hidden.tagVisibility;
    }
    this.hiddenSpectator = null; this.spectatedId = null;
    this.spectatorView.epoch = null;
    this.spectatorPanel.hidden = true; this.ctx.hud.root.classList.remove('spectating');
  }
}
