// 64 D2 — the PATH SOURCES text can follow: any object that can hand over a polyline in its own
// local frame. A LEAF over three + the spline/flow-path record readers (the runtime, the
// Inspector and 64-vector's shapes all reach it; it reaches nothing that records history).
//
// A source answers three things about an object: is it mine (`match`), what is its curve
// (`polyline`, object-local points), and how does a letter stand on it (`normal` of the plane the
// letters lie in or stand along, `orient` when the text says 'auto'). Linked text copies the
// source object's world transform into its own carrier every frame (textPathRuntime), so the
// object-local points ARE the carrier-local points and no peer ever sends a pose for it.
//
// 64-int MERGE POINT: 64-vector's shapes register here with ONE call (normal +Z, flat).

// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { isSplineObject, normalizeSpline, splineCurve } from './splineTube';
import { normalizeFlowPath } from './sim/flowPathCore.js';

/**
 * @typedef {{points: number[][], closed: boolean, normal: number[], orient?: string}} SourcePolyline
 * @typedef {{id: string, label: string, match: (o: any) => boolean, polyline: (o: any) => SourcePolyline | null,
 *   key?: (o: any) => any}} TextPathSource
 *   `key` = what changes when the curve does (compared by identity, then JSON), so the runtime
 *   re-lays only on a real edit; absent = the object's userData is compared whole.
 */

/** @type {TextPathSource[]} */
const sources = [];

/**
 * Register a path source (a later id replaces an earlier one). Returns the unregister.
 * @param {TextPathSource} source @returns {() => void}
 */
export function registerTextPathSource(source) {
	if (!source?.id || typeof source.match !== 'function' || typeof source.polyline !== 'function') return () => {};
	const i = sources.findIndex((s) => s.id === source.id);
	if (i >= 0) sources.splice(i, 1, source);
	else sources.push(source);
	return () => {
		const k = sources.indexOf(source);
		if (k >= 0) sources.splice(k, 1);
	};
}

/** the source that claims an object, or null @param {any} o */
export function textPathSourceFor(o) {
	if (!o) return null;
	for (const s of sources) {
		try {
			if (s.match(o)) return s;
		} catch {
			/* a broken source claims nothing */
		}
	}
	return null;
}

/** what a source's curve depends on @param {any} o */
export function textPathSourceKey(o) {
	const s = textPathSourceFor(o);
	if (!s) return null;
	try {
		return s.key ? s.key(o) : o.userData;
	} catch {
		return null;
	}
}

/** the object's curve, or null when nothing claims it @param {any} o @returns {SourcePolyline | null} */
export function textPathPolylineOf(o) {
	const s = textPathSourceFor(o);
	if (!s) return null;
	try {
		const line = s.polyline(o);
		return line && Array.isArray(line.points) && line.points.length >= 2 ? line : null;
	} catch {
		return null;
	}
}

/** every object in `root` text can follow, by name (the Inspector's link list) @param {any} root */
export function textPathTargets(root) {
	/** @type {{value: string, name: string, kind: string}[]} */
	const out = [];
	root?.traverse?.((/** @type {any} */ o) => {
		if (o === root || o.userData?.textPath) return;
		const s = textPathSourceFor(o);
		if (s) out.push({ value: o.uuid, name: o.name || s.label, kind: s.label });
	});
	return out;
}

// ---- built-in sources ------------------------------------------------------------------------

/** samples per spline span: smooth enough for letters, cheap enough to rebuild per edit */
const SPLINE_SAMPLES_PER_SPAN = 24;

// a spline (Draw ▸ Spline): the CatmullRom curve its tube is built on. Letters STAND on it
// (normal +Y, the spline's local up), which is how a sign along a road or a ribbon reads.
registerTextPathSource({
	id: 'spline',
	label: 'Spline',
	match: (o) => isSplineObject(o),
	key: (o) => o.userData.spline,
	polyline(o) {
		const data = normalizeSpline(o.userData.spline);
		if (data.points.length < 2) return null;
		const curve = splineCurve(data);
		if (!curve) return null;
		const spans = Math.max(1, data.closed ? data.points.length : data.points.length - 1);
		const n = Math.min(4000, spans * SPLINE_SAMPLES_PER_SPAN);
		/** @type {number[][]} */
		const points = [];
		const v = new THREE.Vector3();
		for (let i = 0; i < (data.closed ? n : n + 1); i++) {
			curve.getPoint(i / n, v);
			points.push([v.x, v.y, v.z]);
		}
		return { points, closed: data.closed, normal: [0, 1, 0], orient: 'upright' };
	}
});

// a flow path (Add ▸ Water ▸ Flow path): its point list, letters lying on the water
registerTextPathSource({
	id: 'flowPath',
	label: 'Flow path',
	match: (o) => !!o.userData?.flowPath,
	key: (o) => o.userData.flowPath,
	polyline(o) {
		const spec = normalizeFlowPath(o.userData.flowPath);
		return { points: spec.points.map((p) => p.slice(0, 3)), closed: false, normal: [0, 1, 0], orient: 'flat' };
	}
});
