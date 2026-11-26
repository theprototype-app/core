// 64-vector-edit (D5 row 2): SNAPPING in a shape's plane — the scene half. The rules live in the
// vectorSnapCore leaf; this module gathers what a point can snap to, turns pixel tolerances into
// plane metres, and draws the smart guides.
//
// NO SECOND SNAP SWITCH: every rule hangs off a setting the scene already has.
//   grid ........ `snapEnabled` + `snapSettings.translate` (the gizmo's grid step), rounded in WORLD
//                 metres, so a shape on the floor lands on the floor grid
//   points ...... `snapTargets.enabled && snapTargets.vertex` (the 19-B element targets)
//   edges ....... `snapTargets.enabled && snapTargets.edge`
//   guides ...... `snapTargets.enabled` (the element-snap master switch, on by default)
// Point and edge tolerance is `snapTargets.radiusPx`; guides take a tighter 6 px.
// A "plane" is any world matrix whose local z = 0 is the drawing plane: a shape's own matrixWorld
// (Edit points) or the pen's frame. Candidates are other vector shapes' anchors, centres and
// outlines lying within 5 cm of that plane (anything further is on another plane).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalScene, globalCamera, globalRenderer } from '../../stores/sceneStore';
import { snapEnabled, snapSettings, snapTargets } from '../snapping';
import { cleanVector, vectorSubpaths } from './vectorRecord.js';
import { flattenSubpath } from './vectorPath.js';
import { isVectorObject } from './vectorGate.js';
import { snap2d, roundTo } from './vectorSnapCore.js';

/** metres off the plane past which a candidate belongs to another plane */
export const PLANE_TOL = 0.05;
const GUIDE_PX = 6;
const MAX_POINTS = 4000;
const MAX_SEGMENTS = 8000;
const GUIDE_COLOUR = 0xff4fd8;

/** @typedef {{points: number[][], guidePoints: number[][], segments: number[][][]}} Candidates */

/** what snaps right now (the scene's own settings) */
export function vectorSnapPrefs() {
	const t = /** @type {any} */ (get(snapTargets)) ?? {};
	const grid = get(snapEnabled) ? Number(/** @type {any} */ (get(snapSettings))?.translate) || 0 : 0;
	return {
		grid,
		points: !!t.enabled && !!t.vertex,
		edges: !!t.enabled && !!t.edge,
		guides: !!t.enabled,
		radiusPx: Number(t.radiusPx) > 0 ? Number(t.radiusPx) : 25
	};
}

/**
 * Gather the candidates for a plane. `own` adds points of the shape being edited (its anchors that
 * are not moving) — they snap and guide like anyone else's.
 * @param {THREE.Matrix4} matrixWorld @param {{exclude?: string, own?: number[][]}} [opts] @returns {Candidates}
 */
export function snapCandidates(matrixWorld, opts = {}) {
	const inv = matrixWorld.clone().invert();
	/** @type {number[][]} */ const points = [...(opts.own ?? [])];
	/** @type {number[][][]} */ const segments = [];
	const group = /** @type {any} */ (get(objectsGroup));
	const m = new THREE.Matrix4();
	const v = new THREE.Vector3();
	/** @param {number} x @param {number} y */
	const into = (x, y) => {
		v.set(x, y, 0).applyMatrix4(m);
		return Math.abs(v.z) < PLANE_TOL ? [v.x, v.y] : null;
	};
	group?.traverse((/** @type {any} */ o) => {
		if (!isVectorObject(o) || o.uuid === opts.exclude || !o.visible) return;
		o.updateMatrixWorld();
		m.multiplyMatrices(inv, o.matrixWorld);
		const subs = vectorSubpaths(cleanVector(o.userData.geometryParams.params ?? {}));
		for (const sub of subs) {
			for (const n of sub.nodes) {
				const p = into(n.x, n.y);
				if (p && points.length < MAX_POINTS) points.push(p);
			}
			const line = flattenSubpath(sub, 0.01)
				.map((q) => into(q[0], q[1]))
				.filter(Boolean);
			const ring = sub.closed && line.length > 2 ? [...line, line[0]] : line;
			for (let i = 1; i < ring.length && segments.length < MAX_SEGMENTS; i++) segments.push([/** @type {number[]} */ (ring[i - 1]), /** @type {number[]} */ (ring[i])]);
		}
		if (o.geometry && !o.geometry.boundingBox) o.geometry.computeBoundingBox();
		const box = o.geometry?.boundingBox;
		if (box && !box.isEmpty()) {
			const c = into((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2);
			if (c && points.length < MAX_POINTS) points.push(c);
		}
	});
	return { points, guidePoints: points, segments };
}

/** plane metres per screen pixel at a plane point @param {THREE.Matrix4} matrixWorld @param {number[]} at */
export function unitsPerPx(matrixWorld, at) {
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const renderer = get(globalRenderer);
	if (!camera || !renderer) return 0;
	const rect = renderer.domElement.getBoundingClientRect();
	/** @param {number} x @param {number} y */
	const px = (x, y) => {
		const p = new THREE.Vector3(x, y, 0).applyMatrix4(matrixWorld).project(camera);
		return [((p.x + 1) / 2) * rect.width, ((1 - p.y) / 2) * rect.height];
	};
	const step = 0.05;
	const a = px(at[0], at[1]);
	const bx = px(at[0] + step, at[1]);
	const by = px(at[0], at[1] + step);
	const len = (Math.hypot(bx[0] - a[0], bx[1] - a[1]) + Math.hypot(by[0] - a[0], by[1] - a[1])) / 2;
	return len > 1e-6 ? step / len : 0;
}

/**
 * Snap a plane point. @param {THREE.Matrix4} matrixWorld @param {number[]} at @param {Candidates | null} cand
 * @returns {import('./vectorSnapCore.js').SnapResult}
 */
export function snapInPlane(matrixWorld, at, cand) {
	const prefs = vectorSnapPrefs();
	const upp = unitsPerPx(matrixWorld, at);
	const inv = matrixWorld.clone().invert();
	const grid = prefs.grid > 0
		? (/** @type {number[]} */ p) => {
				const w = new THREE.Vector3(p[0], p[1], 0).applyMatrix4(matrixWorld);
				w.set(roundTo(w.x, prefs.grid), roundTo(w.y, prefs.grid), roundTo(w.z, prefs.grid)).applyMatrix4(inv);
				return [w.x, w.y];
			}
		: null;
	return snap2d(at, {
		points: prefs.points ? (cand?.points ?? []) : [],
		guidePoints: cand?.guidePoints ?? [],
		segments: prefs.edges ? (cand?.segments ?? []) : [],
		tol: upp * prefs.radiusPx,
		guideTol: upp * GUIDE_PX,
		guides: prefs.guides,
		grid
	});
}

/* --------------------------------------------------------------- guides ---- */

/** @type {THREE.LineSegments | null} */ let guideLines = null;

/** draw a snap result's guides (and a cross on a point / edge target) in the plane
 * @param {THREE.Matrix4} matrixWorld @param {import('./vectorSnapCore.js').SnapResult} result */
export function showSnapGuides(matrixWorld, result) {
	clearSnapGuides();
	const scene = /** @type {any} */ (get(globalScene));
	if (!scene || !result) return;
	/** @type {number[]} */
	const pos = [];
	const z = 0.003;
	for (const g of result.guides) pos.push(g.from[0], g.from[1], z, result.at[0], result.at[1], z);
	if (result.kind === 'point' || result.kind === 'edge') {
		const s = Math.max(unitsPerPx(matrixWorld, result.at) * 6, 1e-3);
		const [x, y] = result.at;
		pos.push(x - s, y - s, z, x + s, y + s, z, x - s, y + s, z, x + s, y - s, z);
	}
	if (!pos.length) return;
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	guideLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: GUIDE_COLOUR, depthTest: false, transparent: true }));
	guideLines.name = 'vector-snap-guides';
	guideLines.userData.isEditOverlay = true;
	guideLines.renderOrder = 21;
	guideLines.matrixAutoUpdate = false;
	guideLines.matrix.copy(matrixWorld);
	scene.add(guideLines);
}

export function clearSnapGuides() {
	if (!guideLines) return;
	/** @type {any} */ (get(globalScene))?.remove(guideLines);
	guideLines.geometry.dispose();
	/** @type {any} */ (guideLines.material).dispose();
	guideLines = null;
}

/** suites: what the guides show now */
export function snapGuidesDebug() {
	return { shown: !!guideLines, segments: guideLines ? guideLines.geometry.attributes.position.count / 2 : 0 };
}
