// 37 R3 — PARAMETRIC ARCHITECTURE: the pure half (imports three ONLY, so vitest covers it
// with no browser). Wall (with door/window openings), Door, Window and Staircase (straight,
// L, U, spiral) as GEOMETRY_PARAMS `build` specs — the 21-C1 Terrain precedent: the existing
// {type:'geometry', uuid, gtype, params} message, the 'geometry' history kind and
// userData.geometryParams riding toJSON + GLTF extras carry them, so nothing new travels.
//
// EVERY PARAM IS CLAMPED HERE (`cleanParams`), not in the Inspector: a `geometry` message
// is applied straight off the wire, and a peer asking for a 10^6-step staircase must get
// the 40-step one every other peer builds.
//
// FRAMES (the 1 m grid): a WALL's origin is its START end, on the centre line, at the floor
// — it runs along +X, so a whole-metre wall placed on the grid ends on the grid, and a 90°
// turn about the origin keeps the corner where it was (rooms snap together). A DOOR and a
// WINDOW sit centred on X at the FLOOR (a window's `sill` is its height above it), so one
// dropped on the same grid point as a wall opening's centre fills it: opening centres land
// on half metres (`wallOpenings`). A STAIRCASE starts at its first riser, centred on X,
// climbing toward -Z; a spiral's origin is its column.
//
// Builders return a plain BufferGeometry with NO groups: an ExtrudeGeometry's toJSON
// re-runs the shape without the translate we bake in, and a mesh with groups exports to
// GLTF as several primitives, which comes back as a Group — not the Mesh it was.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** the primitives this file builds (geometryParams + the collider/placement rules key on it) */
export const ARCH_TYPES = ['Wall', 'Door', 'Window', 'Staircase'];
export const STAIR_SHAPES = ['straight', 'L', 'U', 'spiral'];

/** narrowest pier (m) left between two openings or at a wall end */
const PIER = 0.1;
/** the gap round a door leaf / window sash inside its frame */
const LEAF_GAP = 0.005;
/** a casement window opens this far (degrees) */
const CASEMENT_ANGLE = 80;

/** @typedef {import('../geometryParams').ParamSpec} ParamSpec */

/** @type {ParamSpec[]} */
const WALL_PARAMS = [
	{ key: 'length', label: 'Length', kind: 'slider', min: 0.5, max: 30, step: 0.5, def: 4 },
	{ key: 'height', label: 'Height', kind: 'slider', min: 0.5, max: 10, step: 0.1, def: 2.8 },
	{ key: 'thickness', label: 'Thickness', kind: 'slider', min: 0.05, max: 1, step: 0.05, def: 0.2 },
	{ key: 'doors', label: 'Doors', kind: 'int', min: 0, max: 6, def: 0 },
	{ key: 'doorWidth', label: 'Door width', kind: 'slider', min: 0.5, max: 4, step: 0.05, def: 1, show: (p) => p.doors > 0 },
	{ key: 'doorHeight', label: 'Door height', kind: 'slider', min: 1, max: 4, step: 0.05, def: 2.1, show: (p) => p.doors > 0 },
	{ key: 'windows', label: 'Windows', kind: 'int', min: 0, max: 8, def: 0 },
	{ key: 'windowWidth', label: 'Win width', kind: 'slider', min: 0.3, max: 4, step: 0.05, def: 1.2, show: (p) => p.windows > 0 },
	{ key: 'windowHeight', label: 'Win height', kind: 'slider', min: 0.2, max: 3, step: 0.05, def: 1.2, show: (p) => p.windows > 0 },
	{ key: 'sill', label: 'Sill height', kind: 'slider', min: 0, max: 3, step: 0.05, def: 0.9, show: (p) => p.windows > 0 },
	{ key: 'offset', label: 'Shift', kind: 'slider', min: -15, max: 15, step: 0.5, def: 0, show: (p) => p.doors + p.windows > 0 }
];

/** @type {ParamSpec[]} */
const DOOR_PARAMS = [
	{ key: 'width', label: 'Width', kind: 'slider', min: 0.5, max: 4, step: 0.05, def: 1 },
	{ key: 'height', label: 'Height', kind: 'slider', min: 1.5, max: 4, step: 0.05, def: 2.1 },
	{ key: 'depth', label: 'Frame depth', kind: 'slider', min: 0.05, max: 0.8, step: 0.05, def: 0.2 },
	{ key: 'frame', label: 'Frame', kind: 'slider', min: 0.02, max: 0.3, step: 0.01, def: 0.08 },
	{ key: 'leaves', label: 'Leaves', kind: 'choice', options: ['single', 'double'], def: 'single' },
	{ key: 'hinge', label: 'Hinge', kind: 'choice', options: ['left', 'right'], def: 'left', show: (p) => p.leaves === 'single' },
	{ key: 'swing', label: 'Opens', kind: 'choice', options: ['in', 'out'], def: 'in' },
	{ key: 'angle', label: 'Swing °', kind: 'slider', min: 30, max: 175, step: 5, def: 95 },
	{ key: 'panes', label: 'Glass panes', kind: 'int', min: 0, max: 8, def: 0 },
	{ key: 'threshold', label: 'Sill', kind: 'bool', def: false },
	{ key: 'trigger', label: 'Opens on', kind: 'choice', options: ['click', 'proximity'], def: 'click' }
];

/** @type {ParamSpec[]} */
const WINDOW_PARAMS = [
	{ key: 'width', label: 'Width', kind: 'slider', min: 0.3, max: 4, step: 0.05, def: 1.2 },
	{ key: 'height', label: 'Height', kind: 'slider', min: 0.3, max: 3, step: 0.05, def: 1.2 },
	{ key: 'sill', label: 'Sill height', kind: 'slider', min: 0, max: 3, step: 0.05, def: 0.9 },
	{ key: 'depth', label: 'Frame depth', kind: 'slider', min: 0.05, max: 0.6, step: 0.05, def: 0.2 },
	{ key: 'frame', label: 'Frame', kind: 'slider', min: 0.02, max: 0.2, step: 0.01, def: 0.06 },
	{ key: 'cols', label: 'Panes across', kind: 'int', min: 1, max: 6, def: 2 },
	{ key: 'rows', label: 'Panes up', kind: 'int', min: 1, max: 6, def: 2 },
	{ key: 'ledge', label: 'Sill ledge', kind: 'bool', def: true },
	{ key: 'opening', label: 'Opens', kind: 'choice', options: ['fixed', 'casement'], def: 'fixed' },
	{ key: 'hinge', label: 'Hinge', kind: 'choice', options: ['left', 'right'], def: 'left', show: (p) => p.opening === 'casement' }
];

/** @type {ParamSpec[]} */
const STAIR_PARAMS = [
	{ key: 'shape', label: 'Shape', kind: 'choice', options: STAIR_SHAPES, def: 'straight' },
	{ key: 'width', label: 'Width', kind: 'slider', min: 0.5, max: 4, step: 0.05, def: 1 },
	{ key: 'steps', label: 'Steps', kind: 'int', min: 2, max: 40, def: 14 },
	{ key: 'rise', label: 'Rise', kind: 'slider', min: 0.1, max: 0.3, step: 0.005, def: 0.18 },
	{ key: 'run', label: 'Run', kind: 'slider', min: 0.15, max: 0.5, step: 0.01, def: 0.28 },
	{ key: 'turn', label: 'Turn', kind: 'choice', options: ['left', 'right'], def: 'left', show: (p) => p.shape !== 'straight' },
	{ key: 'gap', label: 'Flight gap', kind: 'slider', min: 0, max: 1, step: 0.05, def: 0.1, show: (p) => p.shape === 'U' },
	{ key: 'core', label: 'Column', kind: 'slider', min: 0.05, max: 0.5, step: 0.01, def: 0.12, show: (p) => p.shape === 'spiral' },
	{ key: 'solid', label: 'Solid', kind: 'bool', def: true, show: (p) => p.shape !== 'spiral' },
	{ key: 'tread', label: 'Tread', kind: 'slider', min: 0.03, max: 0.2, step: 0.01, def: 0.05, show: (p) => p.shape === 'spiral' || !p.solid }
];

/** @param {ParamSpec[]} params */
const keysOf = (params) => params.map((p) => p.key);

/**
 * Every param of `spec` within its range (ints rounded, choices from the set, bools
 * strict); unknown keys dropped, missing ones defaulted. The ONE boundary for wire input.
 * @param {ParamSpec[]} specs @param {any} raw @returns {Record<string, any>}
 */
export function cleanParams(specs, raw) {
	/** @type {Record<string, any>} */
	const out = {};
	const src = raw && typeof raw === 'object' ? raw : {};
	for (const p of specs) {
		const v = src[p.key];
		if (p.kind === 'bool') out[p.key] = typeof v === 'boolean' ? v : !!p.def;
		else if (p.kind === 'choice') out[p.key] = (p.options ?? []).includes(v) ? v : p.def;
		else {
			const n = Number(v);
			const lo = p.min ?? -Infinity;
			const hi = p.max ?? Infinity;
			const value = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : Number(p.def);
			out[p.key] = p.kind === 'int' ? Math.round(value) : value;
		}
	}
	return out;
}

/* ------------------------------------------------------------------ helpers ------ */

/** an axis-aligned box from min/max corners @param {number[]} b [x0,y0,z0,x1,y1,z1] */
function box(b) {
	const g = new THREE.BoxGeometry(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
	g.translate((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
	return g;
}

/** a rectangle path (counter-clockwise) @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 */
function rectPath(x0, y0, x1, y1) {
	const path = new THREE.Path();
	path.moveTo(x0, y0);
	path.lineTo(x1, y0);
	path.lineTo(x1, y1);
	path.lineTo(x0, y1);
	path.closePath();
	return path;
}

/** extrude a shape `depth` along Z, centred on z = 0 @param {THREE.Shape} shape @param {number} depth */
function slab(shape, depth) {
	const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
	g.translate(0, 0, -depth / 2);
	return g;
}

/**
 * Merge parts into ONE plain, group-free, non-indexed BufferGeometry and dispose the parts.
 * @param {THREE.BufferGeometry[]} parts @returns {THREE.BufferGeometry}
 */
export function mergeParts(parts) {
	const flat = parts.map((g) => {
		if (!g.index) return g;
		const n = g.toNonIndexed();
		g.dispose();
		return n;
	});
	// every builder here makes position/normal/uv — keep exactly those, in that order
	for (const g of flat) for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
	const merged = flat.length === 1 ? flat[0].clone() : mergeGeometries(flat, false);
	for (const g of flat) g.dispose();
	const out = new THREE.BufferGeometry().copy(merged ?? new THREE.BufferGeometry());
	merged?.dispose?.();
	out.clearGroups();
	out.computeBoundingBox();
	out.computeBoundingSphere();
	return out;
}

/* ------------------------------------------------------------------ the wall ----- */

/**
 * Where a wall's openings are, in its local frame (x along the wall from its start, y up
 * from the floor). Slots are even along the length (shifted by `offset`), centres rounded
 * to half a metre so a 1 m door or window on the grid fills one; doors take the middle
 * slots, windows the rest. Each opening is narrowed to keep a PIER to its neighbours and the
 * wall ends, and dropped when nothing useful is left.
 * @param {any} raw wall params @returns {{kind: 'door'|'window', cx: number, x0: number, x1: number, y0: number, y1: number}[]}
 */
export function wallOpenings(raw) {
	const p = cleanParams(WALL_PARAMS, raw);
	const n = p.doors + p.windows;
	if (!n) return [];
	const L = p.length;
	const H = p.height;
	const centres = [];
	for (let i = 0; i < n; i++) centres.push(Math.round(((i + 0.5) * (L / n) + p.offset) * 2) / 2);
	// the middle-most slots are doors
	const order = centres.map((_, i) => i).sort((a, b) => Math.abs(a - (n - 1) / 2) - Math.abs(b - (n - 1) / 2) || a - b);
	const isDoor = new Set(order.slice(0, p.doors));
	/** @type {{kind: 'door'|'window', cx: number, x0: number, x1: number, y0: number, y1: number}[]} */
	const out = [];
	for (let i = 0; i < n; i++) {
		const cx = centres[i];
		const door = isDoor.has(i);
		const left = i === 0 ? cx - PIER : (cx - centres[i - 1]) / 2 - PIER / 2;
		const right = i === n - 1 ? L - PIER - cx : (centres[i + 1] - cx) / 2 - PIER / 2;
		const half = Math.min((door ? p.doorWidth : p.windowWidth) / 2, left, right);
		if (!(half >= 0.1)) continue;
		const y0 = door ? 0 : Math.min(p.sill, H - 0.3);
		const y1 = Math.min(door ? p.doorHeight : y0 + p.windowHeight, H - PIER);
		if (!(y1 - y0 >= 0.1)) continue;
		out.push({ kind: door ? 'door' : 'window', cx, x0: cx - half, x1: cx + half, y0, y1 });
	}
	return out;
}

/** @param {any} raw */
export function wallGeometry(raw) {
	const p = cleanParams(WALL_PARAMS, raw);
	const L = p.length;
	const H = p.height;
	const openings = wallOpenings(p);
	// doors notch the outline from the floor (a hole may not touch the outline); windows are holes
	const shape = new THREE.Shape();
	shape.moveTo(0, 0);
	for (const o of openings.filter((o) => o.kind === 'door')) {
		shape.lineTo(o.x0, 0);
		shape.lineTo(o.x0, o.y1);
		shape.lineTo(o.x1, o.y1);
		shape.lineTo(o.x1, 0);
	}
	shape.lineTo(L, 0);
	shape.lineTo(L, H);
	shape.lineTo(0, H);
	shape.closePath();
	for (const o of openings) if (o.kind === 'window') shape.holes.push(rectPath(o.x0, o.y0, o.x1, o.y1));
	return mergeParts([slab(shape, p.thickness)]);
}

/* ------------------------------------------------------------------ the door ----- */

/**
 * A door's moving parts, in the DOOR's frame: per leaf the hinge pivot, the angle it opens
 * to (radians, signed so it swings the way `swing` says), and its geometry relative to the
 * pivot (`leaf`, plus `glass` when it has panes). archParts hangs these under the root.
 * @param {any} raw
 */
export function doorParts(raw) {
	const p = cleanParams(DOOR_PARAMS, raw);
	const f = Math.min(p.frame, p.width / 4);
	const clear = p.width - 2 * f;
	const t = Math.min(0.045, p.depth * 0.8);
	const y0 = (p.threshold ? 0.03 : 0) + LEAF_GAP;
	const y1 = p.height - f - LEAF_GAP;
	const zFace = p.swing === 'in' ? -t / 2 : t / 2;
	const angle = THREE.MathUtils.degToRad(p.angle);
	/** @type {('left'|'right')[]} */
	const hinges = p.leaves === 'double' ? ['left', 'right'] : [p.hinge];
	const leafW = (p.leaves === 'double' ? clear / 2 : clear) - 2 * LEAF_GAP;
	const panes = p.leaves === 'double' ? Math.ceil(p.panes / 2) : p.panes;
	return hinges.map((hinge) => {
		const dir = hinge === 'left' ? 1 : -1; // the leaf runs from its hinge toward +x (left) or -x (right)
		const pivotX = dir * -(clear / 2 - LEAF_GAP);
		// a +Y rotation carries +x toward -z: left+in and right+out turn positive
		const sign = (hinge === 'left') === (p.swing === 'in') ? 1 : -1;
		const { leaf, glass } = leafGeometry(leafW, y0, y1, t, dir, panes, -zFace);
		return { name: hinge === 'left' ? 'DoorLeafL' : 'DoorLeafR', pivot: [pivotX, 0, zFace], angle: sign * angle, leaf, glass };
	});
}

/**
 * One leaf in its pivot's frame: x from 0 toward `dir`, z centred on `zMid` (the pivot sits
 * on the swing face). Panes cut holes in the upper half (1 column, 2 from four up) and get
 * a thin glass slab each; a handle sits near the free edge on both faces.
 * @param {number} w @param {number} y0 @param {number} y1 @param {number} t @param {number} dir
 * @param {number} panes @param {number} zMid
 */
function leafGeometry(w, y0, y1, t, dir, panes, zMid) {
	const x = (/** @type {number} */ v) => (dir > 0 ? v : -v);
	const shape = new THREE.Shape();
	shape.moveTo(Math.min(x(0), x(w)), y0);
	shape.lineTo(Math.max(x(0), x(w)), y0);
	shape.lineTo(Math.max(x(0), x(w)), y1);
	shape.lineTo(Math.min(x(0), x(w)), y1);
	shape.closePath();
	/** @type {THREE.BufferGeometry[]} */
	const glassParts = [];
	if (panes > 0) {
		const cols = panes >= 4 ? 2 : 1;
		const rows = Math.ceil(panes / cols);
		const m = Math.min(0.12, w * 0.15);
		const bar = 0.05;
		const gy0 = y0 + (y1 - y0) * 0.45;
		const gy1 = y1 - m;
		const cw = (w - 2 * m - (cols - 1) * bar) / cols;
		const ch = (gy1 - gy0 - (rows - 1) * bar) / rows;
		if (cw > 0.05 && ch > 0.05) {
			let made = 0;
			for (let r = 0; r < rows; r++)
				for (let c = 0; c < cols && made < panes; c++, made++) {
					const a = m + c * (cw + bar);
					const hx0 = Math.min(x(a), x(a + cw));
					const hx1 = Math.max(x(a), x(a + cw));
					const hy0 = gy0 + r * (ch + bar);
					shape.holes.push(rectPath(hx0, hy0, hx1, hy0 + ch));
					glassParts.push(box([hx0, hy0, zMid - 0.004, hx1, hy0 + ch, zMid + 0.004]));
				}
		}
	}
	const body = slab(shape, t);
	body.translate(0, 0, zMid);
	const hx = x(w - 0.08);
	const hy = Math.min(1.0, (y0 + y1) / 2);
	const handle = [
		box([hx - 0.06, hy - 0.015, zMid + t / 2, hx + 0.06, hy + 0.015, zMid + t / 2 + 0.05]),
		box([hx - 0.06, hy - 0.015, zMid - t / 2 - 0.05, hx + 0.06, hy + 0.015, zMid - t / 2])
	];
	return { leaf: mergeParts([body, ...handle]), glass: glassParts.length ? mergeParts(glassParts) : null };
}

/** the door's FRAME (the root mesh): two jambs, the head and an optional sill @param {any} raw */
export function doorGeometry(raw) {
	const p = cleanParams(DOOR_PARAMS, raw);
	const f = Math.min(p.frame, p.width / 4);
	const w = p.width / 2;
	const d = p.depth / 2;
	const parts = [
		box([-w, 0, -d, -w + f, p.height, d]),
		box([w - f, 0, -d, w, p.height, d]),
		box([-w + f, p.height - f, -d, w - f, p.height, d])
	];
	if (p.threshold) parts.push(box([-w + f, 0, -d, w - f, 0.03, d]));
	return mergeParts(parts);
}

/* ------------------------------------------------------------------ the window --- */

/** the window's FRAME (the root mesh): jambs, head, bottom rail and the ledge @param {any} raw */
export function windowGeometry(raw) {
	const p = cleanParams(WINDOW_PARAMS, raw);
	const f = Math.min(p.frame, p.width / 4, p.height / 4);
	const w = p.width / 2;
	const d = p.depth / 2;
	const s = p.sill;
	const top = s + p.height;
	const parts = [
		box([-w, s, -d, -w + f, top, d]),
		box([w - f, s, -d, w, top, d]),
		box([-w + f, top - f, -d, w - f, top, d]),
		box([-w + f, s, -d, w - f, s + f, d])
	];
	// the ledge sticks out on the OUTSIDE (+z), under the bottom rail
	if (p.ledge && s >= 0.04) parts.push(box([-w - 0.05, s - 0.04, -d, w + 0.05, s, d + 0.06]));
	return mergeParts(parts);
}

/**
 * The window's SASH (frame bars + glass), in its pivot's frame. A fixed window hangs it on
 * a pivot that never turns; a casement's pivot is the hinge side on the outer face.
 * @param {any} raw
 */
export function windowParts(raw) {
	const p = cleanParams(WINDOW_PARAMS, raw);
	const f = Math.min(p.frame, p.width / 4, p.height / 4);
	const x0 = -p.width / 2 + f + LEAF_GAP;
	const x1 = p.width / 2 - f - LEAF_GAP;
	const y0 = p.sill + f + LEAF_GAP;
	const y1 = p.sill + p.height - f - LEAF_GAP;
	const t = Math.min(0.05, p.depth * 0.6);
	const casement = p.opening === 'casement';
	const left = p.hinge === 'left';
	const pivot = casement ? [left ? x0 : x1, 0, t / 2] : [0, 0, 0];
	const ox = -pivot[0];
	const oz = -pivot[2];
	const bar = Math.min(0.03, (x1 - x0) / (p.cols * 4), (y1 - y0) / (p.rows * 4));
	const rim = Math.min(0.04, (x1 - x0) / 6, (y1 - y0) / 6);
	const shape = new THREE.Shape();
	shape.moveTo(x0 + ox, y0);
	shape.lineTo(x1 + ox, y0);
	shape.lineTo(x1 + ox, y1);
	shape.lineTo(x0 + ox, y1);
	shape.closePath();
	const cw = (x1 - x0 - 2 * rim - (p.cols - 1) * bar) / p.cols;
	const ch = (y1 - y0 - 2 * rim - (p.rows - 1) * bar) / p.rows;
	/** @type {THREE.BufferGeometry[]} */
	const glass = [];
	for (let r = 0; r < p.rows; r++)
		for (let c = 0; c < p.cols; c++) {
			const hx = x0 + rim + c * (cw + bar) + ox;
			const hy = y0 + rim + r * (ch + bar);
			shape.holes.push(rectPath(hx, hy, hx + cw, hy + ch));
			glass.push(box([hx, hy, oz - 0.004, hx + cw, hy + ch, oz + 0.004]));
		}
	const sash = slab(shape, t);
	sash.translate(0, 0, oz);
	// a casement's +Y rotation carries +x toward -z; it opens OUT (+z), so a left hinge turns negative
	const angle = casement ? (left ? -1 : 1) * THREE.MathUtils.degToRad(CASEMENT_ANGLE) : 0;
	return { name: 'WindowSash', pivot, angle, leaf: mergeParts([sash]), glass: mergeParts(glass) };
}

/* ------------------------------------------------------------------ stairs ------- */

/**
 * Each step as a box [x0,y0,z0,x1,y1,z1] for the straight / L / U shapes (the spiral is
 * built from sectors). `top` is the step's walking height. A solid stair fills every step
 * to the floor; an open one is a tread slab per step. L and U turn at a square landing
 * (one step of its own, so the step count stays the riser count); too few steps for the
 * turn degrade to a straight flight.
 * @param {any} raw @returns {number[][]}
 */
export function stairBoxes(raw) {
	const p = cleanParams(STAIR_PARAMS, raw);
	const { width: w, rise, run, steps: n } = p;
	const s = p.turn === 'left' ? -1 : 1; // the side the stair turns toward (climbing toward -z, left is -x)
	/** @type {number[][]} */
	const out = [];
	/** @param {number} xa @param {number} xb @param {number} za @param {number} zb @param {number} top */
	const step = (xa, xb, za, zb, top) =>
		out.push([Math.min(xa, xb), p.solid ? 0 : top - p.tread, Math.min(za, zb), Math.max(xa, xb), top, Math.max(za, zb)]);
	const shape = (p.shape === 'L' && n >= 3) || (p.shape === 'U' && n >= 3) ? p.shape : 'straight';
	if (shape === 'straight') {
		for (let i = 0; i < n; i++) step(-w / 2, w / 2, -i * run, -(i + 1) * run, (i + 1) * rise);
		return out;
	}
	const k1 = shape === 'L' ? Math.floor(n / 2) : Math.floor((n - 1) / 2);
	for (let i = 0; i < k1; i++) step(-w / 2, w / 2, -i * run, -(i + 1) * run, (i + 1) * rise);
	const zl = -k1 * run; // the landing's front edge
	const k2 = n - k1 - 1;
	if (shape === 'L') {
		step(-w / 2, w / 2, zl, zl - w, (k1 + 1) * rise);
		for (let j = 0; j < k2; j++) step(s * (w / 2 + j * run), s * (w / 2 + (j + 1) * run), zl, zl - w, (k1 + 2 + j) * rise);
		return out;
	}
	// U: the landing spans both flights; the second comes back toward +z beside the first
	const xc = s * (w + p.gap);
	step(-s * (w / 2), xc + s * (w / 2), zl, zl - w, (k1 + 1) * rise);
	for (let j = 0; j < k2; j++) step(xc - w / 2, xc + w / 2, zl + j * run, zl + (j + 1) * run, (k1 + 2 + j) * rise);
	return out;
}

/** a spiral's steps as sectors round a column, plus the column @param {Record<string, any>} p */
function spiralGeometry(p) {
	const { width: w, rise, run, steps: n, core, tread } = p;
	const outer = core + w;
	// the step angle keeps `run` along the walking line (60% out from the column)
	const d = run / (core + w * 0.6);
	const dir = p.turn === 'left' ? 1 : -1;
	const segs = Math.max(2, Math.ceil(d / 0.12));
	/** @type {THREE.BufferGeometry[]} */
	const parts = [];
	for (let i = 0; i < n; i++) {
		const a0 = i * d;
		const shape = new THREE.Shape();
		for (let k = 0; k <= segs; k++) {
			const a = dir * (a0 + (d * k) / segs);
			if (k === 0) shape.moveTo(outer * Math.cos(a), outer * Math.sin(a));
			else shape.lineTo(outer * Math.cos(a), outer * Math.sin(a));
		}
		for (let k = segs; k >= 0; k--) {
			const a = dir * (a0 + (d * k) / segs);
			shape.lineTo(core * Math.cos(a), core * Math.sin(a));
		}
		shape.closePath();
		const g = new THREE.ExtrudeGeometry(shape, { depth: tread, bevelEnabled: false, curveSegments: 1 });
		// the shape's XY becomes XZ (its +y -> world -z), the extrusion becomes the height
		g.rotateX(-Math.PI / 2);
		g.translate(0, (i + 1) * rise - tread, 0);
		parts.push(g);
	}
	const column = new THREE.CylinderGeometry(core, core, n * rise, 16, 1);
	column.translate(0, (n * rise) / 2, 0);
	parts.push(column);
	return mergeParts(parts);
}

/** @param {any} raw */
export function staircaseGeometry(raw) {
	const p = cleanParams(STAIR_PARAMS, raw);
	if (p.shape === 'spiral') return spiralGeometry(p);
	return mergeParts(stairBoxes(p).map(box));
}

/* ------------------------------------------------------------------ the specs ---- */

/** @param {any} v @param {number} fallback */
const arg = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * GEOMETRY_PARAMS entries. `fromArgs` turns the replicated `/create X a b c d` numbers into
 * params (createGeometry runs it on every peer, so a variant needs no second message):
 *   Wall  length height thickness preset   (preset 0 plain, 1 a door, 2 two windows, 3 a door + two windows)
 *   Door  width height leaves              (leaves 0 single, 1 double)
 *   Window width height sill opening       (opening 0 fixed, 1 casement)
 *   Staircase shape width steps rise       (shape 0 straight, 1 L, 2 U, 3 spiral)
 * `colliderHint` is stamped at creation (the building blocks' precedent).
 * @type {Record<string, {order: string[], params: ParamSpec[], build: (p: any) => THREE.BufferGeometry, fromArgs: (a: any[]) => Record<string, any>, colliderHint?: string}>}
 */
export const ARCH_SPECS = {
	Wall: {
		order: keysOf(WALL_PARAMS),
		params: WALL_PARAMS,
		build: wallGeometry,
		colliderHint: 'trimesh',
		fromArgs: (a) => {
			const preset = Math.round(arg(a[3], 0));
			return cleanParams(WALL_PARAMS, {
				length: arg(a[0], 4),
				height: arg(a[1], 2.8),
				thickness: arg(a[2], 0.2),
				doors: preset === 1 || preset === 3 ? 1 : 0,
				windows: preset === 2 || preset === 3 ? 2 : 0
			});
		}
	},
	Door: {
		order: keysOf(DOOR_PARAMS),
		params: DOOR_PARAMS,
		build: doorGeometry,
		fromArgs: (a) =>
			cleanParams(DOOR_PARAMS, { width: arg(a[0], 1), height: arg(a[1], 2.1), leaves: arg(a[2], 0) === 1 ? 'double' : 'single' })
	},
	Window: {
		order: keysOf(WINDOW_PARAMS),
		params: WINDOW_PARAMS,
		build: windowGeometry,
		colliderHint: 'box',
		fromArgs: (a) =>
			cleanParams(WINDOW_PARAMS, {
				width: arg(a[0], 1.2),
				height: arg(a[1], 1.2),
				sill: arg(a[2], 0.9),
				opening: arg(a[3], 0) === 1 ? 'casement' : 'fixed'
			})
	},
	Staircase: {
		order: keysOf(STAIR_PARAMS),
		params: STAIR_PARAMS,
		build: staircaseGeometry,
		colliderHint: 'trimesh',
		fromArgs: (a) =>
			cleanParams(STAIR_PARAMS, {
				shape: STAIR_SHAPES[Math.round(arg(a[0], 0))] ?? 'straight',
				width: arg(a[1], 1),
				steps: arg(a[2], 14),
				rise: arg(a[3], 0.18)
			})
	}
};

/** the clean params of an arch primitive (the parts builder and the tests read them) @param {string} gtype @param {any} raw */
export function archParams(gtype, raw) {
	const spec = ARCH_SPECS[gtype];
	return spec ? cleanParams(spec.params, raw) : null;
}
