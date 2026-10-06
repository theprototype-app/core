// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { normalizeFlowPath, FLOW_PATH_DEFAULTS, arcLengths } from './flowPathCore.js';

// 36-fb F24: the FLOW PATH object (Add ▸ Water ▸ Flow path). Its geometry is a pure function
// of `userData.flowPath` (the spline-tube rule): a river is a flat ribbon along the path at its
// water surface, a pipe a thin tube; every peer rebuilds the same vertices from the same record,
// so only the record travels (objectParameters 'flowPath', props undo). It is a SENSOR for
// physics (a ribbon must never be a floor a boat rests on) and never a fluid collider.
// A LEAF over three (geometries.svelte.js / objectActions / commandsHandler call it).

const SEG_STEP = 0.25; // m between ribbon rows (smooth enough for the scrolling surface)

/**
 * The ribbon (river) or tube (pipe) for a record, in the object's local frame.
 * @param {any} raw @returns {THREE.BufferGeometry}
 */
export function flowPathGeometry(raw) {
	const spec = normalizeFlowPath(raw);
	if (spec.kind === 'pipe') return pipeGeometry(spec);
	const pts = spec.points;
	const { cum, total } = arcLengths(pts);
	/** @type {number[]} */
	const pos = [];
	/** @type {number[]} */
	const uv = [];
	/** @type {number[]} */
	const idx = [];
	let prevPerp = [0, 0, 1];
	let row = 0;
	const hw = spec.width / 2;
	for (let i = 0; i + 1 < pts.length; i++) {
		const a = pts[i], b = pts[i + 1];
		const len = cum[i + 1] - cum[i];
		const steps = Math.max(1, Math.ceil(len / SEG_STEP));
		// the horizontal perpendicular (a vertical drop keeps the last one)
		const tx = b[0] - a[0], tz = b[2] - a[2];
		const hl = Math.hypot(tx, tz);
		const perp = hl > 1e-4 ? [-tz / hl, 0, tx / hl] : prevPerp;
		prevPerp = perp;
		for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
			const u = k / steps;
			const c = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
			pos.push(c[0] + perp[0] * hw, c[1], c[2] + perp[2] * hw, c[0] - perp[0] * hw, c[1], c[2] - perp[2] * hw);
			const v = (cum[i] + len * u) / Math.max(spec.width, 0.1);
			uv.push(0, v, 1, v);
			if (row > 0) {
				const r0 = (row - 1) * 2, r1 = row * 2;
				idx.push(r0, r1, r0 + 1, r0 + 1, r1, r1 + 1);
			}
			row++;
		}
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
	g.setIndex(idx);
	// face up whichever way the rows wind
	g.computeVertexNormals();
	const n = g.getAttribute('normal');
	if (n.count && n.getY(0) < 0) {
		idx.reverse();
		g.setIndex(idx);
		g.computeVertexNormals();
	}
	g.userData.flowLength = total;
	return g;
}

/** a pipe: a thin tube along the polyline @param {ReturnType<typeof normalizeFlowPath>} spec */
function pipeGeometry(spec) {
	const path = new THREE.CurvePath();
	for (let i = 0; i + 1 < spec.points.length; i++)
		path.add(new THREE.LineCurve3(new THREE.Vector3(...spec.points[i]), new THREE.Vector3(...spec.points[i + 1])));
	const r = Math.min(spec.width / 2, 0.08);
	const tube = new THREE.TubeGeometry(/** @type {any} */ (path), Math.max(4, spec.points.length * 6), r, 10, false);
	// BAKED to a plain BufferGeometry: a TubeGeometry serializes its CurvePath, which
	// ObjectLoader cannot rebuild — a pipe would break every toJSON round trip (sessions, the
	// peer object sync, the card render). Plain buffers are what every other path carries.
	const g = new THREE.BufferGeometry().copy(tube);
	tube.dispose();
	g.userData.flowLength = arcLengths(spec.points).total;
	return g;
}

/**
 * Stamp a fresh flow path (from the replicated /create, deterministic on every peer).
 * @param {any} object
 */
export function stampFlowPath(object) {
	object.name = 'Flow path';
	object.userData.flowPath = JSON.parse(JSON.stringify(FLOW_PATH_DEFAULTS));
	// a sensor: bodies pass through the surface (floating is the water's job), On Enter fires
	object.userData.physics = { mode: 'static', sensor: true };
	object.castShadow = false;
	object.userData.shadow = false;
	lookOf(object, object.userData.flowPath);
}

/** the base material's look for a record @param {any} object @param {any} raw */
function lookOf(object, raw) {
	const spec = normalizeFlowPath(raw);
	const m = object.material;
	if (!m) return;
	m.color?.set(spec.kind === 'pipe' ? '#7d8a94' : spec.color);
	if ('roughness' in m) m.roughness = spec.kind === 'pipe' ? 0.5 : 0.08;
	if ('metalness' in m) m.metalness = spec.kind === 'pipe' ? 0.6 : 0;
	m.transparent = spec.kind !== 'pipe';
	m.opacity = spec.kind === 'pipe' ? 1 : spec.opacity;
	m.depthWrite = spec.kind === 'pipe';
	m.side = THREE.DoubleSide;
	m.visible = spec.show;
	m.needsUpdate = true;
}

/**
 * Apply a (normalized) record to an object: store it, rebuild the geometry, re-tint. The ONE
 * place a flow path changes shape — the write path, the remote applier and undo all call it.
 * @param {any} object @param {any} raw
 */
export function applyFlowPathTo(object, raw) {
	const spec = normalizeFlowPath(raw);
	object.userData.flowPath = spec;
	const old = object.geometry;
	object.geometry = flowPathGeometry(spec);
	old?.dispose?.();
	lookOf(object, spec);
	return spec;
}
