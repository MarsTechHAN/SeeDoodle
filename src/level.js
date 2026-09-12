// Level construction. Every map shares one builder: everything is merged ink geometry plus
// axis-aligned box colliders, which is what the navigation grid is generated from. See `LEVELS`
// below for what is actually offered - a map can be marked `pvpOnly`, and one is gated off
// entirely behind MEXICO_READY while it is unfinished.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeInkMaterial, INK } from './render.js';
import { rand, choose, TAU } from './util.js';
import { buildHumanoid } from './enemies.js';

// Doodle Mexico is built and kept, but off the menu until it is ready; flip this to offer it again
export const MEXICO_READY = false;
export const LEVELS = [
  { key: 'district', name: 'DOODLE DISTRICT', blurb: 'streets, rooftops and fire escapes' },
  { key: 'undercity', name: 'THE UNDERCITY', blurb: 'flooded tunnels, shuttered shops and metro echoes', pvpOnly: true },
  { key: 'depot', name: 'SUNLINE DEPOT', blurb: 'opposite bases, twin courtyards and covered routes', pvpOnly: true, teamOnly: true },
  { key: 'zijingang', name: 'ZIJINGANG EAST', blurb: 'East 1, East 2 and the Qizhen lakeside', team: true },
  { key: 'timesquare', name: 'TIMES SQUARE', blurb: 'Broadway lights, red steps and the city crossroads', team: true },
  { key: 'summerpalace', name: 'SUMMER PALACE', blurb: 'Longevity Hill, painted corridors and Kunming Lake', team: true, reference: 'https://whc.unesco.org/en/list/880/', referenceName: 'Summer Palace', note: 'Longevity Hill and lakeshore - routes adapted for play' },
  { key: 'yuanmingyuan', name: 'OLD SUMMER PALACE', blurb: 'Great Fountain ruins, carved stone and garden paths', team: true, reference: 'https://en.wikipedia.org/wiki/Old_Summer_Palace', referenceName: 'Old Summer Palace', note: 'Western Mansions ruins - garden routes adapted for play' },
  { key: 'greatwall', name: 'THE GREAT WALL', blurb: 'Mutianyu watchtowers, ridge stairs and mountain trails', team: true, reference: 'https://whc.unesco.org/en/list/438/', referenceName: 'The Great Wall', note: 'Mutianyu-inspired ridge - linked wall and mountain routes' },
  { key: 'lombard', name: 'LOMBARD STREET', blurb: 'eight hairpin turns, hillside gardens and bay views', team: true, reference: 'https://en.wikipedia.org/wiki/Lombard_Street_(San_Francisco)', referenceName: 'Lombard Street', note: 'Hyde to Leavenworth - eight bends and a 34 m descent' },
  ...(MEXICO_READY ? [{ key: 'mexico', name: 'DOODLE MEXICO', blurb: 'a sun-baked plaza · piñatas, tacos and mariachi' }] : []),
];

function createBuilder(scene, world) {
  const geos = {}; const L = { rings: [], spawns: [], snipers: [], pickups: [], animated: [], meshes: [], playerStart: new THREE.Vector3(0, 0, 42), bounds: { minX: -55, maxX: 55, minZ: -55, maxZ: 55 }, arenaSpawns: [], grappleMovers: [], breakables: [], key: 'district' };
  // Keep semantic surfaces separate when merging; the classic shader still uses only the ink.
  const addGeo = (g, ink, surface = 'ink', classicOnly = false) => {
    const key = `${ink}:${surface}:${classicOnly}`;
    (geos[key] || (geos[key] = { ink, surface, classicOnly, items: [] })).items.push(g);
  };
  const collider = (x, y, z, w, h, d, o = {}) => world.addBox({ x: x - w / 2, y, z: z - d / 2 }, { x: x + w / 2, y: y + h, z: z + d / 2 }, { noNav: !!o.noNav, noShoot: !!o.noShoot, noGrapple: !!o.noGrapple, tag: o.tag });
  function box(x, y, z, w, h, d, o = {}) {
    const surface = o.surface || (o.ink === INK.BLACK || (Math.min(w, d) < 0.3 && h > 1) ? 'metal' : h <= 1 && w > 3 && d > 3 ? 'ground' : 'plaster');
    const pad = o.visualPad || 0;
    const g = new THREE.BoxGeometry(w + pad * 2, h + pad * 2, d + pad * 2); g.translate(x, y + h / 2, z); addGeo(g, o.ink ?? INK.BLUE, surface, !!o.classicOnly);
    if (!o.noCollide) collider(x, y, z, w, h, d, o);
  }
  const slab = (x1, z1, x2, z2, y, t, o = {}) => {
    const x = (x1 + x2) / 2, z = (z1 + z2) / 2, w = x2 - x1, d = z2 - z1;
    // Floors cap adjoining walls. A tiny visual overhang prevents coincident top/bottom and
    // edge faces from alternating materials, while the walkable height remains exactly y.
    box(x, y - t, z, w, t, d, { surface: 'stone', visualPad: 0.004, ...o });
  };
  // Wall pieces along an axis with rectangular gaps [a1, a2, yBottom = 0, yTop = h]; gaps may overlap.
  function wallPieces(a1, a2, h, gaps) {
    const xs = new Set([a1, a2]);
    for (const g of gaps) { xs.add(Math.min(Math.max(g[0], a1), a2)); xs.add(Math.min(Math.max(g[1], a1), a2)); }
    const sorted = [...xs].sort((a, b) => a - b); const runs = new Map(); const out = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const s1 = sorted[i], s2 = sorted[i + 1]; if (s2 - s1 < 0.005) continue; const mid = (s1 + s2) / 2;
      const cuts = gaps.filter((g) => g[0] <= mid && g[1] >= mid).map((g) => [g[2] ?? 0, g[3] ?? h]).sort((a, b) => a[0] - b[0]);
      const pieces = []; let y = 0;
      for (const [gb, gt] of cuts) { if (gb > y + 0.005) pieces.push([y, gb]); y = Math.max(y, gt); }
      if (y < h - 0.005) pieces.push([y, h]);
      const keys = new Set();
      for (const [yb, yt] of pieces) { const k = yb.toFixed(3) + ',' + yt.toFixed(3); keys.add(k); const r = runs.get(k); if (r && Math.abs(r[1] - s1) < 0.005) r[1] = s2; else runs.set(k, [s1, s2, yb, yt]); }
      for (const [k, r] of [...runs]) if (!keys.has(k)) { out.push(r); runs.delete(k); }
    }
    for (const r of runs.values()) out.push(r);
    return out;
  }
  function wallX(x1, x2, z, y, h, t, gaps = [], o = {}) {
    for (const [a, b, yb, yt] of wallPieces(x1, x2, h, gaps)) box((a + b) / 2, y + yb, z, b - a, yt - yb, t, o);
  }
  function wallZ(z1, z2, x, y, h, t, gaps = [], o = {}) {
    for (const [a, b, yb, yt] of wallPieces(z1, z2, h, gaps)) box(x, y + yb, (a + b) / 2, t, yt - yb, b - a, o);
  }
  function stairs(x, y, z, dir, steps, width, o = {}) {
    const rise = o.rise ?? 4 / 14, run = o.run ?? 0.45;
    const dx = dir === '+x' ? 1 : dir === '-x' ? -1 : 0, dz = dir === '+z' ? 1 : dir === '-z' ? -1 : 0;
    for (let i = 0; i < steps; i++) {
      const c = (i + 0.5) * run, h = (i + 1) * rise; const cx = x + dx * c, cz = z + dz * c;
      box(cx, y, cz, dx ? run + 0.004 : width, h, dz ? run + 0.004 : width, { surface: 'stone', ...o });
    }
    return { x: x + dx * steps * run, z: z + dz * steps * run, y: y + steps * rise };
  }
  // railing along an axis-aligned segment: visual posts + bar, one collider
  function rail(x1, z1, x2, z2, y, o = {}) {
    const len = Math.hypot(x2 - x1, z2 - z1); const ax = Math.abs(x2 - x1) > Math.abs(z2 - z1);
    const cx = (x1 + x2) / 2, cz = (z1 + z2) / 2;
    box(cx, y + 0.9, cz, ax ? len : 0.12, 0.12, ax ? 0.12 : len, { noCollide: true, ink: o.ink, surface: 'metal' });
    const n = Math.max(1, Math.round(len / 2));
    for (let i = 0; i <= n; i++) { const t = i / n; box(x1 + (x2 - x1) * t, y, z1 + (z2 - z1) * t, 0.1, 0.9, 0.1, { noCollide: true, ink: o.ink, surface: 'metal' }); }
    collider(cx, y, cz, ax ? len : 0.12, 1.0, ax ? 0.12 : len, { noNav: true, noShoot: true });
  }
  function cyl(x, y, z, r, h, o = {}) {
    const g = new THREE.CylinderGeometry(r, r, h, o.seg ?? 12); g.translate(x, y + h / 2, z); addGeo(g, o.ink ?? INK.BLUE, o.surface || 'metal');
    if (!o.noCollide) collider(x, y, z, r * 1.6, h, r * 1.6, o);
  }
  function sphere(x, y, z, r, o = {}) { const g = new THREE.SphereGeometry(r, o.seg ?? 10, o.seg ?? 8); g.translate(x, y, z); addGeo(g, o.ink ?? INK.BLUE, o.surface || (o.ink === INK.GREEN ? 'foliage' : 'ink'), !!o.classicOnly); }
  function ring(x, y, z, axis = 'z') {
    const g = new THREE.TorusGeometry(0.6, 0.1, 8, 20);
    if (axis === 'x') g.rotateY(Math.PI / 2); else if (axis === 'y') g.rotateX(Math.PI / 2);
    g.translate(x, y, z); addGeo(g, INK.ORANGE);
    L.rings.push(new THREE.Vector3(x, y, z));
  }
  const spawn = (x, y, z) => L.spawns.push(new THREE.Vector3(x, y, z));
  const sniper = (x, y, z) => L.snipers.push(new THREE.Vector3(x, y, z));
  const pickup = (x, y, z) => L.pickups.push(new THREE.Vector3(x, y, z));
  // ---------------- shared finish ----------------
  function finish() {
    for (const { ink, surface, classicOnly, items } of Object.values(geos)) {
      const merged = mergeGeometries(items, false);
      const mesh = new THREE.Mesh(merged, makeInkMaterial({ ink, surface }));
      if (classicOnly) mesh.userData.skin = 'classic';
      mesh.matrixAutoUpdate = false; scene.add(mesh); L.meshes.push(mesh);
    }
    world.finalize();
    return L;
  }
  // a paper plane that loops overhead, purely decorative
  function planes(n, baseR, baseH, o = {}) {
    const sc = o.scale || 1;
    for (let i = 0; i < n; i++) {
      const g = new THREE.ConeGeometry(1.2 * sc, 4 * sc, 3); g.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(g, makeInkMaterial({ ink: o.ink ?? INK.BLUE })); scene.add(m); L.meshes.push(m);
      L.grappleMovers.push({ mesh: m, radius: 2.2 * sc });
      const r = baseR + i * (o.rStep ?? 12), h = baseH + i * (o.hStep ?? 6), ph = i * 2.1, sp = (o.speed ?? 0.11) + i * 0.01;
      L.animated.push({ mesh: m, update: (t) => { const a = t * sp + ph; m.position.set(Math.cos(a) * r, h + Math.sin(a * 2.3) * 3, Math.sin(a) * r * 0.7); m.lookAt(Math.cos(a + 0.05) * r, h + Math.sin((a + 0.05) * 2.3) * 3, Math.sin(a + 0.05) * r * 0.7); m.rotateZ(Math.sin(a * 3) * 0.6); } });
    }
  }
  return { L, addGeo, collider, box, slab, wallX, wallZ, stairs, rail, cyl, sphere, ring, spawn, sniper, pickup, finish, planes, scene, world };
}

// ============================ map 1: Doodle District ============================
function buildDistrict(B, arena = false, team = false) {
  arena = arena || team;
  const { L, box, slab, wallX, wallZ, stairs, rail, cyl, sphere, ring, spawn, sniper, pickup, planes, addGeo, collider } = B;
  // ---------------- ground + perimeter ----------------
  // solo keeps the tight old block; a match gets a far wider arena, a dome and a hanging playground
  const P = arena ? 68 : 55, T = 6, PH = arena ? 30 : 18, E = P - 3.8, D = P - 3;
  L.bounds.minX = -P; L.bounds.maxX = P; L.bounds.minZ = -P; L.bounds.maxZ = P;
  box(0, -1, 0, 2 * P + T, 1, 2 * P + T);
  box(0, 0, -P, 2 * P + T, PH, T); box(0, 0, P, 2 * P + T, PH, T); box(-P, 0, 0, T, PH, 2 * P + T); box(P, 0, 0, T, PH, 2 * P + T);
  if (!arena) {
    // solo: the walls carry on upward unseen and unhookable, so their tops are not a place to camp, and a lid closes the sky
    const NG = { noNav: true, noGrapple: true };
    collider(0, PH, -P, 2 * P + T, 40, T, NG); collider(0, PH, P, 2 * P + T, 40, T, NG); collider(-P, PH, 0, T, 40, 2 * P + T, NG); collider(P, PH, 0, T, 40, 2 * P + T, NG);
    collider(0, 56, 0, 2 * P + 40, 8, 2 * P + 40, NG);
    const R = 96, C = -22;
    for (let k = 0; k < 6; k++) { const g = new THREE.TorusGeometry(R, 0.5, 5, 80, Math.PI); g.rotateY(k * Math.PI / 6); g.translate(0, C, 0); addGeo(g, INK.BLUE, 'ink', true); }
    for (const h of [30, 46, 60, 70]) { const r = Math.sqrt(R * R - (h - C) * (h - C)); const g = new THREE.TorusGeometry(r, 0.4, 5, 96); g.rotateX(Math.PI / 2); g.translate(0, h, 0); addGeo(g, INK.BLUE, 'ink', true); }
  }
  // ledges / balconies on the perimeter (grapple + stand)
  const ledges = [[-30, -E, 8, 1.6], [30, -E, 8, 1.6], [-E, 40, 1.6, 8], [E, -10, 1.6, 8], [-E, -30, 1.6, 6], [E, 35, 1.6, 6], [10, E, 8, 1.6], [-40, E, 6, 1.6]];
  for (const [x, z, w, d] of ledges) {
    box(x, 9, z, w, 0.4, d); box(x, 5.5, z, w, 0.4, d);
    if (arena) { box(x, 16, z, w, 0.4, d); ring(x, 20, z, 'y'); }
  }
  // spawn doorways in the perimeter (visual frames)
  const doorFrame = (x, z, alongX) => { if (alongX) { box(x - 1.2, 0, z, 0.3, 3.2, 0.5, { noCollide: true, ink: INK.BLACK }); box(x + 1.2, 0, z, 0.3, 3.2, 0.5, { noCollide: true, ink: INK.BLACK }); box(x, 3.0, z, 2.7, 0.3, 0.5, { noCollide: true, ink: INK.BLACK }); } else { box(x, 0, z - 1.2, 0.5, 3.2, 0.3, { noCollide: true, ink: INK.BLACK }); box(x, 0, z + 1.2, 0.5, 3.2, 0.3, { noCollide: true, ink: INK.BLACK }); box(x, 3.0, z, 0.5, 0.3, 2.7, { noCollide: true, ink: INK.BLACK }); } };
  for (const [x, z] of [[-D, 0], [D, 0], [-D, 30], [D, -30], [-D, -30], [D, 30]]) { doorFrame(x, z, false); spawn(x + (x < 0 ? 1.2 : -1.2), 0, z); }
  for (const [x, z] of [[0, -D], [0, D], [-30, D], [30, D]]) { doorFrame(x, z, true); spawn(x, 0, z + (z < 0 ? 1.2 : -1.2)); }
  if (arena) {
    // where a match drops people in: rooftops, the highway, the field edges and the outer ring
    for (const [x, y, z] of [[-34, 12.2, 12], [34, 12.2, 12], [-30, 7.2, -45], [16, 7.2, -45], [0, 7.4, -30], [-44, 0, -10], [44, 0, -10], [-40, 0, 40], [40, 0, 40], [0, 0, 55], [-58, 0, 0], [58, 0, 0], [0, 0, -58], [-54, 0, 54], [54, 0, -54]]) L.arenaSpawns.push(new THREE.Vector3(x, y, z));
    // a few low things on the field, nothing to hide a whole person
    box(-8, 0, 20, 3, 1, 1.2); box(10, 0, 26, 1.4, 1.2, 1.4); box(-12, 0, -8, 2.4, 0.8, 2.4); box(14, 0, -4, 2.4, 0.8, 2.4);
    for (const [x, z] of [[-56, 30], [56, -30], [30, -56], [-30, 56]]) { box(x, 0, z, 0.3, 7, 0.3, { noNav: true }); box(x, 7, z, 1.4, 0.3, 0.3, { noCollide: true }); addGeo(new THREE.SphereGeometry(0.45, 8, 6).translate(x + 0.7, 6.8, z), INK.ORANGE); }
    // the dome: ribs to look at, plus an invisible shell of bands that stops you and shrugs off the hook
    const R = 120, C = -30; const domeY = (x, z) => Math.sqrt(Math.max(1, R * R - x * x - z * z)) + C;
    for (let k = 0; k < 8; k++) { const g = new THREE.TorusGeometry(R, 0.6, 5, 96, Math.PI); g.rotateY(k * Math.PI / 8); g.translate(0, C, 0); addGeo(g, INK.BLUE, 'ink', true); }
    for (const h of [38, 54, 68, 80, 88]) { const r = Math.sqrt(R * R - (h - C) * (h - C)); const g = new THREE.TorusGeometry(r, 0.5, 5, 128); g.rotateX(Math.PI / 2); g.translate(0, h, 0); addGeo(g, INK.BLUE, 'ink', true); }
    addGeo(new THREE.SphereGeometry(2.4, 10, 8).translate(0, R + C, 0), INK.RED, 'ink', true);
    const NG = { noNav: true, noGrapple: true };
    collider(0, 88, 0, 300, 10, 300, NG);
    for (let y0 = PH; y0 < 88; y0 += 4) { const inner = Math.sqrt(Math.max(0, R * R - (y0 + 4 - C) ** 2)); if (inner > P + T) continue; const o = inner + 80; collider(0, y0, -o, 320, 4, 160, NG); collider(0, y0, o, 320, 4, 160, NG); collider(-o, y0, 0, 160, 4, 320, NG); collider(o, y0, 0, 160, 4, 320, NG); }
    // a few pads hung from the dome, spread over the map so a swing has somewhere to land
    const cable = (x, y, z) => box(x, y, z, 0.12, Math.max(1, domeY(x, z) - y), 0.12, { noCollide: true, ink: INK.BLACK });
    const pad = (x, y, z, w, d) => { box(x, y, z, w, 0.5, d, { noNav: true }); cable(x, y + 0.5, z); ring(x, y - 1.3, z, 'y'); };
    for (const [x, y, z, w, d] of [[0, 24, 0, 8, 8], [-42, 18, -24, 6, 6], [44, 21, 30, 6, 6], [28, 27, -46, 5, 5], [-30, 30, 44, 5, 5]]) pad(x, y, z, w, d);
    // paper planes big enough to hook: they loop around the map at different heights
    planes(4, 30, 26, { scale: 1.7, rStep: 9, hStep: 6, speed: 0.11, ink: INK.BLUE });
  }

  // ---------------- central tower (solo only: a match wants the field open) ----------------
  if (!arena) {
    const W = 14, H = 4, hw = W / 2;
    for (let f = 1; f <= 4; f++) slab(-hw, -hw, hw, hw, f * H, 0.4);
    for (const [px, pz] of [[-6.6, -6.6], [6.6, -6.6], [-6.6, 6.6], [6.6, 6.6], [0, -6.6], [0, 6.6], [-6.6, 0], [6.6, 0]]) box(px, 0, pz, 0.8, 16, 0.8);
    for (let f = 1; f <= 3; f++) {
      const y = f * H;
      rail(-hw, hw, -1.5, hw, y); rail(1.5, hw, hw, hw, y); // south edge with a gap
      rail(-hw, -hw, hw, -hw, y); // west
      rail(hw, -hw, hw, hw, y); // east
      rail(-hw, -hw, -6.5, -hw, y); rail(3.5, -hw, hw, -hw, y); // north edge with landing gaps
    }
    // roof parapet with gaps, crane
    rail(-5, -hw, hw, -hw, 16); rail(-hw, hw, -1.5, hw, 16); rail(1.5, hw, hw, hw, 16); rail(-hw, -hw, -hw, hw, 16); rail(hw, -hw, hw, 3, 16);
    box(5.5, 16, 5.5, 1, 10, 1); box(5.5, 25.2, 5.5, 1.6, 1.4, 1.6, { noCollide: true });
    box(11.5, 25, 5.5, 16, 0.8, 0.8); box(1, 25, 5.5, 5, 0.8, 0.8); box(-0.5, 23.6, 5.5, 2, 1.6, 1.6);
    box(19, 20.5, 5.5, 0.08, 4.6, 0.08, { noCollide: true, ink: INK.BLACK });
    ring(19, 19.8, 5.5, 'x'); ring(19.5, 24.6, 5.5, 'z');   // only the crane keeps its rings
    // exterior switchback stairs on the north face (x runs -5..1.3, landings each side)
    // two-lane switchback: flights alternate between lanes so no flight sits directly under the next one
    let y = 0;
    for (let f = 0; f < 4; f++) {
      const dir = f % 2 === 0 ? '+x' : '-x'; const sx = dir === '+x' ? -5 : 1.3; const lane = f % 2 === 0 ? -8.3 : -10.3;
      stairs(sx, y, lane, dir, 14, 1.8); y += 4;
      const lx = dir === '+x' ? 2.4 : -6.1; slab(lx - 1.1, -11.4, lx + 1.1, -7, y, 0.4);
      rail(lx - 1.1, -11.4, lx + 1.1, -11.4, y);
    }
    spawn(0, 8, 0); spawn(0, 4, 3); sniper(0, 16, -3); pickup(0, 12, 0); pickup(-4, 8, 4); pickup(0, 16, 0);
  }

  // ---------------- building A (west): 3 floors, fire escape, ruler bridge to the tower ----------------
  {
    const x1 = -43, x2 = -25, z1 = 4, z2 = 20, H = 4;
    for (let f = 1; f <= 3; f++) slab(x1, z1, x2, z2, f * H, 0.4);
    // exterior walls with doors/windows
    wallZ(z1, z2, x2, 0, 12, 0.4, [[10, 13, 0, 3.2], [6, 9, 5, 7], [14, 17, 5, 7], [6, 9, 9, 11], [14, 17, 9, 11]]); // east face
    wallZ(z1, z2, x1, 0, 12, 0.4, [[8, 11, 0, 3.2], [8, 11, 4.5, 7.5], [8, 11, 8.5, 11.5]]); // west face
    wallX(x1, x2, z1, 0, 12, 0.4, [[-36, -33, 0, 3.2], [-40, -37, 5, 7], [-31, -28, 5, 7], [-36, -32, 8.5, 11.5]]); // north face
    wallX(x1, x2, z2, 0, 12, 0.4, [[-36, -32, 0, 3.2], [-31, -27, 0, 3.2], [-42, -39, 0, 3.2], [-37.2, -33.5, 4.05, 7.2], [-36, -32, 8.4, 11.4], [-41, -27, 4.6, 7.6], [-29, -25.5, 8.05, 11.2]]); // south face
    // interior partitions
    wallX(x1, x2, 12, 0, 4, 0.3, [[-40, -37.5], [-30, -27.5]]);
    wallX(x1, x2, 12, 4, 4, 0.3, [[-36, -32]]);
    wallZ(z1, z2, -34, 8, 4, 0.3, [[8, 11], [14, 17]]);
    // roof parapet with gaps
    rail(x1, z1, -37, z1, 12); rail(-31, z1, x2, z1, 12); rail(x1, z2, -37.4, z2, 12); rail(-34.4, z2, x2, z2, 12); rail(x1, z1, x1, z2, 12); rail(x2, z1, x2, 9, 12); rail(x2, 15, x2, z2, 12);
    // fire escape: switchback on the south face (z 21..23)
    let y = 0;
    for (let f = 0; f < 3; f++) {
      const dir = f % 2 === 0 ? '-x' : '+x'; const sx = dir === '-x' ? -28.5 : -34.8; const lane = f % 2 === 0 ? 21.2 : 23.2;
      stairs(sx, y, lane, dir, 14, 1.8); y += 4;
      const lx = dir === '-x' ? -35.9 : -27.4; slab(lx - 1.1, 20.2, lx + 1.1, 24.4, y, 0.4);
      rail(lx - 1.1, 24.4, lx + 1.1, 24.4, y);
    }
    // ruler bridge from the A roof: to the tower's third floor in solo, right across to building B in a match (y=12)
    { const bx2 = arena ? 24.2 : -7; const len = bx2 + 25.2;
      box((bx2 - 25.2) / 2, 11.6, 6, len, 0.4, 2.4, { ink: INK.ORANGE, visualPad: 0.008 });
      for (let i = 0; i <= Math.floor(len); i++) box(-25 + i, 12, 5, 0.06, 0.02, i % 5 === 0 ? 0.6 : 0.35, { noCollide: true, ink: INK.BLACK });
      rail(-25, 7.2, bx2, 7.2, 12, { ink: INK.ORANGE }); if (arena) rail(-25, 4.8, bx2, 4.8, 12, { ink: INK.ORANGE }); }
    
    spawn(-34, 12, 12); spawn(-40, 0, 18); sniper(-27, 12, 6); pickup(-34, 4, 12); pickup(-30, 12, 16); pickup(-40, 8, 8);
  }

  // ---------------- building B (east): warehouse with catwalk + skylight ----------------
  {
    const x1 = 24, x2 = 44, z1 = 4, z2 = 20;
    // roof with a 6x6 skylight hole in the middle
    slab(x1, z1, x2, 9, 12, 0.4); slab(x1, 15, x2, z2, 12, 0.4); slab(x1, 9, 31, 15, 12, 0.4); slab(37, 9, x2, 15, 12, 0.4);
    wallZ(z1, z2, x1, 0, 12, 0.4, [[10, 14, 0, 3.6], [6, 9, 7, 10], [15, 18, 7, 10]]); // west face
    wallZ(z1, z2, x2, 0, 12, 0.4, [[7, 10, 0, 3.2], [14, 17, 0, 3.2], [8, 16, 7, 10]]); // east face
    wallX(x1, x2, z1, 0, 12, 0.4, [[32, 36, 0, 3.6], [27, 30, 7, 10], [38, 41, 7, 10]]); // north face
    wallX(x1, x2, z2, 0, 12, 0.4, [[26, 29, 0, 3.2], [39, 42, 0, 3.2], [33.5, 36.5, 4.05, 7.2], [25.5, 28.5, 8.05, 11.2], [32, 36, 8, 11]]); // south face
    // catwalk at y=6 around the inside walls (1.6 wide), interior stairs along the west wall
    slab(x1 + 0.4, z1 + 0.4, x1 + 2, z2 - 0.4, 6, 0.3); slab(x2 - 2, z1 + 0.4, x2 - 0.4, z2 - 0.4, 6, 0.3);
    slab(x1 + 2, z1 + 0.4, x2 - 2, z1 + 2, 6, 0.3); slab(x1 + 2, z2 - 2, x2 - 2, z2 - 0.4, 6, 0.3);
    rail(x1 + 2, z1 + 2, x1 + 2, 9, 6); rail(x1 + 2, 15, x1 + 2, 17, 6); rail(x2 - 2, z1 + 2, x2 - 2, z2 - 2, 6);
    rail(x1 + 2, z1 + 2, 31, z1 + 2, 6); rail(37, z1 + 2, x2 - 2, z1 + 2, 6); rail(x1 + 2, z2 - 2, x2 - 2, z2 - 2, 6);
    stairs(26.2, 0, 8.6, '+z', 21, 1.6, { rise: 6 / 21, run: 0.45 }); // arrives at z=18.05, y=6 onto the catwalk
    // crates inside
    box(34, 0, 12, 2.4, 2.4, 2.4); box(36.4, 0, 12, 2.4, 1.2, 2.4); box(30, 0, 16, 1.6, 1.6, 1.6, { ink: INK.GREEN });
    // exterior switchback on the south face to the roof (z 21..23)
    let y = 0;
    for (let f = 0; f < 3; f++) {
      const dir = f % 2 === 0 ? '+x' : '-x'; const sx = dir === '+x' ? 27.5 : 33.8; const lane = f % 2 === 0 ? 21.2 : 23.2;
      stairs(sx, y, lane, dir, 14, 1.8); y += 4;
      const lx = dir === '+x' ? 34.9 : 26.4; slab(lx - 1.1, 20.2, lx + 1.1, 24.4, y, 0.4);
      rail(lx - 1.1, 24.4, lx + 1.1, 24.4, y);
    }
    rail(x1, z1, 31, z1, 12); rail(37, z1, x2, z1, 12); rail(x1, z2, 33.4, z2, 12); rail(36.4, z2, x2, z2, 12); rail(x2, z1, x2, z2, 12); rail(x1, z1, x1, 9, 12); rail(x1, 15, x1, z2, 12);
    // plank bridge tower floor 3 -> B roof
    // The arena's ruler already spans both buildings; a second plank had coplanar top/bottom faces.
    if (!arena) { box(15.5, 11.6, 6, 17.4, 0.4, 2.2); rail(7, 4.9, 24, 4.9, 12); }
    
    spawn(34, 12, 18); spawn(40, 0, 8); sniper(26, 12, 18); pickup(34, 0, 12); pickup(34, 6, 19); pickup(42, 12, 6);
  }

  // ---------------- highway ----------------
  {
    const z = -30, y = 7;
    slab(-52, z - 4.5, 52, z + 4.5, y, 0.6);
    wallX(-52, 52, z - 4.3, y, 0.9, 0.4, [[-33, -29], [27, 31], [-2, 2]]); // north barrier gaps: bridges to houses
    wallX(-52, 52, z + 4.3, y, 0.9, 0.4, [[-36.5, -33], [33, 36.5]]); // south barrier gaps: stairs
    for (let x = -48; x <= 48; x += 12) box(x, 0, z, 1.4, 6.4, 1.4);
    stairs(-46.5, 0, z + 5.5, '+x', 25, 2, { rise: 0.28, run: 0.45 }); stairs(46.5, 0, z + 5.5, '-x', 25, 2, { rise: 0.28, run: 0.45 });
    
    // road markings
    for (let x = -50; x < 50; x += 4) box(x + 1, y, z, 2, 0.02, 0.2, { noCollide: true, ink: INK.BLACK });
    spawn(-48, y, z); spawn(48, y, z); sniper(0, y, z); pickup(-10, y, z); pickup(24, y, z);
  }

  // ---------------- row houses (north) ----------------
  {
    const z = -45;
    box(-30, 0, z, 14, 7, 10); box(-8, 0, z, 14, 11, 10); box(16, 0, z, 14, 7, 10);
    // bridges from the highway to house 1 and house 3 (y=7)
    box(-31, 6.7, -37.25, 2.6, 0.3, 5.5); box(29, 6.7, -37.25, 2.6, 0.3, 5.5); box(0, 6.7, -37.25, 2.6, 0.3, 5.5);
    rail(-32.3, -40, -32.3, -34.5, 7); rail(-29.7, -40, -29.7, -34.5, 7); rail(27.7, -40, 27.7, -34.5, 7); rail(30.3, -40, 30.3, -34.5, 7);
    // stairs house1 roof -> house2 roof (over the gap)
    stairs(-23, 7, z, '+x', 14, 2.2); slab(-16.9, z - 1.1, -15, z + 1.1, 11, 0.4);
    // stairs house3 roof -> house2 roof
    stairs(9, 7, z, '-x', 14, 2.2); slab(-1, z - 1.1, 2.9, z + 1.1, 11, 0.4);
    // chimneys, water tank, doodle antenna
    box(-33, 7, z - 3, 1.2, 1.6, 1.2); box(19, 7, z + 3, 1.2, 1.4, 1.2); cyl(-10, 11, z - 2.5, 1.4, 2.6, { seg: 14 });
    box(-5, 11, z + 3, 0.1, 4, 0.1, { noCollide: true, ink: INK.BLACK });
    
    spawn(-8, 11, z); spawn(-30, 7, z - 3); spawn(16, 7, z); sniper(-8, 11, z - 3); sniper(16, 7, z + 2); pickup(-8, 11, z + 2); pickup(-30, 7, z);
  }

  // ---------------- south plaza: containers, crates, bus, doodle props (solo only) ----------------
  if (!arena) {
    box(-14, 0, 34, 2.5, 2.6, 6.2, { ink: INK.GREEN }); box(-14, 2.6, 34, 2.5, 2.6, 6.2, { ink: INK.ORANGE });
    box(14, 0, 36, 6.2, 2.6, 2.5); box(17, 2.6, 36, 3, 2.6, 2.5, { ink: INK.GREEN });
    box(-6, 0, 28, 1.4, 1.4, 1.4); box(-4.5, 0, 28.5, 1.2, 1.2, 1.2); box(-5.3, 1.4, 28.2, 1.0, 1.0, 1.0);
    box(8, 0, 26, 1.6, 1.6, 1.6); box(9.6, 0, 26.4, 1.2, 1.2, 1.2);
    // bus
    box(24, 0.6, 40, 11, 3.2, 2.8); box(24, 0, 40, 10, 0.6, 2.6, { noCollide: true }); for (const x of [20, 28]) { cyl(x, 0, 41.5, 0.55, 0.4, { noCollide: true, seg: 10, ink: INK.BLACK }); cyl(x, 0, 38.5, 0.55, 0.4, { noCollide: true, seg: 10, ink: INK.BLACK }); }
    // giant pencil lying on the ground (orange body, black tip, pink eraser)
    { const g = new THREE.CylinderGeometry(0.8, 0.8, 16, 6); g.rotateZ(Math.PI / 2); g.translate(-30, 0.8, 44); addGeo(g, INK.ORANGE); collider(-30, 0, 44, 16, 1.6, 1.6);
      const tip = new THREE.ConeGeometry(0.8, 2.4, 6); tip.rotateZ(-Math.PI / 2); tip.translate(-20.8, 0.8, 44); addGeo(tip, INK.BLACK); collider(-20.8, 0, 44, 2.4, 1.6, 1.6);
      const er = new THREE.CylinderGeometry(0.82, 0.82, 1.6, 8); er.rotateZ(Math.PI / 2); er.translate(-38.8, 0.8, 44); addGeo(er, INK.PINK); collider(-38.8, 0, 44, 1.6, 1.64, 1.64); }
    // giant eraser block (pink) + coffee mug (blue) props to climb
    box(38, 0, 40, 6, 2.2, 3.2, { ink: INK.PINK }); box(38, 2.2, 40, 6, 0.8, 3.2, { ink: INK.BLUE });
    cyl(-40, 0, 32, 2.6, 3.4, { seg: 16 }); { const h = new THREE.TorusGeometry(1.4, 0.35, 8, 16); h.translate(-36.6, 1.8, 32); addGeo(h, INK.BLUE); }
    // lamp posts + benches
    for (const [x, z] of [[-10, 46], [10, 46], [-22, 24], [22, 24]]) { box(x, 0, z, 0.25, 6, 0.25); box(x, 6, z, 1.4, 0.3, 0.5, { noCollide: true }); }
    for (const [x, z] of [[-4, 46], [4, 46]]) { box(x, 0.4, z, 3, 0.15, 0.6); box(x, 0, z, 2.6, 0.4, 0.2, { noCollide: true }); }
    pickup(-6, 0, 36); pickup(6, 0, 36); pickup(-30, 1.6, 44); pickup(38, 3, 40); pickup(0, 0, 10);
    // scattered cover in the open middle areas
    box(-16, 0, -8, 2.2, 1.2, 2.2); box(18, 0, -10, 2.2, 1.6, 2.2); box(-20, 0, 8, 1.6, 1.0, 3); box(20, 0, -2, 3, 1.0, 1.6);
    box(-8, 0, -18, 4, 1.1, 1.2); box(8, 0, -18, 4, 1.1, 1.2); box(0, 0, 22, 5, 0.5, 1.4); box(-24, 0, -18, 2.4, 2.6, 2.4, { ink: INK.ORANGE }); box(26, 0, -18, 2.4, 2.6, 2.4, { ink: INK.GREEN });
  }

  // ---------------- sky doodles ----------------
  {
    sphere(-90, 110, -160, 12, { seg: 12, classicOnly: true });
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; const g = new THREE.BoxGeometry(6, 0.7, 0.7); g.rotateZ(a); g.translate(-90 + Math.cos(a) * 19, 110 + Math.sin(a) * 19, -160); addGeo(g, INK.BLUE, 'ink', true); }
    for (const [cx, cy, cz, s] of [[60, 70, -170, 1], [-20, 75, -190, 1.3], [140, 60, -80, 0.9], [-150, 65, 40, 1.1], [30, 80, 180, 1.2], [-90, 60, 170, 0.8]]) {
      for (let i = 0; i < 6; i++) sphere(cx + (i - 2.5) * 5 * s, cy + Math.sin(i * 1.7) * 2.5 * s, cz, (4 + (i % 3)) * s, { seg: 10, classicOnly: true });
    }
  }

  L.teamSpawns = [[-40, 0, 18], [-34, 12, 12], [-48, 7, -30], [-52, 0, 30], [-30, 7, -48]].map(([x, y, z]) => new THREE.Vector3(x, y, z));
  L.teamSpawns = [L.teamSpawns, [[40, 0, 8], [34, 12, 18], [48, 7, -30], [52, 0, 30], [16, 7, -45]].map(([x, y, z]) => new THREE.Vector3(x, y, z))];
  if (team) {
    L.teamSpawns = [-1, 1].map(side => [54, 59].flatMap(x => [33, 37, 41, 45].map(z => new THREE.Vector3(side * x, 0.03, z))));
    L.teamFacing = [-Math.PI / 2, Math.PI / 2];
    L.playerStart.copy(L.teamSpawns[0][0]);
    // Covered bases open through two rear corners; staggered screens protect the exits.
    for (const side of [-1, 1]) {
      const ink = side < 0 ? INK.BLUE : INK.ORANGE;
      box(side * 49.5, 0, 39, 0.6, 4.2, 22, { ink, surface: 'stone' });
      box(side * 63.5, 0, 39, 0.6, 4.2, 22, { surface: 'stone' });
      box(side * 56.5, 4.2, 39, 14.6, 0.35, 22.6, { ink, surface: 'metal', noNav: true });
      for (const z of [28, 50]) box(side * 54.3, 0, z, 9, 4.2, 0.6, { surface: 'stone' });
      for (const z of [24, 54]) box(side * 62, 0, z, 5.4, 3.2, 0.6, { ink, surface: 'stone' });
      for (const z of [31, 47]) box(side * 56.4, 0.013, z, 11.4, 0.022, 0.14, { noCollide: true, ink });
    }
    // Both objectives stay on the street so every loadout and bot can reach the C4.
    L.bombSites = [{ id: 'A', pos: new THREE.Vector3(0, 0.08, -12), radius: 3 }, { id: 'B', pos: new THREE.Vector3(0, 0.08, 40), radius: 3 }];
    const paint = { noCollide: true, ink: INK.ORANGE, surface: 'ink' };
    const stroke = (x1, z1, x2, z2) => {
      const g = new THREE.BoxGeometry(Math.hypot(x2 - x1, z2 - z1), 0.022, 0.14);
      g.rotateY(-Math.atan2(z2 - z1, x2 - x1));
      g.translate((x1 + x2) / 2, 0.025, (z1 + z2) / 2);
      addGeo(g, INK.ORANGE, 'ink');
    };
    for (const site of L.bombSites) {
      const z = site.pos.z;
      for (const d of [-3.2, 3.2]) {
        box(0, 0.013, z + d, 6.54, 0.022, 0.14, paint);
        box(d, 0.013, z, 0.14, 0.022, 6.26, paint);
      }
      if (site.id === 'A') {
        stroke(-0.8, z + 1, 0, z - 1); stroke(0, z - 1, 0.8, z + 1); stroke(-0.45, z + 0.15, 0.45, z + 0.15);
      } else {
        stroke(-0.65, z - 1, -0.65, z + 1);
        for (const dz of [-1, 0, 1]) stroke(-0.65, z + dz, 0.55, z + dz);
        stroke(0.55, z - 1, 0.8, z - 0.5); stroke(0.8, z - 0.5, 0.55, z);
        stroke(0.55, z, 0.8, z + 0.5); stroke(0.8, z + 0.5, 0.55, z + 1);
      }
      for (const side of [-1, 1]) box(side * 6.5, 0, z, 2.2, 2.3, 4, { ink: INK.BROWN, surface: 'stone' });
    }
    box(0, 0, 19, 6, 3.2, 4, { ink: INK.TEAL, surface: 'stone' });
    L.tactical = {
      buildings: [[-43, 4, -25, 20], [24, 4, 44, 20], [-37, -50, -23, -40], [-15, -50, -1, -40], [9, -50, 23, -40]].map(([x1, z1, x2, z2]) => ({ x1, z1, x2, z2 })),
      paths: [[[-52, -34.5], [52, -34.5], [52, -25.5], [-52, -25.5]]],
    };
  }
  if (!arena) planes(3, 30, 30, { rStep: 8, hStep: 6, scale: 1.4 });
  return B.finish();
}

// ============================ map 3: The Undercity ============================
// A compact PVP maze: service tunnels below a shop-lined ground floor, with short roof
// catwalks above. Every room has two exits and a small visual marker to keep orientation clear.
function buildUndercity(B, arena = false, team = false) {
  const { L, box, slab, wallX, wallZ, stairs, rail, cyl, sphere, ring, spawn, sniper, pickup, collider, addGeo } = B;
  const BL = INK.BLUE, BK = INK.BLACK, OR = INK.ORANGE, RD = INK.RED;
  const P = 45; L.key = 'undercity'; L.playerStart.set(0, 0.2, 34);
  L.bounds = { minX: -P, maxX: P, minZ: -P, maxZ: P };
  if (team) L.bounds.minY = -12;

  // Floors are deliberately broken into plates, leaving a central hatch and two side shafts. The
  // shafts are not decoration: the north and south stairs climb out of the tunnels through them,
  // with enough headroom beneath the ground floor. Team play widens the openings for its
  // shallower flights and the full body clearance used by navigation.
  slab(-44, -44, -4, 44, 0.15, 0.3); slab(4, -44, 44, 44, 0.15, 0.3);
  slab(-4, -44, 4, team ? -20.5 : -17.5, 0.15, 0.3); slab(-4, -14.1, 4, -4, 0.15, 0.3);
  slab(-4, 4, 4, 14.1, 0.15, 0.3); slab(-4, team ? 20.5 : 17.5, 4, 44, 0.15, 0.3);
  slab(-44, -44, 44, 44, -11.5, 0.5, { ink: BL });
  // The enclosing shell is tall enough to keep grapples and players inside all three layers.
  wallX(-P, P, -P, -12, 28, 0.8, [[-7, 7, 0, 3.4]], { ink: BL });
  wallX(-P, P, P, -12, 28, 0.8, [[-34, -28, 0, 3.4], [25, 31, 0, 3.4]], { ink: BL });
  wallZ(-P, P, -P, -12, 28, 0.8, [[-7, 0, 0, 3.4], [20, 26, 0, 3.4]], { ink: BL });
  wallZ(-P, P, P, -12, 28, 0.8, [[-25, -19, 0, 3.4], [15, 21, 0, 3.4]], { ink: BL });
  collider(0, 17, 0, 100, 5, 100, { noNav: true, noGrapple: true });

  const room = (x1, z1, x2, z2, h, gaps, landmark) => {
    wallX(x1, x2, z1, 0.15, h, 0.35, gaps[0] || [], { ink: BL });
    wallX(x1, x2, z2, 0.15, h, 0.35, gaps[1] || [], { ink: BL });
    wallZ(z1, z2, x1, 0.15, h, 0.35, gaps[2] || [], { ink: BL });
    wallZ(z1, z2, x2, 0.15, h, 0.35, gaps[3] || [], { ink: BL });
    landmark(x1, z1, x2, z2);
  };
  // Four ground-floor interiors: paired doors plus windows keep cross-room fights moving.
  room(-39, -39, -7, -8, 5.2, [[[ -25, -20, 0, 3.1 ]], [[-34, -29, 0, 3.1]], [[-25, -20, 0, 3.1]], [[-15, -10, 0, 3.1]]], (x1, z1, x2, z2) => {
    box(x1 + 3, 0.15, z1 + 3, 1.2, 4, 1.2, { ink: RD }); box(x1 + 3, 4.2, z1 + 3, 1.8, 0.2, 1.8, { noCollide: true, ink: BK });
  });
  room(7, -39, 39, -8, 5.2, [[[15, 20, 0, 3.1]], [[28, 33, 0, 3.1]], [[10, 15, 0, 3.1]], [[25, 30, 0, 3.1]]], (x1, z1, x2, z2) => {
    for (const x of [x1 + 4, x1 + 6]) { box(x, 0.15, z1 + 3, 0.22, 3.8, 0.22, { ink: OR }); box(x, 3.8, z1 + 3, 0.7, 0.18, 0.18, { noCollide: true, ink: BK }); }
  });
  room(-39, 8, -7, 39, 5.2, [[[ -28, -23, 0, 3.1 ]], [[-16, -11, 0, 3.1]], [[20, 26, 0, 3.1]], [[-2, 4, 0, 3.1]]], (x1, z1, x2, z2) => {
    for (const z of [z1 + 4, z2 - 4]) cyl(x1 + 3, 0.15, z, 0.5, 3.5, { ink: RD });
  });
  room(7, 8, 39, 39, 5.2, [[[15, 20, 0, 3.1]], [[27, 32, 0, 3.1]], [[-4, 2, 0, 3.1]], [[20, 26, 0, 3.1]]], (x1, z1, x2, z2) => {
    box(x2 - 3, 0.15, z2 - 3, 1.4, 3.6, 1.4, { ink: OR }); ring(x2 - 3, 4.2, z2 - 3, 'y');
  });
  // Interior sightline breaks: offset partitions create jogged routes and short shooting lanes.
  wallZ(-8, 8, -3, 0.15, 5.2, 0.35, [[-1, 3], [5, 8]], { ink: BL });
  wallZ(-8, 8, 3, 0.15, 5.2, 0.35, [[-8, -4], [0, 4]], { ink: BL });
  wallX(-7, 7, -3, 0.15, 5.2, 0.35, [[-2, 2]], { ink: BL });
  wallX(-7, 7, 3, 0.15, 5.2, 0.35, [[-5, -1], [2, 6]], { ink: BL });
  // Skylight frames and catwalks above the four quarters.
  slab(-39, -39, -7, -8, 9.1, 0.3); slab(7, -39, 39, -8, 9.1, 0.3);
  slab(-39, 8, -7, 39, 9.1, 0.3); slab(7, 8, 39, 39, 9.1, 0.3);
  for (const [x1, z1, x2, z2] of [[-39,-8,-7,-8],[7,-8,39,-8],[-39,8,-7,8],[7,8,39,8]]) rail(x1, z1, x2, z2, 9.1, { ink: BK });
  rail(-3, -39, -3, -8, 9.1, { ink: BK }); rail(3, 8, 3, 39, 9.1, { ink: BK });
  // Three stair cores and a central floor hatch form multiple vertical routes. Every riser is
  // under the 0.55 m a body can be lifted by (physics.js, _moveHoriz): a taller one looks like a
  // staircase and behaves like a wall, and the route it belongs to quietly stops existing.
  if (team) {
    // Shallower, longer flights keep adjacent navigation samples within one safe
    // step and reach the existing landings without requiring a grapple or roof jump.
    for (const side of [-1, 1]) {
      const x = side * 2.5, z = side * 42.28, rise = 11.7 / 47;
      stairs(x, -11.5, z, side < 0 ? '+z' : '-z', 47, 2.2, { rise, run: 0.6 });
      // Side panels rule out impossible shortcuts onto the middle of the flight.
      for (let i = 0; i < 47; i++) for (const edge of [-1, 1])
        box(x + edge * 1.1, -11.5, z - side * (i + 0.5) * 0.6, 0.12, (i + 1) * rise + 0.9, 0.604, { ink: BK, surface: 'metal', noNav: true });
      rail(-4, side * 20.5, 4, side * 20.5, 0.15, { ink: BK });
      for (const edge of [-1, 1]) rail(edge * 4, side * 14.1, edge * 4, side * 20.5, 0.15, { ink: BK });
    }
  } else {
    stairs(-2, -11.5, -25, '+z', 26, 2.2, { rise: 0.45, run: 0.42 });
    stairs(2, -11.5, 25, '-z', 26, 2.2, { rise: 0.45, run: 0.42 });
  }
  stairs(-25, 0.15, 2, '+x', 20, 2.2, { rise: 0.448, run: 0.42 });
  stairs(25, 0.15, -2, '-x', 20, 2.2, { rise: 0.448, run: 0.42 });
  // The middle flight stands clear of the hatch lip rather than on it: a stair whose bottom tread
  // is over the void can only be entered from the side, and a side entry has to clear two treads
  // at once (a body is wider than a tread is deep), which is 0.85 m and not a step anybody has.
  stairs(-1.2, 0.15, 5.5, '+z', 20, 2.0, { rise: 0.448, run: 0.42 });
  stairs(1, 0.15, -5.5, '-z', 20, 2.0, { rise: 0.448, run: 0.42 });
  // and each of the two side flights arrives on a landing that reaches the roof lane beside it,
  // laid level with the top step rather than ahead of it, which would clip the climber's head
  slab(-16.6, -2, -13.6, 3.1, 9.1, 0.3, { ink: BL }); slab(13.6, -3.1, 16.6, 2, 9.1, 0.3, { ink: BL });
  // Underground chambers and jogged service tunnels.
  wallX(-39, 39, -29, -11.5, 7.2, 0.45, [[-34, -28], [-7, -1], [20, 26]], { ink: BL });
  wallX(-39, 39, 0, -11.5, 7.2, 0.45, [[-28, -22], [-3, 3], [25, 31]], { ink: BL });
  wallZ(-29, 0, -12, -11.5, 7.2, 0.45, [[-24, -18], [-5, 1]], { ink: BL });
  wallZ(-29, 0, 12, -11.5, 7.2, 0.45, [[-14, -8], [7, 13]], { ink: BL });
  wallZ(0, 29, -12, -11.5, 7.2, 0.45, [[3, 9], [20, 26]], { ink: BL });
  wallZ(0, 29, 12, -11.5, 7.2, 0.45, [[-2, 4], [14, 20]], { ink: BL });
  // Flooded duct (blue ribs), metro platform (orange edge), and red pipe room landmarks.
  slab(-38, -27, 38, -23, -10.9, 0.12, { ink: BL });
  for (let x = -30; x <= 34; x += 8) { box(x, -10.8, -25, 0.25, 5.4, 0.25, { ink: BK }); box(x, -5.6, -25, 1.2, 0.15, 0.15, { noCollide: true, ink: BL }); }
  // Heavy service cabinets interrupt the only long bay, so the three tunnel spawns cannot see one
  // another. They keep off the two stair runs - a duct post standing in the middle of a flight is
  // the sort of thing nobody notices until they are being shot at on it.
  for (const x of [-18, 18]) box(x, -11.5, -35, 2.4, 5.0, 2.6, { ink: BK });
  box(0, -11.5, 10, 2.6, 5.0, 2.6, { ink: BK });
  box(-30, -11.5, 17, 18, 0.25, 3.5, { ink: OR }); box(-21, -11.2, 17, 0.4, 2.2, 0.4, { ink: BK }); box(-6, -11.2, 17, 0.4, 2.2, 0.4, { ink: BK });
  for (const x of [-30, -27, -24]) cyl(x, -11.3, 10, 0.38, 4.8, { ink: RD });
  // Roof lanes are short and offset, with parapets and cover at each turn.
  slab(-39, -5, -6, -2, 9.1, 0.3, { ink: BL }); slab(6, 2, 39, 5, 9.1, 0.3, { ink: BL });
  slab(-5, 6, -2, 39, 9.1, 0.3, { ink: BL }); slab(2, -39, 5, -6, 9.1, 0.3, { ink: BL });
  rail(-39, -5, -6, -5, 9.1, { ink: BK }); rail(6, 5, 39, 5, 9.1, { ink: BK }); rail(-5, 6, -5, 39, 9.1, { ink: BK }); rail(5, -39, 5, -6, 9.1, { ink: BK });
  box(-22, 9.4, -3.5, 2.2, 1.0, 1.2, { ink: OR }); box(19, 9.4, 3.5, 2.2, 1.0, 1.2, { ink: RD });
  for (const [x, z] of [[-6, -2], [6, 2], [-2, 6], [2, -6]]) box(x, 9.1, z, 0.8, 3.8, 0.8, { ink: BK });

  // Co-op spawns, elevated perches, and contested floor pickups.
  for (const p of [[-33,-11.5,-36], [0,-11.5,-36], [33,-11.5,-36], [-33,-11.5,8], [33,-11.5,8], [0,-11.5,27], [-29,0.2,-20], [28,0.2,-21], [-28,0.2,25], [28,0.2,27]]) spawn(...p);
  for (const p of [[-22,10.45,-3.5], [19,10.45,3.5], [-3,9.45,20], [3,9.45,-20], [-20, -4.1, 17], [22, -4.1, -17]]) sniper(...p);
  for (const p of [[-18,-11.45,-25], [18,-11.45,-25], [-18,-11.45,0], [18,-11.45,0], [-25,0.2,-4], [25,0.2,4], [-8,0.2,-15], [8,0.2,15], [-6,0.2,0], [-20,9.45,-3], [22,9.45,3], [-3,9.45,20], [3,9.45,-20], [0,-11.45,17]]) pickup(...p);
  // roof spawns sit beside the crates, not in them - a body that starts inside geometry is shoved
  // out of it on its first step, and where it lands is anyone's guess
  const arenaPoints = [[-35,-11.4,-35], [0,-11.4,-35], [35,-11.4,-35], [-35,-11.4,10], [35,-11.4,10], [0,-11.4,28], [-30,0.25,-20], [28,0.25,-20], [-28,0.25,25], [30,0.25,27], [-25,9.4,-3.5], [16,9.4,3.5], [-4,9.5,20], [4,9.5,-20], [0,-11.4,0]];
  for (const p of arenaPoints) L.arenaSpawns.push(new THREE.Vector3(...p));
  L.teamSpawns = [arenaPoints.slice(0, 5), arenaPoints.slice(5, 10)].map(a => a.map(p => new THREE.Vector3(...p)));
  if (team) {
    L.teamSpawns = [-1, 1].map(side => [-42.2, -40.4].flatMap(x => [-5.4, -1.8, 1.8, 5.4].map(z => new THREE.Vector3(x * -side, 0.2, z))));
    L.teamFacing = [-Math.PI / 2, Math.PI / 2];
    L.playerStart.copy(L.teamSpawns[0][0]);
    for (const side of [-1, 1]) {
      box(side * 36.5, 0.15, 0, 0.5, 2.5, 11.6, { ink: side < 0 ? BL : OR, surface: 'plaster', noNav: true });
      for (const z of [-6.8, 6.8]) box(side * 41.3, 0.17, z, 4.4, 0.025, 0.12, { ink: side < 0 ? BL : OR, surface: 'cloth', noCollide: true });
    }
    L.bombSites = [{ id: 'A', pos: new THREE.Vector3(0, 0.2, -34), radius: 3 }, { id: 'B', pos: new THREE.Vector3(0, 0.2, 34), radius: 3 }];
    const mark = { ink: OR, surface: 'cloth', noCollide: true };
    for (const { id, pos: { x, z } } of L.bombSites) {
      for (const dx of [-3.15, 3.15]) box(x + dx, 0.17, z, 0.12, 0.025, 6.4, mark);
      for (const dz of [-3.15, 3.15]) box(x, 0.17, z + dz, 6.2, 0.025, 0.12, mark);
      if (id === 'A') {
        for (const side of [-1, 1]) {
          const g = new THREE.BoxGeometry(0.18, 0.025, 2.2); g.rotateY(side * 0.4); g.translate(x + side * 0.42, 0.21, z); addGeo(g, OR, 'cloth');
        }
        box(x, 0.198, z + 0.2, 1.1, 0.025, 0.16, mark);
      } else {
        for (const dx of [-0.7, 0.7]) box(x + dx, 0.198, z, 0.16, 0.025, 2.1, mark);
        for (const dz of [-1, 0, 1]) box(x, 0.198, z + dz, 1.3, 0.025, 0.16, mark);
      }
    }
    // The tactical view represents the ground floor; the invisible sky collider
    // and underground partitions must not paint over its routes and objectives.
    L.tactical = {
      buildings: [[-39, -39, -7, -8], [7, -39, 39, -8], [-39, 8, -7, 39], [7, 8, 39, 39]].map(([x1, z1, x2, z2]) => ({ x1, z1, x2, z2 })),
      paths: [[[-44, -7], [44, -7], [44, 7], [-44, 7]], [[-6, -44], [6, -44], [6, 44], [-6, 44]]],
      labels: [{ name: 'NORTH STAIRS', x: 0, z: -16, small: true }, { name: 'SOUTH STAIRS', x: 0, z: 16, small: true }],
    };
  }
  return B.finish();
}

// ============================ map 2: The Desk ============================
// You are two inches tall on somebody's desk. Everything is a stationery object at monstrous
// scale: an open book whose pages are ramps, keyboard keys you hop between, a mug you spiral up,
// pen barrels laid as beams, paper clips arching overhead to swing from. Wide open in between,
// nothing enclosed, and every high place is in the open where anyone can shoot you off it.
// ============================ map 2: Paper Canyon ============================
// A gorge cut into the notebook. An ink river runs along the bottom, terraced cliffs step up on
// both sides (each ledge reachable by cut-in stairs, so enemies climb too), rock spires and a
// rope bridge give the grapple something to bite, and the top ledges are exposed sniper ground.

// ============================ map 2: Doodle Mexico ============================
// A sun-baked pueblo: a plaza with a fountain and a floating sombrero, a bandstand full of mariachis,
// a church with a bell tower, adobe houses, a market of piñatas, a taco cart, and mesas all around.
// Pots, crates, barrels, cacti and piñatas all break.
function buildMexico(B, arena = false) {
  const { L, box, slab, stairs, rail, cyl, sphere, ring, spawn, sniper, pickup, planes, addGeo, collider, scene } = B;
  const OR = INK.ORANGE, GR = INK.GREEN, PK = INK.PINK, BK = INK.BLACK, BL = INK.BLUE;
  L.key = 'mexico'; L.playerStart.set(0, 0, 16); const P = 62; L.bounds = { minX: -P, maxX: P, minZ: -P, maxZ: P };
  const mat = (ink, fill = false) => makeInkMaterial({ ink, fill, side: fill ? THREE.DoubleSide : THREE.FrontSide });
  const mesh = (geo, ink, fill = false) => new THREE.Mesh(geo, mat(ink, fill));
  // a prop that can be broken: its own meshes (so they can fly off) and a tagged collider
  const breakable = (kind, x, y, z, w, h, d, build, o = {}) => {
    const g = new THREE.Group(); build(g); g.position.set(x, y, z); scene.add(g); L.meshes.push(g);
    const br = { id: L.breakables.length, kind, group: g, hp: o.hp ?? 1, pos: new THREE.Vector3(x, y + h / 2, z), alive: true, ink: o.ink ?? OR, box: null };
    br.box = collider(x, y, z, w, h, d, { noNav: true }); br.box.data.breakable = br; L.breakables.push(br); return br;
  };
  const pot = (x, z, big = false) => breakable('pot', x, 0, z, big ? 1.2 : 0.9, big ? 1.3 : 0.9, big ? 1.2 : 0.9, (g) => {
    const r = big ? 0.55 : 0.4, h = big ? 1.2 : 0.85;
    g.add(mesh(new THREE.CylinderGeometry(r * 0.75, r, h, 9).translate(0, h / 2, 0), OR)); g.add(mesh(new THREE.TorusGeometry(r * 0.72, 0.05, 5, 12).rotateX(Math.PI / 2).translate(0, h, 0), BK));
    g.add(mesh(new THREE.TorusGeometry(r * 0.98, 0.04, 4, 12).rotateX(Math.PI / 2).translate(0, h * 0.45, 0), PK));
  }, { hp: 1, ink: OR });
  const crate = (x, z) => breakable('crate', x, 0, z, 1.1, 1.1, 1.1, (g) => {
    g.add(mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1).translate(0, 0.55, 0), BL)); for (const k of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(1.14, 0.12, 0.12).translate(0, 0.55 + k * 0.35, 0.56), BK));
  }, { hp: 30, ink: BL });
  const barrel = (x, z) => breakable('barrel', x, 0, z, 1.1, 1.2, 1.1, (g) => {
    g.add(mesh(new THREE.CylinderGeometry(0.5, 0.45, 1.2, 10).translate(0, 0.6, 0), OR)); for (const y of [0.25, 0.95]) g.add(mesh(new THREE.TorusGeometry(0.5, 0.04, 4, 14).rotateX(Math.PI / 2).translate(0, y, 0), BK));
  }, { hp: 30, ink: OR });
  const cactus = (x, z, h = 2.6) => breakable('cactus', x, 0, z, 0.9, h, 0.9, (g) => {
    g.add(mesh(new THREE.CylinderGeometry(0.28, 0.34, h, 8).translate(0, h / 2, 0), GR));
    g.add(mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.9, 7).translate(0.6, h * 0.55, 0), GR)); g.add(mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.7, 7).rotateZ(Math.PI / 2).translate(0.35, h * 0.38, 0), GR));
    g.add(mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.7, 7).translate(-0.55, h * 0.7, 0), GR)); g.add(mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.6, 7).rotateZ(Math.PI / 2).translate(-0.3, h * 0.55, 0), GR));
    g.add(mesh(new THREE.SphereGeometry(0.16, 6, 5).translate(0, h + 0.05, 0), PK));
  }, { hp: 40, ink: GR });
  // a piñata: a striped donkey hung on a string, bursting with candy
  const pinata = (x, y, z) => breakable('pinata', x, y, z, 1.1, 0.9, 0.6, (g) => {
    g.add(mesh(new THREE.BoxGeometry(0.9, 0.5, 0.45).translate(0, 0.55, 0), PK)); for (const k of [-0.3, 0, 0.3]) g.add(mesh(new THREE.BoxGeometry(0.1, 0.52, 0.47).translate(k, 0.55, 0), k ? GR : OR));
    g.add(mesh(new THREE.BoxGeometry(0.34, 0.3, 0.3).translate(0.6, 0.72, 0), PK)); g.add(mesh(new THREE.BoxGeometry(0.1, 0.22, 0.08).translate(0.62, 0.95, 0.1), OR)); g.add(mesh(new THREE.BoxGeometry(0.1, 0.22, 0.08).translate(0.62, 0.95, -0.1), OR));
    for (const [lx, lz] of [[-0.3, 0.15], [-0.3, -0.15], [0.3, 0.15], [0.3, -0.15]]) g.add(mesh(new THREE.BoxGeometry(0.12, 0.34, 0.12).translate(lx, 0.15, lz), PK));
    g.add(mesh(new THREE.BoxGeometry(0.03, 2.2, 0.03).translate(0, 1.85, 0), BK));
  }, { hp: 1, ink: PK });

  // ---------------- ground and the mesas around the edge ----------------
  box(0, -1, 0, 2 * P + 10, 1, 2 * P + 10);
  const mesa = (x, z, w, d) => { box(x, 0, z, w, 11, d); box(x + rand(-1.2, 1.2), 11, z + rand(-1.2, 1.2), w * 0.78, 7, d * 0.78); box(x + rand(-1, 1), 18, z + rand(-1, 1), w * 0.5, 5, d * 0.5); };
  for (let i = -2; i <= 2; i++) { mesa(i * 24, -P, 19, 8); mesa(i * 24, P, 19, 8); mesa(-P, i * 24, 8, 19); mesa(P, i * 24, 8, 19); }
  // trails between the mesas are where the doodles come from
  for (let i = -2; i < 2; i++) { spawn(i * 24 + 12, 0, -P + 5); spawn(i * 24 + 12, 0, P - 5); spawn(-P + 5, 0, i * 24 + 12); spawn(P - 5, 0, i * 24 + 12); }
  // an invisible lid so nobody leaves through the sky; the hook will not bite it
  collider(0, 62, 0, 2 * P + 40, 6, 2 * P + 40, { noNav: true, noGrapple: true });

  // ---------------- the plaza: paving, a fountain, and a sombrero floating above it ----------------
  slab(-24, -24, 24, 24, 0.15, 0.15);
  cyl(0, 0, 0, 5.5, 1.1); cyl(0, 1.1, 0, 1.2, 2.6); cyl(0, 3.7, 0, 2.4, 0.5); sphere(0, 5.4, 0, 0.7, { ink: BL }); ring(0, 7.2, 0, 'y');
  addGeo(new THREE.CylinderGeometry(5.1, 5.1, 0.08, 20).translate(0, 1.1, 0), BL);
  for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU; addGeo(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 5).rotateZ(0.35).rotateY(a).translate(Math.cos(a) * 1.7, 5.0, Math.sin(a) * 1.7), BL); }
  cyl(0, 13, 0, 8, 0.45, { ink: OR }); cyl(0, 13.45, 0, 3.2, 3, { ink: OR }); addGeo(new THREE.CylinderGeometry(3.3, 3.3, 0.5, 16).translate(0, 13.9, 0), PK);
  for (let k = 0; k < 6; k++) { const a = (k / 6) * TAU; ring(Math.cos(a) * 7.2, 12.2, Math.sin(a) * 7.2, 'y'); }
  ring(0, 17.5, 0, 'y');

  // ---------------- the bandstand, with a mariachi band that never stops ----------------
  cyl(0, 0, -26, 6.5, 1.2); stairs(0, 0, -19.5, '-z', 4, 4.5, { rise: 0.3, run: 0.5 });
  for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU + Math.PI / 8; cyl(Math.cos(a) * 5.6, 1.2, -26 + Math.sin(a) * 5.6, 0.22, 4.2, { noCollide: true, ink: OR }); }
  addGeo(new THREE.ConeGeometry(7.6, 3.2, 8).translate(0, 7.0, -26), OR); collider(0, 5.4, -26, 9, 0.5, 9, { noNav: true }); addGeo(new THREE.CylinderGeometry(7.6, 7.6, 0.3, 8).translate(0, 5.55, -26), BL); ring(0, 9.4, -26, 'y');
  const mariachi = (x, z, yaw, guitar) => {
    const m = buildHumanoid(makeInkMaterial({ ink: BK, shadeScale: 0, shadeBias: 1 }), makeInkMaterial({ ink: BK, fill: true, side: THREE.DoubleSide }), { weapon: 'rifle', scale: 1, hat: 'none', build: { bodyW: 1.05, headS: 1, limbR: 0.034 } });
    const J = m.J; while (J.gun.children.length) J.gun.remove(J.gun.children[0]);
    // sombrero: a wide brim and a tall crown; a guitar or a trumpet in the hands
    const hat = new THREE.Group(); hat.add(mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.05, 14), OR), mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.28, 10).translate(0, 0.16, 0), OR), mesh(new THREE.TorusGeometry(0.24, 0.03, 4, 12).rotateX(Math.PI / 2).translate(0, 0.06, 0), PK)); hat.position.y = 0.5; J.headG.add(hat);
    if (guitar) { J.gun.add(mesh(new THREE.BoxGeometry(0.34, 0.12, 0.5).translate(0, 0.02, 0.05), OR), mesh(new THREE.BoxGeometry(0.06, 0.05, 0.7).translate(0, 0.06, 0.55), BK)); J.armR.rotation.x = -0.9; J.armL.rotation.x = -1.0; J.armL.rotation.y = 0.5; J.foreL.rotation.x = -0.9; }
    else { J.gun.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.55, 7).rotateX(Math.PI / 2).translate(0, 0.02, 0.25), OR), mesh(new THREE.CylinderGeometry(0.14, 0.05, 0.16, 8).rotateX(Math.PI / 2).translate(0, 0.02, 0.55), OR)); J.armR.rotation.x = -1.6; J.armL.rotation.x = -1.5; J.armL.rotation.y = 0.4; J.foreL.rotation.x = -0.4; J.headG.rotation.x = -0.25; }
    m.root.position.set(x, 1.2, z); m.root.rotation.y = yaw; scene.add(m.root); L.meshes.push(m.root);
    L.animated.push({ mesh: m.root, update: (t) => { const s = Math.sin(t * 6 + x); m.root.position.y = 1.2 + Math.max(0, s) * 0.08; J.hips.parent.rotation.z = s * 0.04; if (guitar) J.foreR.rotation.x = -0.5 + Math.sin(t * 9 + x) * 0.25; else J.headG.rotation.z = Math.sin(t * 4 + x) * 0.08; } });
  };
  mariachi(-2.6, -27.5, 0.4, true); mariachi(0, -28.5, 0, false); mariachi(2.6, -27.5, -0.4, true);

  // ---------------- the church: a nave, a bell tower you can climb, a domed second tower ----------------
  box(0, 0, 44, 24, 11, 16); box(0, 11, 44, 24, 1.6, 4.5); box(0, 12.6, 44, 3, 1.2, 3); box(0, 13.8, 44, 0.3, 2.2, 0.3); box(0, 15.2, 44, 1.4, 0.3, 0.3);
  slab(-7, 33.5, 7, 36.5, 0.8, 0.8); box(-3.2, 0, 35.8, 0.5, 5.4, 0.5, { noCollide: true, ink: BK }); box(3.2, 0, 35.8, 0.5, 5.4, 0.5, { noCollide: true, ink: BK }); addGeo(new THREE.TorusGeometry(3.2, 0.25, 6, 16, Math.PI).translate(0, 5.4, 35.8), BK);
  for (const x of [-8, 8]) for (const y of [3, 7]) box(x, y, 35.9, 1.6, 2.2, 0.3, { noCollide: true, ink: BK });
  box(-10, 0, 46, 6, 26, 6); for (const [dx, dz] of [[-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5], [2.5, 2.5]]) box(-10 + dx, 26, 46 + dz, 0.6, 4, 0.6);
  box(-10, 30, 46, 7.2, 0.6, 7.2); box(-10, 30.6, 46, 0.3, 3, 0.3); box(-10, 32.4, 46, 1.6, 0.3, 0.3); sphere(-10, 28.2, 46, 0.95, { ink: OR }); ring(-10, 27.4, 42.2, 'y'); ring(-10, 33.8, 46, 'y');
  for (const y of [8, 15, 21]) { box(-10, y, 42.4, 6, 0.4, 1.3, { ink: OR }); box(-13.6, y + 3, 46, 1.3, 0.4, 6, { ink: OR }); }
  box(10, 0, 46, 6, 15, 6); sphere(10, 17.4, 46, 3.6, { ink: OR }); collider(10, 15, 46, 6, 5, 6, { noNav: true }); box(10, 20.8, 46, 0.3, 2, 0.3); ring(10, 21.6, 46, 'y');
  for (const y of [6, 11]) box(13.6, y, 46, 1.3, 0.4, 6, { ink: OR });

  // ---------------- adobe houses east and west, flat roofs with stairs, colored doors ----------------
  const house = (x, z, w, d, h, door, side) => {
    box(x, 0, z, w, h, d); box(x, h, z, w + 0.6, 0.35, d + 0.6, { ink: OR }); rail(x - w / 2, z - d / 2, x + w / 2, z - d / 2, h + 0.35, { ink: OR });
    const dx = side * (w / 2 + 0.01); box(x + dx, 0, z, 0.15, 2.6, 1.4, { noCollide: true, ink: door }); box(x + dx, 2.6, z, 0.15, 0.3, 1.8, { noCollide: true, ink: BK });
    for (const wz of [z - d * 0.32, z + d * 0.32]) box(x + dx, 1.6, wz, 0.12, 1.1, 1.1, { noCollide: true, ink: BK });
    const n = Math.round(h / 0.3); stairs(x - side * (w / 2 + 0.3), 0, z + d / 2 + 0.9, side > 0 ? '+x' : '-x', n, 1.6, { rise: h / n, run: 0.42 });
    box(x, h + 0.35, z + d / 2 - 1.2, 2.2, 0.9, 1.4, { ink: OR }); ring(x, h + 3.2, z, 'y');
  };
  house(-40, -20, 11, 9, 6, GR, 1); house(-40, -4, 9, 8, 5, PK, 1); house(-40, 14, 12, 10, 7.5, OR, 1);
  house(40, -18, 12, 9, 7, PK, -1); house(40, 0, 9, 8, 5.5, GR, -1); house(40, 16, 11, 10, 6.5, OR, -1);
  // strings of papel picado across the plaza, with rings hung along them
  const banner = (x1, y1, z1, x2, y2, z2, n) => {
    for (let i = 0; i <= n; i++) { const t = i / n, x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t - Math.sin(t * Math.PI) * 1.2, z = z1 + (z2 - z1) * t; if (i < n) { const dx = (x2 - x1) / n, dz = (z2 - z1) / n; addGeo(new THREE.BoxGeometry(Math.hypot(dx, dz) + 0.05, 0.05, 0.05).rotateY(-Math.atan2(dz, dx)).translate(x + dx / 2, y, z + dz / 2), BK); } if (i % 2 === 1) addGeo(new THREE.BoxGeometry(0.7, 0.55, 0.02).rotateY(-Math.atan2(z2 - z1, x2 - x1)).translate(x, y - 0.32, z), [PK, GR, OR][i % 3]); if (i === Math.floor(n / 2)) ring(x, y - 1.2, z, 'y'); }
  };
  banner(-34.5, 6.4, -20, -8, 30.6, 42, 22); banner(34.5, 7.4, -18, 8, 21.2, 42, 22); banner(-34.5, 5.4, -4, 34.5, 5.9, 0, 26); banner(-34.5, 7.9, 14, 34.5, 6.9, 16, 26);

  // ---------------- the market: stalls under striped canopies, piñatas hanging, pots and crates about ----------------
  const stall = (x, z, w, d, yaw) => {
    box(x, 0, z, w, 0.9, d); for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(x + sx * (w / 2 - 0.15), 0, z + sz * (d / 2 - 0.15), 0.14, 2.9, 0.14, { noCollide: true, ink: BK });
    for (let i = 0; i < 5; i++) addGeo(new THREE.BoxGeometry(w + 0.6, 0.06, (d + 0.6) / 5).translate(x, 2.95, z - (d + 0.6) / 2 + (i + 0.5) * (d + 0.6) / 5), i % 2 ? PK : OR);
    collider(x, 2.9, z, w + 0.6, 0.12, d + 0.6, { noNav: true });
  };
  stall(-20, 22, 4.5, 2.4); stall(-13, 22, 4.5, 2.4); stall(20, 22, 4.5, 2.4); stall(13, 22, 4.5, 2.4); stall(-24, -12, 2.4, 4.5); stall(26, -8, 2.4, 4.5);
  pinata(-20, 1.3, 22); pinata(13, 1.3, 22); pinata(-24, 1.3, -12); pinata(26, 1.3, -8); pinata(0, 6.4, 8); pinata(-9, 9.5, 12); pinata(9, 9.5, 12);
  for (const [x, z] of [[-17.5, 24.5], [-9.5, 24.5], [16.5, 24.5], [23.5, 24.5], [-27.5, -9], [-27.5, -15], [29, -5], [29, -11]]) crate(x, z);
  for (const [x, z] of [[-33, -14], [-33, -12.6], [-33, -6], [-33, 10], [-33, 20], [33, -12], [33, -3], [33, 6], [33, 22], [-6, 30], [6, 30], [-18, 31], [18, 31], [-3, -33], [3, -33]]) pot(x, z, Math.random() < 0.3);
  for (const [x, z] of [[-18, -30], [18, -30], [-30, 30], [30, 30]]) barrel(x, z);

  // ---------------- the taco cart: the best tacos on the page, and where the healing comes from ----------------
  box(24, 0, 4, 3.2, 1.3, 1.6, { ink: OR }); box(24, 1.3, 4, 3.4, 0.9, 1.8, { ink: BL }); box(22.5, 0, 4, 0.14, 3.6, 0.14, { noCollide: true, ink: BK }); box(25.5, 0, 4, 0.14, 3.6, 0.14, { noCollide: true, ink: BK });
  for (let i = 0; i < 4; i++) addGeo(new THREE.BoxGeometry(3.6, 0.06, 0.55).translate(24, 3.62, 3 + i * 0.55), i % 2 ? GR : OR);
  addGeo(new THREE.CylinderGeometry(0.34, 0.34, 0.14, 12).rotateZ(Math.PI / 2).translate(23.1, 0.34, 3.1), BK); addGeo(new THREE.CylinderGeometry(0.34, 0.34, 0.14, 12).rotateZ(Math.PI / 2).translate(24.9, 0.34, 3.1), BK);
  { const g = new THREE.CylinderGeometry(0.7, 0.7, 0.35, 12, 1, false, 0, Math.PI); g.rotateZ(Math.PI / 2); g.rotateX(-Math.PI / 2); g.translate(24, 4.6, 4); addGeo(g, OR); addGeo(new THREE.BoxGeometry(1.3, 0.14, 0.3).translate(24, 4.62, 4), GR); addGeo(new THREE.BoxGeometry(1.1, 0.1, 0.2).translate(24, 4.76, 4), BK); }
  for (const [x, z] of [[22, 6.5], [26, 6.5], [24, 1.5]]) pickup(x, 0, z);

  // ---------------- cacti and rocks in the dust outside the plaza ----------------
  for (const [x, z, h] of [[-46, -40, 2.8], [-50, -28, 2.2], [-48, 30, 3.0], [-44, 44, 2.4], [46, -44, 2.6], [50, -30, 2.2], [48, 34, 3.2], [44, 46, 2.5], [-30, -48, 2.8], [30, -48, 2.4], [-28, 48, 2.6], [28, 50, 2.9], [12, -44, 2.2], [-12, -44, 2.6]]) cactus(x, z, h);
  for (const [x, z, r] of [[-52, -46, 2.2], [52, 48, 2.6], [-52, 48, 1.8], [52, -48, 2.0], [0, -52, 1.6], [0, 52, 1.6]]) { sphere(x, r * 0.55, z, r, { ink: BL }); collider(x, 0, z, r * 1.5, r * 1.2, r * 1.5); }
  // a few low walls and a well for cover between the plaza and the market
  box(-12, 0, -12, 8, 1.1, 0.5, { ink: OR }); box(12, 0, -12, 8, 1.1, 0.5, { ink: OR }); box(-30, 0, 34, 0.5, 1.1, 8, { ink: OR }); box(30, 0, 34, 0.5, 1.1, 8, { ink: OR });
  cyl(-14, 0, 8, 1.3, 1.0); box(-14, 1, 8, 0.15, 2.0, 0.15, { noCollide: true, ink: BK }); box(-14, 3, 8, 2.2, 0.3, 0.3, { noCollide: true, ink: BK });

  // ---------------- where things are: perches, pickups, match spawns ----------------
  for (const [x, y, z] of [[-10, 30.6, 46], [10, 15, 46], [-40, 7.5, 14], [40, 7, -18], [0, 5.9, -26], [0, 13.45, 0]]) sniper(x, y, z);
  for (const [x, y, z] of [[0, 1.25, 8], [-20, 0, 0], [20, 0, -14], [0, 0, -36], [-40, 6, -20], [40, 5.5, 0], [0, 11, 44], [0, 13.5, 0], [-24, 0, 24], [24, 0, 24]]) pickup(x, y, z);
  for (const [x, y, z] of [[-40, 6.2, -20], [40, 7.2, -18], [-40, 7.7, 14], [40, 6.7, 16], [0, 11.2, 44], [0, 5.6, -26], [-46, 0, 0], [46, 0, 0], [0, 0, -50], [-30, 0, 46], [30, 0, 46], [0, 13.6, 0], [-10, 30.8, 46]]) L.arenaSpawns.push(new THREE.Vector3(x, y, z));

  // ---------------- sky: a fat sun, far mesas, paper planes ----------------
  addGeo(new THREE.SphereGeometry(14, 14, 10).translate(70, 95, -150), OR);
  for (let i = 0; i < 12; i++) { const a = (i / 12) * TAU; const g = new THREE.BoxGeometry(7, 0.9, 0.9); g.rotateZ(a); g.translate(70 + Math.cos(a) * 21, 95 + Math.sin(a) * 21, -150); addGeo(g, OR); }
  for (const [x, z, w, h] of [[-120, -160, 60, 30], [40, -190, 90, 36], [150, -120, 70, 26], [-170, 60, 50, 24], [160, 90, 80, 30], [-60, 190, 100, 34]]) { addGeo(new THREE.BoxGeometry(w, h, 30).translate(x, h / 2, z), BL); addGeo(new THREE.BoxGeometry(w * 0.6, h * 0.5, 22).translate(x, h + h * 0.25, z), BL); }
  planes(3, 30, 26, { rStep: 8, hStep: 6, scale: 1.4 });
  B.finish(); return L;
}

// A ground-level, symmetric depot keeps objectives reachable by foot and gives each team a
// sheltered assembly area. Routes bend outside both bases before joining either courtyard.
function buildDepot(B) {
  const { L, box, wallX, wallZ, cyl, sphere, collider, addGeo } = B;
  L.key = 'depot'; L.bounds = { minX: -42, maxX: 42, minZ: -32, maxZ: 32 };
  box(0, -0.8, 0, 86, 0.8, 66, { surface: 'ground', ink: INK.BROWN });
  wallX(-42, 42, -32, 0, 8.4, 0.7, [], { surface: 'plaster', ink: INK.BROWN });
  wallX(-42, 42, 32, 0, 8.4, 0.7, [], { surface: 'plaster', ink: INK.BROWN });
  wallZ(-31.65, 31.65, -42, 0, 8.4, 0.7, [], { surface: 'plaster', ink: INK.BROWN });
  wallZ(-31.65, 31.65, 42, 0, 8.4, 0.7, [], { surface: 'plaster', ink: INK.BROWN });
  collider(0, 14, 0, 90, 4, 70, { noNav: true, noGrapple: true });
  for (const z of [-31.57, 31.57]) {
    box(0, 6.7, z, 82.8, 0.24, 0.12, { noCollide: true, surface: 'metal', ink: INK.BLACK });
    for (const x of [-32, -16, 0, 16, 32]) {
      box(x, 4.5, z, 7.8, 1.4, 0.12, { noCollide: true, surface: 'glass', ink: INK.TEAL });
      box(x, 4.4, z + (z < 0 ? 0.09 : -0.09), 0.1, 1.6, 0.15, { noCollide: true, surface: 'metal', ink: INK.BLACK });
    }
  }

  const cargo = (x, z, w, d, h, ink) => {
    box(x, 0, z, w, h, d, { surface: 'metal', ink, noNav: true });
    // Ribs stand clear of the body face so the stylized surface pass never alternates materials.
    for (const dx of [-w / 2 + 0.24, w / 2 - 0.24]) for (const dz of [-d / 2 - 0.045, d / 2 + 0.045])
      box(x + dx, 0.12, z + dz, 0.12, h - 0.24, 0.06, { noCollide: true, surface: 'metal', ink: INK.BLACK });
    for (const dz of [-d / 2 - 0.04, d / 2 + 0.04]) box(x, h - 0.25, z + dz, w - 0.3, 0.1, 0.05, { noCollide: true, surface: 'metal', ink: INK.BLACK });
  };
  L.teamSpawns = [];
  for (const [team, sign, ink] of [[0, -1, INK.BLUE], [1, 1, INK.ORANGE]]) {
    L.teamSpawns[team] = [-36, -33].flatMap(x => [-6, -2, 2, 6].map(z => new THREE.Vector3(x * -sign, 0.05, z)));
    wallZ(-13, 13, sign * 26, 0, 6.4, 0.7, [[-10, -6, 0, 3.3], [6, 10, 0, 3.3]], { surface: 'plaster', ink });
    // Short returns shield both exits without turning a spawn area into a one-door trap.
    for (const z of [-13, 13]) box(sign * 31.5, 0, z, 11.7, 5.8, 0.55, { surface: 'plaster', ink });
    box(sign * 34, 6.4, 0, 14.8, 0.32, 26.6, { surface: 'metal', ink, noNav: true });
    box(sign * 25.57, 4.3, 0, 0.12, 0.7, 8.5, { noCollide: true, surface: 'cloth', ink });
    for (const z of [-8, 8]) {
      box(sign * 25.53, 3.42, z, 0.17, 0.18, 4.5, { noCollide: true, surface: 'metal', ink: INK.BLACK });
      box(sign * 30, 0.012, z, 7, 0.022, 0.12, { noCollide: true, surface: 'cloth', ink });
    }
    for (const z of [-19, 19]) cargo(sign * 19, z, 4, 6, 3.4, ink);
    for (const z of [-5, 5]) cargo(sign * 15, z, 3.5, 4, 2.3, INK.OLIVE);
  }
  // The central hall is solid cover; the north/south lanes remain at least six metres wide.
  cargo(0, 0, 14, 12, 5.4, INK.TEAL);
  box(0, 5.48, 0, 14.5, 0.18, 12.5, { surface: 'metal', ink: INK.BLACK, noNav: true });
  for (const z of [-6.13, 6.13]) box(0, 3.3, z, 8, 0.75, 0.12, { noCollide: true, surface: 'cloth', ink: INK.ORANGE });
  for (const z of [-26, 26]) {
    cargo(-7.5, z, 3.5, 2.5, 1.25, INK.BROWN);
    cargo(7.5, z, 3.5, 2.5, 1.25, INK.BROWN);
    // Low planting beds make the outer courtyards distinct without hiding a standing player.
    for (const x of [-28, 28]) {
      box(x, 0, z, 3.8, 0.55, 2, { surface: 'stone', ink: INK.BROWN });
      for (const dx of [-1, 0, 1]) sphere(x + dx, 0.85, z, 0.58, { surface: 'foliage', ink: INK.GREEN });
    }
  }
  L.bombSites = [{ id: 'A', pos: new THREE.Vector3(0, 0.05, -20), radius: 3 }, { id: 'B', pos: new THREE.Vector3(0, 0.05, 20), radius: 3 }];
  for (const site of L.bombSites) {
    const { x, z } = site.pos;
    for (const dx of [-3.1, 3.1]) box(x + dx, 0.013, z, 0.1, 0.022, 6.3, { noCollide: true, surface: 'cloth', ink: INK.ORANGE });
    for (const dz of [-3.1, 3.1]) box(x, 0.013, z + dz, 6.1, 0.022, 0.1, { noCollide: true, surface: 'cloth', ink: INK.ORANGE });
    // Ground letters use plain geometry so the map is legible offline in either visual style.
    if (site.id === 'A') {
      for (const sign of [-1, 1]) {
        const g = new THREE.BoxGeometry(0.18, 0.025, Math.hypot(0.85, 2));
        g.rotateY(Math.atan2(sign * 0.85, 2)); g.translate(sign * 0.425, 0.03, z);
        addGeo(g, INK.ORANGE, 'cloth');
      }
      box(0, 0.016, z + 0.2, 0.9, 0.025, 0.18, { noCollide: true, surface: 'cloth', ink: INK.ORANGE });
    } else {
      for (const dx of [-0.75, 0.75]) box(dx, 0.016, z, 0.18, 0.025, 2, { noCollide: true, surface: 'cloth', ink: INK.ORANGE });
      for (const dz of [-0.9, 0, 0.9]) box(0, 0.016, z + dz, 1.32, 0.025, 0.18, { noCollide: true, surface: 'cloth', ink: INK.ORANGE });
    }
    cyl(0, 0, z < 0 ? -30.4 : 30.4, 0.35, 5.8, { surface: 'metal', ink: INK.BLACK });
    box(0, 5.4, z < 0 ? -29.8 : 29.8, 1.6, 0.22, 1.6, { noCollide: true, surface: 'metal', ink: INK.ORANGE });
  }
  L.teamFacing = [-Math.PI / 2, Math.PI / 2];
  L.playerStart.copy(L.teamSpawns[0][0]);
  L.arenaSpawns = L.teamSpawns.flat().map(p => p.clone());
  return B.finish();
}

// A compressed, north-up adaptation of East 1 / East 2 and the Qizhen lakeside. The
// footprints follow OSM; entrances, cover and playable balconies are match-design choices.
function buildZijingang(B) {
  const { L, box, slab, wallX, wallZ, stairs, rail, cyl, sphere, collider, addGeo, spawn, sniper, pickup } = B;
  L.key = 'zijingang'; L.bounds = { minX: -240, maxX: 240, minZ: -180, maxZ: 180 }; L.navCell = 1.5; L.fallY = -5;
  L.previewCam = { target: [0, 3, -6], radius: 302, height: 191, speed: 0.012 };
  L.zones = [
    { id: 'hall', name: 'YONGMAN HALL', x: -71, z: -7, bounds: { minX: -83, maxX: -55, minZ: -19, maxZ: 5 } },
    { id: 'east1', name: 'EAST 1', x: 0, z: -46, bounds: { minX: -79, maxX: 83, minZ: -77, maxZ: -17 } },
    { id: 'east2', name: 'EAST 2', x: 63, z: 38, bounds: { minX: 32, maxX: 92, minZ: 12, maxZ: 64 } },
    { id: 'corridor', name: 'CULTURE CORRIDOR', x: 26, z: 38, bounds: { minX: 20, maxX: 32, minZ: -17, maxZ: 84 } },
    { id: 'lake', name: 'QIZHEN LAKE', x: -104, z: 36, bounds: { minX: -120, maxX: -43, minZ: -89, maxZ: 89 } },
    { id: 'garden', name: 'LAKESIDE GARDEN', x: -15, z: 40, bounds: { minX: -43, maxX: 20, minZ: 10, maxZ: 85 } },
    { id: 'road', name: 'EAST CAMPUS ROAD', x: 104, z: 0, bounds: { minX: 93, maxX: 119, minZ: -89, maxZ: 89 } },
    { id: 'library', name: 'BASIC LIBRARY', x: -19, z: -137, bounds: { minX: -93, maxX: 58, minZ: -173, maxZ: -99 } },
    { id: 'east3', name: 'EAST 3', x: 28, z: 133, bounds: { minX: -80, maxX: 95, minZ: 105, maxZ: 167 } },
    { id: 'east5', name: 'EAST 5', x: 178, z: -54, bounds: { minX: 137, maxX: 221, minZ: -88, maxZ: -16 } },
    { id: 'east67', name: 'EAST 6 / EAST 7', x: 174, z: 57, bounds: { minX: 134, maxX: 222, minZ: 13, maxZ: 151 } },
    { id: 'westbank', name: 'WEST LAKE WALK', x: -211, z: 24, bounds: { minX: -239, maxX: -181, minZ: -88, maxZ: 89 } },
  ];
  L.tactical = { buildings: [], water: [], paths: [], labels: L.zones.map(({ name, x, z }) => ({ name, x, z, small: name === 'YONGMAN HALL' || name === 'LAKESIDE GARDEN' })) };
  L.referenceNotes = 'OSM East 1 / East 2 / East 3 / East 5 / East 6-7, the Basic Library, Qizhen Lake and the official ZJU campus map; expanded to a compressed 480 x 360 m district. Existing East 1 / East 2 retain their dimensions. The west-shore route, bridge, interior routes, cover and objective positions are gameplay adaptations, not a campus survey.';
  const stone = { surface: 'stone', ink: INK.BROWN }, pale = { surface: 'ceramic', ink: INK.BLACK }, dark = { surface: 'metal', ink: INK.BLACK }, interior = { surface: 'plaster', ink: INK.BLACK };
  const glass = { surface: 'glass', ink: INK.TEAL, noCollide: true }, detail = { noCollide: true, noNav: true };
  const stairGuards = (x, z, dir, width, run = 0.85) => {
    const dx = dir === '-x' ? -1 : 0, dz = dir === '+z' ? 1 : 0;
    // Side-entry onto a high tread is physically impossible even when a coarse nav cell
    // thinks the rise is a valid step. Visible stepped parapets make the approach explicit.
    for (let i = 0; i < 7; i++) for (const s of [-1, 1]) {
      const along = (i * 2 + 1) * run, side = s * (width / 2 + 0.13);
      box(x + dx * along + dz * side, 0, z + dz * along + (dx ? side : 0), dx ? run * 2 : 0.22, (i + 1) * 0.6 + 1, dz ? run * 2 : 0.22, { ...pale, noNav: true });
    }
  };

  // The collision strips leave the lake unsupported. One visible land surface avoids
  // exposing internal box sides along coplanar joins at shallow viewing angles.
  box(-60, -0.9, 0, 120, 0.08, 180, { surface: 'water', ink: INK.TEAL, noCollide: true });
  const shore = [-100, -100, -101, -102, -102, -97, -92, -78, -62, -52, -54, -58, -61, -71, -84];
  const landOutline = [[120, -90], ...shore.flatMap((x, i) => [[x, -90 + i * 12], [x, -78 + i * 12]]), [120, 90]];
  const landShape = new THREE.Shape();
  landOutline.forEach(([x, z], i) => i ? landShape.lineTo(x, -z) : landShape.moveTo(x, -z)); landShape.closePath();
  const landSurface = new THREE.ShapeGeometry(landShape); landSurface.rotateX(-Math.PI / 2); landSurface.translate(0, 0.003, 0); addGeo(landSurface, INK.GREEN, 'foliage');
  L.tactical.water.push([[-120, -90], ...shore.flatMap((x, i) => [[x, -90 + i * 12], [x, -78 + i * 12]]), [-120, 90]]);
  L.tactical.paths.push([[93, -90], [119, -90], [119, 90], [93, 90]], [[-79, -17], [97, -17], [97, 10], [-79, 10]], [[-37, 65], [97, 65], [97, 87], [-37, 87]]);
  for (let i = 0; i < shore.length; i++) {
    const x = shore[i], z1 = -90 + i * 12, z2 = z1 + 12;
    collider((x + 120) / 2, -1.4, (z1 + z2) / 2, 120 - x, 1.4, 12);
    box(x + 9, 0.012, (z1 + z2) / 2, 18, 0.022, 12, { ...stone, ...detail });
    box(x + 0.13, -1.5, (z1 + z2) / 2, 0.3, 1.65, 12, { ...stone, noNav: true });
    if (i === 3) { rail(x + 0.35, z1, x + 0.35, -52, 0.15); rail(x + 0.35, -44, x + 0.35, z2, 0.15); }
    else rail(x + 0.35, i === 9 ? z1 + 6 : i === 7 ? 2 : z1, x + 0.35, z2, 0.15);
    if (i && shore[i - 1] !== x) {
      const a = Math.min(x, shore[i - 1]), b = Math.max(x, shore[i - 1]);
      box((a + b) / 2, -1.5, z1, b - a, 1.65, 0.3, { ...stone, noNav: true });
      if (i === 7) { rail(a + 0.35, z1, -91, z1, 0.15); rail(-85, z1, -82.8, z1, 0.15); }
      else rail(a + 0.35, z1, b + 0.35, z1, 0.15);
    }
  }
  const paving = (x1, z1, x2, z2, surface = 'stone', ink = INK.BROWN) => box((x1 + x2) / 2, 0.036, (z1 + z2) / 2, x2 - x1, 0.022, z2 - z1, { ...detail, surface, ink });
  paving(-80, -86, 97.8, -77); paving(-80, -17, 97.8, 10); paving(-37, 65, 97.8, 87);
  paving(98, -90, 112, 90, 'ground', INK.BLACK);
  paving(93, -90, 97.8, 90); paving(112.2, -90, 119, 90);
  for (let z = -83; z < 90; z += 12) box(105, 0.075, z, 0.18, 0.022, 5, { surface: 'plaster', ink: INK.ORANGE, ...detail });
  for (const z of [-10, 68]) for (let x = 99; x < 112; x += 1.7) box(x, 0.077, z, 0.8, 0.022, 4, { ...pale, ...detail });
  for (const [x1, z1, x2, z2] of [[-42, 39, -15, 58], [-34, 65, -9, 82], [-38, 12, -14, 19], [-58, -52, -39, -40], [-25, -52, -12, -40], [46, -54, 62, -39], [48, 29, 62, 47], [72, 41, 79, 49], [113, -88, 118, 88]])
    box((x1 + x2) / 2, 0.065, (z1 + z2) / 2, x2 - x1, 0.024, z2 - z1, { surface: 'foliage', ink: INK.GREEN, ...detail });
  // The stone shader supplies restrained paving joints; raised metal lines would look
  // like a coarse grid and compete with the objective markings.
  for (const [x1, z1, x2, z2] of [[-77, -60.3, 18, -33.7], [32.5, -60.3, 82, -33.7], [42.3, 24.4, 83.2, 51.6]]) {
    box((x1 + x2) / 2, 0.025, (z1 + z2) / 2, x2 - x1, 0.025, z2 - z1, { ...stone, ...detail });
  }
  const gardenPath = [[-48, 5], [-35, 23], [-22, 43], [-8, 63], [13, 79]];
  for (let i = 0; i < gardenPath.length - 1; i++) {
    const [x1, z1] = gardenPath[i], [x2, z2] = gardenPath[i + 1], dx = x2 - x1, dz = z2 - z1;
    const g = new THREE.BoxGeometry(6.2, 0.04, Math.hypot(dx, dz) + 0.3); g.rotateY(Math.atan2(dx, dz)); g.translate((x1 + x2) / 2, 0.115, (z1 + z2) / 2); addGeo(g, INK.BROWN, 'stone');
  }
  // The old cropped-block hedges move to the enlarged district perimeter; all three
  // former borders remain open so the original teaching courts connect to the new routes.
  for (const [x, z, w, d] of [[0, -179.5, 479, 0.65], [0, 179.5, 479, 0.65], [239.5, 0, 0.65, 358], [-239.5, 0, 0.65, 358]]) {
    box(x, 0, z, w, 0.75, d, { ...stone, noNav: true });
    box(x, 0.75, z, w - (w > d ? 0.1 : 0), 1.5, d + 0.9, { surface: 'foliage', ink: INK.GREEN, noNav: true });
  }

  const facade = (x1, z1, x2, z2, h) => {
    const rows = Math.max(1, Math.round((h - 4.2) / 3));
    for (let f = 0; f < rows; f++) {
      const y = 4.7 + f * (h - 4.9) / rows;
      for (const z of [z1 - 0.27, z2 + 0.27]) {
        box((x1 + x2) / 2, y, z, x2 - x1 - 1.4, 1.55, 0.08, glass);
        for (let x = x1 + 1.3; x < x2 - 0.6; x += 3.4) box(x, y - 0.08, z + (z === z1 - 0.27 ? -0.075 : 0.075), 0.22, 1.73, 0.13, { ...pale, ...detail });
        box((x1 + x2) / 2, y + 0.92, z + (z === z1 - 0.27 ? -0.07 : 0.07), x2 - x1 - 1.35, 0.07, 0.12, { ...dark, ...detail });
      }
      for (const x of [x1 - 0.27, x2 + 0.27]) {
        box(x, y, (z1 + z2) / 2, 0.08, 1.55, z2 - z1 - 1.4, glass);
        for (let z = z1 + 1.3; z < z2 - 0.6; z += 3.4) box(x + (x === x1 - 0.27 ? -0.075 : 0.075), y - 0.08, z, 0.13, 1.73, 0.22, { ...pale, ...detail });
      }
    }
    for (const z of [z1 - 0.3, z2 + 0.3]) box((x1 + x2) / 2, h - 0.32, z, x2 - x1 + 0.65, 0.18, 0.18, { ...pale, ...detail });
  };
  const wing = (x1, z1, x2, z2, h, doors = {}) => {
    L.tactical.buildings.push({ x1, z1, x2, z2 });
    const openings = xs => (xs || []).map(x => [x - 2.3, x + 2.3, 0, 3.4]);
    wallX(x1, x2, z1, 0, 4, 0.48, openings(doors.n), pale);
    wallX(x1, x2, z2, 0, 4, 0.48, openings(doors.s), pale);
    wallZ(z1 + 0.24, z2 - 0.24, x1, 0, 4, 0.48, openings(doors.w), pale);
    wallZ(z1 + 0.24, z2 - 0.24, x2, 0, 4, 0.48, openings(doors.e), pale);
    box((x1 + x2) / 2, 0.008, (z1 + z2) / 2, x2 - x1 - 0.46, 0.022, z2 - z1 - 0.46, { ...stone, ...detail });
    wallZ(z1 + 0.24, z2 - 0.24, x1 + 0.265, 0, 3.72, 0.025, openings(doors.w), { ...interior, ...detail });
    wallZ(z1 + 0.24, z2 - 0.24, x2 - 0.265, 0, 3.72, 0.025, openings(doors.e), { ...interior, ...detail });
    slab(x1 - 0.28, z1 - 0.28, x2 + 0.28, z2 + 0.28, 4, 0.28, { ...interior, noNav: true });
    box((x1 + x2) / 2, 3.98, (z1 + z2) / 2, x2 - x1 + 0.48, h - 3.98, z2 - z1 + 0.48, { ...pale, noNav: true });
    slab(x1 - 0.6, z1 - 0.6, x2 + 0.6, z2 + 0.6, h + 0.18, 0.2, { ...stone, noNav: true });
    facade(x1, z1, x2, z2, h);
    for (const [z, side, doorXs] of [[z1, -1, doors.n || []], [z2, 1, doors.s || []]]) {
      wallX(x1, x2, z - side * 0.265, 0, 3.72, 0.025, openings(doorXs), { ...interior, ...detail });
      for (let x = x1 + 2.2; x < x2 - 1.8; x += 5.1) {
        if (doorXs.some(d => Math.abs(d - x) < 4)) continue;
        for (const face of [-1, 1]) {
          const wz = z + face * 0.29;
          box(x, 1.05, wz, 2.65, 1.9, 0.08, glass);
          for (const dx of [-1.43, 0, 1.43]) box(x + dx, 0.95, wz + face * 0.075, 0.13, 2.12, 0.12, { ...pale, ...detail });
          for (const y of [0.92, 3.02]) box(x, y, wz + face * 0.07, 3, 0.12, 0.25, { ...pale, ...detail });
        }
      }
      wallX(x1, x2, z + side * 0.3, 0.12, 0.42, 0.1, openings(doorXs), { ...stone, ...detail });
      for (const x of doorXs) {
        box(x, 3.4, z + side * 1.05, 5.8, 0.2, 2.3, { ...dark, noNav: true });
        for (const dx of [-2.8, 2.8]) box(x + dx, 0, z + side * 1.85, 0.2, 3.4, 0.2, { ...pale, noNav: true });
      }
      for (let x = x1 + 1; x < x2 - 1; x += 4) {
        box(x, h + 0.24, z + side * 0.35, 0.07, 0.85, 0.07, { ...dark, ...detail });
      }
      box((x1 + x2) / 2, h + 1, z + side * 0.35, x2 - x1 - 1, 0.07, 0.07, { ...dark, ...detail });
    }
  };
  const classroom = (x, wallZPos, inward) => {
    const front = wallZPos + inward * 5.2;
    for (const dx of [-7, 7]) box(x + dx, 0, wallZPos + inward * 2.7, 0.2, 3.65, 5, { ...interior, noNav: true });
    wallX(x - 7, x + 7, front, 0, 3.65, 0.2, [[x - 2.1, x + 2.1, 0, 3.25]], { ...interior, noNav: true });
    box(x - 6.83, 1.15, wallZPos + inward * 2.7, 0.1, 1.65, 3.5, { surface: 'cloth', ink: INK.GREEN, ...detail });
    box(x - 6.72, 1.1, wallZPos + inward * 2.7, 0.28, 0.1, 3.65, { ...pale, ...detail });
    for (const dx of [-3.7, 3.7]) {
      const tz = wallZPos + inward * 2.8;
      box(x + dx, 0.78, tz, 2.8, 0.12, 1.05, { surface: 'wood', ink: INK.BROWN, ...detail });
      for (const sx of [-1.1, 1.1]) box(x + dx + sx, 0, tz, 0.09, 0.78, 0.65, { ...dark, ...detail });
      for (const sx of [-0.7, 0.7]) {
        box(x + dx + sx, 0.44, tz + inward * 0.78, 0.58, 0.09, 0.5, { surface: 'wood', ink: INK.BROWN, ...detail });
        box(x + dx + sx, 0.53, tz + inward * 1.01, 0.58, 0.45, 0.08, { surface: 'wood', ink: INK.BROWN, ...detail });
        for (const sz of [0.6, 0.96]) box(x + dx + sx, 0, tz + inward * sz, 0.08, 0.44, 0.08, { ...dark, ...detail });
      }
      collider(x + dx, 0, tz + inward * 0.25, 2.8, 0.98, 1.6, { noNav: true });
      box(x + dx - 0.55, 0.91, tz, 0.62, 0.05, 0.4, { surface: 'cloth', ink: INK.TEAL, ...detail });
    }
    box(x, 3.48, wallZPos + inward * 2.8, 4, 0.08, 0.34, { ...pale, ...detail });
  };
  const exhibition = (x, z, w, d) => {
    box(x, 0, z, w, 1.45, d, { surface: 'wood', ink: INK.BROWN, noNav: true });
    for (const side of [-1, 1]) {
      box(x, 0.28, z + side * (d / 2 + 0.05), w - 0.38, 0.88, 0.08, { surface: 'cloth', ink: INK.TEAL, ...detail });
      for (let i = 0; i < 3; i++) box(x - w * 0.3 + i * w * 0.3, 0.44, z + side * (d / 2 + 0.11), w * 0.2, 0.52, 0.03, { ...pale, ...detail });
    }
    box(x, 1.46, z, w + 0.12, 0.08, d + 0.12, { ...stone, ...detail });
  };
  // East 1 retains the long north/south wings and transverse bridges of its real footprint.
  wing(-78, -76, 82, -61, 15.4, { n: [-66, -25, 55], s: [-66, -25, 55], w: [-68], e: [-68] });
  wing(-78, -33, 82, -18, 15.4, { n: [-66, -25, 9, 55], s: [-66, -25, 9, 55], w: [-25], e: [-25] });
  wing(19, -60.65, 32, -33.35, 15.4, { n: [25.5], s: [25.5], w: [-47], e: [-47] });
  for (const x of [-48, -7, 36]) classroom(x, -75.7, 1);
  for (const x of [-47, -9, 38]) classroom(x, -18.3, -1);
  for (const x of [-74, -33, 67, 79]) {
    slab(x - 1.8, -60.6, x + 1.8, -33.4, 4.2, 0.35, { ...stone, noNav: x > 0 });
    for (const z of [-57, -37]) box(x, 0, z, 0.5, 3.85, 0.5, { ...pale, noNav: true });
    const za = x < 0 ? -55.8 : -60.6, zb = x < 0 ? -38.2 : -33.4;
    rail(x - 1.8, za, x - 1.8, zb, 4.2); rail(x + 1.8, za, x + 1.8, zb, 4.2);
  }
  // Two generous stair flights lead to a real balcony loop. The high teaching-block roofs
  // remain out of navigation, so bots never choose decorative upper storeys as destinations.
  for (const [x1, x2] of [[-76, -75.8], [-72.2, -34.8], [-31.2, 17.5]]) {
    slab(x1, -59.6, x2, -55.8, 4.2, 0.32, stone); slab(x1, -38.2, x2, -34.4, 4.2, 0.32, stone);
  }
  rail(-76, -55.8, -69, -55.8, 4.2); rail(-63, -55.8, 17.5, -55.8, 4.2);
  rail(-76, -38.2, -12, -38.2, 4.2); rail(-6, -38.2, 17.5, -38.2, 4.2);
  stairs(-66, 0, -44.6, '-z', 14, 4.2, { rise: 0.3, run: 0.8 });
  stairs(-9, 0, -49.4, '+z', 14, 4.2, { rise: 0.3, run: 0.8 });
  for (const x of [-52, -11, 45]) {
    exhibition(x, -68.4, 7, 2.2); exhibition(x, x === -11 ? -27.8 : -25.4, 7, 2.2);
  }
  for (const x of [-66, 9, 67]) {
    box(x, 4.06, -17.3, 4.3, 13, 1.3, { ...dark, noNav: true });
    box(x, 4.35, -16.59, 3.65, 12.4, 0.1, glass);
    for (let y = 4.4; y < 17; y += 1.55) box(x, y, -16.47, 3.85, 0.09, 0.11, { ...pale, ...detail });
    box(x, 17.1, -17.3, 4.8, 0.22, 1.8, { ...pale, ...detail });
  }

  // Yongman Hall is an enterable report room. Short wall collider sections follow its
  // polygonal shell; the omitted east facets connect to real portals in the cream lobby.
  const ax = -71, az = -7, ar = 11;
  L.tactical.buildings.push({ x1: -82.5, z1: -18.5, x2: -56.3, z2: 4.5 });
  const outline = Array.from({ length: 12 }, (_, i) => [ax + Math.sin(TAU * i / 12) * ar, az + Math.cos(TAU * i / 12) * ar]);
  const floorCollider = (x1, z1, x2, z2, y, t) => collider((x1 + x2) / 2, y - t, (z1 + z2) / 2, x2 - x1, t, z2 - z1);
  // Keep the proven floor boxes but draw the hall and entrance as one plinth. Its only
  // side faces follow the exterior perimeter, never a seam across the interior floor.
  const hallFloorShape = new THREE.Shape();
  for (let i = 16; i <= 56; i++) {
    const a = TAU * i / 48, x = ax + Math.sin(a) * ar, z = az + Math.cos(a) * ar;
    if (i === 16) hallFloorShape.moveTo(x, -z); else hallFloorShape.lineTo(x, -z);
  }
  hallFloorShape.lineTo(-56.5, 1.5); hallFloorShape.lineTo(-56.5, 12.5); hallFloorShape.closePath();
  const hallPlinth = new THREE.ExtrudeGeometry(hallFloorShape, { depth: 1.604, bevelEnabled: false, steps: 1 });
  hallPlinth.rotateX(-Math.PI / 2); hallPlinth.translate(0, -1.4, 0);
  hallPlinth.setIndex(Array.from({ length: hallPlinth.getAttribute('position').count }, (_, i) => i)); addGeo(hallPlinth, INK.BROWN, 'stone');
  for (let i = 0; i < 22; i++) {
    const z1 = az - ar + i, z2 = z1 + 1, zw = (z1 + z2) / 2;
    const extent = Math.sqrt(Math.max(0.5, ar * ar - Math.min(Math.abs(z1 - az), Math.abs(z2 - az)) ** 2));
    floorCollider(ax - extent, z1, ax + extent, z2, 0.2, 1.6);
    collider(ax, 5.3, zw, extent * 2, 0.4, 1, { noNav: true });
  }
  const apothem = ar * Math.cos(Math.PI / 12), panelWidth = ar * 2 * Math.sin(Math.PI / 12);
  for (let i = 0; i < 12; i++) {
    if (i === 2 || i === 3) continue;
    const a = TAU * (i + 0.5) / 12, sx = Math.sin(a), cz = Math.cos(a);
    const panel = (w, h, d, y, offset, ink, surface) => {
      const g = new THREE.BoxGeometry(w, h, d); g.rotateY(a); g.translate(ax + sx * (apothem + offset), y + h / 2, az + cz * (apothem + offset)); addGeo(g, ink, surface);
    };
    panel(panelWidth + 0.08, 5.3, 0.32, 0, 0, INK.BLACK, 'ceramic');
    panel(panelWidth + 0.04, 5.3, 0.025, 0, -0.177, INK.BLACK, 'plaster');
    for (const side of [-1, 1]) {
      panel(panelWidth - 0.55, 2.8, 0.07, 1.15, side * 0.2, INK.TEAL, 'glass');
      for (const y of [1, 4]) panel(panelWidth - 0.3, 0.15, 0.15, y, side * 0.25, INK.BLACK, 'ceramic');
    }
    const p = outline[i], q = outline[(i + 1) % 12];
    for (let j = 0; j < 4; j++) {
      const f = (j + 0.5) / 4;
      collider(p[0] + (q[0] - p[0]) * f, 0, p[1] + (q[1] - p[1]) * f, Math.abs(q[0] - p[0]) / 4 + Math.abs(sx) * 0.32, 5.3, Math.abs(q[1] - p[1]) / 4 + Math.abs(cz) * 0.32, { noNav: true });
    }
  }
  cyl(ax, 5.35, az, ar + 0.6, 0.35, { ...interior, noCollide: true, seg: 12 });
  const annexRoof = new THREE.SphereGeometry(ar + 0.6, 24, 8, 0, TAU, 0, Math.PI / 2);
  annexRoof.scale(1, 0.12, 1); annexRoof.translate(ax, 5.7, az); addGeo(annexRoof, INK.BLACK, 'ceramic');
  const cream = { surface: 'plaster', ink: INK.BROWN, noNav: true };
  floorCollider(-64.5, -12.5, -56.5, -1.5, 0.2, 0.4);
  wallX(-64.5, -56.5, -12.5, 0, 6.8, 0.35, [], cream);
  wallX(-64.5, -56.5, -1.5, 0, 6.8, 0.35, [[-62.8, -58.2, 0, 3.6]], cream);
  wallZ(-12.5, -1.5, -56.5, 0, 6.8, 0.35, [[-9.3, -4.7, 0, 3.6]], cream);
  slab(-64.75, -12.75, -56.25, -1.25, 6.95, 0.25, cream);
  for (const z of [-13, -1]) {
    const g = new THREE.BoxGeometry(0.36, 5.9, 0.4); g.rotateZ(-0.3); g.translate(-82.1, 2.7, z); addGeo(g, INK.BLACK, 'ceramic');
  }
  box(-78, 0.2, -7, 3.8, 0.4, 8, { surface: 'wood', ink: INK.BROWN });
  box(-79.8, 1.2, -7, 0.14, 2.6, 5.5, { ...dark, ...detail });
  box(-79.69, 1.34, -7, 0.07, 2.32, 5.2, { ...interior, ...detail });
  box(-77.2, 0.6, -9, 0.75, 1.05, 0.7, { surface: 'wood', ink: INK.BROWN, noNav: true });
  for (const x of [-72, -68]) for (const z of [-11, -7, -3]) {
    box(x, 0.62, z, 1.1, 0.12, 1.5, { surface: 'cloth', ink: INK.TEAL, ...detail });
    box(x + 0.48, 0.74, z, 0.15, 0.75, 1.5, { surface: 'cloth', ink: INK.TEAL, ...detail });
    box(x, 0.2, z, 0.16, 0.42, 1.25, { ...dark, ...detail });
    collider(x, 0.2, z, 1.1, 1.29, 1.5, { noNav: true });
  }
  spawn(-65.8, 0.28, -7); pickup(-78, 0.75, -6);

  // East 2 has one enclosed quadrangle in the surveyed footprint, with a lower glazed
  // eastern link. Wide portals leave both objectives reachable without jumping or grappling.
  wing(33, 13, 91, 24, 10.4, { n: [44, 73], s: [44, 73], w: [18.5], e: [18.5] });
  wing(33, 52, 91, 63, 10.4, { n: [44, 73], s: [44, 73], w: [57.5], e: [57.5] });
  wing(33, 24.4, 42, 51.6, 10.4, { w: [37], e: [37], n: [37.5], s: [37.5] });
  classroom(57, 13.3, 1); classroom(57, 62.7, -1);
  slab(83.5, 24.4, 91, 51.6, 4.2, 0.35, stone);
  slab(83, 24.1, 91.5, 51.9, 8, 0.3, { ...pale, noNav: true });
  for (const z of [26, 33, 43, 50]) for (const x of [84, 90.5]) box(x, 0, z, 0.45, 7.7, 0.45, { ...pale, noNav: true });
  rail(83.5, 24.4, 83.5, 51.6, 4.2); rail(91, 24.4, 91, 35, 4.2); rail(91, 41, 91, 51.6, 4.2);
  stairs(103, 0, 38, '-x', 14, 4.2, { rise: 0.3, run: 0.85 });
  stairGuards(103, 38, '-x', 4.2);
  for (const z of [18.5, 57.5]) for (const x of [66.5, 83]) exhibition(x, z, 5, 2.2);

  // The two-level student corridor links the teaching buildings to the southern plaza.
  L.tactical.buildings.push({ x1: 21, z1: -17.5, x2: 30.5, z2: 83 });
  slab(21, -17.5, 30.5, 83, 4.2, 0.32, stone);
  slab(20.5, -17.9, 31, 83.4, 7.7, 0.25, { ...interior, noNav: true });
  for (let z = -14; z <= 81; z += 10.5) for (const x of [21.4, 30.1]) if (!(x === 30.1 && z === 7)) box(x, 0, z, 0.45, 7.45, 0.45, { ...pale, noNav: true });
  for (const z of [4, 10]) box(30.1, 0, z, 0.45, 7.45, 0.45, { ...pale, noNav: true });
  rail(21, -17.5, 21, 68, 4.2); rail(21, 74, 21, 83, 4.2);
  rail(30.5, -17.5, 30.5, 4, 4.2); rail(30.5, 10, 30.5, 83, 4.2);
  stairs(39, 0, -4.9, '+z', 14, 4.2, { rise: 0.3, run: 0.85 });
  slab(30.5, 7, 41.1, 10, 4.2, 0.32, stone); stairGuards(39, -4.9, '+z', 4.2);
  stairs(10, 0, 58.9, '+z', 14, 4.2, { rise: 0.3, run: 0.85 });
  slab(7.9, 70.8, 21, 74, 4.2, 0.32, stone); stairGuards(10, 58.9, '+z', 4.2);
  for (const [x, z] of [[24, 13], [27, 47]]) {
    box(x, 4.2, z, 3.5, 2.2, 0.35, { surface: 'wood', ink: INK.BROWN, noNav: true });
    for (const side of [-1, 1]) for (const dx of [-0.9, 0, 0.9]) box(x + dx, 4.68, z + side * 0.23, 0.68, 1.24, 0.07, { surface: 'cloth', ink: dx === 0 ? INK.TEAL : INK.ORANGE, ...detail });
  }
  for (const z of [0, 27, 61]) exhibition(25.7, z, 3.6, 1.1);
  for (const y of [0.08, 4.22]) {
    box(25.75, y, 32.75, 8.85, 0.025, 98.4, { surface: 'wood', ink: INK.BROWN, ...detail });
    for (let z = -16; z < 82; z += 1.8) box(25.75, y + 0.029, z, 8.82, 0.007, 0.018, { ...dark, ...detail });
  }
  for (let z = -14; z <= 81; z += 5.25) {
    box(25.75, 7.15, z, 9.65, 0.27, 0.16, { ...dark, ...detail });
    box(25.75, 3.72, z, 1.3, 0.075, 0.42, { ...pale, ...detail });
  }
  for (const [x, y, z] of [[22.65, 0, 13], [28.5, 0, 43], [22.65, 4.2, -6], [28.5, 4.2, 64]]) {
    box(x, y + 0.78, z, 1.3, 0.12, 3.2, { surface: 'wood', ink: INK.BROWN, ...detail });
    for (const dz of [-1.2, 1.2]) box(x, y, z + dz, 0.1, 0.78, 0.35, { ...dark, ...detail });
    collider(x, y, z, 1.3, 0.9, 3.2, { noNav: true });
    box(x, y + 0.91, z, 0.5, 0.06, 0.75, { surface: 'cloth', ink: INK.TEAL, ...detail });
  }

  // A white colonnade bends beside the lake. The ground-level route remains visible and
  // navigable beneath it; each butt joint shares an edge rather than overlapping roof faces.
  const walk = [[-46, 4, 15, 9], [-32, 13, 24, 9], [-13, 22, 31, 9], [4, 31, 15, 9]];
  for (const [x, z, w, d] of walk) {
    slab(x - w / 2, z - d / 2, x + w / 2, z + d / 2, 3.8, 0.24, { ...interior, noNav: true });
    for (const dx of [-w / 2 + 1, w / 2 - 1]) for (const dz of [-d / 2 + 0.6, d / 2 - 0.6]) cyl(x + dx, 0, z + dz, 0.24, 3.56, { ...pale, noNav: true, seg: 8 });
    for (let dx = -w / 2 + 0.8; dx < w / 2; dx += 1.8) box(x + dx, 3.35, z, 0.11, 0.2, d - 0.6, { ...dark, ...detail });
  }
  // A short footbridge crosses an inlet west of the teaching buildings, away from either
  // team spawn. Its stone abutments and rail match the embankment around the real lake.
  slab(-91, -13, -85, 18, 0.2, 0.65, stone); slab(-91, 18, -44, 24, 0.2, 0.65, stone);
  rail(-91, -13, -91, 24, 0.2); rail(-85, -13, -85, 18, 0.2); rail(-85, 18, -44, 18, 0.2); rail(-91, 24, -44, 24, 0.2);
  L.tactical.paths.push([[-91, -13], [-85, -13], [-85, 18], [-44, 18], [-44, 24], [-91, 24]]);
  box(-88, 0.211, 2.5, 5.5, 0.025, 30.5, { surface: 'wood', ink: INK.BROWN, ...detail });
  box(-67.5, 0.211, 21, 46.5, 0.025, 5.5, { surface: 'wood', ink: INK.BROWN, ...detail });
  for (let z = -12; z < 18; z += 1.2) box(-88, 0.239, z, 5.47, 0.007, 0.022, { ...dark, ...detail });
  for (let x = -90; x < -44; x += 1.2) box(x, 0.239, 21, 0.022, 0.007, 5.47, { ...dark, ...detail });

  const planter = (x, z, w = 5, d = 3) => {
    box(x, 0, z, w, 0.65, d, { ...stone, noNav: true });
    box(x, 0.67, z, w - 0.35, 0.12, d - 0.35, { surface: 'ground', ink: INK.OLIVE, ...detail });
    const n = Math.max(2, Math.floor(w / 2));
    for (let i = 0; i < n; i++) sphere(x - w * 0.35 + i * w * 0.7 / (n - 1), 1, z, 0.62, { surface: 'foliage', ink: INK.GREEN });
  };
  const tree = (x, z, i) => {
    const h = 4.8 + i % 3 * 0.4, willow = x < -35 && z > -22, cedar = !willow && i % 4 === 0;
    cyl(x, 0, z, 0.24, h + (cedar ? 1.5 : 0), { surface: 'wood', ink: INK.BROWN, noNav: true, seg: 7 });
    if (cedar) {
      for (let j = 0; j < 4; j++) { const g = new THREE.ConeGeometry(2.3 - j * 0.4, 3.1, 9); g.translate(x, 3.7 + j * 1.3, z); addGeo(g, i % 8 ? INK.GREEN : INK.OLIVE, 'foliage'); }
    } else {
      for (let j = 0; j < 5; j++) {
        const a = j * TAU / 5 + i * 0.41, r = willow ? 1.9 : 1.65;
        const g = new THREE.SphereGeometry(r, 8, 6); g.scale(1, willow ? 1.65 : 0.85, 1);
        g.translate(x + Math.sin(a) * 1.25, h + (willow ? -0.5 : 0.7) + j % 2 * 0.6, z + Math.cos(a) * 1.2); addGeo(g, j % 3 ? INK.GREEN : INK.OLIVE, 'foliage');
      }
      sphere(x, h + 1.1, z, 1.8, { surface: 'foliage', ink: INK.GREEN, seg: 8 });
    }
  };
  const bench = (x, z, alongX = true) => {
    const w = alongX ? 3 : 0.65, d = alongX ? 0.65 : 3;
    box(x, 0.48, z, w, 0.14, d, { surface: 'wood', ink: INK.BROWN, ...detail });
    box(x + (alongX ? 0 : -0.27), 0.66, z + (alongX ? -0.27 : 0), alongX ? 3 : 0.1, 0.7, alongX ? 0.1 : 3, { surface: 'wood', ink: INK.BROWN, ...detail });
    for (const s of [-1, 1]) box(x + (alongX ? s : 0), 0, z + (alongX ? 0 : s), 0.12, 0.5, 0.45, { ...dark, ...detail });
    collider(x, 0, z, w, 1.36, d, { noNav: true });
  };
  for (const [x, z, w, d] of [[-47, -46, 9, 7], [-16, -46, 8, 7], [9, -45, 5, 8], [51, -47, 9, 8], [59, 34, 8, 6], [73, 45, 8, 4], [-14, 0, 13, 5], [7, 15, 7, 5], [4, 50, 9, 5], [-25, 61, 10, 5], [59, 71, 14, 3], [63, -82, 13, 3]]) planter(x, z, w, d);
  const trees = [[-87, -70], [-86, -50], [-85, -31], [-53, -14], [-41, -8], [-20, -9], [1, -9], [52, 3], [72, 3], [87, -9], [87, -48], [60, -47], [-46, -46], [-16, -46], [57, 43], [73, 32], [-41, 29], [-40, 46], [-49, 59], [-60, 75], [-23, 73], [-3, 77], [12, 48], [7, 60], [46, 71], [84, 71]];
  for (let z = -80; z <= 80; z += 20) trees.push([116, z]);
  trees.forEach(([x, z], i) => tree(x, z, i));
  for (const [x, z, dir] of [[-87, -61, false], [-86, -41, false], [-51, 15, false], [-42, 37, false], [-51, 67, false], [-39, -42, true], [0, -42, true], [50, 44, false], [73, 29, true], [-5, 3, true], [15, 53, false], [76, 69, true]]) bench(x, z, dir);
  for (const [x, z] of [[-89, -21], [-43, 23], [-54, 70], [91, -80], [91, -5], [93, 76], [5, 41]]) {
    cyl(x, 0, z, 0.12, 5.6, { ...dark, noNav: true, seg: 6 });
    box(x + 0.4, 5.45, z, 1.2, 0.2, 0.6, { ...pale, ...detail });
  }
  // Low-poly cycle racks and frames identify the teaching precinct without adding tiny
  // collision traps to the pedestrian routes.
  for (const z of [-7, 68]) for (let i = 0; i < 6; i++) {
    const x = 76 + i * 1.55;
    box(x, 0, z, 0.06, 0.7, 1.9, { ...dark, ...detail });
    for (const dz of [-0.72, 0.72]) { const g = new THREE.TorusGeometry(0.42, 0.055, 5, 12); g.rotateY(Math.PI / 2); g.translate(x + 0.3, 0.46, z + dz); addGeo(g, INK.BLACK, 'metal'); }
    box(x + 0.3, 0.85, z, 0.09, 0.1, 1.45, { surface: 'metal', ink: i % 2 ? INK.TEAL : INK.ORANGE, ...detail });
    box(x + 0.3, 0.88, z - 0.65, 0.65, 0.08, 0.08, { ...dark, ...detail });
    const frame = [[0.46, -0.72], [0.46, 0.72], [0.91, -0.3], [0.91, 0.36], [0.48, 0]];
    for (const [ai, bi] of [[0, 2], [2, 4], [4, 0], [4, 3], [3, 1], [2, 3], [4, 1]]) {
      const a = new THREE.Vector3(x + 0.3, frame[ai][0], z + frame[ai][1]), b = new THREE.Vector3(x + 0.3, frame[bi][0], z + frame[bi][1]), d = b.clone().sub(a);
      const g = new THREE.CylinderGeometry(0.04, 0.04, d.length(), 5);
      g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize())));
      g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2); addGeo(g, i % 2 ? INK.TEAL : INK.ORANGE, 'metal');
    }
    box(x + 0.3, 1.03, z + 0.36, 0.34, 0.08, 0.44, { ...dark, ...detail });
  }

  // Wall-mounted lettering is ordinary merged geometry, so wayfinding also works offline
  // and never adds screen-space clutter or depends on a remote font.
  const glyphs = { E: ['111', '100', '110', '100', '111'], '1': ['010', '110', '010', '010', '111'], '2': ['111', '001', '111', '100', '111'], A: ['010', '101', '111', '101', '101'], B: ['110', '101', '110', '101', '110'] };
  const sign = (x, y, z, text, facing = 1) => {
    box(x, y, z, text.length * 1.08 + 0.8, 1.65, 0.12, { ...dark, ...detail });
    for (let n = 0; n < text.length; n++) for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) if (glyphs[text[n]][row][col] === '1')
      box(x + (n - (text.length - 1) / 2) * 1.08 + (col - 1) * 0.24, y + (4 - row) * 0.24 + 0.25, z + facing * 0.1, 0.21, 0.21, 0.07, { surface: 'cloth', ink: INK.ORANGE, ...detail });
  };
  sign(9, 3.45, -16.3, 'E1'); sign(55, 3.6, -76.5, 'E1', -1);
  sign(73, 3.45, 63.5, 'E2'); sign(44, 3.45, 12.5, 'E2', -1);
  sign(-3, 3.65, -33.45, 'A', -1); sign(69, 3.65, 51.65, 'B', -1);

  L.teamSpawns = [[55, 51, 47, 43].flatMap(x => [-86, -82.5].map(z => new THREE.Vector3(x, 0.08, z))), [43, 47, 51, 55].flatMap(x => [79, 83].map(z => new THREE.Vector3(x, 0.08, z)))];
  L.teamFacing = [Math.PI, 0]; L.playerStart.copy(L.teamSpawns[1][0]);
  L.bombSites = [{ id: 'A', pos: new THREE.Vector3(-3, 0.08, -46), radius: 3 }, { id: 'B', pos: new THREE.Vector3(69, 0.08, 37), radius: 3 }];
  for (const { pos: { x, z }, id } of L.bombSites) {
    for (const dx of [-3.2, 3.2]) box(x + dx, 0.075, z, 0.12, 0.022, 6.5, { surface: 'cloth', ink: INK.ORANGE, ...detail });
    for (const dz of [-3.2, 3.2]) box(x, 0.075, z + dz, 6.3, 0.022, 0.12, { surface: 'cloth', ink: INK.ORANGE, ...detail });
    if (id === 'A') {
      for (const s of [-1, 1]) { const g = new THREE.BoxGeometry(0.18, 0.024, 2.2); g.rotateY(s * 0.4); g.translate(x + s * 0.42, 0.103, z); addGeo(g, INK.ORANGE, 'cloth'); }
      box(x, 0.091, z + 0.2, 1.1, 0.024, 0.16, { surface: 'cloth', ink: INK.ORANGE, ...detail });
    } else {
      for (const dx of [-0.7, 0.7]) box(x + dx, 0.091, z, 0.16, 0.024, 2.1, { surface: 'cloth', ink: INK.ORANGE, ...detail });
      for (const dz of [-1, 0, 1]) box(x, 0.091, z + dz, 1.3, 0.024, 0.16, { surface: 'cloth', ink: INK.ORANGE, ...detail });
    }
  }
  const groundSpots = [[-89, 0, -78], [-86, 0, -45], [-66, 0, -68], [-25, 0, -68], [55, 0, -68], [-66, 0, -25], [9, 0, -25], [55, 0, -25], [-35, 0, -2], [7, 0, 7], [49, 0, 5], [88, 0, -44], [45, 0, 38], [73, 0, 18.5], [44, 0, 57.5], [74, 0, 57.5], [3, 0, 40], [-32, 0, 55], [-34, 0, 80], [83, 0, 81]];
  for (const [x, y, z] of groundSpots) spawn(x, y + 0.08, z);
  for (const [x, y, z] of [[-49, 4.2, -57.7], [-48, 4.2, -36.3], [25, 4.2, 34], [87, 4.2, 31]]) sniper(x, y + 0.08, z);
  for (const [x, y, z] of [[-57, 0, -47], [5, 0, -48], [45, 0, -44], [-34, 0, 3], [7, 0, 37], [50, 0, 34], [76, 0, 55], [25.5, 4.2, 57], [-49, 4.2, -57.7], [87, 4.2, 46]]) pickup(x, y + 0.15, z);

  // Retain the teaching-block scale and add its real neighbouring building groups. Ground
  // rectangles meet at their edges, avoiding both coincident grass faces and hidden water floors.
  const extraGround = [[-240, -180, 240, -90], [-240, 90, 240, 180], [120, -90, 240, 90], [-240, -90, -180, 90]];
  for (const [x1, z1, x2, z2] of extraGround) {
    collider((x1 + x2) / 2, -1.4, (z1 + z2) / 2, x2 - x1, 1.4, z2 - z1);
  }
  box(-150, -0.9, 0, 60, 0.08, 180, { surface: 'water', ink: INK.TEAL, ...detail });
  L.tactical.water.push([[-180, -90], [-120, -90], [-120, 90], [-180, 90]]);
  const path = (x1, z1, x2, z2, road = false) => {
    paving(x1, z1, x2, z2, road ? 'ground' : 'stone', road ? INK.BLACK : INK.BROWN);
    L.tactical.paths.push([[x1, z1], [x2, z1], [x2, z2], [x1, z2]]);
  };
  path(98, -179, 112, -90, true); path(98, 90, 112, 179, true);
  path(120, -13, 239, 1, true); path(-238, -102, 98, -91, true); path(-238, 91, 98, 102, true);
  path(-238, -175, 237, -167); path(-238, 169, 237, 176);
  path(122, -166, 132, -14); path(122, 2, 132, 169);
  path(228, -166, 236, -13); path(228, 1, 236, 169);
  for (const [a, b] of [[-166, -102], [-91, 91], [102, 169]]) path(-211, a, -199, b);
  path(-197, -59, -182, -37); path(-198, 4, -181, 16);
  path(-91, -166, -81, -103); path(52, -166, 61, -103);
  path(-78, -114, 51, -104); path(-78, -164, 51, -154);
  path(-78, 104, 96, 105.8); path(-79, 106, -75, 166); path(88, 106, 96, 168);
  path(133, -88, 224, -81); path(133, -14, 227, -13.2); path(133, 7, 227, 15);
  path(134, 83, 226, 94); path(134, 100, 226, 106);
  for (const z of [-162, -142, -122, 111, 131, 151, 171]) box(105, 0.075, z, .18, .022, 6, { ...detail, surface: 'plaster', ink: INK.ORANGE });
  for (let x = 140; x < 236; x += 16) box(x, .075, -6, 6, .022, .18, { ...detail, surface: 'plaster', ink: INK.ORANGE });

  wing(-73, -152, 42, -137, 18.4, { n: [-57, -13, 27], s: [-57, -13, 27], w: [-145], e: [-145] });
  wing(27, -136.6, 42, -116, 18.4, { n: [34], s: [34], w: [-126], e: [-126] });
  wing(-55, -127, 26.5, -116, 10.4, { n: [-39, 6], s: [-39, 6], w: [-121], e: [-121] });
  // The library's glazed cylindrical corner is deliberately distinct from low Yongman Hall.
  cyl(-70, 0, -123, 9.2, 25.4, { surface: 'glass', ink: INK.TEAL, noCollide: true, seg: 24 });
  collider(-70, 0, -123, 17, 25.4, 17, { noNav: true });
  cyl(-70, 25.45, -123, 9.65, .55, { ...pale, ...detail, seg: 24 });
  for (let i = 0; i < 24; i++) {
    const a = i * TAU / 24; box(-70 + Math.sin(a) * 9.24, 0, -123 + Math.cos(a) * 9.24, .12, 25.4, .12, { ...dark, ...detail });
  }
  for (let y = 4; y < 25; y += 3.5) cyl(-70, y, -123, 9.28, .08, { ...dark, ...detail, seg: 24 });
  for (const x of [-46, -18, 10]) { exhibition(x, -145, 6, 1.5); planter(x, -111, 8, 3); }

  wing(-73, 106, 86, 117, 14.4, { n: [-57, -20, 63], s: [-57, -20, 63], w: [111.5], e: [111.5] });
  wing(-73, 151, 86, 162, 14.4, { n: [-57, -20, 63], s: [-57, -20, 63], w: [156.5], e: [156.5] });
  wing(19, 117.4, 32, 150.6, 14.4, { n: [25.5], s: [25.5], w: [134], e: [134] });
  path(21, 83.5, 30.5, 105.8);
  for (const z of [91, 102]) for (const x of [21.4, 30.1]) box(x, 0, z, .45, 3.65, .45, { ...pale, noNav: true });
  slab(20.5, 83.5, 31, 105.7, 3.9, .25, { ...interior, noNav: true });
  for (const x of [-59, -8, 67]) { exhibition(x, 111.5, 6, 1.6); exhibition(x, 156.5, 6, 1.6); }
  for (const [x, z] of [[-45, 135], [-10, 135], [52, 134]]) { planter(x, z, 11, 6); tree(x, z, 10); }

  wing(143, -80, 215, -67, 13.4, { n: [161, 195], s: [161, 195], w: [-73.5], e: [-73.5] });
  wing(143, -28, 215, -15, 13.4, { n: [161, 195], s: [161, 195], w: [-21.5], e: [-21.5] });
  wing(203, -66.6, 215, -28.4, 13.4, { w: [-47], e: [-47], n: [209], s: [209] });
  for (const [a, b] of [[18, 66], [109, 151]]) {
    wing(144, a, 215, a + 13, 11.4, { n: [170, 202], s: [170, 202], w: [a + 6.5], e: [a + 6.5] });
    wing(144, b, 215, b + 13, 11.4, { n: [170, 202], s: [170, 202], w: [b + 6.5], e: [b + 6.5] });
    wing(144, a + 13.4, 157, b - .4, 11.4, { n: [150.5], s: [150.5], w: [(a + b + 13) / 2], e: [(a + b + 13) / 2] });
    for (const x of [170, 197]) { planter(x, (a + b + 13) / 2, 7, 5); exhibition(x + 5, a + 6.5, 5, 1.4); }
  }
  for (const [x, z] of [[161, -49], [190, -43]]) { planter(x, z, 9, 6); tree(x, z, 7); }

  // Two broad land crossings and an eight-metre footbridge keep the west bank reachable
  // without swimming. The bridge meets an actual gap in the east-shore rail.
  slab(-185, -52, -99, -44, .2, .55, stone);
  rail(-185, -52, -99, -52, .2); rail(-185, -44, -99, -44, .2);
  L.tactical.paths.push([[-185, -52], [-99, -52], [-99, -44], [-185, -44]]);
  for (const z of [-52, -44]) for (const x of [-168, -140, -112]) box(x, .2, z, .65, 1.6, .65, { ...stone, noNav: true });
  for (const [z1, z2] of [[-90, -52], [-44, 90]]) {
    box(-180.15, -1.4, (z1 + z2) / 2, .3, 1.6, z2 - z1, { ...stone, noNav: true });
    rail(-180.35, z1, -180.35, z2, .15);
  }
  for (const [x, z] of [[-220, -126], [-222, -48], [-222, 27], [-220, 132]]) {
    slab(x - 9, z - 6, x + 9, z + 6, 3.5, .25, { ...interior, noNav: true });
    for (const dx of [-8, 8]) for (const dz of [-5, 5]) box(x + dx, 0, z + dz, .45, 3.25, .45, { ...pale, noNav: true });
    planter(x, z, 7, 3); bench(x, z + 4); bench(x, z - 4);
  }
  const extraTrees = [[-214, -164], [-187, -152], [-149, -147], [-122, -117], [-123, 120], [-159, 130], [-182, 146], [-222, 164], [-99, 155], [-90, 117], [62, -124], [80, -159], [136, -151], [185, -142], [219, -123], [73, 132], [136, 158], [226, 162]];
  for (let z = -76; z <= 78; z += 26) extraTrees.push([-191, z], [-230, z + 5]);
  for (let z = -164; z < 163; z += 28) extraTrees.push([119, z], [223, z]);
  extraTrees.forEach(([x, z], i) => tree(x, z, i + 40));
  for (const [x, z, w, d] of [[-147, -119, 16, 4], [-165, -161, 4, 13], [-129, 154, 14, 4], [-170, 115, 4, 13], [151, -144, 12, 4], [192, -111, 14, 4], [-228, -84, 5, 10], [-223, 77, 10, 4], [179, 93, 13, 4]]) planter(x, z, w, d);
  for (const [x, z] of [[-195, -116], [-191, 124], [-100, -146], [76, -107], [132, -112], [223, -99], [137, 92], [87, 173]]) {
    cyl(x, 0, z, .12, 5.6, { ...dark, noNav: true, seg: 6 }); box(x + .4, 5.45, z, 1.2, .2, .6, { ...pale, ...detail });
  }
  const addedSpots = [[-224, -158], [-204, -128], [-132, -134], [-102, -166], [-37, -164], [67, -148], [142, -160], [208, -156], [227, -113], [173, -102], [-223, -73], [-206, -26], [-188, 55], [-221, 88], [-144, -48], [153, -60], [184, -60], [191, -36], [226, -43], [135, 6], [170, 39], [199, 59], [226, 44], [174, 95], [192, 139], [226, 138], [-217, 109], [-192, 157], [-151, 141], [-102, 111], [-56, 125], [-16, 145], [47, 143], [79, 168], [134, 171], [214, 174]];
  for (const [x, z] of addedSpots) spawn(x, .08, z);
  for (const [x, z] of addedSpots.filter((_, i) => i % 2 === 0)) pickup(x, .15, z);
  // Remove hidden grass rather than relying on tiny depth offsets below distant paving.
  // Collision ground stays continuous, including beneath building floors and paths.
  const subtractFootprint = ([x1, z1, x2, z2], [a, b, c, d]) => {
    const left = Math.max(x1, a), right = Math.min(x2, c), top = Math.max(z1, b), bottom = Math.min(z2, d);
    if (left >= right || top >= bottom) return [[x1, z1, x2, z2]];
    return [[x1, z1, left, z2], [right, z1, x2, z2], [left, z1, right, top], [left, bottom, right, z2]].filter(([x, z, xx, zz]) => xx > x && zz > z);
  };
  const covered = [
    ...L.tactical.paths.map(poly => [Math.min(...poly.map(p => p[0])), Math.min(...poly.map(p => p[1])), Math.max(...poly.map(p => p[0])), Math.max(...poly.map(p => p[1]))]),
    ...L.tactical.buildings.map(({ x1, z1, x2, z2 }) => [x1, z1, x2, z2]),
  ];
  let grass = extraGround;
  for (const footprint of covered) grass = grass.flatMap(rect => subtractFootprint(rect, footprint));
  for (const [x1, z1, x2, z2] of grass) {
    const g = new THREE.PlaneGeometry(x2 - x1, z2 - z1); g.rotateX(-Math.PI / 2); g.translate((x1 + x2) / 2, .003, (z1 + z2) / 2); addGeo(g, INK.GREEN, 'foliage');
  }
  L.arenaSpawns = [...L.teamSpawns.flat(), ...L.spawns, ...L.snipers].map(p => p.clone());
  return B.finish();
}

let timesSquareAtlas;

// The real Broadway / Seventh Avenue crossing forms two tapered islands. Landmark heights
// and the five street blocks are compressed, while their order and silhouettes are retained.
function buildTimesSquare(B) {
  const { L, box, wallX, wallZ, stairs, rail, sphere, cyl, collider, addGeo, spawn, sniper, pickup, scene } = B;
  L.key='timesquare'; L.bounds={minX:-50,maxX:50,minZ:-110,maxZ:110}; L.fallY=-5;
  L.previewCam={target:[0,19,0],radius:128,height:93,speed:0.009};
  L.referenceNotes='Times Square Alliance, Wikimedia Commons street photographs and documented building footprints: Broadway crosses Seventh Avenue at the bowtie; TKTS/Duffy Square is north, One Times Square south, Marriott/One Astor/Paramount west and Nasdaq east. Compressed to 100 x 220 for matches.';
  L.zones=[
    {id:'duffy',name:'DUFFY SQUARE',x:-9,z:-64,bounds:{minX:-27,maxX:-3,minZ:-84,maxZ:-40}},
    {id:'broadway',name:'BROADWAY PLAZA',x:12,z:35,bounds:{minX:-30,maxX:29,minZ:-38,maxZ:88}},
    {id:'avenue',name:'SEVENTH AVENUE',x:0,z:-24,bounds:{minX:-5,maxX:5,minZ:-108,maxZ:108}},
    {id:'tower',name:'ONE TIMES SQUARE',x:12,z:68,bounds:{minX:4,maxX:22,minZ:51,maxZ:83}},
    {id:'marriott',name:'MARRIOTT MARQUIS',x:-38,z:-18,bounds:{minX:-50,maxX:-28,minZ:-40,maxZ:5}},
    {id:'astor',name:'ONE ASTOR PLAZA',x:-38,z:25,bounds:{minX:-50,maxX:-28,minZ:9,maxZ:42}},
    {id:'paramount',name:'PARAMOUNT',x:-39,z:65,bounds:{minX:-50,maxX:-28,minZ:52,maxZ:79}},
    {id:'arcade',name:'CITY ARCADE',x:38,z:26,bounds:{minX:28,maxX:50,minZ:10,maxZ:42}},
    {id:'north',name:'47TH STREET',x:0,z:-99,bounds:{minX:-28,maxX:28,minZ:-109,maxZ:-89}},
    {id:'south',name:'42ND STREET',x:0,z:99,bounds:{minX:-28,maxX:28,minZ:89,maxZ:109}},
  ];
  L.tactical={buildings:[],water:[],paths:[],labels:L.zones.map(({name,x,z,id})=>({name,x,z,small:['marriott','astor','paramount','arcade','avenue'].includes(id)}))};
  const detail={noCollide:true}, dark={surface:'metal',ink:INK.BLACK}, stone={surface:'stone',ink:INK.BROWN}, pale={surface:'ceramic',ink:INK.BLACK};
  const glass={surface:'glass',ink:INK.TEAL}, red={surface:'cloth',ink:INK.RED}, bronze={surface:'metal',ink:INK.BROWN};
  if(!timesSquareAtlas) {
    timesSquareAtlas=new THREE.TextureLoader().load(new URL('../assets/times-square-billboards-v2.jpg',import.meta.url).href,tex=>{tex.userData.ready=true;},undefined,()=>{timesSquareAtlas.userData.failed=true;});
    timesSquareAtlas.minFilter=THREE.LinearMipmapLinearFilter; timesSquareAtlas.magFilter=THREE.LinearFilter;
    timesSquareAtlas.wrapS=timesSquareAtlas.wrapT=THREE.ClampToEdgeWrapping; timesSquareAtlas.anisotropy=4;
    timesSquareAtlas.userData.ready=false;
  }
  L.textures=[timesSquareAtlas]; const ads=[];
  const tileUV=(g,tile,aspect=1)=>{
    const uv=g.getAttribute('uv'), col=tile%4,row=Math.floor(tile/4), inset=8.5;
    const crop=[0,2,12,13,14,15].includes(tile),cw=crop?Math.min(1,aspect):1,ch=crop?Math.min(1,1/aspect):1;
    const x=tile===16?0:col*512,y=tile===16?2048:row*512,w=tile===16?2048:512;
    for(let i=0;i<uv.count;i++) uv.setXY(i,(x+inset+((1-cw)/2+uv.getX(i)*cw)*(w-2*inset))/2048,1-(y+512-inset-((1-ch)/2+uv.getY(i)*ch)*(512-2*inset))/2560);
    return g;
  };
  const billboard=(x,y,z,w,h,yaw,tile,frame=true)=>{
    if(frame){const g=new THREE.BoxGeometry(w+0.38,h+0.38,0.34);g.rotateY(yaw);g.translate(x,y,z);addGeo(g,INK.BLACK,'metal');}
    const g=tileUV(new THREE.PlaneGeometry(w,h),tile,w/h);g.translate(0,0,0.19);g.rotateY(yaw);g.translate(x,y,z);ads.push(g);
  };
  const curvedBillboard=(x,y,z,r,h,start,arc,tile)=>{
    const back=new THREE.CylinderGeometry(r-0.08,r-0.08,h+0.4,32,1,true,start,arc);back.translate(x,y,z);addGeo(back,INK.BLACK,'metal');
    const g=tileUV(new THREE.CylinderGeometry(r,r,h,32,1,true,start,arc),tile);g.translate(x,y,z);ads.push(g);
  };
  const polygon=(points,y,ink=INK.BROWN,surface='stone')=>{
    const s=new THREE.Shape();points.forEach(([x,z],i)=>i?s.lineTo(x,-z):s.moveTo(x,-z));s.closePath();
    const g=new THREE.ShapeGeometry(s);g.rotateX(-Math.PI/2);g.translate(0,y,0);addGeo(g,ink,surface);
  };
  const line=(x1,z1,x2,z2,w,y,ink=INK.BLACK,surface='metal')=>{
    const dx=x2-x1,dz=z2-z1,g=new THREE.BoxGeometry(w,0.018,Math.hypot(dx,dz));g.rotateY(Math.atan2(dx,dz));g.translate((x1+x2)/2,y,(z1+z2)/2);addGeo(g,ink,surface);
  };
  box(0,-1,0,102,1,222,{surface:'ground',ink:INK.BLACK});
  // Each island tapers toward the crossing. Shallow collision strips follow its kerb,
  // preserving a real raised pavement without diagonal blockers above ankle height.
  const island=(z1,z2,west,east)=>{
    const pts=[[west(z1),z1],[east(z1),z1],[east(z2),z2],[west(z2),z2]];
    polygon(pts,0.122);L.tactical.paths.push(pts);
    for(let z=z1;z<z2;z+=2){const end=Math.min(z+2,z2),mid=(z+end)/2,a=west(mid),b=east(mid);collider((a+b)/2,0,mid,b-a,0.12,end-z);}
    for(let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length];line(...a,...b,0.22,0.128,INK.BROWN,'ceramic');}
  };
  island(-84,-24,z=>0.33*z+3.7,()=>-3.7);
  island(26,86,()=>4.1,z=>0.33*z-3.7);
  for(const side of [-1,1]) {
    const pts=side<0?[[-50,-110],[-30,-110],[-20,-55],[-24,0],[-25,110],[-50,110]]:[[27,-110],[50,-110],[50,110],[37,110],[28,35],[24,-30]];
    polygon(pts,0.034);L.tactical.paths.push(pts);
  }
  for(const z of [-87,-42,4,47,88]) {
    for(let x=-26;x<=30;x+=2.05) box(x,0.148,z,0.95,0.018,3.5,{...pale,...detail});
    line(-27,z-2.7,29,z-2.7,0.16,0.15,INK.BLACK,'ceramic');
  }
  for(let z=-105;z<=108;z+=10) {
    for(const x of [-0.13,0.13]) box(x,0.037,z,0.08,0.018,4.6,{surface:'cloth',ink:INK.ORANGE,...detail});
    if(Math.abs(z)>25) line(z*0.33-0.13,z-2.3,z*0.33+0.13,z+2.3,0.1,0.037,INK.ORANGE,'cloth');
  }
  for(const z of [-73,-32,27,77]) {
    box(1.85,0.04,z,0.15,0.018,2.2,{...pale,...detail});
    const shape=new THREE.Shape();shape.moveTo(-.65,0);shape.lineTo(.65,0);shape.lineTo(0,1);shape.closePath();const g=new THREE.ShapeGeometry(shape);g.rotateX(-Math.PI/2);g.translate(1.85,0.054,z-1.1);addGeo(g,INK.BLACK,'ceramic');
  }
  const footprint=(x,z,w,d)=>L.tactical.buildings.push({x1:x-w/2,z1:z-d/2,x2:x+w/2,z2:z+d/2});
  const block=(x,z,w,d,h,opts=pale)=>{box(x,0,z,w,h,d,{...opts,noNav:true});footprint(x,z,w,d);};
  const windows=(x,z,w,d,h,side,opts={})=>{
    const face=x-side*w/2-0.08*side, start=opts.start??7, gap=opts.gap??3.8, ribbon=!!opts.ribbon;
    for(let y=start;y<h-1;y+=gap){
      if(ribbon)box(face,y,z,0.12,2.1,d-0.6,{...glass,...detail});
      else for(let zz=z-d/2+1.8;zz<z+d/2-1;zz+=3.2)box(face,y,zz,0.1,1.9,1.6,{...glass,...detail});
      box(face-side*0.13,y+2.2,z,0.16,0.21,d+0.1,{...(opts.band||dark),...detail});
    }
  };
  const passage=(side,z,d)=>{
    const x=side*39,x1=side<0?-50:28,x2=side<0?-28:50;
    wallX(x1,x2,z-d/2,0,5.6,0.55,[[x-3.2,x+3.2,0,4.2]],pale);
    wallX(x1,x2,z+d/2,0,5.6,0.55,[[x-3.2,x+3.2,0,4.2]],pale);
    wallZ(z-d/2+0.28,z+d/2-0.28,side*28,0,5.6,0.55,[[z-12,z-4,0,4.2],[z+5,z+13,0,4.2]],pale);
    box(side*49.6,0,z,0.55,5.6,d,{...pale,noNav:true});
    box(side*45.7,0,z,2.2,1.1,5,{...dark,noNav:true});
    box(x,0.02,z,21.1,0.022,d-.6,{...stone,...detail});footprint(x,z,22,d);
  };

  // Marriott's enormous podium, round central drum and concrete/glass wings are the
  // dominant west-side silhouette; its long screen wraps the projecting lower volume.
  passage(-1,-17,44);
  box(-39,5.6,-17,22,12.4,44,{...pale,noNav:true});
  box(-39,18,-17,24,1.1,47,{...dark,noNav:true});
  for(const zz of [-31,0]){
    box(-42,19.1,zz,23,80,15,{...pale,noNav:true});
    box(-29,19.1,zz,3,80,15,{...pale,...detail});
    for(const dz of[-5.7,5.7])box(-27.43,20,zz+dz,.1,78,1.15,{...glass,...detail});
    for(let y=23;y<98;y+=4.2)box(-27.42,y,zz,.08,.055,14.8,{surface:'ceramic',ink:INK.BROWN,...detail});
  }
  const marriottDrum=new THREE.CylinderGeometry(8.2,8.2,16,32);marriottDrum.translate(-37,27,-16);addGeo(marriottDrum,INK.TEAL,'glass');
  for(let zz=-8.2;zz<8.2;zz+=1.5){const end=Math.min(zz+1.5,8.2),mid=(zz+end)/2,half=Math.sqrt(Math.max(0,8.2*8.2-mid*mid));collider(-37,19,-16+mid,half*2,77,end-zz,{noNav:true});}
  box(-37,35,-16,16.4,61,16.4,{...glass,...detail});
  for(let y=22;y<35;y+=3.25){const g=new THREE.TorusGeometry(8.24,.15,4,32);g.rotateX(Math.PI/2);g.translate(-37,y,-16);addGeo(g,INK.BLACK,'ceramic');}
  for(let y=37;y<96;y+=3.25)box(-28.72,y,-16,.15,.28,16.5,{...pale,...detail});
  curvedBillboard(-32.7,10.8,-17,5.8,8.4,0,Math.PI,2);
  billboard(-26.25,11.1,-17,42,10.5,Math.PI/2,16);
  billboard(-26.08,21.4,-17,39,4.6,Math.PI/2,9);
  billboard(-27.8,40,-32,14,23,Math.PI/2,3);
  for(const z of [-38.4,4.4]){box(-26.8,0,z,1.1,18,1.1,{...pale,noNav:true});box(-27.2,4.1,z,1.4,.35,1.4,{...dark,...detail});}

  // One Astor Plaza / 1515 Broadway sits south of the Marriott, with its dark tower
  // set back behind a low advertising podium and pale mechanical ribs at the crown.
  block(-39,25,22,32,19,dark);
  box(-46,19,25,22,108,26,{...glass,noNav:true});
  for(let y=22;y<124;y+=3.5)box(-34.86,y,25,.16,.22,26.2,{...dark,...detail});
  for(let z=12.8;z<38;z+=2)box(-34.76,19,z,.13,108,.075,{...pale,...detail});
  for(const z of[17,32])box(-34.56,19,z,.35,112,.72,{...pale,...detail});
  for(const z of [14,21,29,36])box(-34.5,112,z,.7,20,1.45,{...pale,...detail});
  box(-44,127,25,21,3.2,26,{...pale,...detail});
  for(const s of[-1,1]){const g=new THREE.BoxGeometry(12,.9,.8);g.rotateZ(s*.2);g.translate(-44+s*5.5,131.2,11.5);addGeo(g,INK.BLACK,'ceramic');}
  billboard(-27.78,11,25,29,15,Math.PI/2,10);
  billboard(-27.35,28,24,20,16,Math.PI/2,11);
  billboard(-28.6,50,11,16,29,Math.PI/2,12);

  // Paramount's limestone setbacks climb to the clock and gold globe, distinct from
  // the glass offices around it. The clock hands and rim are real geometry.
  block(-39,65,22,26,35,{surface:'plaster',ink:INK.BROWN});
  for(const [y,w,d,h]of[[35,20,23,22],[57,16,18,14],[71,11,12,14],[85,7,8,9]])box(-40,y,65,w,h,d,{surface:'plaster',ink:INK.ORANGE,noNav:true});
  windows(-39,65,22,26,34,-1,{start:8});
  for(let y=39;y<82;y+=4)for(const dz of[-4,0,4])box(-29.86-(y>57?3:0),y,65+dz,.12,2.5,1.3,{...glass,...detail});
  const clockFace=(x,y,z,yaw)=>{
    const g=new THREE.CylinderGeometry(2.1,2.1,.18,32);g.rotateX(Math.PI/2);g.rotateY(yaw);g.translate(x,y,z);addGeo(g,INK.OLIVE,'screen');
    for(let i=0;i<12;i++){const a=i*Math.PI/6,gg=new THREE.BoxGeometry(.16,.42,.15);gg.rotateZ(-a);gg.translate(Math.sin(a)*1.72,Math.cos(a)*1.72,.15);gg.rotateY(yaw);gg.translate(x,y,z);addGeo(gg,INK.BLACK,'metal');}
    for(const [len,a]of[[1.25,.25],[.85,-1.1]]){const gg=new THREE.BoxGeometry(.16,len,.16);gg.translate(0,len/2,.19);gg.rotateZ(a);gg.rotateY(yaw);gg.translate(x,y,z);addGeo(gg,INK.BLACK,'metal');}
  };
  clockFace(-34.35,80,65,Math.PI/2);clockFace(-40,80,58.8,Math.PI);
  cyl(-40,94,65,1.15,4,{...bronze,noNav:true});sphere(-40,99.2,65,1.65,{surface:'cloth',ink:INK.ORANGE});
  billboard(-27.6,18,65,22,18,Math.PI/2,6);
  billboard(-27.25,37,57,9,18,Math.PI/2,3);

  // Northern hotels and the east theater row use different curtain walls, masonry,
  // cornices and hanging advertisements instead of repeating one apartment facade.
  block(-39,-84,22,48,78,glass);windows(-39,-84,22,48,78,-1,{start:7,ribbon:true,band:pale,gap:3.4});
  for(const z of[-104,-89,-74,-62])box(-27.6,0,z,.45,78,.55,{...pale,...detail});
  billboard(-27.35,24,-81,29,29,Math.PI/2,1);billboard(-27.12,49,-66,16,20,Math.PI/2,15);
  block(-39,99,22,20,83,pale);windows(-39,99,22,20,82,-1,{ribbon:true});
  block(39,-88,22,44,90,dark);windows(39,-88,22,44,88,1,{ribbon:true,gap:3.6});
  box(42,90,-88,13,13,31,{...glass,...detail});
  billboard(27.5,30,-88,28,34,-Math.PI/2,12);billboard(27.2,9,-81,27,9,-Math.PI/2,8);
  block(39,-51,22,24,67,pale);windows(39,-51,22,24,65,1,{start:6,gap:3.5});
  billboard(27.5,23,-51,20,28,-Math.PI/2,9);billboard(26.95,49,-50,18,14,-Math.PI/2,14);
  block(39,-15,22,34,61,{surface:'plaster',ink:INK.BROWN});windows(39,-15,22,34,60,1,{start:8});
  billboard(27.45,27,-19,23,31,-Math.PI/2,13);billboard(27.1,9,-13,29,9,-Math.PI/2,7);
  billboard(26.9,45,-3,10,20,-Math.PI/2,3);
  passage(1,26,32);box(39,5.6,26,22,38.4,32,{surface:'plaster',ink:INK.BROWN,noNav:true});windows(39,26,22,32,44,1,{start:9,gap:3.6});
  box(38.5,44,26,23,.5,33,{...pale,...detail});
  billboard(27.15,20,26,25,24,-Math.PI/2,6);billboard(26.9,39,26,29,9,-Math.PI/2,7);
  // McDonald's twin arches provide a small street-level landmark below the theater posters.
  for(const z of[15.2,17.3]){const g=new THREE.TorusGeometry(1.05,.16,6,14,Math.PI);g.rotateY(-Math.PI/2);g.translate(26.7,4.15,z);addGeo(g,INK.ORANGE,'screen');}
  for(const z of[14.15,16.25,18.35])box(26.7,1.8,z,.25,2.4,.25,{surface:'screen',ink:INK.ORANGE,...detail});

  // Nasdaq's cylindrical corner belongs to the east side at the southern end.
  block(39,73,22,30,6,dark);
  const ng=new THREE.CylinderGeometry(9.3,9.3,39,32);ng.translate(37,25.5,73);addGeo(ng,INK.BLACK,'glass');
  for(let zz=-9;zz<9;zz+=1.5){const mid=zz+.75,half=Math.sqrt(Math.max(0,9.3*9.3-mid*mid));collider(37,6,73+mid,half*2,39,1.5,{noNav:true});}
  curvedBillboard(37,25.5,73,9.48,34,Math.PI*.92,Math.PI*.68,4);
  for(const a of[Math.PI*1.08,Math.PI*1.27,Math.PI*1.46])for(const y of[24,29,34,39]){
    const g=new THREE.BoxGeometry(1.15,1.7,.065);g.rotateY(a);g.translate(37+Math.sin(a)*9.55,y,73+Math.cos(a)*9.55);addGeo(g,INK.BLACK,'screen');
  }
  box(46,6,79,8,112,22,{...glass,noNav:true});
  for(let y=10;y<115;y+=4)box(41.92,y,79,.12,.26,22,{...pale,...detail});
  block(39,100,22,20,91,glass);windows(39,100,22,20,89,1,{ribbon:true});
  billboard(27.5,23,99,17,29,-Math.PI/2,2);

  // Deep continuation streets are scenic, outside the closed match boundary. Open gaps
  // down each road replace the old continuous end wall, so the city has a horizon.
  for(const s of[-1,1]) {
    box(0,-.1,s*145,100,.1,70,{surface:'ground',ink:INK.BLACK,...detail});
    for(const [x,z,w,d,h]of[[-37,125,24,26,81],[36,129,23,34,104],[-29,162,29,30,115],[24,170,22,34,90],[-39,200,24,30,141],[38,207,26,30,120]]){
      const zz=z*s;box(x,0,zz,w,h,d,{surface:Math.abs(x)>30?'glass':'plaster',ink:INK.BLACK,...detail});
      for(let y=8;y<h;y+=5)box(x+(x<0?w/2+.05:-w/2-.05),y,zz,.12,.35,d,{...pale,...detail});
      box(x,0,zz-s*(d/2+.05),w,h,.1,{...glass,...detail});
    }
    collider(0,0,s*111,104,180,2,{noNav:true,noGrapple:true});
    for(const x of[-23,23]){box(x,0,s*108,8,1.05,1.1,{...stone,noNav:true});for(const dx of[-2,0,2])sphere(x+dx,1.2,s*108,.55,{surface:'foliage',ink:INK.GREEN});}
    // Vehicle barriers visibly close the otherwise continuing lanes at the map boundary.
    for(const x of[-12,-8,-4,0,4,8,12])box(x,0,s*109,1.6,1.1,.75,{surface:'metal',ink:INK.ORANGE,noNav:true});
  }
  for(const x of[-51,51])collider(x,0,0,2,180,224,{noNav:true,noGrapple:true});
  collider(0,174,0,104,5,224,{noNav:true,noGrapple:true});

  // TKTS is a red glass stair over a wedge-shaped booth, with glass balustrades and
  // vertical TKTS signs. The physical risers remain shallow enough for every input mode.
  stairs(-9,0.12,-55,'-z',16,11.8,{rise:.3,run:.9,...red});
  for(let i=0;i<8;i++)for(const x of[-15.05,-2.95]){
    const height=.12+(i+1)*.6;collider(x,0,-55-(i+.5)*1.8,.22,height+.85,1.8,{noNav:true});
    box(x,height-.06,-55-(i+.5)*1.8,.075,.91,.075,{...pale,...detail});
  }
  // The opaque G-buffer cannot draw transmissive glass. Fine frames retain the real
  // clear-balustrade silhouette while its safety collision remains fully closed.
  for(const x of[-15.05,-2.95]){const g=new THREE.BoxGeometry(.09,Math.hypot(14.4,4.8),.09);g.rotateX(-Math.atan2(14.4,4.8));g.translate(x,3.56,-62.2);addGeo(g,INK.BLACK,'ceramic');}
  box(-9,0,-70.6,12.1,4.92,2.4,{...red});rail(-15,-71.75,-3,-71.75,4.92);
  for(let i=0;i<16;i++)box(-9,.12+(i+1)*.3-.045,-55-i*.9+.025,11.55,.062,.062,{...pale,...detail});
  box(-9,0.18,-71.86,11.3,3.5,.15,{...glass,...detail});
  for(const x of[-13,-9,-5])box(x,.2,-71.96,.11,3.5,.16,{...dark,...detail});
  billboard(-9,3.45,-72.02,9.6,1.15,Math.PI,5);
  for(const x of[-16.7,-1.3]){box(x,0,-64,.16,4.6,.16,{...dark,...detail});billboard(x,3,-63.8,1.3,3.3,0,5);}
  footprint(-9,-63.4,12.3,16.8);
  // Duffy's bronze figure stands against the distinctive stone Celtic-cross backing.
  box(-9,.12,-48,2.5,1.42,2.5,{...stone,noNav:true});box(-9,1.54,-48,1.2,.25,1.3,{...bronze,noNav:true});
  box(-9,1.79,-48.42,.67,3.5,.28,{...stone,noNav:true});box(-9,3.65,-48.42,2.08,.72,.3,{...stone,noNav:true});
  const crossRing=new THREE.TorusGeometry(.76,.18,6,20);crossRing.translate(-9,4,-48.39);addGeo(crossRing,INK.BROWN,'stone');
  for(const dx of[-.22,.22]){box(-9+dx,1.79,-47.85,.25,.78,.27,{...bronze,...detail});box(-9+dx,1.79,-47.75,.29,.1,.49,{...bronze,...detail});}
  const coat=new THREE.CylinderGeometry(.35,.49,1.25,8);coat.scale(1,1,.65);coat.translate(-9,2.99,-47.91);addGeo(coat,INK.BROWN,'metal');
  sphere(-9,3.84,-47.91,.28,bronze);
  for(const s of[-1,1]){const arm=new THREE.BoxGeometry(.2,.86,.23);arm.rotateZ(s*.32);arm.translate(-9+s*.43,3.08,-47.9);addGeo(arm,INK.BROWN,'metal');const fore=new THREE.BoxGeometry(.23,.2,.49);fore.rotateY(s*.5);fore.translate(-9+s*.2,2.73,-47.63);addGeo(fore,INK.BROWN,'metal');}

  // One Times Square has a six-metre north face that widens to fifteen metres south.
  // Thin collision strips follow the taper, and ads run along all three exposed faces.
  const towerNorth=52,towerSouth=82,towerWest=4.6,towerEast=z=>10.6+(z-52)*.3;
  polygon([[towerWest,52],[10.6,52],[19.6,82],[towerWest,82]],84.03,INK.BLACK,'metal');
  for(let z=52;z<82;z+=1.5){const e=towerEast(z+.75);box((towerWest+e)/2,0,z+.75,e-towerWest,84,1.5,{...dark,noNav:true});}
  const frontX=7.6;
  for(const [y,h,tile]of[[7,11,11],[21,16,1],[39,17,10],[55,12,2],[67,9,4],[77,8,1]])billboard(frontX,y,51.7,6.1,h,Math.PI,tile);
  const edgeYaw=Math.atan2(1,-.3),edgeMidX=(10.6+19.6)/2;
  for(const [y,h,tile]of[[12,18,0],[33,20,1],[55,20,12],[75,15,10]]){
    billboard(4.35,y,67,29,h,-Math.PI/2,tile);
    billboard(edgeMidX+.2,y,67,31,h,edgeYaw,tile);
    billboard(12.1,y,82.2,14.8,h,0,tile===1?9:tile);
  }
  box(7.5,84,62,4,3,6,{...pale,noNav:true});cyl(7.5,87,62,.18,8,{...dark,noNav:true});sphere(7.5,94,62,1.55,{surface:'screen',ink:INK.OLIVE,seg:16});
  footprint(12.1,67,15,30);

  const taxi = (x, z, yaw = 0) => {
    const alongX = yaw !== 0, body = (dx, y, dz, w, h, d, opts) => box(x + (alongX ? dz : dx), y, z + (alongX ? -dx : dz), alongX ? d : w, h, alongX ? w : d, opts);
    body(0, 0.32, 0, 2.3, 0.72, 5.1, { surface: 'cloth', ink: INK.ORANGE, noNav: true });
    body(0, 1.04, -0.15, 1.94, 0.66, 2.6, { surface: 'glass', ink: INK.TEAL, noNav: true });
    body(0, 1.7, -0.15, 2, 0.12, 2.7, { surface: 'cloth', ink: INK.ORANGE, noNav: true });
    for (const dz of [-1.36, 1.03]) body(0, 1.03, dz, 1.99, 0.7, 0.08, { surface: 'cloth', ink: INK.ORANGE, ...detail });
    for (const dx of [-1.02, 1.02]) body(dx, 1.02, -0.12, 0.08, 0.7, 0.14, { surface: 'cloth', ink: INK.ORANGE, ...detail });
    body(0, 1.82, -0.1, 0.85, 0.32, 0.3, { surface: 'screen', ink: INK.OLIVE, ...detail });
    for (const dx of [-1.13, 1.13]) for (const dz of [-1.65, 1.65]) {
      const g = new THREE.CylinderGeometry(0.4, 0.4, 0.18, 12); g.rotateZ(Math.PI / 2); g.translate(dx, 0.43, dz); g.rotateY(yaw); g.translate(x, 0, z); addGeo(g, INK.BLACK, 'metal');
    }
    for (const dx of [-0.76, 0.76]) body(dx, 0.67, 2.59, 0.55, 0.22, 0.07, { surface: 'screen', ink: INK.OLIVE, ...detail });
  };
  const planter=(x,z,w=4.2,d=1.4)=>{
    box(x,0,z,w,.85,d,{...stone,noNav:true});box(x,.85,z,w+.1,.1,d+.1,{...dark,noNav:true});
    for(let i=0;i<3;i++)sphere(x+(i-1)*w*.26,1.04,z,Math.min(.5,d*.4),{surface:'foliage',ink:INK.GREEN});
  };
  const kiosk=(x,z,tile)=>{
    box(x,0,z,3.4,2.75,2.8,{...dark,noNav:true});box(x,2.75,z,3.9,.25,3.3,{...pale,noNav:true});
    for(const dz of[-1.47,1.47])billboard(x,1.6,z+dz,2.6,1.8,dz<0?Math.PI:0,tile);
    footprint(x,z,3.4,2.8);
  };
  kiosk(-21,15,7);kiosk(19,-10,11);kiosk(-22,81,8);kiosk(21,-78,8);
  for(const args of[[-23,-26,1.5,7],[-17,-34,6,1.5],[-17,-18,5,1.4],[24,27,1.5,7],[18,19,6,1.5],[19,35,5,1.4],[-20,33,5,1.4],[-18,-84,5,1.4],[16,-50,4,1.4],[20,49,1.4,5],[-18,64,5,1.4],[10,-36,4,1.4]])planter(...args);
  for(const args of[[-.4,-34,0],[.4,31,0],[-23,-74,0],[25,78,0],[-23,44,0],[23,-62,0],[-21,92,Math.PI/2],[21,-91,Math.PI/2]])taxi(...args);
  for(const[x,z]of[[-19,-89],[19,-89],[-24,-43],[22,-43],[-24,7],[25,7],[-25,47],[27,47],[-25,89],[28,89]]){
    cyl(x,0,z,.13,6.5,{...dark,noNav:true});box(x+(x<0?1.3:-1.3),6.2,z,2.8,.14,.14,{...dark,...detail});
    box(x+(x<0?2.6:-2.6),5.3,z,.4,1,.35,{surface:'cloth',ink:INK.ORANGE,...detail});
    for(let i=0;i<3;i++)sphere(x+(x<0?2.6:-2.6),5.45+i*.27,z-.2,.09,{surface:'screen',ink:i===2?INK.RED:i===1?INK.ORANGE:INK.GREEN,seg:6});
    box(x,4.4,z,.15,.36,2,{surface:'cloth',ink:INK.GREEN,...detail});
  }
  for(const[x,z]of[[-9,-79],[-18,-43],[-14,-38],[12,41],[17,45],[-19,56],[20,-40],[21,-54]]){
    cyl(x,.12,z,.08,.66,{...dark,...detail});cyl(x,.78,z,.57,.07,{...dark,noNav:true});
    for(const dx of[-.95,.95]){
      box(x+dx,.48,z,.48,.065,.5,{...red,...detail});box(x+dx,.5,z+.25,.48,.46,.055,{...red,...detail});
      for(const dz of[-.19,.19]){const g=new THREE.BoxGeometry(.04,.6,.04);g.rotateZ(dx<0?.16:-.16);g.translate(x+dx,.27,z+dz);addGeo(g,INK.BLACK,'metal');}
    }
  }
  // Bollards define the triangular pedestrian edges but never block the crosswalk gaps.
  for(let z=-82;z<-25;z+=7)for(const x of[.33*z+4.25,-4.25])cyl(x,.12,z,.13,.78,{...dark,noNav:true});
  for(let z=26;z<86;z+=7)for(const x of[4.65,.33*z-4.25])if(z<49||x>towerEast(z)+1)cyl(x,.12,z,.13,.78,{...dark,noNav:true});

  // Small event-service pavilions shelter each team from the opposite starting slots.
  // Two broad side exits remain independent, so neither base becomes a one-door trap.
  L.teamSpawns=[];
  for(const[team,s,ink]of[[0,1,INK.BLUE],[1,-1,INK.ORANGE]]){
    L.teamSpawns[team]=[-9,-3,3,9].flatMap(x=>[98,103].map(z=>new THREE.Vector3(x,.08,z*s)));
    box(0,0,90*s,30,3.9,.55,{...dark,noNav:true});
    for(let x=-12;x<=12;x+=4.8){box(x,.4,90*s-s*.33,4.4,2.9,.12,{surface:'metal',ink:INK.BROWN,...detail});for(let y=.7;y<3.3;y+=.3)box(x,y,90*s-s*.42,4.2,.06,.06,{...pale,...detail});}
    for(const x of[-23,23])box(x,0,95*s,.55,4.1,10,{...dark,noNav:true});
    box(0,4,98*s,30.4,.25,16.4,{...dark,noNav:true});
    for(const x of[-15,15])box(x,0,105*s,.25,4,.25,{...dark,noNav:true});
    box(0,3.4,90*s-s*.38,13,.42,.1,{surface:'cloth',ink,...detail});
    footprint(0,90*s,30,.55);
  }
  L.teamFacing=[0,Math.PI];L.playerStart.copy(L.teamSpawns[0][0]);
  L.bombSites=[{id:'A',pos:new THREE.Vector3(-17,.08,-26),radius:3},{id:'B',pos:new THREE.Vector3(18,.08,27),radius:3}];
  const letters={A:['01110','10001','10001','11111','10001','10001','10001'],B:['11110','10001','10001','11110','10001','10001','11110']};
  for(const{id,pos:{x,z}}of L.bombSites){
    for(const dx of[-3.2,3.2])box(x+dx,.17,z,.12,.022,6.5,{surface:'cloth',ink:INK.ORANGE,...detail});
    for(const dz of[-3.2,3.2])box(x,.17,z+dz,6.3,.022,.12,{surface:'cloth',ink:INK.ORANGE,...detail});
    const rows=letters[id];for(let row=0;row<7;row++)for(let col=0;col<5;col++)if(rows[row][col]==='1')box(x+(col-2)*.32,.177,z+(row-3)*.32,.3,.022,.3,{surface:'cloth',ink:INK.ORANGE,...detail});
  }
  for(const[x,z]of[[-26,-93],[26,-94],[-21,-40],[18,-43],[-39,-30],[-39,-4],[39,14],[39,38],[-21,9],[19,4],[-20,46],[23,51],[-26,94],[24,97],[10,-82],[-20,-78]])spawn(x,.2,z);
  sniper(-9,5,-70.5);sniper(-6,5,-70.5);sniper(-22,.2,50);sniper(22,.2,-31);
  for(const[x,y,z]of[[-39,0,-17],[39,0,26],[-9,4.92,-70.5],[10,0,-25],[-17,0,-26],[18,0,27],[-20,0,62],[23,0,46],[-18,.12,-78],[17,0,-83]])pickup(x,y+.2,z);
  L.arenaSpawns=[...L.teamSpawns.flat(),...L.spawns].map(p=>p.clone());
  const result=B.finish();
  if(ads.length){const mesh=new THREE.Mesh(mergeGeometries(ads,false),makeInkMaterial({surface:'screen',map:timesSquareAtlas,ink:INK.BLACK}));mesh.matrixAutoUpdate=false;scene.add(mesh);L.meshes.push(mesh);L.billboards=mesh;}
  return result;
}

// Longevity Hill's south-facing axis, with the lake and the Long Corridor kept in their real order.
// Distances are compressed; the diamond stair, octagonal tower and four eaves retain their silhouettes.
function buildSummerPalace(B) {
  const { L, box, slab, wallX, wallZ, stairs, cyl, sphere, addGeo, collider, spawn, sniper, pickup } = B;
  L.key = 'summerpalace';
  L.bounds = { minX: -88, maxX: 88, minZ: -64, maxZ: 43 };
  L.navCell = 1; L.fallY = -12;
  const detail = { noCollide: true }, stone = { surface: 'limestone', ink: INK.BROWN }, red = { surface: 'lacquer', ink: INK.RED };
  const dark = { surface: 'metal', ink: INK.BLACK }, green = { surface: 'lacquer', ink: INK.TEAL };
  const rects = [], rect = (x1, z1, x2, z2) => [[x1, z1], [x2, z1], [x2, z2], [x1, z2]];
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const beam = (a, b, radius, ink = INK.TEAL, surface = 'lacquer', segments = 6) => {
    const av = new THREE.Vector3(...a), bv = new THREE.Vector3(...b), dir = bv.clone().sub(av);
    const g = new THREE.CylinderGeometry(radius, radius, dir.length(), segments);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
    g.translate(...av.add(bv).multiplyScalar(.5).toArray()); addGeo(g, ink, surface);
  };
  function roof(x, y, z, w, d, h, ink = INK.ORANGE, octagonal = false) {
    const turn = !octagonal && d > w; if (turn) [w, d] = [d, w];
    const roofPoint = p => turn ? [x + p[2] - z, p[1], z - p[0] + x] : p;
    const roofBeam = (a, b, ...rest) => beam(roofPoint(a), roofPoint(b), ...rest);
    const roofBox = (px, py, pz, ww, hh, dd, o) => { const p = roofPoint([px, py, pz]); box(...p, turn ? dd : ww, hh, turn ? ww : dd, o); };
    const roofSphere = (px, py, pz, rr, o) => sphere(...roofPoint([px, py, pz]), rr, o);
    const positions = [], uvs = [], indices = [], rings = 9, sides = octagonal ? 64 : 64;
    const ridge = Math.max(.1, (w - d) * .5);
    for (let r = 0; r <= rings; r++) {
      const t = r / rings, e = 1 - t, hw = ridge * t + w * .5 * e, hd = d * .5 * e + .035;
      for (let s = 0; s <= sides; s++) {
        const q = s / sides * (octagonal ? 8 : 4), side = Math.min((octagonal ? 8 : 4) - 1, Math.floor(q)), f = q - side;
        let px, pz, corner;
        if (octagonal) {
          const a = side * Math.PI / 4 + Math.PI / 8, b = a + Math.PI / 4;
          px = (Math.cos(a) * (1 - f) + Math.cos(b) * f) * w * .5 * (1 - t * .985);
          pz = (Math.sin(a) * (1 - f) + Math.sin(b) * f) * d * .5 * (1 - t * .985);
          corner = Math.pow(Math.abs(f * 2 - 1), 5);
        } else {
          const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]], a = corners[side], b = corners[(side + 1) % 4];
          px = a[0] + (b[0] - a[0]) * f; pz = a[1] + (b[1] - a[1]) * f; corner = Math.pow(Math.abs(f * 2 - 1), 5);
        }
        const yy = h * Math.pow(t, 1.8) + .28 * Math.pow(e, 7) + .48 * corner * Math.pow(e, 6);
        positions.push(x + px, y + yy, z + pz); uvs.push(s / sides, t);
        if (r < rings && s < sides) { const i = r * (sides + 1) + s; indices.push(i, i + sides + 1, i + 1, i + 1, i + sides + 1, i + sides + 2); }
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setIndex(indices); g.computeVertexNormals(); if (turn) { g.translate(-x, -y, -z); g.rotateY(Math.PI / 2); g.translate(x, y, z); } addGeo(g, ink, 'roofTile');
    const under = g.clone(); under.translate(0, -.10, 0); const ui = under.index.array;
    for (let i = 0; i < ui.length; i += 3) [ui[i + 1], ui[i + 2]] = [ui[i + 2], ui[i + 1]];
    under.computeVertexNormals(); addGeo(under, INK.TEAL, 'lacquer');
    if (!octagonal) {
      roofBox(x, y + h - .05, z, Math.max(.3, w - d), .23, .22, { ...green, ...detail });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        roofBeam([x + sx * w * .38, y + .3, z + sz * d * .39], [x + sx * w * .505, y + .92, z + sz * d * .505], .085);
        roofSphere(x + sx * w * .50, y + 1.02, z + sz * d * .50, .14, { surface: 'roofTile', ink });
      }
      // Separate shallow parallel tile rolls make the roof legible at courtyard distance.
      for (let px = -w * .46; px <= w * .46; px += .5) for (const side of [-1, 1]) {
        const lim = Math.min(1, Math.max(.05, (w * .5 - Math.abs(px)) / (d * .5)));
        const count = Math.max(2, Math.round(lim * 5));
        for (let j = 0; j < count; j++) {
          const t1 = j / 5, t2 = Math.min(lim, (j + 1) / 5), y1 = y + h * t1 * t1 + .29 * Math.pow(1 - t1, 7), y2 = y + h * t2 * t2 + .29 * Math.pow(1 - t2, 7);
          roofBeam([x + px, y1 + .035, z + side * d * .5 * (1 - t1)], [x + px, y2 + .035, z + side * d * .5 * (1 - t2)], .04, ink, 'roofTile', 5);
        }
      }
    } else {
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4 + Math.PI / 8;
        roofBeam([x + Math.cos(a) * w * .40, y + .42, z + Math.sin(a) * d * .40], [x + Math.cos(a) * w * .515, y + .98, z + Math.sin(a) * d * .515], .09);
      }
    }
  }
  function carvedRail(x1, z1, x2, z2, y, collide = true) {
    const length = Math.hypot(x2 - x1, z2 - z1), n = Math.max(1, Math.ceil(length / 1.8)), ax = Math.abs(x2 - x1) > Math.abs(z2 - z1);
    for (let i = 0; i <= n; i++) { const t = i / n, x = x1 + (x2 - x1) * t, z = z1 + (z2 - z1) * t;
      box(x, y, z, .22, 1.05, .22, { ...stone, ...detail }); sphere(x, y + 1.12, z, .15, { ...stone, seg: 6 });
    }
    for (const height of [.35, .84]) box((x1 + x2) / 2, y + height, (z1 + z2) / 2, ax ? length : .13, .14, ax ? .13 : length, { ...stone, ...detail });
    if (collide) collider((x1 + x2) / 2, y, (z1 + z2) / 2, ax ? length : .2, 1.05, ax ? .2 : length, { noNav: true, noShoot: true });
  }
  function hall(x, y, z, w, d, h, open = false) {
    const fw = w - 1.6, fd = d - 1.6;
    box(x, y, z, fw, .18, fd, { ...stone, noNav: true });
    if (!open) {
      wallX(x - fw / 2, x + fw / 2, z + fd / 2, y + .18, h - .18, .34, [[x - 3, x + 3, 0, 3.4]], red);
      wallX(x - fw / 2, x + fw / 2, z - fd / 2, y + .18, h - .18, .34, [[x - 3, x + 3, 0, 3.4]], red);
      wallZ(z - fd / 2, z + fd / 2, x - fw / 2, y + .18, h - .18, .34, [[z - 1.7, z + 1.7, 0, 3.4]], red);
      wallZ(z - fd / 2, z + fd / 2, x + fw / 2, y + .18, h - .18, .34, [[z - 1.7, z + 1.7, 0, 3.4]], red);
      rects.push({ x1: x - fw / 2, z1: z - fd / 2, x2: x + fw / 2, z2: z + fd / 2 });
    }
    const n = Math.max(2, Math.round(fw / 4));
    for (let i = 0; i <= n; i++) for (const side of [-1, 1]) {
      const px = x - fw / 2 + i / n * fw, pz = z + side * fd / 2;
      cyl(px, y + .18, pz, .23, h, red); cyl(px, y, pz, .34, .23, stone);
      box(px, y + h - .5, pz, 1.15, .25, .8, { ...green, ...detail }); box(px, y + h - .2, pz, 1.75, .19, 1.0, { ...green, ...detail });
    }
    for (const side of [-1, 1]) {
      box(x, y + h - .9, z + side * fd / 2, fw, .6, .32, { ...green, ...detail });
      for (let px = x - fw / 2 + 1.8; px < x + fw / 2; px += 3.6) {
        box(px, y + h - .72, z + side * (fd / 2 + .17), 1.8, .18, .035, { surface: 'roofTile', ink: INK.ORANGE, ...detail });
        if (!open && Math.abs(px - x) > 4) {
          box(px, y + 1.3, z + side * (fd / 2 + .18), 2.0, 1.8, .04, { ...dark, ...detail });
          for (const dx of [-.8, -.4, 0, .4, .8]) box(px + dx, y + 1.3, z + side * (fd / 2 + .22), .055, 1.8, .05, { ...red, ...detail });
          for (const yy of [1.6, 2.2, 2.8]) box(px, y + yy, z + side * (fd / 2 + .25), 1.98, .05, .055, { ...red, ...detail });
        }
      }
    }
    box(x, y + h, z, fw, .24, fd, { ...red, noNav: true }); roof(x, y + h + .1, z, w + 1.5, d + 1.5, Math.min(3.3, d * .31));
  }
  function pine(x, y, z, h = 9, seed = 0, collide = true) {
    cyl(x, y, z, .24 + h * .016, h * .6, { surface: 'wood', ink: INK.BROWN, noCollide: !collide });
    for (let k = 0; k < 5; k++) {
      const a = seed + k * 2.399, spread = h * (.15 + (k % 2) * .035), by = y + h * (.47 + k * .065), ex = x + Math.cos(a) * spread, ez = z + Math.sin(a) * spread;
      beam([x, by - .8, z], [ex, by, ez], .15, INK.BROWN, 'wood');
      const g = new THREE.SphereGeometry(h * .24, 12, 8); const verts = g.attributes.position;
      for (let j = 0; j < verts.count; j++) { const vx = verts.getX(j), vy = verts.getY(j), vz = verts.getZ(j), rough = 1 + .12 * Math.sin(vx * 4.5 + vy * 3.8 + seed) * Math.cos(vz * 4.1 + k); verts.setXYZ(j, vx * rough, vy * rough, vz * rough); }
      g.computeVertexNormals(); g.scale(1.15, .58, .9); g.translate(ex, by + .35, ez); addGeo(g, k % 3 ? INK.GREEN : INK.OLIVE, 'foliage');
    }
  }
  function rock(x, y, z, r = 1.3, h = 2.2, collide = true) {
    const g = new THREE.DodecahedronGeometry(1, 0); g.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i)); g.scale(r, h * .5, r * .74); g.rotateY(x * .57 + z); g.translate(x, y + h * .5, z); addGeo(g, INK.BROWN, 'limestone');
    if (collide) collider(x, y, z, r * 1.4, h * .82, r, { noNav: true });
  }
  // Solid land and a true non-walkable lake edge keep respawns away from decorative scenery.
  box(0, -1, -10.5, 176, 1, 107, { surface: 'grass', ink: INK.GREEN });
  box(0, -.65, 137, 650, .15, 190, { surface: 'water', ink: INK.TEAL, ...detail });
  for (const [x, z, w, d] of [[-89, -10, 2, 110], [89, -10, 2, 110], [0, -65, 180, 2], [0, 43.4, 180, 1]]) collider(x, -2, z, w, 110, d, { noNav: true, noShoot: true, noGrapple: true });
  collider(0, 85, -10, 182, 3, 114, { noNav: true, noShoot: true, noGrapple: true });
  // Forecourt paving, orthogonal garden routes and the uninterrupted lakeshore promenade.
  const paths = [[-86, 17, 86, 42], [-82, -12, -29, 17], [29, -12, 82, 17], [-85, -24, -31, -12], [31, -24, 85, -12], [-34, -24, -26, 20], [26, -24, 34, 20]];
  for (const [x1, z1, x2, z2] of paths) box((x1 + x2) / 2, .008, (z1 + z2) / 2, x2 - x1, .028, z2 - z1, { ...stone, ...detail });
  box(0, -1, 41.6, 176, 1.15, 2.0, { ...stone, noNav: true });
  carvedRail(-87, 42, 87, 42, .14);
  for (let x = -84; x <= 84; x += 4.2) box(x, .047, 35, .035, .014, 12.5, { surface: 'brick', ink: INK.BLACK, ...detail });
  for (const z of [31, 37, 40]) box(0, .047, z, 174, .014, .035, { surface: 'brick', ink: INK.BLACK, ...detail });

  // The Long Corridor's repeated bays are open on both sides, with deep painted soffits.
  function corridor(x1, x2, z) {
    slab(x1, z - 2.55, x2, z + 2.55, .14, .18, stone);
    for (let x = x1 + .35; x <= x2 - .3; x += 3.8) for (const side of [-1, 1]) {
      cyl(x, .14, z + side * 2.15, .16, 3.9, red); cyl(x, .14, z + side * 2.15, .24, .17, stone);
      box(x, 3.35, z + side * 2.15, 1.05, .27, .7, { ...green, ...detail });
      beam([x - .75, 3.5, z + side * 2.15], [x, 2.95, z + side * 2.15], .065);
      beam([x + .75, 3.5, z + side * 2.15], [x, 2.95, z + side * 2.15], .065);
    }
    for (const side of [-1, 1]) {
      box((x1 + x2) / 2, 3.65, z + side * 2.15, x2 - x1, .48, .30, { ...green, ...detail });
      box((x1 + x2) / 2, 3.76, z + side * 2.315, x2 - x1, .095, .025, { surface: 'roofTile', ink: INK.ORANGE, ...detail });
      for (let x = x1 + 1.7; x < x2 - 1; x += 3.8) {
        box(x, 3.82, z + side * 2.325, 2.25, .2, .028, { surface: 'lacquer', ink: INK.BLUE, ...detail });
        for (const dx of [-.73, 0, .73]) sphere(x + dx, 3.93, z + side * 2.35, .095, { surface: 'roofTile', ink: INK.ORANGE, seg: 5 });
      }
    }
    box((x1 + x2) / 2, 4.02, z, x2 - x1, .16, 4.4, { ...red, noNav: true });
    roof((x1 + x2) / 2, 4.12, z, x2 - x1 + 1.5, 5.65, 1.25, INK.GREEN);
  }
  corridor(-83, -8, 23); corridor(8, 83, 23);
  hall(0, 0, 23, 12.5, 8, 5.1, true);
  // Small seasonal corridor pavilions interrupt the long roofline as in the real promenade.
  for (const x of [-50, 50]) {
    for (const dx of [-3.2, 3.2]) for (const dz of [-3.2, 3.2]) cyl(x + dx, .14, 23 + dz, .2, 4.6, red);
    roof(x, 4.75, 23, 10, 10, 2.1, INK.GREEN, true);
  }

  // Paiyun forecourt: wide processional stair, side entries and a traversable main hall.
  box(0, 0, -8.5, 52, 4, 27, stone);
  stairs(0, 0, 17, '-z', 16, 8, { rise: .25, run: .75, ...stone });
  for (let i = 0; i < 16; i++) for (const side of [-1, 1]) box(side * 4.18, 0, 17 - (i + .5) * .75, .30, (i + 1) * .25 + 1.2, .754, { ...stone, noNav: true });
  for (const side of [-1, 1]) {
    stairs(side * 38, 0, -7, side < 0 ? '+x' : '-x', 16, 5, { rise: .25, run: .75, ...stone });
    for (let i = 0; i < 16; i++) for (const sz of [-1, 1]) box(side * (38 - (i + .5) * .75), 0, -7 + sz * 2.65, .754, (i + 1) * .25 + 1.2, .30, { ...stone, noNav: true });
    carvedRail(side * 5, 5.05, side * 25.8, 5.05, 4);
    wallZ(-21.8, 4.9, side * 25.8, 4, 1.05, .24, [[-10, -4, 0, 1.05]], stone);
    hall(side * 20.8, 4, -9, 7.8, 15.6, 4.0, true);
  }
  hall(0, 4, -10.1, 24, 9.4, 5.5, false);
  for (const side of [-1, 1]) {
    cyl(side * 10, 4, .2, .65, .7, stone); sphere(side * 10, 5, .2, .55, { ...stone, seg: 8 });
    box(side * 10, 4.56, -.18, .76, .8, .62, { ...stone, noNav: true });
    rock(side * 23.0, 4, 1.7, .95, 1.5);
  }

  // Foxiangge's pale platform and diamond stair are actual walkable geometry, not a facade.
  box(0, 0, -44.5, 56, 16, 31, stone);
  box(0, 4, -28.2, 51, 12, 1.6, stone);
  for (const side of [-1, 1]) {
    stairs(0, 4, -20, side < 0 ? '-x' : '+x', 24, 3.6, { rise: .25, run: 1, ...stone });
    for (let i = 2; i < 24; i++) for (const sz of [-1, 1]) box(side * (i + .5), 4, -20 + sz * 1.94, 1.004, (i + 1) * .25 + 1.2, .24, { ...stone, noNav: true });
    slab(side < 0 ? -27 : 24, -27, side < 0 ? -24 : 27, -18.2, 10, .35, stone);
    stairs(side * 24, 10, -24.8, side < 0 ? '+x' : '-x', 24, 3.6, { rise: .25, run: 1, ...stone });
    for (let i = 2; i < 24; i++) box(side * (i + .5), 10, -26.74, 1.004, (24 - i) * .25 + 1.2, .24, { ...stone, noNav: true });
    // Coloured stone handrails follow the slope without introducing stair-height blockers.
    for (const upper of [false, true]) for (const dz of [-1.8, 1.8]) {
      const ay = upper ? 10 : 4, ax = upper ? side * 24 : 0, bx = upper ? 0 : side * 24, zz = upper ? -24.8 : -20;
      beam([ax, ay + 1.05, zz + dz], [bx, ay + 7.05, zz + dz], .095, INK.GREEN, 'roofTile');
      for (let k = 0; k <= 24; k += 2) {
        const t = k / 24, xx = ax + (bx - ax) * t;
        box(xx, ay + 6 * t, zz + dz, .16, 1.05, .16, { ...stone, ...detail });
      }
    }
    hall(side * 22, 16, -33, 9, 7, 4.0, true);
    carvedRail(side * 4.6, -29, side * 17, -29, 16);
  }
  slab(-1.5, -21.5, 1.5, -16.8, 4.5, .5, stone);
  slab(-1.5, -30.2, 1.5, -22.9, 16, .3, stone);
  // An octagonal red body, four swept eaves and a narrow gilded finial identify the tower.
  const tx = 0, tz = -43;
  const body = new THREE.CylinderGeometry(7.9, 8.6, 25.6, 8); body.rotateY(Math.PI / 8); body.translate(tx, 28.8, tz); addGeo(body, INK.RED, 'lacquer');
  collider(tx, 16, tz, 16.0, 27, 16.0, { noNav: true });
  for (const [yy, rr, hh] of [[19, 12.2, 1.65], [26.3, 11.2, 1.7], [33.9, 10.3, 1.9], [41.1, 10.0, 5.0]]) {
    roof(tx, yy, tz, rr * 2, rr * 2, hh, INK.ORANGE, true);
    const collar = new THREE.CylinderGeometry(rr * .89, rr * .89, .42, 8); collar.rotateY(Math.PI / 8); collar.translate(tx, yy -.25, tz); addGeo(collar, INK.TEAL, 'lacquer');
  }
  for (const yy of [20.9, 28.4, 36.2]) for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 4, nx = Math.sin(a), nz = Math.cos(a), angle = a, face = (8.6 - .7 * (yy + 1.65 - 16) / 25.6) * Math.cos(Math.PI / 8) + .10;
    const panel = new THREE.BoxGeometry(4.8, 3.4, .075); panel.rotateY(angle); panel.translate(tx + nx * face, yy + 1.65, tz + nz * face); addGeo(panel, INK.BLACK, 'metal');
    for (let j = -2; j <= 2; j++) {
      const px = tx + nx * (face + .12) + Math.cos(a) * j * .9, pz = tz + nz * (face + .12) - Math.sin(a) * j * .9;
      cyl(px, yy, pz, .085, 3.5, { ...red, ...detail });
    }
    for (const h of [.35, 1.25, 2.65, 3.35]) {
      const g = new THREE.BoxGeometry(5.2, .10, .09); g.rotateY(angle); g.translate(tx + nx * (face + .14), yy + h, tz + nz * (face + .14)); addGeo(g, INK.ORANGE, 'roofTile');
    }
    const g = new THREE.BoxGeometry(5.5, .50, .15); g.rotateY(angle); g.translate(tx + nx * 8.0, yy + 3.7, tz + nz * 8.0); addGeo(g, INK.TEAL, 'lacquer');
  }
  cyl(0, 46.0, tz, .32, 1.65, { surface: 'roofTile', ink: INK.ORANGE, ...detail }); sphere(0, 47.7, tz, .58, { surface: 'roofTile', ink: INK.ORANGE });

  // Wooded hill shoulders conceal the map boundary; their masses stay outside the fighting lanes.
  for (const side of [-1, 1]) {
    const g = new THREE.SphereGeometry(1, 24, 14); g.scale(66, 23, 40); g.translate(side * 46, -2.5, -65); addGeo(g, INK.GREEN, 'grass');
    for (let i = 0; i < 35; i++) {
      const x = side * (29 + (i * 17.17 % 66)), z = -32 - (i * 8.61 % 36), k = Math.max(0, 1 - ((x - side * 46) / 66) ** 2 - ((z + 65) / 40) ** 2);
      pine(x, Math.sqrt(k) * 23 - 2.5, z, 7 + i % 5, i * 2.1, false);
    }
    box(side * 58, 0, -28.3, 60, 3.5, 2.5, { surface: 'brick', ink: INK.BLACK, noNav: true });
    for (let i = 0; i < 10; i++) rock(side * (31 + i * 5.6), 1, -27.8, 2 + i % 3 * .3, 3.6, false);
    // Courtyard wings and screen walls create two sheltered entrances for each base.
    box(side * 57, 0, 0, 1.3, 3.5, 15, { surface: 'brick', ink: INK.BLACK, noNav: true });
    roof(side * 57, 3.5, 0, 2.1, 15.8, .8, INK.BLACK);
    hall(side * 76, 0, -18.3, 17.5, 9.6, 4.6, false);
    for (const zz of [-8.6, 9.2]) {
      box(side * 70.8, 0, zz, 7.2, .5, 1.25, stone); box(side * 70.8, .5, zz, 6.8, 1.2, .95, { surface: 'foliage', ink: INK.GREEN, noNav: true });
    }
    for (const [xx, zz, hh] of [[45, -16, 9], [36, 12.7, 8.5], [78, 14.7, 10], [83, -2, 10], [46, 7.5, 9]]) pine(side * xx, 0, zz, hh, xx);
    // Low garden objects provide cover without turning the site entrances into choke points.
    for (const [xx, zz, r, h] of [[41, -.8, 2.4, 2.1], [33, 11.5, 1.1, 1.4], [48, -17.2, 1.5, 1.8], [20, 32.2, 1.4, 1.3]]) rock(side * xx, 0, zz, r, h);
    for (const zz of [-.5, 12.5]) box(side * 47.5, 0, zz, 3.7, .62, .9, { ...stone, noNav: true });
    for (let i = 0; i < 4; i++) {
      const x = side * (32 + i * 14), z = 38.4;
      cyl(x, 0, z, .2, 5.5, { surface: 'wood', ink: INK.BROWN });
      for (let k = 0; k < 5; k++) {
        const a = k * Math.PI * .4 + i, ex = x + Math.cos(a) * 1.4, ez = z + Math.sin(a) * 1.4;
        const g = new THREE.SphereGeometry(1.5, 8, 7); g.scale(.65, 1.5, .65); g.translate(ex, 4.5, ez); addGeo(g, INK.GREEN, 'foliage');
      }
    }
  }
  // Bronze incense burners and stone benches read as site-specific cover, not generic crates.
  for (const x of [-13, 13]) {
    cyl(x, 4, -1.2, .68, .25, stone); cyl(x, 4.25, -1.2, .5, 1.35, { surface: 'metal', ink: INK.TEAL, noNav: true });
    roof(x, 5.6, -1.2, 1.65, 1.65, .5, INK.GREEN, true); sphere(x, 6.2, -1.2, .15, { surface: 'metal', ink: INK.TEAL });
  }
  for (const [x, z] of [[-32, 30], [54, 31], [-66, 31]]) {
    box(x, 0, z, 3.8, .72, 1.1, { ...stone, noNav: true });
    box(x, .73, z - .43, 3.8, .65, .24, { ...stone, noNav: true });
  }
  // Boats and the far-shore bridge are scenery beyond the balustrade, never respawn surfaces.
  for (const [x, z, s] of [[-48, 66, 1], [26, 82, .9], [74, 61, .8]]) {
    const g = new THREE.SphereGeometry(1, 12, 6); g.scale(3.8 * s, .5 * s, 1.4 * s); g.translate(x, -.05, z); addGeo(g, INK.ORANGE, 'lacquer');
    for (const dx of [-1.8, 1.8]) for (const dz of [-.8, .8]) cyl(x + dx * s, .1, z + dz * s, .07, 1.8 * s, { ...red, ...detail });
    roof(x, 1.9 * s, z, 4.5 * s, 2.5 * s, .65 * s, INK.GREEN);
  }
  for (let k = 0; k < 17; k++) {
    const x = 70 + k * 4.0, z = 167, y = 2 + Math.sin(k / 16 * Math.PI) * 4.0;
    box(x, -.8, z, .6, y + .8, 4, { ...stone, ...detail }); box(x + 1.7, y, z, 3.8, .5, 4.6, { ...stone, ...detail });
    const arch = new THREE.TorusGeometry(1.72, .31, 5, 12, Math.PI); arch.translate(x + 2, y - 1.3, z - 2); addGeo(arch, INK.BROWN, 'limestone');
  }
  const island = new THREE.SphereGeometry(1, 20, 10); island.scale(90, 5, 25); island.translate(185, -1, 166); addGeo(island, INK.GREEN, 'grass');
  hall(173, 3, 165, 16, 11, 6, true);

  L.teamSpawns = [[-76, -72, -68, -64].flatMap(x => [-4.5, 3.5].map(z => v(x, .08, z))), [76, 72, 68, 64].flatMap(x => [-4.5, 3.5].map(z => v(x, .08, z)))];
  L.teamFacing = [-Math.PI / 2, Math.PI / 2]; L.playerStart.copy(L.teamSpawns[0][3]);
  L.bombSites = [{ id: 'A', pos: v(39, .08, 30), radius: 3.0 }, { id: 'B', pos: v(0, 4.08, .7), radius: 3.0 }];
  for (const { pos } of L.bombSites) {
    for (const dx of [-3.2, 3.2]) box(pos.x + dx, pos.y - .025, pos.z, .08, .015, 6.5, { surface: 'lacquer', ink: INK.ORANGE, ...detail });
    for (const dz of [-3.2, 3.2]) box(pos.x, pos.y - .025, pos.z + dz, 6.5, .015, .08, { surface: 'lacquer', ink: INK.ORANGE, ...detail });
  }
  for (const [x, y, z] of [[-71, 0, 1], [71, 0, 1], [-36, 0, -17], [36, 0, -17], [-48, 0, 14], [48, 0, 14], [-59, .14, 23], [59, .14, 23], [-8, 4, -1], [8, 4, -1], [-12, 16, -33], [12, 16, -33], [-36, 0, 34], [39, 0, 30], [-12, 0, 37], [10, 0, 37]]) spawn(x, y + .08, z);
  sniper(-12, 16.08, -31.3); sniper(12, 16.08, -31.3);
  for (const [x, y, z] of [[-42, 0, -8], [42, 0, -8], [-16, 4, -17], [16, 4, -17], [-59, .14, 23], [59, .14, 23], [0, 16, -31.2], [-9, 0, 32]]) pickup(x, y + .1, z);
  L.arenaSpawns = [...L.teamSpawns.flat(), ...L.spawns].map(p => p.clone());
  L.zones = [
    { name: 'Long Corridor', x: 0, z: 23, bounds: { minX: -87, maxX: 87, minZ: 18, maxZ: 27 } },
    { name: 'Paiyun Courtyard', x: 0, z: -2, bounds: { minX: -28, maxX: 28, minZ: -22, maxZ: 17 } },
    { name: 'Tower of Buddhist Incense', x: 0, z: -39, bounds: { minX: -28, maxX: 28, minZ: -62, maxZ: -22 } },
    { name: 'Kunming Lakeshore', x: 0, z: 34, bounds: { minX: -88, maxX: 88, minZ: 27, maxZ: 43 } },
    { name: 'West Garden', x: -65, z: -5, bounds: { minX: -88, maxX: -28, minZ: -27, maxZ: 18 } },
    { name: 'East Garden', x: 65, z: -5, bounds: { minX: 28, maxX: 88, minZ: -27, maxZ: 18 } }
  ];
  L.tactical = { buildings: [...rects, { x1: -8, z1: -51, x2: 8, z2: -35 }], water: [rect(-88, 42, 88, 55)], paths: [...paths.map(r => rect(...r)), rect(-26, -22, 26, 5), rect(-28, -60, 28, -29)], labels: [
    { name: 'Long Corridor', x: -40, z: 23, small: true }, { name: 'Paiyun Courtyard', x: 0, z: 0, small: true },
    { name: 'Foxiangge', x: 0, z: -44, small: true }, { name: 'Kunming Lake', x: 0, z: 40, small: true },
    { name: 'West Garden', x: -68, z: 1, small: true }, { name: 'East Garden', x: 68, z: 1, small: true }
  ] };
  return B.finish();
}

// A compressed view of the surviving Dashuifa / Guanshuifa axis, not a reconstruction of
// the lost palaces. The photographs guide each remaining scroll, column and panel group.
function buildYuanmingyuan(B) {
  const {L,box,slab,stairs,wallX,wallZ,cyl,sphere,collider,addGeo,spawn,sniper,pickup}=B;
  L.key='yuanmingyuan';L.bounds={minX:-70,maxX:70,minZ:-64,maxZ:64};L.fallY=-5;L.navCell=1;
  L.previewCam={target:[0,2,-8],radius:84,height:44,speed:.009};
  L.referenceNotes='Surviving Western Mansions ruins: Wikimedia Commons 2009/2012/2013 Dashuifa and Yuanyingguan photographs, 2019 Guanshuifa photographs, and the Xiyang Lou plan. The north-south landmark order is retained; paths, garden edges, cover, bases and the 140 x 128 playable crop are match-design adaptations.';
  L.zones=[
    {id:'yuanyingguan',name:'YUANYINGGUAN RUINS',x:0,z:-43,bounds:{minX:-20,maxX:20,minZ:-55,maxZ:-30}},
    {id:'dashuifa',name:'DASHUIFA',x:0,z:-15,bounds:{minX:-18,maxX:18,minZ:-25,maxZ:-7}},
    {id:'fountains',name:'GRAND FOUNTAIN BASINS',x:0,z:5,bounds:{minX:-21,maxX:21,minZ:-7,maxZ:18}},
    {id:'guanshuifa',name:'GUANSHUIFA',x:0,z:30,bounds:{minX:-18,maxX:18,minZ:20,maxZ:40}},
    {id:'west',name:'WEST RUINS GARDEN',x:-36,z:-24,bounds:{minX:-51,maxX:-19,minZ:-55,maxZ:42}},
    {id:'east',name:'EAST STONE GARDEN',x:34,z:27,bounds:{minX:20,maxX:51,minZ:-54,maxZ:53}},
    {id:'south',name:'SOUTH GARDEN WALK',x:0,z:49,bounds:{minX:-53,maxX:53,minZ:41,maxZ:61}},
  ];
  L.tactical={buildings:[],water:[],paths:[],labels:L.zones.map(({name,x,z})=>({name,x,z,small:name.includes('GARDEN')}))};
  const stone={surface:'limestone',ink:INK.BROWN},oldStone={surface:'stone',ink:INK.BROWN},brick={surface:'brick',ink:INK.BROWN};
  const detail={noCollide:true},grass={surface:'grass',ink:INK.GREEN},dark={surface:'metal',ink:INK.BLACK};
  const foot=(x,z,w,d)=>L.tactical.buildings.push({x1:x-w/2,z1:z-d/2,x2:x+w/2,z2:z+d/2});
  const pave=(x1,z1,x2,z2)=>{
    box((x1+x2)/2,.018,(z1+z2)/2,x2-x1,.022,z2-z1,{surface:'ground',ink:INK.BROWN,...detail});
    L.tactical.paths.push([[x1,z1],[x2,z1],[x2,z2],[x1,z2]]);
  };
  box(0,-.8,0,142,.8,130,grass);
  pave(-68,-8,68,8);pave(-49,-50,49,-39);pave(-51,43,51,53);pave(-46,-53,-36,47);pave(35,-53,45,49);pave(-7,-32,7,43);
  box(0,.044,3,40,.022,30,{surface:'ground',ink:INK.BROWN,...detail});
  box(0,.046,-16,32,.022,19,{surface:'ground',ink:INK.BROWN,...detail});
  box(0,.042,30,34,.022,22,{...oldStone,...detail});
  // Sculpted shapes remain one material batch. Extrusion produces non-indexed geometry,
  // so an identity index allows it to merge with the builder's indexed boxes and cylinders.
  const extrude=(shape,x,y,z,depth=.9,ink=INK.BROWN)=>{
    const g=new THREE.ExtrudeGeometry(shape,{depth,bevelEnabled:false,curveSegments:16});
    g.setIndex(Array.from({length:g.attributes.position.count},(_,i)=>i));g.translate(x,y,z-depth/2);addGeo(g,ink,'limestone');
  };
  const curve=(points,r=.055,ink=INK.BROWN)=>{
    const path=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p)));
    addGeo(new THREE.TubeGeometry(path,Math.max(12,points.length*5),r,5,false),ink,'limestone');
  };
  const scroll=(x,y,z,r,side=1)=>{
    const pts=[];for(let i=0;i<=30;i++){const a=i/30*Math.PI*3.1,rr=r*(1-i/35);pts.push([x+side*Math.cos(a)*rr,y+Math.sin(a)*rr,z]);}curve(pts,.065);
  };
  const rosette=(x,y,z,r=.33)=>{
    const ring=new THREE.TorusGeometry(r*.67,r*.1,5,16);ring.translate(x,y,z);addGeo(ring,INK.BROWN,'limestone');
    for(let j=0;j<8;j++){const a=j*Math.PI/4,g=new THREE.SphereGeometry(r*.31,6,4);g.scale(.58,1.45,.3);g.rotateZ(-a);g.translate(x+Math.sin(a)*r*.51,y+Math.cos(a)*r*.51,z+.025);addGeo(g,INK.BROWN,'limestone');}
  };
  const leaf=(x,y,z,h=.75,lean=0,reverse=false)=>{
    const s=new THREE.Shape();s.moveTo(0,0);s.bezierCurveTo(-h*.45,h*.4,-h*.2,h*.78,0,h);s.bezierCurveTo(h*.3,h*.62,h*.33,h*.25,0,0);
    const g=new THREE.ShapeGeometry(s);if(reverse){const ix=g.index;for(let k=0;k<ix.count;k+=3){const a=ix.getX(k+1);ix.setX(k+1,ix.getX(k+2));ix.setX(k+2,a);}g.computeVertexNormals();}g.rotateZ(lean);g.translate(x,y,z);addGeo(g,INK.BROWN,'limestone');
    curve([[x,y,z+.022],[x-Math.sin(lean)*h*.44,y+Math.cos(lean)*h*.44,z+.055],[x-Math.sin(lean)*h*.89,y+Math.cos(lean)*h*.89,z+.025]],.033);
  };
  const shard=(x,y,z,w,h,d,seed=0,solid=false)=>{
    const g=new THREE.BoxGeometry(w,h,d,1,1,1),p=g.attributes.position;
    for(let i=0;i<p.count;i++){let px=p.getX(i),py=p.getY(i),pz=p.getZ(i);if(py>0){py+=h*.22*Math.sin(px*4.7+pz*3.8+seed);if(px>0&&pz>0)py-=h*.24;}px*=.88+.1*Math.sin(pz*6.2+seed);pz*=.88+.1*Math.cos(px*5+seed);p.setXYZ(i,px,py,pz);}
    g.computeVertexNormals();g.translate(x,y+h/2,z);addGeo(g,INK.BROWN,'limestone');if(solid)collider(x,y,z,w,h,d,{noNav:h>.55});
  };
  const column=(x,y,z,h,r=.5,broken=true)=>{
    box(x,y,z,r*3.3,.24,r*3.3,{...stone,noNav:true});box(x,y+.24,z,r*2.65,.18,r*2.65,{...stone,noNav:true});
    const shaftH=h-.75,g=new THREE.CylinderGeometry(r*.88,r,shaftH,16,4);const p=g.attributes.position;
    for(let i=0;i<p.count;i++){const xx=p.getX(i),zz=p.getZ(i),a=Math.atan2(zz,xx);if(broken&&p.getY(i)>shaftH*.49)p.setY(i,p.getY(i)+.15*Math.sin(a*3+x*.5+z));}
    g.computeVertexNormals();g.translate(x,y+.42+shaftH/2,z);addGeo(g,INK.BROWN,'limestone');
    collider(x,y+.42,z,r*1.62,shaftH+.15,r*1.62,{noNav:true});
    for(let j=0;j<12;j++){const a=j*Math.PI/6;const line=new THREE.CylinderGeometry(.027,.04,Math.max(.3,shaftH-.35),5);line.translate(x+Math.sin(a)*r*.96,y+.55+(shaftH-.35)/2,z+Math.cos(a)*r*.96);addGeo(line,INK.BROWN,'limestone');}
    if(!broken){box(x,y+h-.34,z,r*3.1,.24,r*3.1,{...stone,noNav:true});box(x,y+h-.1,z,r*3.65,.14,r*3.65,{...stone,noNav:true});for(const dx of[-r*.86,r*.86])scroll(x+dx,y+h-.5,z+r*.86,r*.35,dx<0?-1:1);}
  };
  const ruinWall=(x,z,w,d,h)=>{
    for(let y=0;y<h;y+=.55)box(x,y,z,w,Math.min(.53,h-y),d,{...brick,noNav:true});
    for(let i=0;i<Math.max(2,Math.round(w/1.4));i++){const px=x-w/2+(i+.5)*w/Math.max(2,Math.round(w/1.4));shard(px,h,z,Math.min(1.3,w*.4),.15+.15*(1+Math.sin(i*2.7+x)),d+.08,i);}
    foot(x,z,w,d);
  };

  // Yuanyingguan survives as free-standing, uneven pillars on an eroded raised foundation.
  slab(-17,-53,17,-33,1.2,.5,brick);box(0,0,-43,34,.7,20,{...brick,noNav:true});
  stairs(0,0,-28.2,'-z',6,6,{rise:.2,run:.8,...stone});
  for(let i=0;i<6;i++)for(const x of[-3.2,3.2])box(x,0,-28.2-(i+.5)*.8,.24,(i+1)*.2+.7,.8,{...stone,noNav:true});
  for(const[x,z,h,r,broken]of[[-11,-43,7.7,.58,false],[-6,-42,6.9,.52,true],[6,-43,8.3,.57,false],[11,-43,6.6,.52,true],[-10,-49,4.5,.51,true],[8,-49,3.4,.51,true]])column(x,1.2,z,h,r,broken);
  box(-8.3,7.63,-43,4.4,.43,1.05,{...stone,noNav:true});
  for(const z of[-45,-41])for(const x of[-14,14])shard(x,1.2,z,2.2,.35,1.45,x+z,true);
  wallX(-16,16,-52,1.2,.65,.9,[[-3,3]],brick);
  foot(0,-43,34,20);
  for(const[x,z,w,d,h]of[[-28,-45,11,1.8,.9],[28,-45,10,1.7,1.1],[-31,-37,1.6,8,1.6],[29,-36,1.6,7,1.4]])ruinWall(x,z,w,d,h);

  // The photographed Dashuifa portal: square fluted pilasters, a broken semicircular
  // crest and low scroll-shaped wings. The central opening stays genuinely traversable.
  slab(-14,-18.1,14,-12.1,.4,.4,stone);
  const baseY=.4,faceZ=-13.32,backZ=-15.1;
  for(const[s,h]of[[-1,5.25],[1,5.1]]){
    const x=s*2.7;box(x,baseY,-15,1.58,.5,1.9,{...stone,noNav:true});
    box(x,baseY+.5,-15,1.32,h-.75,1.52,{...stone,noNav:true});
    for(const dx of[-.46,0,.46])box(x+dx,baseY+.57,faceZ-.75,.12,h-.94,.17,{...stone,...detail});
    box(x,baseY+h-.27,-15,1.78,.21,1.9,{...stone,noNav:true});box(x,baseY+h-.06,-15,1.98,.16,2.03,{...stone,noNav:true});
    for(const yy of[1.05,1.7,2.45,3.2]){rosette(x,baseY+yy,faceZ-.62,.22);leaf(x,baseY+yy+.12,faceZ-.6,.4,s*.16);}
  }
  box(0,baseY+4.7,-15,4.2,.58,1.6,{...stone,noNav:true});
  for(const[a1,a2]of[[0,Math.PI/2-.12],[Math.PI/2+.16,Math.PI]]){
    const s=new THREE.Shape(),r=3.08,inner=2.59;
    for(let j=0;j<=24;j++){const a=a1+(a2-a1)*j/24,x=Math.cos(a)*r,y=5.13+Math.sin(a)*r*.72;j?s.lineTo(x,y):s.moveTo(x,y);}
    for(let j=24;j>=0;j--){const a=a1+(a2-a1)*j/24;s.lineTo(Math.cos(a)*inner,5.13+Math.sin(a)*inner*.72);}s.closePath();extrude(s,0,baseY,-15,1.06);
    const pts=[];for(let j=0;j<=20;j++){const a=a1+(a2-a1)*j/20;pts.push([Math.cos(a)*2.88,baseY+5.13+Math.sin(a)*2.88*.72,-14.43]);}curve(pts,.068);
  }
  for(const s of[-1,1]){
    scroll(s*2.75,baseY+5.18,-14.39,.42,s);
    const shape=new THREE.Shape();shape.moveTo(3.45,.2);shape.lineTo(3.45,1.92);shape.bezierCurveTo(4.2,1.55,4.8,1.3,5.35,1.9);shape.bezierCurveTo(6.25,2.8,7.1,2.75,7.7,2.25);shape.bezierCurveTo(8.7,3.5,9.65,3.4,10.7,2.5);shape.bezierCurveTo(11.9,1.6,12.8,1.35,13.7,1.25);shape.lineTo(13.7,.22);shape.bezierCurveTo(11.1,.07,9.5,.8,8.3,.4);shape.bezierCurveTo(6.8,.05,5.4,.35,3.45,.2);shape.closePath();
    const g=new THREE.ExtrudeGeometry(shape,{depth:1.05,bevelEnabled:false,curveSegments:18});g.setIndex(Array.from({length:g.attributes.position.count},(_,i)=>i));g.scale(s,1,1);if(s<0){const ix=g.index;for(let k=0;k<ix.count;k+=3){const a=ix.getX(k+1);ix.setX(k+1,ix.getX(k+2));ix.setX(k+2,a);}g.computeVertexNormals();}g.translate(0,baseY,-15);addGeo(g,INK.BROWN,'limestone');
    for(const[x,h]of[[4.1,1.55],[5.5,1.7],[6.8,2.25],[8.2,2.2],[9.5,2.8],[10.8,1.8],[12.2,1.2],[13.2,.9]])collider(s*x,baseY,-14.5,1.2,h,1.05,{noNav:true});
    curve([[s*3.5,2.15,-13.88],[s*4.6,1.7,-13.88],[s*5.5,2.05,-13.88],[s*6.6,2.86,-13.88],[s*7.9,2.83,-13.88],[s*9.4,3.53,-13.88],[s*11.3,2.25,-13.88],[s*13.6,1.67,-13.88]],.095);
    scroll(s*9.1,3.04,-13.83,.48,s);scroll(s*6.6,1.5,-13.83,.36,-s);
    for(const dy of[0,.21])curve([[s*3.53,2.05+dy,-13.78],[s*3.85,1.25+dy,-13.78],[s*4.35,.8+dy,-13.78],[s*5.17,.7+dy,-13.78],[s*5.76,1.0+dy,-13.78],[s*6.1,1.65+dy,-13.78]],dy?.065:.105);
    for(const dy of[0,.16])curve([[s*7.12,2.62+dy,-13.78],[s*7.57,1.7+dy,-13.78],[s*8.18,1.02+dy,-13.78],[s*9.3,.62+dy,-13.78],[s*10.63,.66+dy,-13.78],[s*12.84,.91+dy,-13.78]],.074);
    for(const[x,y,r]of[[4.45,1.1,.47],[6.15,1.1,.33],[8.1,1.47,.43],[10.8,1.3,.36]]){rosette(s*x,y,-13.78,r);leaf(s*x,y+.2,-13.77,.73,s*.48);}
    const outerH=s<0?1.4:4.55;box(s*6.25,baseY,-15.08,1.45,outerH,1.7,{...stone,noNav:true});
    box(s*6.25,baseY+outerH,-15.08,1.88,.23,1.96,{...stone,noNav:true});
    if(s>0){for(const dx of[-.49,.49])box(s*6.25+dx,.95,-14.16,.13,3.7,.12,{...stone,...detail});for(const yy of[1.6,2.3,3.0])rosette(6.25,yy,-14.06,.2);}
    else shard(-6.25,baseY+outerH+.23,-15.08,1.55,.26,1.55,3);
  }
  foot(0,-15,28,3);
  // Displaced plinths, fallen capitals and pale fragments match the foreground rubble.
  for(const[x,z,w,h,d]of[[-10,-9,3.1,.48,1.35],[-5,-9,2.2,.35,1.6],[5.5,-8.9,2.9,.52,1.5],[11.5,-9.8,2.3,.4,1.6],[-14,-21,2.8,.7,1.6],[14,-21,2.2,.6,1.45]])shard(x,0,z,w,h,d,x*.6,true);
  for(const[x,z,rot]of[[-18,-21,.32],[18,-24,-.4],[-16,-35,.2],[19,-39,-.25]]){
    const g=new THREE.CylinderGeometry(.58,.66,3.1,14);g.rotateZ(Math.PI/2);g.rotateY(rot);g.translate(x,.67,z);addGeo(g,INK.BROWN,'limestone');collider(x,0,z,3.2,1.25,1.6,{noNav:true});
    for(let j=0;j<10;j++){const a=j*Math.PI/5;const gg=new THREE.CylinderGeometry(.035,.035,2.8,5);gg.rotateZ(Math.PI/2);gg.translate(0,Math.sin(a)*.62,Math.cos(a)*.62);gg.rotateY(rot);gg.translate(x,.67,z);addGeo(gg,INK.BROWN,'limestone');}
  }

  // Only the dry, broken fountain beds remain: no invented working jets or restored
  // bronze animals. Four broad gaps keep both sides of the ellipse accessible on foot.
  const basin=(x,z,rx,rz)=>{
    for(let j=0;j<32;j++){
      const a=j*Math.PI/16;if(Math.abs(Math.sin(a))<.2||Math.abs(Math.cos(a))<.2)continue;
      const px=x+Math.cos(a)*rx,pz=z+Math.sin(a)*rz;
      const g=new THREE.BoxGeometry(1.9,.42,.64);g.rotateY(-Math.atan2(Math.cos(a)*rz,-Math.sin(a)*rx));g.translate(px,.21,pz);addGeo(g,INK.BROWN,'limestone');
      collider(px,0,pz,1.12,.42,1.12);
    }
  };
  basin(0,5,18,10);
  for(const x of[-8,0,8]){
    const r=x===0?2.75:2.35;
    const g=new THREE.CylinderGeometry(r,r+.08,.34,24,1,true);g.translate(x,.17,4);addGeo(g,INK.BROWN,'limestone');
    const ring=new THREE.TorusGeometry(r,.18,6,32);ring.rotateX(Math.PI/2);ring.translate(x,.38,4);addGeo(ring,INK.BROWN,'limestone');
    for(const a of[0,Math.PI/2,Math.PI,Math.PI*1.5])collider(x+Math.sin(a)*r*.82,0,4+Math.cos(a)*r*.82,1,.46,1);
    cyl(x,0,4,.75,x===0?1.03:.6,{...stone,noNav:true});
    box(x,x===0?1.03:.6,4,1.9,.22,1.7,{...stone,noNav:true});
  }
  for(const[x,z]of[[-20,0],[-15,14],[15,14],[20,0]])shard(x,0,z,2.2,.45,1.3,x+z,true);

  // Guanshuifa's surviving arc has five separate carved slabs, tall end pilasters and
  // outer obelisks, with a circular stepped throne platform in front of them.
  for(let j=0;j<3;j++){
    const r=6.7-j*.65,h=.15;const g=new THREE.CylinderGeometry(r,r,h,40);g.translate(0,j*.15+h/2,27);addGeo(g,INK.BROWN,'limestone');
    for(let zz=-r;zz<r;zz+=.75){const end=Math.min(zz+.75,r),mid=(zz+end)/2,w=2*Math.sqrt(Math.max(0,r*r-mid*mid));collider(0,0,27+mid,w,(j+1)*.15,end-zz);}
  }
  stairs(0,0,19.8,'+z',3,4.8,{rise:.15,run:.65,...stone});
  for(const s of[-1,1])stairs(s*7.3,0,27,s<0?'+x':'-x',3,4.8,{rise:.15,run:.65,...stone});
  stairs(0,0,34.2,'-z',3,4.8,{rise:.15,run:.65,...stone});
  for(let j=-4;j<=4;j++){
    const a=j*.17,x=Math.sin(a)*12.4,z=32+Math.cos(a)*3.4;
    box(x,0,z,2.3,.9,1.05,{...stone,noNav:true});box(x,.9,z,2.45,.2,1.17,{...stone,noNav:true});
    if(j>-3&&j<3){
      box(x,1.1,z,1.35,2.45,.37,{...stone,noNav:true});
      for(const dx of[-.62,.62])box(x+dx,1.15,z-.24,.09,2.35,.12,{...stone,...detail});
      for(const y of[1.17,3.43])box(x,y,z-.24,1.3,.1,.12,{...stone,...detail});
      rosette(x,2.12,z-.27,.34);for(const s of[-1,1]){leaf(x+s*.23,2.32,z-.28,.75,-s*.32,true);curve([[x+s*.52,1.4,z-.28],[x-s*.1,1.95,z-.27],[x-s*.47,2.36,z-.28]],.07);}
      for(let k=0;k<3;k++)rosette(x,2.8+k*.16,z-.27,.075);
    }
  }
  for(const s of[-1,1]){
    const x=s*7.5,z=34.6;box(x,0,z,1.3,1.2,1.25,{...stone,noNav:true});box(x,1.2,z,.94,3.7,.82,{...stone,noNav:true});
    for(const dx of[-.32,.32])box(x+dx,1.32,z-.47,.09,3.45,.14,{...stone,...detail});rosette(x,4.4,z-.5,.23);
    const ox=s*10.7,oz=33.15;box(ox,0,oz,1.45,1.25,1.4,{...stone,noNav:true});
    const g=new THREE.CylinderGeometry(.1,.52,2.1,4);g.rotateY(Math.PI/4);g.translate(ox,2.3,oz);addGeo(g,INK.BROWN,'limestone');collider(ox,1.25,oz,.6,2.1,.6,{noNav:true});
  }
  foot(0,34.4,23,2.2);

  // Ground-level ruin courts and planted edges provide cover without turning the
  // archaeological site into a maze of newly built walls.
  for(const[x,z,w,d,h]of[[-35,-16,9,1.5,1.35],[-22,-38,1.5,5,1.25],[-33,-23,1.4,8,1.2],[-22,-20,6,1.3,.95],[29,17,7,1.5,1.2],[34,27,1.5,9,1.3],[25,36,7,1.5,1.1],[-30,27,9,1.5,1.4],[38,-23,8,1.4,1.45],[-22,37,1.3,6,1.1]])ruinWall(x,z,w,d,h);
  for(const[x,z,h]of[[-38,28,3.1],[-23,22,2.3],[39,15,2.4],[21,-40,2.1],[-42,-29,1.8],[32,39,1.7]])column(x,0,z,h,.42,true);
  for(const[x,z,w,d]of[[-30,-56,15,3],[28,-56,16,3],[-51,-32,3,15],[51,32,3,16],[-35,56,17,3],[33,56,17,3]]){
    box(x,0,z,w,.45,d,{...oldStone,noNav:true});box(x,.45,z,w-.1,1.1,d-.1,{surface:'foliage',ink:INK.GREEN,noNav:true});
  }
  // Small rubble is deterministic and kept off the clear centreline of every route.
  for(let i=0;i<95;i++){
    const a=i*2.39996,r=17+(i%7)*3.1,x=Math.cos(a)*r,z=-22+Math.sin(a)*r*.54;
    if(Math.abs(x)<4||Math.hypot(x+27,z+29)<5||Math.hypot(x-25,z-27)<5)continue;
    shard(x,0,z,.22+(i%5)*.1,.07+(i%3)*.045,.2+(i%4)*.08,i);
  }
  for(const[x,z,rx,rz]of[[-11,-5,4,2.5],[8,-5,5,2],[16,-19,3,5],[-19,-23,3,4],[-5,-23,5,2.4],[9,-27,4,2.3],[-10,11,4.5,2],[12,12,3.5,2]]){
    const shape=new THREE.Shape();for(let j=0;j<13;j++){const a=j*Math.PI*2/12,r=.8+.14*Math.sin(j*2.3+x);const xx=x+Math.cos(a)*rx*r,zz=z+Math.sin(a)*rz*r;j?shape.lineTo(xx,-zz):shape.moveTo(xx,-zz);}shape.closePath();const g=new THREE.ShapeGeometry(shape);g.rotateX(-Math.PI/2);g.translate(0,.074,0);addGeo(g,INK.GREEN,'grass');
  }
  for(let j=0;j<48;j++){const x=-19+(j%16)*2.45,z=-8-Math.floor(j/16)*6+Math.sin(j*2.1)*1.2;if(Math.abs(x)<3.8)continue;shard(x,.045,z,.4+(j%4)*.27,.1+(j%3)*.08,.3+(j%5)*.11,j);}
  const tree=(x,z,h,seed)=>{
    const trunk=new THREE.CylinderGeometry(.25,.46,h*.6,7);trunk.translate(x,h*.3,z);addGeo(trunk,INK.BROWN,'wood');if(Math.abs(x)<68&&Math.abs(z)<62)collider(x,0,z,.65,h*.6,.65,{noNav:true});
    for(let j=0;j<8;j++){const a=j*2.4+seed,g=new THREE.IcosahedronGeometry(h*(.135+(j%3)*.014),1);g.setIndex(Array.from({length:g.attributes.position.count},(_,k)=>k));const p=g.attributes.position;for(let k=0;k<p.count;k++){const xx=p.getX(k),yy=p.getY(k),zz=p.getZ(k),f=1+.13*Math.sin(xx*3.4+yy*2.6+zz*3.9+seed);p.setXYZ(k,xx*f,yy*f,zz*f);}g.computeVertexNormals();g.scale(1,1.06,.9);g.translate(x+Math.cos(a)*h*.19,h*(.5+j*.038),z+Math.sin(a)*h*.19);addGeo(g,INK.GREEN,'foliage');
      if(j<4){const end=new THREE.Vector3(Math.cos(a)*h*.22,h*.28,Math.sin(a)*h*.22),branch=new THREE.CylinderGeometry(.07,.2,end.length(),6);branch.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),end.clone().normalize()));branch.translate(x+end.x/2,h*.34+end.y/2,z+end.z/2);addGeo(branch,INK.BROWN,'wood');}
    }
  };
  for(let i=0;i<24;i++){const a=i*Math.PI/12;tree(Math.cos(a)*77,Math.sin(a)*71,13+(i%4)*2,i);}
  for(const[x,z,h]of[[-46,-56,12],[46,-57,14],[-52,48,13],[51,-43,12],[47,53,14]])tree(x,z,h,x);
  for(const z of[-63,63])box(0,0,z,140,.7,1,{...brick,noNav:true});
  for(const x of[-69,69])box(x,0,0,1,.7,126,{...brick,noNav:true});
  for(const z of[-63,63])collider(0,.7,z,142,45,1,{noNav:true,noGrapple:true});
  for(const x of[-69,69])collider(x,.7,0,1,45,128,{noNav:true,noGrapple:true});
  collider(0,45,0,142,4,130,{noNav:true,noGrapple:true});

  L.teamSpawns=[];
  for(const[team,s,ink]of[[0,-1,INK.BLUE],[1,1,INK.ORANGE]]){
    L.teamSpawns[team]=[60,64].flatMap(x=>[-9,-3,3,9].map(z=>new THREE.Vector3(s*x,.08,z)));
    ruinWall(s*52,0,1.3,28,3.3);
    for(const z of[-19,19]){box(s*60,0,z,16,.4,1.8,{...oldStone,noNav:true});box(s*60,.4,z,15.7,1.55,1.6,{surface:'foliage',ink:INK.GREEN,noNav:true});}
    box(s*51.31,2.65,0,.1,.34,8,{surface:'cloth',ink,...detail});
  }
  L.teamFacing=[-Math.PI/2,Math.PI/2];L.playerStart.copy(L.teamSpawns[0][0]);
  L.bombSites=[{id:'A',pos:new THREE.Vector3(-27,.08,-29),radius:3},{id:'B',pos:new THREE.Vector3(25,.08,27),radius:3}];
  const glyphs={A:['01110','10001','10001','11111','10001','10001','10001'],B:['11110','10001','10001','11110','10001','10001','11110']};
  for(const{id,pos:{x,z}}of L.bombSites){
    for(const dx of[-3.2,3.2])box(x+dx,.065,z,.1,.02,6.5,{surface:'cloth',ink:INK.ORANGE,...detail});
    for(const dz of[-3.2,3.2])box(x,.065,z+dz,6.3,.02,.1,{surface:'cloth',ink:INK.ORANGE,...detail});
    const rows=glyphs[id];for(let row=0;row<7;row++)for(let col=0;col<5;col++)if(rows[row][col]==='1')box(x+(col-2)*.3,.07,z+(row-3)*.3,.28,.02,.28,{surface:'cloth',ink:INK.ORANGE,...detail});
  }
  for(const[x,z]of[[-43,-47],[42,-47],[-44,2],[44,2],[-39,39],[39,42],[-29,-7],[29,-7],[-19,21],[19,20],[-6,49],[8,49],[-22,-52],[23,-51]])spawn(x,.08,z);
  sniper(-13,1.28,-47);sniper(13,1.28,-47);sniper(-42,.08,31);sniper(41,.08,-31);
  for(const[x,y,z]of[[-27,0,-29],[25,0,27],[-5,1.2,-47],[12,1.2,-47],[-38,0,5],[39,0,-7],[0,0,18],[-14,0,38],[14,0,38],[0,0,-24]])pickup(x,y+.16,z);
  L.arenaSpawns=[...L.teamSpawns.flat(),...L.spawns].map(p=>p.clone());
  return B.finish();
}

// Mutianyu's stepped ridge, double-sided crenellations and vaulted watchtowers.
// The southern mountain trail compresses the visitor paths into a connected combat route.
function buildGreatWall(B) {
  const { L, box, slab, collider, addGeo, wallX, wallZ, stairs, spawn, sniper, pickup } = B;
  L.key = 'greatwall'; L.bounds = { minX: -120, maxX: 120, minZ: -66, maxZ: 76, minY: -18 }; L.navCell = 1.0; L.fallY = -23;
  L.tactical = { buildings: [], water: [], paths: [], labels: [] };
  const BR = { surface: 'brick', ink: INK.BLACK }, ST = { surface: 'limestone', ink: INK.BROWN }, GR = { surface: 'grass', ink: INK.GREEN };
  const detail = { noCollide: true }, towers = [ { x: -96, y: 12, z: 22 }, { x: -48, y: 20, z: -12 }, { x: 0, y: 26, z: 16 }, { x: 48, y: 34, z: -10 }, { x: 96, y: 42, z: 20 } ];
  const trail = [ [-108,2,66], [-96,2,66], [-73,2,61], [-48,2,66], [-26,6.6,70], [-8,12,66], [0,12,66], [8,12,66], [24,14.5,61], [48,17,66], [72,23.5,70], [96,30,66], [108,30,64] ];
  const ridge = [];
  for (let i = 0; i < towers.length - 1; i++) {
    const a = towers[i], b = towers[i + 1];
    ridge.push([a.x + 6.8,a.y,a.z], [a.x + 14,a.y,a.z], [b.x - 14,b.y,b.z], [b.x - 6.8,b.y,b.z]);
  }
  const corridors = [], addRoute = (points, width, high = false) => {
    for (let i = 0; i < points.length - 1; i++) corridors.push({ a: points[i], b: points[i + 1], width, high });
  };
  for (let i = 0; i < ridge.length; i += 4) addRoute(ridge.slice(i,i+4), 6.6, true);
  addRoute(trail,3.8);
  const links = [];
  for (let i = 0; i < towers.length; i++) {
    const t = towers[i], lower = [2,2,12,17,30][i], start=t.z+8.3, run=62-start, bend=i%2===0?5:-5;
    const points = [[t.x,t.y,t.z+5.8],[t.x,t.y,start],[t.x+bend,t.y+(lower-t.y)*.34,start+run*.34],[t.x+bend,t.y+(lower-t.y)*.4,start+run*.4],[t.x-bend*.55,t.y+(lower-t.y)*.72,start+run*.72],[t.x,lower,62],[t.x,lower,66]];
    addRoute(points,3.8); links.push({ tower: [t.x,t.y,t.z], lower: [t.x,lower,66] });
  }
  const ridgeAt = x => {
    let a = towers[0], b = towers[1];
    for (let i=0;i<towers.length-1;i++) if(x>=towers[i].x){a=towers[i];b=towers[i+1];}
    const t=Math.max(0,Math.min(1,(x-a.x)/(b.x-a.x)));return { y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t };
  };
  const ground = (x,z) => {
    const r=ridgeAt(x), dz=Math.abs(z-r.z);
    let y=r.y-7-dz*.27 + Math.sin(x*.09)*Math.sin(z*.055)*1.6;
    for(const p of corridors){const dx=p.b[0]-p.a[0],dz=p.b[2]-p.a[2],l2=dx*dx+dz*dz,t=Math.max(0,Math.min(1,((x-p.a[0])*dx+(z-p.a[2])*dz)/l2));const d=Math.hypot(x-p.a[0]-dx*t,z-p.a[2]-dz*t),top=p.a[1]+(p.b[1]-p.a[1])*t;if(!p.high){const influence=Math.max(0,Math.min(1,(p.width*.5+13-d)/13));y=Math.max(y,y+(top-1.15-y)*influence);}else if(d<p.width*.5+1)y=Math.min(y,top-1.15);}
    // Neighboring stair embankments must never raise terrain through an existing path.
    // The margin covers both the terrain column footprint and its corner height samples.
    for(const p of corridors){const dx=p.b[0]-p.a[0],dz=p.b[2]-p.a[2],l2=dx*dx+dz*dz,t=Math.max(0,Math.min(1,((x-p.a[0])*dx+(z-p.a[2])*dz)/l2)),d=Math.hypot(x-p.a[0]-dx*t,z-p.a[2]-dz*t);if(d<p.width*.5+2.2)y=Math.min(y,p.a[1]+(p.b[1]-p.a[1])*t-1.3);}
    for(const t of towers)if(Math.abs(x-t.x)<8&&Math.abs(z-t.z)<7)y=Math.min(y,t.y-1.2);
    return Math.max(-18,y);
  };
  const terrainGeo = (x1,z1,x2,z2,cell,height,edgeAxis=null) => {
    const nx=Math.ceil((x2-x1)/(edgeAxis==='x'?2:cell)),nz=Math.ceil((z2-z1)/(edgeAxis==='z'?2:cell)),g=new THREE.PlaneGeometry(x2-x1,z2-z1,nx,nz);g.rotateX(-Math.PI/2);g.translate((x1+x2)/2,0,(z1+z2)/2);
    const a=g.attributes.position;for(let i=0;i<a.count;i++)a.setY(i,height(a.getX(i),a.getZ(i)));g.computeVertexNormals();return g;
  };
  addGeo(terrainGeo(-128,-74,128,84,2,ground),INK.GREEN,'grass');
  // The visible terrain is smooth; compact non-navigation columns catch an accidental vault
  // over a parapet, while all planned routes use their own fine, step-height collision grid.
  for(let x=-119;x<120;x+=2)for(let z=-65;z<76;z+=2){const y=Math.max(ground(x-.7,z-.7),ground(x+.7,z-.7),ground(x-.7,z+.7),ground(x+.7,z+.7));collider(x,-25,z,2.01,y+25,2.01,{noNav:true});}
  const farHeight=(x,z)=>{
    const near=ground(x,z),d=Math.max(0,Math.abs(x)-128,-74-z,z-84);
    const mountains=18+55*Math.exp(-Math.pow((z+150+Math.sin(x*.018)*48)/95,2))+48*Math.exp(-Math.pow((z+330+Math.sin(x*.014+1)*68)/105,2))+(Math.sin(x*.021+z*.009)+Math.sin(x*.038-z*.012)) * 10;
    const blend=Math.max(0,Math.min(1,d/110));return near*(1-blend)+mountains*blend;
  };
  // Match the near terrain's two-meter boundary samples exactly to avoid visible cracks.
  const scenery = new THREE.Mesh(mergeGeometries([terrainGeo(-620,-650,620,-74,18,farHeight,'x'),terrainGeo(-620,84,620,420,18,farHeight,'x'),terrainGeo(-620,-74,-128,84,18,farHeight,'z'),terrainGeo(128,-74,620,84,18,farHeight,'z')],false),makeInkMaterial({surface:'grass',ink:INK.GREEN}));
  scenery.userData.noSun=true;scenery.matrixAutoUpdate=false;B.scene.add(scenery);L.meshes.push(scenery);
  // The wall continues over the distant ridge beyond the closed end-tower gates.
  const distantWall=[];
  const distantBox=(x,y,z,w,h,d,yaw=0)=>{const g=new THREE.BoxGeometry(w,h,d);g.rotateY(yaw);g.translate(x,y+h*.5,z);distantWall.push(g);};
  for(const points of [[[-103.6,12,22],[-125,12,15],[-151,0,-17],[-176,0,-49],[-191,0,-88],[-218,0,-117]],[[103.6,42,20],[127,42,8],[151,0,-21],[176,0,-55],[209,0,-77],[233,0,-114]]]){
    for(let k=2;k<points.length;k++)points[k][1]=farHeight(points[k][0],points[k][2])+5.5;
    for(let k=0;k<points.length-1;k++){const a=points[k],b=points[k+1],dx=b[0]-a[0],dz=b[2]-a[2],len=Math.hypot(dx,dz),n=Math.ceil(len/2.1),nx=dz/len,nz=-dx/len,yaw=Math.atan2(dx,dz);
      for(let i=0;i<n;i++){const t=(i+.5)/n,x=a[0]+dx*t,z=a[2]+dz*t,y=a[1]+(b[1]-a[1])*t;distantBox(x,y-5.6,z,5.4,5.6,len/n+.08,yaw);for(const side of[-1,1]){distantBox(x+nx*side*2.4,y,z+nz*side*2.4,.58,.92,len/n+.1,yaw);if(i%2===0)distantBox(x+nx*side*2.4,y+.92,z+nz*side*2.4,.62,.62,1.0,yaw);}}
      if(k>1&&k%2===0){const [x,y,z]=b;distantBox(x,y-5.6,z,8,10.0,8);for(const side of[-1,1])for(let q=-3;q<=3;q+=2){distantBox(x+side*3.7,y+4.4,z+q,.6,.9,.95);distantBox(x+q,y+4.4,z+side*3.7,.95,.9,.6);}}
    }
  }
  const continuation=new THREE.Mesh(mergeGeometries(distantWall,false),makeInkMaterial(BR));continuation.userData.noSun=true;continuation.matrixAutoUpdate=false;B.scene.add(continuation);L.meshes.push(continuation);
  const rotatedBox = (x,y,z,w,h,d,yaw,ink,surface) => { const g=new THREE.BoxGeometry(w,h,d);g.rotateY(yaw);g.translate(x,y+h*.5,z);addGeo(g,ink,surface); };
  const floors=new Map(), cs=1;
  const markFloor=(a,b,width,y)=>{
    const dx=b[0]-a[0],dz=b[2]-a[2],len=Math.hypot(dx,dz),ux=dx/len,uz=dz/len;
    const minX=Math.floor(Math.min(a[0],b[0])-width*.5-1),maxX=Math.ceil(Math.max(a[0],b[0])+width*.5+1),minZ=Math.floor(Math.min(a[2],b[2])-width*.5-1),maxZ=Math.ceil(Math.max(a[2],b[2])+width*.5+1);
    for(let ix=minX;ix<maxX;ix++)for(let iz=minZ;iz<maxZ;iz++){const x=ix+.5,z=iz+.5,along=(x-a[0])*ux+(z-a[2])*uz,side=(x-a[0])*uz-(z-a[2])*ux;if(along<-.015||along>len+.015||Math.abs(side)>width*.5-.1)continue;const key=ix+','+iz,old=floors.get(key);if(!old||old.y<y)floors.set(key,{x,z,y});}
  };
  const wallCoping=(x,y,z,yaw,w,d) => rotatedBox(x,y,z,w,.12,d,yaw,INK.BROWN,'limestone');
  for(const p of corridors){
    const [ax,ay,az]=p.a,[bx,by,bz]=p.b,dx=bx-ax,dz=bz-az,len=Math.hypot(dx,dz),n=Math.max(1,Math.ceil(len/.86),Math.ceil(Math.abs(by-ay)/.24)),yaw=Math.atan2(dx,dz),nx=dz/len,nz=-dx/len,run=len/n;
    L.tactical.paths.push([[ax+nx*p.width*.5,az+nz*p.width*.5],[bx+nx*p.width*.5,bz+nz*p.width*.5],[bx-nx*p.width*.5,bz-nz*p.width*.5],[ax-nx*p.width*.5,az-nz*p.width*.5]]);
    for(let i=0;i<n;i++){
      const f=(i+.5)/n,x=ax+dx*f,z=az+dz*f,y=Math.round((ay+(by-ay)*(i+1)/n)*4)/4,foundation=p.high?7.3:Math.max(.65,y-ground(x,z)+.1);
      rotatedBox(x,y-foundation,z,p.width,foundation,run+.014,yaw,p.high?INK.BLACK:INK.BROWN,p.high?'brick':'ground');
      markFloor([ax+dx*i/n,0,az+dz*i/n],[ax+dx*(i+1)/n,0,az+dz*(i+1)/n],p.width,y);
      // The narrow pale lip shows each individual tread without laying coplanar faces together.
      if(Math.abs(by-ay)>.01)rotatedBox(ax+dx*(i+1)/n,y+.015,az+dz*(i+1)/n,p.width-.14,.035,.065,yaw,INK.BROWN,p.high?'limestone':'ground');
      for(const side of [-1,1]){
        // The last few meters of the visitor stairs open into the cross trail.
        if(!p.high&&((Math.abs(z-66)<3.5)||(Math.abs(x)<9&&Math.abs(z-66)<8)))continue;
        const edge=p.high?.64:.24,px=x+nx*side*(p.width*.5-edge*.5),pz=z+nz*side*(p.width*.5-edge*.5),h=p.high?.88:.18;
        rotatedBox(px,y,pz,edge,h,run+.018,yaw,p.high?INK.BLACK:INK.BROWN,p.high?'brick':'ground');
        collider(px,y,pz,Math.abs(nx)*edge+Math.abs(dx/len)*run+.045,h,Math.abs(nz)*edge+Math.abs(dz/len)*run+.045,{noNav:true});
        if(p.high)wallCoping(px,y+h,pz,yaw,.74,run+.024);
        if(p.high&&i%3===0){rotatedBox(px,y+h+.12,pz,.68,.64,Math.min(1.1,run*1.8),yaw,INK.BLACK,'brick');wallCoping(px,y+h+.76,pz,yaw,.77,Math.min(1.2,run*1.9));collider(px,y+h,pz,.86,.87,.86,{noNav:true});}
      }
    }
  }
  for(const f of floors.values())collider(f.x,f.y-7.5,f.z,cs+.014,7.5,cs+.014);
  const archWall=(t,axis,offset,door=true)=>{
    const span=axis==='x'?14:12,h=5.4,th=.9,shape=new THREE.Shape();shape.moveTo(-span/2,0);shape.lineTo(span/2,0);shape.lineTo(span/2,h);shape.lineTo(-span/2,h);shape.closePath();
    const holes=[];
    const opening=(x,w,sill,rise)=>{const r=w/2,path=new THREE.Path();path.moveTo(x-r,sill);path.lineTo(x-r,sill+rise);path.absarc(x,sill+rise,r,Math.PI,0,true);path.lineTo(x+r,sill);path.closePath();shape.holes.push(path);holes.push([x-r,x+r,sill,sill+rise+r]);};
    if(door)opening(0,3.8,0,1.65);else opening(0,1.05,2.1,.65);
    for(const x of [-4.5,4.5])if(Math.abs(x)+.6<span/2-.3)opening(x,1.05,2.1,.65);
    const g=new THREE.ExtrudeGeometry(shape,{depth:th,bevelEnabled:false,curveSegments:10});g.translate(0,0,-th*.5);
    if(axis==='x')g.translate(t.x,t.y,t.z+offset);
    else{g.rotateY(Math.PI/2);g.translate(t.x+offset,t.y,t.z);}
    g.setIndex(Array.from({length:g.attributes.position.count},(_,i)=>i));addGeo(g,INK.BLACK,'brick');
    // Collision has the same rectangular clear openings; the curved crown is safely above a standing player.
    const breaks=[-span/2,...holes.flatMap(h=>[h[0],h[1]]),span/2].sort((a,b)=>a-b);
    for(let i=0;i<breaks.length-1;i++){const a=breaks[i],b=breaks[i+1],mid=(a+b)/2,hole=holes.find(q=>mid>q[0]&&mid<q[1]);const runs=hole?[[0,hole[2]],[hole[3],h]]:[[0,h]];for(const[lo,hi]of runs)if(hi>lo+.001){if(axis==='x')collider(t.x+mid,t.y+lo,t.z+offset,b-a,hi-lo,th,{noNav:true});else collider(t.x+offset,t.y+lo,t.z+mid,th,hi-lo,b-a,{noNav:true});}}
    // Individually cut arch stones make the silhouette legible from both sides of a dark passage.
    for(const hole of holes){const center=(hole[0]+hole[1])/2,r=(hole[1]-hole[0])/2,cy=hole[3]-r;for(let j=0;j<9;j++){const a=j*Math.PI/9+.016,b=(j+1)*Math.PI/9-.016,ring=new THREE.Shape();ring.absarc(center,cy,r+.17,a,b,false);ring.lineTo(center+Math.cos(b)*r,cy+Math.sin(b)*r);ring.absarc(center,cy,r,b,a,true);ring.closePath();const q=new THREE.ExtrudeGeometry(ring,{depth:th+.036,bevelEnabled:false,curveSegments:3});q.translate(0,0,-(th+.036)/2);if(axis==='x')q.translate(t.x,t.y,t.z+offset);else{q.rotateY(Math.PI/2);q.translate(t.x+offset,t.y,t.z);}q.setIndex(Array.from({length:q.attributes.position.count},(_,i)=>i));addGeo(q,INK.BROWN,'limestone');}}
  };
  const parapet=(x1,z1,x2,z2,y)=>{
    const alongX=Math.abs(x2-x1)>Math.abs(z2-z1),len=Math.hypot(x2-x1,z2-z1),cx=(x1+x2)/2,cz=(z1+z2)/2;
    box(cx,y,cz,alongX?len:.8,.85,alongX?.8:len,{...BR,noNav:true});box(cx,y+.85,cz,alongX?len+.1:.9,.13,alongX?.9:len+.1,{...ST,...detail});
    const n=Math.max(2,Math.round(len/2));for(let i=0;i<=n;i++){const t=i/n;box(x1+(x2-x1)*t,y+.98,z1+(z2-z1)*t,alongX?1.0:.82,.68,alongX?.82:1.0,{...BR,noNav:true});box(x1+(x2-x1)*t,y+1.66,z1+(z2-z1)*t,alongX?1.1:.92,.12,alongX?.92:1.1,{...ST,...detail});}
  };
  for(let k=0;k<towers.length;k++){
    const t=towers[k];slab(t.x-7.2,t.z-6.2,t.x+7.2,t.z+6.2,t.y,7.5,BR);
    archWall(t,'z',-6.8,true);archWall(t,'z',6.8,true);archWall(t,'x',-5.8,false);archWall(t,'x',5.8,true);
    // Roof access follows the north interior wall and leaves the southern trail door unobstructed.
    stairs(t.x-4.5,t.y,t.z-4.05,'+x',18,2.0,{rise:.3,run:.5,...ST});
    for(let i=0;i<18;i++){const h=(i+1)*.3;box(t.x-4.5+(i+.5)*.5,t.y,t.z-2.98,.51,h+.72,.18,{...BR,noNav:true});}
    slab(t.x-7.25,t.z-2.9,t.x+7.25,t.z+6.3,t.y+5.4,.3,BR);
    slab(t.x-7.25,t.z-6.3,t.x-5.55,t.z-2.9,t.y+5.4,.3,BR);
    slab(t.x+4.55,t.z-6.3,t.x+7.25,t.z-2.9,t.y+5.4,.3,BR);
    slab(t.x-5.55,t.z-6.3,t.x+4.55,t.z-5.22,t.y+5.4,.3,BR);
    parapet(t.x-7.0,t.z-6,t.x+7,t.z-6,t.y+5.4);parapet(t.x-7,t.z+6,t.x+7,t.z+6,t.y+5.4);parapet(t.x-7,t.z-6,t.x-7,t.z+6,t.y+5.4);parapet(t.x+7,t.z-6,t.x+7,t.z+6,t.y+5.4);
    for(const side of [-1,1])box(t.x+side*7.23,t.y-1.0,t.z,.12,.2,12.5,{...ST,...detail});
    if(k===1||k===3){
      box(t.x,t.y+5.4,t.z+1.5,5.2,1.85,3.6,{...BR,noNav:true});
      const pitch=Math.atan2(1.0,2.2),len=Math.hypot(1.0,2.2);
      for(const side of[-1,1]){const g=new THREE.BoxGeometry(6.1,.13,len+.22);g.rotateX(side*pitch);g.translate(t.x,t.y+7.8,t.z+1.5+side*1.1);addGeo(g,INK.BLACK,'roofTile');}
      box(t.x,t.y+8.34,t.z+1.5,6.3,.16,.22,{surface:'roofTile',ink:INK.BLACK,...detail});
    }
    if(k===0||k===4){box(t.x+(k===0?-6.8:6.8),t.y,t.z,.7,3.45,3.7,{surface:'wood',ink:INK.BROWN,noNav:true});for(const s of[-1,1])box(t.x+(k===0?-6.39:6.39),t.y+.7,t.z+s*.85,.1,2.2,.1,{surface:'metal',ink:INK.BLACK,...detail});}
    L.tactical.buildings.push({x1:t.x-7.2,z1:t.z-6.2,x2:t.x+7.2,z2:t.z+6.2});
  }
  // A small retaining terrace on the mountain route gives the second objective its own approaches.
  slab(-8,59,8,73,12,.8,{surface:'ground',ink:INK.BROWN});
  for(const x of[-8,8])box(x,12,66,.32,.45,14,{surface:'ground',ink:INK.BROWN,noNav:true});
  box(-5.8,12,62.3,2.3,1.05,1.0,{...BR,noNav:true});box(5.8,12,70.4,2.3,1.05,1.0,{...BR,noNav:true});
  for(const[x,z]of[[-5,71],[5,61]]){box(x,12,z,2.4,.15,.85,{surface:'wood',ink:INK.BROWN,...detail});for(const dx of[-.8,.8])box(x+dx,11.55,z,.18,.45,.6,{...BR,...detail});}
  // Merged woodland clusters retain the densely forested mountain silhouette without extra actors.
  let seed=73471;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const avoid=(x,z)=>corridors.some(p=>{const dx=p.b[0]-p.a[0],dz=p.b[2]-p.a[2],n=dx*dx+dz*dz,t=Math.max(0,Math.min(1,((x-p.a[0])*dx+(z-p.a[2])*dz)/n));return Math.hypot(x-p.a[0]-t*dx,z-p.a[2]-t*dz)<p.width*.5+2.4;})||towers.some(t=>Math.abs(x-t.x)<10&&Math.abs(z-t.z)<9)||(Math.abs(x)<10&&Math.abs(z-66)<9);
  for(let i=0;i<1100;i++){const x=-124+random()*248,z=-72+random()*152;if(avoid(x,z))continue;const y=ground(x,z),h=2.7+random()*3.4,r=1.4+random()*1.3;const trunk=new THREE.CylinderGeometry(.1,.18,h,5);trunk.translate(x,y+h*.5,z);addGeo(trunk,INK.BROWN,'wood');for(let j=0;j<3;j++){const crown=new THREE.IcosahedronGeometry(r,1);crown.scale(1,.65+random()*.4,1);crown.translate(x+(random()-.5)*1.2,y+h+j*.7,z+(random()-.5)*1.2);addGeo(crown,i%9===0?INK.BROWN:INK.GREEN,'foliage');}}
  const forest=[];
  for(let i=0;i<8000;i++){const x=-485+random()*970,z=-480+random()*820;if(Math.abs(x)<130&&z>-77&&z<87)continue;const r=2.5+random()*2.0,h=2.8+random()*3.0,y=farHeight(x,z),g=new THREE.SphereGeometry(r,7,5);g.scale(1,.8+random()*.5,1);g.translate(x,y+h,z);forest.push(g);}
  const woods=new THREE.Mesh(mergeGeometries(forest,false),makeInkMaterial({surface:'foliage',ink:INK.GREEN}));woods.userData.noSun=true;woods.matrixAutoUpdate=false;B.scene.add(woods);L.meshes.push(woods);
  for(const side of[-1,1]){collider(side*121,-24,5,2,103,145,{noNav:true,noGrapple:true});collider(0,-24,side<0?-67:77,244,103,2,{noNav:true,noGrapple:true});}collider(0,78,5,244,4,146,{noNav:true,noGrapple:true});
  L.teamSpawns=[towers[0],towers[4]].map(t=>[-2.2,2.2].flatMap(dz=>[-3.6,-1.2,1.2,3.6].map(dx=>new THREE.Vector3(t.x+dx,t.y+.08,t.z+dz))));
  L.teamFacing=[-Math.PI/2,Math.PI/2];L.playerStart.copy(L.teamSpawns[0][0]);
  L.bombSites=[{id:'A',pos:new THREE.Vector3(0,26.08,16),radius:2.7},{id:'B',pos:new THREE.Vector3(0,12.08,66),radius:2.8}];
  L.arenaSpawns=[...L.teamSpawns[0].slice(0,2),...L.teamSpawns[1].slice(0,2),new THREE.Vector3(-48,20.08,-12),new THREE.Vector3(0,26.08,16),new THREE.Vector3(48,34.08,-10),new THREE.Vector3(-48,2.08,66),new THREE.Vector3(0,12.08,66),new THREE.Vector3(48,17.08,66)].map(v=>v.clone());
  for(const t of towers){spawn(t.x,t.y+.08,t.z);pickup(t.x+2.7,t.y+.15,t.z+1.9);sniper(t.x+4.6,t.y+5.48,t.z+3.4);}
  for(const p of trail.slice(1,-1).filter(p=>Math.abs(p[0])!==8)){spawn(p[0],p[1]+.08,p[2]);pickup(p[0]+.8,p[1]+.15,p[2]);}
  // Step-grid support must cover the full standing footprint, including adjacent higher treads.
  for(const spots of[L.spawns,L.pickups,L.arenaSpawns])for(const p of spots)if(p.z>55){let top=-Infinity;for(let x=Math.floor(p.x-.43);x<=Math.floor(p.x+.43);x++)for(let z=Math.floor(p.z-.43);z<=Math.floor(p.z+.43);z++){const f=floors.get(x+','+z);if(f)top=Math.max(top,f.y);}if(Number.isFinite(top))p.y=top+.08;}
  L.zones=towers.map((t,i)=>({name:['West Watchtower','Ridge Watchtower','Mutianyu Pass','High Watchtower','East Watchtower'][i],x:t.x,z:t.z,bounds:{minX:t.x-21,maxX:t.x+21,minZ:t.z-11,maxZ:t.z+11}}));
  L.zones.push({name:'Mountain Trail',x:0,z:66,bounds:{minX:-115,maxX:115,minZ:55,maxZ:75}});
  L.tactical.labels=[...L.zones.map(z=>({name:z.name,x:z.x,z:z.z,small:true})),{name:'Great Wall Ridge',x:0,z:-44}];
  L.routeLinks=links;L.trailRoute=trail;L.landmarkViews=[{name:'ridge',pos:[-75,27,5],look:[10,30,4]},{name:'watchtower',pos:[-23,27.8,16],look:[0,29.2,16]},{name:'mountain-trail',pos:[-26,10,70],look:[3,32,16]},{name:'aerial',pos:[-110,95,138],look:[0,20,8]}];
  return B.finish();
}

// Lombard's Hyde-to-Leavenworth block keeps the eight bends and 27% hillside;
// wider stairs and two residential courtyards give foot combat alternatives to the road.
function buildLombard(B) {
  const { L, box, slab, collider, addGeo, cyl, sphere, stairs, wallX, wallZ, rail, spawn, sniper, pickup } = B;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  L.key = 'lombard'; L.bounds = { minX: -47, maxX: 47, minZ: -83, maxZ: 83 }; L.navCell = 1.25; L.fallY = -12;
  const hill = z => 34 * (1 - Math.max(0, Math.min(1, (z + 63) / 126)));
  const floor = z => hill(-63 + Math.floor(Math.max(0, Math.min(125.9999, z + 63)) / .75) * .75);
  const yAt = z => z >= 63 ? 0 : z < -63 ? 34 : floor(z);
  const NC = { noCollide: true }, G = { ...NC, surface: 'grass', ink: INK.OLIVE }, ST = { surface: 'stone', ink: INK.BLACK };
  const buildings = [], paths = [];
  // Fine support treads reproduce the slope without asking axis-aligned physics to walk a mesh.
  for (let i = 0; i < 168; i++) {
    const z = -63 + i * .75, y = hill(z);
    collider(0, -6, z + .375, 94, y + 6, .751);
  }
  box(0, -6, -73, 94, 40, 20, { surface: 'ground', ink: INK.BLACK });
  box(0, -6, 73, 94, 6, 20, { surface: 'ground', ink: INK.BLACK });
  const quad = (a, b, c, d, ink, surface) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 3, 4, 5]);
    g.computeVertexNormals(); addGeo(g, ink, surface);
  };
  quad([-47, 34.025, -63], [-47, .025, 63], [47, .025, 63], [47, 34.025, -63], INK.OLIVE, 'grass');
  const line = (a, b, radius, ink, surface) => {
    const va = V(...a), vb = V(...b), delta = vb.clone().sub(va);
    const g = new THREE.CylinderGeometry(radius, radius, delta.length(), 6);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), delta.normalize()));
    g.translate(...va.add(vb).multiplyScalar(.5).toArray()); addGeo(g, ink, surface);
  };
  const roadX = t => 8.2 * Math.sin(t * Math.PI * 8);
  const curve = [], n = 384;
  for (let i = 0; i <= n; i++) {
    const t = i / n, z = -63 + 126 * t, dx = 8.2 * Math.PI * 8 * Math.cos(t * Math.PI * 8), len = Math.hypot(dx, 126);
    curve.push({ x: roadX(t), z, nx: 126 / len, nz: -dx / len });
  }
  for (let i = 0; i < n; i++) {
    const a = curve[i], b = curve[i + 1];
    const edge = (p, s, w, lift) => [p.x + p.nx * w * s, hill(p.z + p.nz * w * s) + lift, p.z + p.nz * w * s];
    quad(edge(a, -1, 2.4, .075), edge(b, -1, 2.4, .075), edge(b, 1, 2.4, .075), edge(a, 1, 2.4, .075), INK.RED, 'paving');
    for (const side of [-1, 1]) {
      const innerA = edge(a, side, 2.4, .115), innerB = edge(b, side, 2.4, .115), outerA = edge(a, side, 2.9, .115), outerB = edge(b, side, 2.9, .115);
      if (side > 0) quad(innerA, innerB, outerB, outerA, INK.BLACK, 'stone');
      else quad(outerA, outerB, innerB, innerA, INK.BLACK, 'stone');
      const lipA = outerA.map((v, j) => j === 1 ? v - .17 : v), lipB = outerB.map((v, j) => j === 1 ? v - .17 : v);
      if (side > 0) quad(outerA, outerB, lipB, lipA, INK.BLACK, 'limestone');
      else quad(lipA, lipB, outerB, outerA, INK.BLACK, 'limestone');
    }
  }
  paths.push(curve.filter((_, i) => i % 8 === 0).map(p => [p.x - 2.4, p.z]).concat(curve.filter((_, i) => i % 8 === 0).reverse().map(p => [p.x + 2.4, p.z])));
  // Continuous side stairs follow the actual pedestrian routes; the road remains smoothly drawn.
  for (const s of [-1, 1]) {
    for (let i = 0; i < 168; i++) {
      const z = -63 + .75 * i, y = hill(z);
      // Keep every tread above the grass and close the riser across the full 20 cm step.
      box(s * 15.8, y - .22, z + .375, 3.6, .26, .75, { ...NC, surface: 'stone', ink: INK.BLACK });
      if (i % 8 === 0 && i > 8 && i < 160) {
        box(s * 17.65, y, z, .065, .92, .065, { ...NC, surface: 'metal', ink: INK.BLACK });
        if (i < 152) line([s * 17.65, y + .92, z], [s * 17.65, hill(z + 6) + .92, z + 6], .035, INK.BLACK, 'metal');
      }
    }
    paths.push([[s * 15.8 - 1.8, -63], [s * 15.8 + 1.8, -63], [s * 15.8 + 1.8, 63], [s * 15.8 - 1.8, 63]]);
  }
  let seed = 381;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const bush = (x, y, z, r, flower = false) => {
    const g = new THREE.SphereGeometry(r, 7, 5); g.scale(1, .72, .9); g.translate(x, y + r * .62, z); addGeo(g, INK.GREEN, 'foliage');
    if (flower) for (let j = 0; j < 4; j++) {
      const a = rnd() * TAU, rr = r * .7 * rnd();
      sphere(x + Math.cos(a) * rr, y + r * (1.1 - rr * .16), z + Math.sin(a) * rr, .11 + rnd() * .10, { seg: 5, ink: [INK.PINK, INK.BLUE, INK.VIOLET, INK.ORANGE][j], surface: j === 1 ? 'ceramic' : 'plaster' });
    }
  };
  // Hydrangea-filled triangular beds are the street's dominant silhouette from both ends.
  for (let k = 0; k < 8; k++) {
    const z = -63 + (k + .5) * 126 / 8, s = k % 2 ? 1 : -1, cx = s * 7.3;
    for (let j = 0; j < 72; j++) {
      const bx = cx + (rnd() - .5) * 7.2, bz = z + (rnd() - .5) * 8.0;
      const t = Math.max(0, Math.min(1, (bz + 63) / 126));
      if (Math.abs(bx - roadX(t)) < 5) continue;
      bush(bx, hill(bz) + .03, bz, .40 + rnd() * .25, true);
    }
    // Dense mature shrubs add intermittent hard cover without barricading the red-brick route.
    const hy = yAt(z), hx = s * 10.7;
    box(hx, hy, z, 3.4, 1.35, 2.1, { surface: 'foliage', ink: INK.GREEN });
    for (let j = -2; j <= 2; j++) bush(hx + j * .55, hy + .65, z, .8);
  }
  for (let i = 3; i < curve.length - 3; i += 4) {
    const p = curve[i];
    for (const s of [-1, 1]) {
      const x = p.x + p.nx * 3.4 * s, z = p.z + p.nz * 3.4 * s;
      if (Math.abs(x) < 13.5) bush(x, hill(z) + .04, z, .39, i % 12 === 3);
    }
  }
  const tree = (x, z, size = 1) => {
    const y = yAt(z);
    cyl(x, y, z, .21 * size, 3.9 * size, { surface: 'wood', ink: INK.BROWN });
    for (let j = 0; j < 5; j++) { const a = j * 2.4; bush(x + Math.cos(a) * .9 * size, y + (3.0 + (j % 2) * .7) * size, z + Math.sin(a) * .7 * size, 1.7 * size); }
  };
  for (const s of [-1, 1]) for (const z of [-57, -40, -5, 10, 42, 58]) tree(s * 19.2, z, .8 + rnd() * .25);
  // Houses differ in bay windows, rooflines and stucco, matching Russian Hill's mix of eras.
  const house = (s, z, w, depth, floors, ink, style) => {
    const x = s * (20 + w / 2), y = hill(z - depth / 2) + .05, h = floors * 3.2, front = s * 20;
    box(x, y - 7, z, w, 7, depth, { surface: 'brick', ink: INK.BLACK });
    box(x, y, z, w, h, depth, { surface: 'stucco', ink });
    buildings.push({ x1: x - w / 2, z1: z - depth / 2, x2: x + w / 2, z2: z + depth / 2 });
    for (let f = 0; f <= floors; f++) box(front - s * .12, y + f * 3.2, z, .32, .17, depth + .2, { ...NC, surface: 'ceramic', ink: INK.BLUE });
    for (let f = 0; f < floors; f++) for (let j = 0; j < 3; j++) {
      const wz = z + (j - 1) * (depth / 3.3), wy = y + 1 + f * 3.2, bay = style % 2 && j === 1;
      if (bay) box(front - s * .68, wy - .6, wz, 1.35, 2.8, 3.1, { ...NC, surface: 'stucco', ink });
      const face = front - s * (bay ? 1.39 : .025);
      box(face, wy, wz, .065, 1.8, 2.5, { ...NC, surface: 'ceramic', ink: INK.BLUE });
      box(face - s * .035, wy + .1, wz, .07, 1.6, 2.2, { ...NC, surface: 'glass', ink: INK.TEAL });
      box(face - s * .08, wy + .1, wz, .075, 1.6, .065, { ...NC, surface: 'ceramic', ink: INK.BLUE });
      box(face - s * .08, wy + .87, wz, .075, .065, 2.2, { ...NC, surface: 'ceramic', ink: INK.BLUE });
      if (bay) for (const e of [-1, 1]) {
        box(front - s * .75, wy, wz + e * 1.57, 1.1, 1.8, .065, { ...NC, surface: 'glass', ink: INK.TEAL });
        box(front - s * .75, wy + .85, wz + e * 1.62, 1.2, .06, .06, { ...NC, surface: 'ceramic', ink: INK.BLUE });
      }
    }
    box(x, y + h, z, w + .55, .28, depth + .55, { surface: 'stone', ink: INK.BLACK });
    if (style === 2) {
      const roof = new THREE.CylinderGeometry(0, 1, 1, 4); roof.rotateY(Math.PI / 4); roof.scale(w * .75, 3, depth * .75); roof.translate(x, y + h + 1.5, z); addGeo(roof, INK.BLACK, 'roofTile');
    } else {
      for (const zz of [z - depth / 2, z + depth / 2]) box(x, y + h + .28, zz, w + .2, .6, .2, { ...NC, surface: 'stucco', ink });
      box(x, y + h + .28, z, 2.5, .6, 2, { ...NC, surface: 'metal', ink: INK.BLACK });
    }
    box(x + s * w * .22, y + h, z + depth * .2, 1.3, 2, 1, { ...NC, surface: 'brick', ink: INK.RED });
    for (let dz = -depth * .45; dz < depth * .48; dz += .8) box(front - s * .22, y + h - .24, z + dz, .55, .28, .18, { ...NC, surface: 'ceramic', ink: INK.BLUE });
    const doorZ = z + depth * .28;
    box(front - s * .04, y + .1, doorZ, .12, 2.65, 1.7, { ...NC, surface: 'ceramic', ink: INK.BLUE });
    box(front - s * .12, y + .1, doorZ, .10, 2.4, 1.3, { ...NC, surface: 'wood', ink: INK.BROWN });
    box(front - s * .18, y + 1.8, doorZ, .04, .45, 1.05, { ...NC, surface: 'glass', ink: INK.TEAL });
    sphere(front - s * .23, y + 1.1, doorZ + .38, .055, { seg: 5, surface: 'metal', ink: INK.ORANGE });
    // Recessed garage and front steps are façade detail; courtyards have their own usable doors.
    box(front - s * .035, y + .3, z - depth * .28, .08, 2.3, 3.3, { ...NC, surface: 'wood', ink: INK.BROWN });
    for (let r = 1; r < 6; r++) box(front - s * .085, y + .3 + r * .36, z - depth * .28, .025, .025, 3.3, { ...NC, surface: 'metal', ink: INK.BLACK });
  };
  for (const s of [-1, 1]) {
    const gap = s < 0 ? -22 : 22;
    let index = 0;
    for (const z of [-54, -38, -22, -6, 10, 26, 42, 57]) {
      if (Math.abs(z - gap) < 13) continue;
      house(s, z, 15 + (index % 3) * 2, 12.0, 2 + index % 3, [INK.BLUE, INK.GREEN, INK.PINK, INK.ORANGE][index % 4], index % 3); index++;
    }
  }
  // Two playable residential gardens have flat planting circles and two stair entrances each.
  const sites = [];
  for (const [s, z, id] of [[-1, -22, 'A'], [1, 22, 'B']]) {
    const y = yAt(z - 8.5), x = s * 30.8;
    slab(s < 0 ? -42 : 22, z - 8, s < 0 ? -22 : 42, z + 8, y, 7, { surface: 'stone', ink: INK.BLACK });
    for (const dz of [-5, 5]) {
      const fromY = yAt(z + dz), rise = y - fromY, count = Math.max(1, Math.ceil(rise / .28));
      stairs(s * 18, fromY, z + dz, s < 0 ? '-x' : '+x', count, 3.6, { rise: rise / count, run: 4 / count, surface: 'stone', ink: INK.BLACK });
    }
    wallZ(z - 8, z + 8, s * 42, y, 2.7, .35, [], { surface: 'plaster', ink: INK.BLUE });
    for (const dz of [-8, 8]) wallX(s < 0 ? -42 : 22, s < 0 ? -22 : 42, z + dz, y, 1.15, .35, [], { surface: 'brick', ink: INK.BLACK, noNav: true });
    box(s * 39.4, y, z - 4.7, 3, 1.3, 3, { surface: 'foliage', ink: INK.GREEN });
    box(s * 25, y, z + 1.5, 2.3, 1.2, 3.1, { surface: 'wood', ink: INK.BROWN });
    for (let j = 0; j < 5; j++) bush(s * 39.3, y + .85, z - 6.3 + j * .85, .62, true);
    box(s * 36.5, y, z + 6.0, 4.1, .42, 1.5, { surface: 'wood', ink: INK.BROWN });
    cyl(s * 39, y, z + 4.6, .15, 3.1, { ...NC, surface: 'wood', ink: INK.BROWN });
    sites.push({ id, pos: V(x, y, z), radius: 3 });
    paths.push([[s < 0 ? -42 : 22, z - 8], [s < 0 ? -22 : 42, z - 8], [s < 0 ? -22 : 42, z + 8], [s < 0 ? -42 : 22, z + 8]]);
    pickup(x, y, z + 4.0);
  }
  const car = (x, y, z, yaw, ink) => {
    const place = (g, material) => { g.rotateY(yaw); g.translate(x, y, z); addGeo(g, ink, material); };
    place(new THREE.BoxGeometry(1.9, .7, 4.2).translate(0, .7, 0), 'lacquer');
    place(new THREE.BoxGeometry(1.66, .72, 2.1).translate(0, 1.36, -.15), 'glass');
    place(new THREE.BoxGeometry(1.7, .12, 2.15).translate(0, 1.75, -.15), 'plaster');
    for (const xx of [-.92, .92]) for (const zz of [-1.3, 1.3]) place(new THREE.CylinderGeometry(.37, .37, .2, 10).rotateZ(Math.PI / 2).translate(xx, .4, zz), 'metal');
    collider(x, y, z, Math.abs(Math.cos(yaw)) * 1.9 + Math.abs(Math.sin(yaw)) * 4.2, 1.75, Math.abs(Math.cos(yaw)) * 4.2 + Math.abs(Math.sin(yaw)) * 1.9);
  };
  car(-5, 34, -72, Math.PI / 2, INK.RED); car(8, 0, 73, Math.PI / 2, INK.BLUE);
  for (const [z, ink] of [[-43, INK.RED], [38, INK.BLUE]]) {
    const t = (z + 63) / 126, x = roadX(t);
    car(x, yAt(z), z, Math.atan2(8.2 * Math.PI * 8 * Math.cos(t * Math.PI * 8), 126), ink);
  }
  // Opposite teams deploy into sheltered cross-street garages, not on an exposed hill crest.
  L.teamSpawns = [[], []]; L.teamFacing = [Math.PI / 2, -Math.PI / 2];
  for (const [team, s, z, y] of [[0, -1, -74, 34], [1, 1, 74, 0]]) {
    const x = s * 32;
    slab(x - 10, z - 7, x + 10, z + 7, y, 1, ST);
    wallZ(z - 7, z + 7, x - s * 10, y, 4.1, .45, [[z - 5, z - 2, 0, 3], [z + 2, z + 5, 0, 3]], { surface: 'brick', ink: INK.BLACK });
    wallZ(z - 7, z + 7, x + s * 10, y, 4.1, .45, [], { surface: 'plaster', ink: INK.BLUE });
    for (const dz of [-7, 7]) wallX(x - 10, x + 10, z + dz, y, 4.1, .45, [], { surface: 'plaster', ink: INK.BLUE });
    slab(x - 10.3, z - 7.3, x + 10.3, z + 7.3, y + 4.1, .25, ST);
    box(x - s * 5, y, z, 3, 2.2, 3, { surface: 'wood', ink: INK.BROWN });
    for (let i = 0; i < 8; i++) L.teamSpawns[team].push(V(x + s * (i % 4) * 1.7, y, z - 2.7 + Math.floor(i / 4) * 5.4));
    buildings.push({ x1: x - 10, z1: z - 7, x2: x + 10, z2: z + 7 });
  }
  L.playerStart = L.teamSpawns[0][0].clone(); L.bombSites = sites;
  const perimeter = { noNav: true, noGrapple: true };
  collider(-47.5, -8, 0, 1, 100, 168, perimeter); collider(47.5, -8, 0, 1, 100, 168, perimeter);
  collider(0, -8, -83.5, 96, 100, 1, perimeter); collider(0, -8, 83.5, 96, 100, 1, perimeter);
  collider(0, 86, 0, 96, 2, 168, perimeter);
  // Hyde cable-car tracks, overhead power wires, and Leavenworth crosswalk tie the block to SF.
  for (const zz of [-77, -75.6, -71.5, -70.1]) box(0, 34.015, zz, 40, .022, .07, { ...NC, surface: 'metal', ink: INK.BLACK });
  for (const z of [-65.5, 65.5]) for (let x = -8; x <= 8; x += 2) box(x, yAt(z) + .015, z, 1.05, .025, 3.8, { ...NC, surface: 'ceramic', ink: INK.BLUE });
  for (const z of [-66, 66]) for (const s of [-1, 1]) {
    const x = s * 18, y = yAt(z);
    cyl(x, y, z, .10, 5.8, { ...NC, surface: 'metal', ink: INK.BLACK });
    line([x, y + 5.7, z], [x - s * 1.4, y + 5.5, z], .07, INK.BLACK, 'metal');
    sphere(x - s * 1.4, y + 5.4, z, .25, { surface: 'ceramic', ink: INK.BLUE });
  }
  for (const z of [-77, -70]) line([-46, 41, z], [46, 41, z], .028, INK.BLACK, 'metal');
  // A stationary Powell-Hyde cable car is both a local landmark and cross-street cover.
  box(7, 34.3, -74, 7, 1.2, 2.7, { surface: 'lacquer', ink: INK.RED });
  box(7, 35.5, -74, 6.3, 1.8, 2.5, { ...NC, surface: 'wood', ink: INK.BROWN });
  for (const s of [-1, 1]) for (let x = 4.3; x <= 9.8; x += 1.1) {
    box(x, 35.85, -74 + s * 1.28, .9, 1.25, .04, { ...NC, surface: 'glass', ink: INK.TEAL });
    box(x - .51, 35.5, -74 + s * 1.33, .09, 1.8, .09, { ...NC, surface: 'lacquer', ink: INK.ORANGE });
  }
  box(7, 37.3, -74, 7.5, .2, 3.1, { ...NC, surface: 'lacquer', ink: INK.BLACK });
  box(7, 37.5, -74, 4.9, .22, 1.9, { ...NC, surface: 'lacquer', ink: INK.BLACK });
  collider(7, 34, -74, 7, 3.55, 2.7);
  for (const [x, z] of [[-15.8, -53], [15.8, -32], [-15.8, 0], [15.8, 16], [-15.8, 34], [15.8, 55], [-9, -66], [9, 66]]) {
    const p = V(x, yAt(z - .43) + .01, z); L.arenaSpawns.push(p); spawn(...p.toArray());
  }
  for (const team of L.teamSpawns) L.arenaSpawns.push(team[0].clone(), team[4].clone());
  for (const [x, z] of [[-15.8, -48], [15.8, -12], [-15.8, 23], [15.8, 48]]) pickup(x, yAt(z - .43) + .01, z);
  sniper(-15.8, yAt(-60.43) + .01, -60); sniper(15.8, yAt(59.57) + .01, 60);
  L.zones = [{ name: 'Hyde Street', x: 0, z: -73, bounds: { minX: -47, maxX: 47, minZ: -83, maxZ: -63 } }, { name: 'Eight Hairpin Turns', x: 0, z: 0, bounds: { minX: -18, maxX: 18, minZ: -63, maxZ: 63 } }, { name: 'Leavenworth Street', x: 0, z: 73, bounds: { minX: -47, maxX: 47, minZ: 63, maxZ: 83 } }];
  L.tactical = { buildings, water: [], paths, labels: [{ name: 'Hyde Street', x: 0, z: -73 }, { name: 'Eight Hairpin Turns', x: 0, z: 0, small: true }, { name: 'Leavenworth Street', x: 0, z: 73 }, { name: 'Garden Courtyard', x: -31, z: -22, small: true }, { name: 'Terrace Garden', x: 31, z: 22, small: true }] };
  const result = B.finish();
  if (!buildLombard.signs) {
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 256;
    const c = canvas.getContext('2d');
    for (const [i, name] of ['LOMBARD ST', 'HYDE ST', 'LEAVENWORTH ST', '5 MPH'].entries()) {
      c.fillStyle = i === 3 ? '#d3bb69' : '#24493f'; c.fillRect(i * 256, 0, 256, 256);
      c.fillStyle = i === 3 ? '#252a28' : '#f0eee5'; c.font = `bold ${i === 2 ? 23 : 31}px sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(name, i * 256 + 128, 128, 236);
    }
    buildLombard.signs = new THREE.CanvasTexture(canvas);
  }
  const signs = [];
  for (const [x, y, z, index, yaw, width] of [[-18, 38.2, -66, 0, 0, 3.8], [-18, 37.6, -66, 1, 0, 3.0], [18, 4.2, 66, 0, Math.PI, 3.8], [18, 3.6, 66, 2, Math.PI, 4.5], [12, 36.3, -64, 3, 0, 1.4]]) {
    const g = new THREE.PlaneGeometry(width, .65), uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (index + .02 + uv.getX(i) * .96) / 4, .24 + uv.getY(i) * .52);
    g.rotateY(yaw); g.translate(x, y, z); signs.push(g);
  }
  const signMesh = new THREE.Mesh(mergeGeometries(signs, false), makeInkMaterial({ surface: 'screen', ink: INK.GREEN, map: buildLombard.signs }));
  signMesh.matrixAutoUpdate = false; B.scene.add(signMesh); result.meshes.push(signMesh);
  // The bay and Telegraph Hill are scenery only and must not dilute the playable shadow map.
  const scenic = new Map();
  const scenery = (g, ink, surface) => { const key = `${ink}:${surface}`; if (!scenic.has(key)) scenic.set(key, { ink, surface, geos: [] }); scenic.get(key).geos.push(g); };
  const neighborhood = new THREE.PlaneGeometry(520, 340, 2, 136); neighborhood.rotateX(-Math.PI / 2);
  const np = neighborhood.attributes.position; for (let i = 0; i < np.count; i++) np.setY(i, hill(np.getZ(i)) - .3); neighborhood.computeVertexNormals(); scenery(neighborhood, INK.BLACK, 'ground');
  for (const s of [-1, 1]) for (let i = 0; i < 9; i++) {
    const z = -106 + i * 27, h = 8 + (i % 3) * 3, x = s * (68 + (i % 2) * 6);
    scenery(new THREE.BoxGeometry(24, h, 19).translate(x, hill(z) + h / 2, z), [INK.BLUE, INK.PINK, INK.ORANGE][i % 3], 'stucco');
    scenery(new THREE.BoxGeometry(24.6, .45, 19.6).translate(x, hill(z) + h, z), INK.BLACK, 'stone');
  }
  scenery(new THREE.BoxGeometry(360, .4, 230).translate(0, -18, 300), INK.TEAL, 'water');
  for (let row = 0; row < 4; row++) for (let i = 0; i < 14; i++) {
    const x = -154 + i * 23 + (row % 2) * 8, z = 111 + row * 29, h = 8 + rnd() * 17, y = -6 - row * 3;
    scenery(new THREE.BoxGeometry(13 + rnd() * 7, h, 15 + rnd() * 6).translate(x, y + h / 2, z), [INK.BLUE, INK.PINK, INK.ORANGE][i % 3], 'stucco');
  }
  const coitBase = new THREE.SphereGeometry(30, 16, 9); coitBase.scale(1.5, .45, 1); coitBase.translate(64, -1, 191); scenery(coitBase, INK.GREEN, 'grass');
  scenery(new THREE.CylinderGeometry(3.8, 4.4, 32, 12).translate(64, 27, 191), INK.BLUE, 'limestone');
  scenery(new THREE.CylinderGeometry(4.3, 3.8, 3, 12).translate(64, 44, 191), INK.BLUE, 'limestone');
  for (let j = 0; j < 12; j++) {
    const a = j / 12 * TAU, g = new THREE.BoxGeometry(1.1, 3.5, .12); g.rotateY(-a); g.translate(64 + Math.sin(a) * 4.0, 42.2, 191 + Math.cos(a) * 4.0); scenery(g, INK.BLACK, 'glass');
  }
  for (const { ink, surface, geos } of scenic.values()) {
    const m = new THREE.Mesh(mergeGeometries(geos, false), makeInkMaterial({ ink, surface })); m.userData.noSun = true; m.matrixAutoUpdate = false; B.scene.add(m); result.meshes.push(m);
  }
  return result;
}

function populateMatchSpawns(L, world) {
  const q = [], min = new THREE.Vector3(), max = new THREE.Vector3(), bounds = L.bounds;
  const fit = (x, y, z) => {
    if (x < bounds.minX + 1 || x > bounds.maxX - 1 || z < bounds.minZ + 1 || z > bounds.maxZ - 1) return null;
    min.set(x - .44, y - 1.4, z - .44); max.set(x + .44, y + 2.6, z + .44); world.query(min, max, q);
    const heights = [];
    for (const [dx, dz] of [[0, 0], [-.42, -.42], [-.42, .42], [.42, -.42], [.42, .42]]) {
      let top = -Infinity;
      for (const b of q) if (!b.data.noNav && b.max.y <= y + .65 && b.min.x <= x + dx && b.max.x >= x + dx && b.min.z <= z + dz && b.max.z >= z + dz) top = Math.max(top, b.max.y);
      if (!Number.isFinite(top)) return null;
      heights.push(top);
    }
    const floor = Math.max(...heights);
    if (floor - Math.min(...heights) > .4) return null;
    min.set(x - .44, floor + .04, z - .44); max.set(x + .44, floor + 1.84, z + .44);
    return world.overlapsAABB(min, max) ? null : new THREE.Vector3(x, floor + .05, z);
  };
  // A larger lobby needs actual standing room, not multiple actors wrapped onto the same
  // eight entries. Resolve nearby points against every map's real floors and full body volume.
  if (L.teamSpawns?.length === 2) {
    const original = L.teamSpawns.map(team => team.map(p => p.clone()));
    const middle = original.map(team => team.reduce((v, p) => v.add(p), new THREE.Vector3()).divideScalar(team.length));
    L.teamSpawns = original.map((seeds, team) => {
      const points = [];
      const accept = p => {
        if (!p || points.some(q => Math.abs(q.y - p.y) < 1.8 && Math.hypot(q.x - p.x, q.z - p.z) < 1.15)) return;
        if (p.distanceToSquared(middle[team]) > p.distanceToSquared(middle[1 - team])) return;
        points.push(p);
      };
      for (const p of seeds) accept(fit(p.x, p.y, p.z));
      for (let ring = 1; ring <= 10 && points.length < 16; ring++) for (const seed of seeds) {
        for (let i = 0; i < ring * 8 && points.length < 16; i++) {
          const a = i / (ring * 8) * TAU, r = ring * 1.35;
          const p = fit(seed.x + Math.sin(a) * r, seed.y, seed.z + Math.cos(a) * r);
          if (!p) continue;
          // Reject a clear pocket on the other side of a spawn-room wall.
          let clear = true;
          for (let j = 1, n = Math.ceil(r / .6); j < n; j++) {
            const k = j / n, x = seed.x + (p.x - seed.x) * k, z = seed.z + (p.z - seed.z) * k;
            min.set(x - .35, Math.max(seed.y, p.y) + .48, z - .35); max.set(x + .35, Math.max(seed.y, p.y) + 1.72, z + .35);
            if (world.overlapsAABB(min, max)) { clear = false; break; }
          }
          if (clear) accept(p);
        }
      }
      return points;
    });
  }
  return L;
}

export function buildLevel(scene, world, key = 'district', opts = {}) {
  const B = createBuilder(scene, world);
  const team = !!opts.team, arena = !!opts.arena || team;
  const level = key === 'greatwall' ? buildGreatWall(B) : key === 'yuanmingyuan' ? buildYuanmingyuan(B) : key === 'summerpalace' ? buildSummerPalace(B) : key === 'lombard' ? buildLombard(B) : key === 'timesquare' ? buildTimesSquare(B) : key === 'zijingang' ? buildZijingang(B) : key === 'depot' ? buildDepot(B) : key === 'mexico' ? buildMexico(B, arena) : key === 'undercity' ? buildUndercity(B, arena, team) : buildDistrict(B, arena, team);
  return populateMatchSpawns(level, world);
}
