// Baked sector-to-sector visibility. A live raycast per (viewer, candidate) pair is
// 16k tests at 128 players; this turns most of them into a bit test. 16 m XZ cells,
// 2D on purpose: height is left to the LOS refine. Cached next to the process so a
// second match on the same map does not pay the bake again.

import * as THREE from '../vendor/three.module.js';

export const CELL = 16;
export const VISIBLE_R = 150;
export const NEARBY_R = 60;
export const HYSTERESIS_MS = 250;
export const SNAP_BUDGET = 1200;

const MAGIC = 0x50565301; // 'PVS\x01'
const _a = new THREE.Vector3(), _b = new THREE.Vector3();

export function sectorIndex(x, z, originX, originZ, nx) {
  const ix = Math.floor((x - originX) / CELL), iz = Math.floor((z - originZ) / CELL);
  return iz * nx + ix;
}

export function bakePvs(world, bounds) {
  const minX = bounds.minX, maxX = bounds.maxX, minZ = bounds.minZ, maxZ = bounds.maxZ;
  const originX = minX, originZ = minZ;
  const nx = Math.max(1, Math.ceil((maxX - minX) / CELL));
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL));
  const n = nx * nz;
  const bits = new Uint8Array(Math.ceil(n * n / 8));
  const occ = new Float32Array(n);
  for (let i = 0; i < n; i++) occ[i] = NaN;
  for (const box of world.boxes) {
    const x0 = Math.max(0, Math.floor((box.min.x - originX) / CELL));
    const x1 = Math.min(nx - 1, Math.floor((box.max.x - originX) / CELL));
    const z0 = Math.max(0, Math.floor((box.min.z - originZ) / CELL));
    const z1 = Math.min(nz - 1, Math.floor((box.max.z - originZ) / CELL));
    const y = (box.min.y + box.max.y) * 0.5;
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
      const i = iz * nx + ix;
      if (!Number.isFinite(occ[i]) || y > occ[i]) occ[i] = Math.max(box.max.y, occ[i] || 0);
    }
  }
  const set = (i, j) => {
    const k = i * n + j, byte = k >> 3, mask = 1 << (k & 7);
    bits[byte] |= mask;
  };
  const eye = 1.6;
  for (let i = 0; i < n; i++) {
    set(i, i);
    if (!Number.isFinite(occ[i])) continue;
    const ix = i % nx, iz = (i / nx) | 0;
    const ax = originX + (ix + 0.5) * CELL, az = originZ + (iz + 0.5) * CELL, ay = occ[i] + eye;
    for (let j = i + 1; j < n; j++) {
      if (!Number.isFinite(occ[j])) continue;
      const jx = j % nx, jz = (j / nx) | 0;
      const bx = originX + (jx + 0.5) * CELL, bz = originZ + (jz + 0.5) * CELL, by = occ[j] + eye;
      const dx = bx - ax, dz = bz - az;
      if (dx * dx + dz * dz > (VISIBLE_R + CELL) * (VISIBLE_R + CELL)) continue;
      _a.set(ax, ay, az); _b.set(bx, by, bz);
      if (world.hasLineOfSight(_a, _b)) { set(i, j); set(j, i); continue; }
      _a.set(ax, ay + 2, az); _b.set(bx, by + 2, bz);
      if (world.hasLineOfSight(_a, _b)) { set(i, j); set(j, i); }
    }
  }
  return { originX, originZ, nx, nz, n, bits, occ, cell: CELL };
}

export function pvsVisible(pvs, ax, az, bx, bz) {
  if (!pvs) return true;
  const i = sectorIndex(ax, az, pvs.originX, pvs.originZ, pvs.nx);
  const j = sectorIndex(bx, bz, pvs.originX, pvs.originZ, pvs.nx);
  if (i < 0 || j < 0 || i >= pvs.n || j >= pvs.n) return true;
  const k = i * pvs.n + j;
  return !!(pvs.bits[k >> 3] & (1 << (k & 7)));
}

export function encodePvs(pvs) {
  const out = new Uint8Array(24 + pvs.bits.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setInt32(4, Math.round(pvs.originX), true);
  view.setInt32(8, Math.round(pvs.originZ), true);
  view.setUint16(12, pvs.nx, true);
  view.setUint16(14, pvs.nz, true);
  view.setUint16(16, pvs.n, true);
  out.set(pvs.bits, 24);
  return out;
}

export function decodePvs(raw) {
  const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (buf.byteLength < 24) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0, true) !== MAGIC) return null;
  const originX = view.getInt32(4, true), originZ = view.getInt32(8, true);
  const nx = view.getUint16(12, true), nz = view.getUint16(14, true), n = view.getUint16(16, true);
  return { originX, originZ, nx, nz, n, bits: buf.subarray(24).slice(), cell: CELL };
}
