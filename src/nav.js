// Navigation grid auto-generated from the collision world (multi-level: one node per walkable surface per cell).
import * as THREE from 'three';

const _min = new THREE.Vector3(), _max = new THREE.Vector3(), _q = [];
const _rp = new THREE.Vector3(), _down = new THREE.Vector3(0, -1, 0);
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

class Heap {
  constructor() { this.a = []; }
  push(f, n) { const a = this.a; a.push([f, n]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a; const top = a[0]; const last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
  get size() { return this.a.length; }
}

export class NavGrid {
  // agentR is the half-width of the widest thing that will walk this graph, plus a little slack.
  // Links used to be carved 0.25 wide, narrower than an enemy, so the graph promised gaps that
  // nothing could physically fit through and whoever tried wedged itself in the wall.
  constructor(world, bounds, cell = 1.0, agentR = 0.42) {
    this.world = world; this.cell = cell; this.agentR = agentR;
    this.minX = bounds.minX; this.minZ = bounds.minZ;
    // Underground team routes include the service tunnels below the usual map floor.
    this.minY = bounds.minY ?? -5;
    this.nx = Math.ceil((bounds.maxX - bounds.minX) / cell); this.nz = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
    this.nodes = []; this.cells = new Array(this.nx * this.nz).fill(null);
    this._gen = null; this._searchId = 0;
  }
  build() {
    const w = this.world, c = this.cell;
    for (let iz = 0; iz < this.nz; iz++) for (let ix = 0; ix < this.nx; ix++) {
      const x = this.minX + (ix + 0.5) * c, z = this.minZ + (iz + 0.5) * c;
      _min.set(x - 0.05, -30, z - 0.05); _max.set(x + 0.05, 90, z + 0.05); w.query(_min, _max, _q);
      if (_q.length === 0) continue;
      const tops = new Set();
      for (const b of _q) if (!b.data.noNav) tops.add(b.max.y);
      for (const y of [...tops].sort((a, b) => a - b)) {
        if (y < this.minY || y > 70) continue;
        _min.set(x - 0.3, y + 0.5, z - 0.3); _max.set(x + 0.3, y + 1.85, z + 0.3);
        if (w.overlapsAABB(_min, _max)) continue;
        const id = this.nodes.length; this.nodes.push({ id, x, y, z, ix, iz, links: [] });
        const ci = iz * this.nx + ix; (this.cells[ci] || (this.cells[ci] = [])).push(id);
      }
    }
    for (const A of this.nodes) {
      for (const [dx, dz] of DIRS) {
        const nix = A.ix + dx, niz = A.iz + dz;
        if (nix < 0 || niz < 0 || nix >= this.nx || niz >= this.nz) continue;
        const cand = this.cells[niz * this.nx + nix]; if (!cand) continue;
        for (const id of cand) {
          const B = this.nodes[id]; const dy = B.y - A.y;
          if (dy > 1.35 || dy < -8) continue;
          if (!this._linkClear(A, B)) continue;
          if (dx !== 0 && dz !== 0) {
            const s1 = this._cornerNode(A, A.ix + dx, A.iz, A.y, B.y), s2 = this._cornerNode(A, A.ix, A.iz + dz, A.y, B.y);
            if (!s1 || !s2 || !this._linkClear(s1, B) || !this._linkClear(s2, B)) continue;
          }
          if (dy < -0.6 && !this._dropClear(A, B)) continue;
          const horiz = Math.hypot(dx, dz) * c; let cost = Math.hypot(horiz, dy);
          if (dy > 0.6) cost *= 1 + dy * 1.1; else if (dy < -0.6) cost += -dy * 0.35;
          A.links.push({ to: id, cost, dy });
        }
      }
    }
    this._escapeLinks();
    // Cells whose centre sits within a body-width of a wall end up linked to nothing. They are
    // still real standing room, so they stay in the graph, but handing one out as the start or
    // the end of a search only ever produces a route that goes nowhere.
    for (const A of this.nodes) A.iso = A.links.length === 0;
    for (const A of this.nodes) for (const l of A.links) this.nodes[l.to].iso = false;
    this._gen = new Int32Array(this.nodes.length); this._g = new Float32Array(this.nodes.length); this._from = new Int32Array(this.nodes.length);
    return this;
  }
  // Clearance wide enough to keep bodies out of gaps they cannot fit through also strands the
  // rim of cells hugging every wall. Something shoved into one of those pockets is physically
  // able to walk out but has no route that says so, and spends the rest of the round hopping
  // against the wall. So give each small pocket a one-way way out, tested at a tighter radius:
  // strict for planning, forgiving for escape, and nothing is ever routed *into* a dead end.
  _escapeLinks() {
    const n = this.nodes.length, comp = new Int32Array(n).fill(-1), sizes = [];
    const rev = this.nodes.map(() => []);
    this.nodes.forEach((N, i) => { for (const l of N.links) rev[l.to].push(i); });
    for (let s = 0; s < n; s++) {
      if (comp[s] >= 0) continue;
      const id = sizes.length, stack = [s]; comp[s] = id; let c = 0;
      while (stack.length) {
        const v = stack.pop(); c++;
        for (const l of this.nodes[v].links) if (comp[l.to] < 0) { comp[l.to] = id; stack.push(l.to); }
        for (const u of rev[v]) if (comp[u] < 0) { comp[u] = id; stack.push(u); }
      }
      sizes.push(c);
    }
    // Islands with real acreage are deliberate — a roof you can drop off but not climb back to.
    // Only the slivers get rescued.
    const POCKET = 24;
    for (const A of this.nodes) {
      if (sizes[comp[A.id]] > POCKET) continue;
      let best = null, bestS = Infinity;
      for (let iz = A.iz - 2; iz <= A.iz + 2; iz++) for (let ix = A.ix - 2; ix <= A.ix + 2; ix++) {
        if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) continue;
        const cand = this.cells[iz * this.nx + ix]; if (!cand) continue;
        for (const id of cand) {
          const B = this.nodes[id];
          if (sizes[comp[id]] <= sizes[comp[A.id]] || Math.abs(B.y - A.y) > 1.5) continue;
          const s = Math.hypot(B.x - A.x, B.z - A.z) + Math.abs(B.y - A.y);
          if (s < bestS && this._segClear(A, B, this.agentR * 0.55)) { bestS = s; best = B; }
        }
      }
      if (best) { A.links.push({ to: best.id, cost: bestS * 3, dy: best.y - A.y }); A.pocket = true; }   // priced high: a last resort, not a shortcut
    }
  }
  // Is there a node in this cell a body could stand on and step to from A? Used to reject
  // diagonals that clip a corner: both orthogonal neighbours have to be genuinely walkable,
  // not merely occupied by some node at a plausible height.
  _cornerNode(A, ix, iz, y1, y2) {
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return null;
    const cand = this.cells[iz * this.nx + ix]; if (!cand) return null;
    for (const id of cand) {
      const N = this.nodes[id];
      if (Math.abs(N.y - y1) > 0.75 && Math.abs(N.y - y2) > 0.75) continue;
      if (this._linkClear(A, N)) return N;
    }
    return null;
  }
  // Sweep a body-sized box along the segment. The old version took the bounding rectangle of
  // the two nodes, which for a diagonal is a whole square: it both over-reported blockage on
  // the diagonal and under-reported it sideways, because the box was thinner than an enemy.
  _segClear(A, B, r = this.agentR, lo = 0.5, hi = 1.7) {
    // Start above knee height so the next stair tread does not read as a wall; railings are
    // a metre tall and still block, which is what keeps enemies off balconies they cannot reach.
    const y = Math.max(A.y, B.y);
    const dx = B.x - A.x, dz = B.z - A.z, len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / (r * 1.2)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, x = A.x + dx * t, z = A.z + dz * t;
      _min.set(x - r, y + lo, z - r); _max.set(x + r, y + hi, z + r);
      if (this.world.overlapsAABB(_min, _max)) return false;
    }
    return true;
  }
  _linkClear(A, B) { return this._segClear(A, B); }
  _dropClear(A, B) {
    _min.set(B.x - this.agentR * 0.6, B.y + 0.05, B.z - this.agentR * 0.6);
    _max.set(B.x + this.agentR * 0.6, A.y + 0.05, B.z + this.agentR * 0.6);
    return !this.world.overlapsAABB(_min, _max);
  }
  // Straight-line walkability between two arbitrary points, floor included. Powers path
  // smoothing here and the "just go at it" shortcut in the chase code.
  walkClear(a, b, r = this.agentR) {
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    if (len < 1e-4) return true;
    if (Math.abs(b.y - a.y) > 1.0) return false;   // never smooth across a level change
    const dy = b.y - a.y, steps = Math.ceil(len / (this.cell * 0.6));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, x = a.x + dx * t, z = a.z + dz * t, y = a.y + dy * t;
      _min.set(x - r, y + 0.5, z - r); _max.set(x + r, y + 1.7, z + r);
      if (this.world.overlapsAABB(_min, _max)) return false;
      if (i < steps && !this.world.raycast(_rp.set(x, y + 0.7, z), _down, 1.9)) return false;  // no shortcut over a hole
    }
    return true;
  }
  // asGoal: escape links only lead *out* of a pocket, so a pocket cell makes a fine place to
  // start from and a hopeless place to aim at. Somebody standing in one is better approached by
  // way of the nearest cell that can actually be routed to.
  nearestNode(pos, r = 3, maxDy = 4, asGoal = false) {
    const c = this.cell; const cx = Math.floor((pos.x - this.minX) / c), cz = Math.floor((pos.z - this.minZ) / c);
    let best = -1, bestS = Infinity, bestAny = -1, bestAnyS = Infinity;
    for (let iz = cz - r; iz <= cz + r; iz++) for (let ix = cx - r; ix <= cx + r; ix++) {
      if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) continue;
      const cand = this.cells[iz * this.nx + ix]; if (!cand) continue;
      for (const id of cand) {
        const n = this.nodes[id]; const dy = n.y - pos.y; const h = Math.hypot(n.x - pos.x, n.z - pos.z);
        const sAny = h + Math.abs(dy) * 2.0; if (sAny < bestAnyS) { bestAnyS = sAny; bestAny = id; }
        if (n.iso || dy < -maxDy || dy > 2.2) continue;
        const s = h + Math.abs(dy) * 1.5 + (asGoal && n.pocket ? 6 : 0);   // a penalty, not a ban: a pocket still beats nothing
        if (s < bestS) { bestS = s; best = id; }
      }
    }
    return best >= 0 ? best : bestAny;
  }
  // A* between two world positions; returns array of Vector3 or null
  findPath(from, to, maxExpand = 40000) {
    const start = this.nearestNode(from, 3, 3), goal = this.nearestNode(to, 4, 8, true);
    if (start < 0 || goal < 0) return null;
    const nodes = this.nodes, gen = this._gen, g = this._g, fromArr = this._from; const sid = ++this._searchId;
    const G = nodes[goal]; const h = (n) => Math.hypot(n.x - G.x, n.y - G.y, n.z - G.z) * 1.15;
    const heap = new Heap(); gen[start] = sid; g[start] = 0; fromArr[start] = -1; heap.push(h(nodes[start]), start);
    let bestN = start, bestH = h(nodes[start]); let expanded = 0; let found = false;
    const closed = new Set();
    while (heap.size) {
      const [, cur] = heap.pop(); if (closed.has(cur)) continue; closed.add(cur);
      if (cur === goal) { found = true; bestN = cur; break; }
      if (++expanded > maxExpand) break;
      const N = nodes[cur]; const hc = h(N); if (hc < bestH) { bestH = hc; bestN = cur; }
      for (const l of N.links) {
        const ng = g[cur] + l.cost;
        if (gen[l.to] !== sid || ng < g[l.to]) { gen[l.to] = sid; g[l.to] = ng; fromArr[l.to] = cur; heap.push(ng + h(nodes[l.to]), l.to); }
      }
    }
    const path = []; let n = bestN;
    while (n >= 0) { const nd = nodes[n]; path.push(new THREE.Vector3(nd.x, nd.y, nd.z)); n = fromArr[n]; }
    path.reverse();
    const out = this._smooth(path); out.complete = found;
    return out;
  }
  // String-pulling. Grid A* comes back as a staircase of cell centres and a body that steers at
  // each one in turn scrapes every corner on the way. Only the leading stretch is worth
  // straightening: a chaser repaths long before it reaches the tail.
  _smooth(path, lookahead = 4, budget = 8) {
    if (path.length < 3) return path;
    const out = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
      let j = i + 1;
      if (out.length <= budget) {
        for (let k = Math.min(path.length - 1, i + lookahead); k > j; k--) {
          if (this.walkClear(path[i], path[k])) { j = k; break; }
        }
      }
      out.push(path[j]); i = j;
      if (out.length > budget) { for (let k = i + 1; k < path.length; k++) out.push(path[k]); break; }
    }
    return out;
  }
  randomNode() { return this.nodes[Math.floor(Math.random() * this.nodes.length)]; }
}
