// 64 D1: EDIT POINTS on a vector shape — the pen's other half. A session on one shape shows its
// anchors (and the handles of the picked one and its neighbours) at the scene root, and takes
// presses through the modulePointer seam:
//   press an anchor ........ pick it and drag it (its handles ride along)
//   press a handle ......... drag it (a smooth point keeps the opposite handle collinear; Alt breaks it)
//   press the outline ...... insert a point there (the curve keeps its shape — de Casteljau)
//   double-click an anchor . convert corner <-> smooth
//   Delete / Backspace ..... remove the picked point · Esc ends the session
// A parametric shape (rect / star / ...) is converted to a path on entry — ONE geometry entry,
// said in a toast. Every gesture is one `applyGeometry` (one undo entry, one message): a drag
// previews by swapping the local geometry only and commits on release, so the recorded `before`
// is the record as it was when the drag began. Peers are told with the usual lock/unlock pair.
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, globalScene, globalCamera, globalRenderer, TControls, sceneRevision, lockedObjects, selectedObjects } from '../../stores/sceneStore';
import { peers, showToast } from '../../stores/appStore';
import { registerModulePointer } from '../modulePointer';
import { registerKeySessionProbe } from '../shortcuts';
import { viewportHasKeys } from '../keyScope';
import { applyGeometry } from '../geometryEdit';
import { moveNode, moveHandle, convertNode, deleteNode, insertNodeAt, nearestOnSubpath, cloneSubpaths } from './vectorPath.js';
import { cleanVector, vectorSubpaths } from './vectorRecord.js';
import { buildVectorGeometry } from './vectorMesh.js';
import { isVector, vectorParamsOf } from './vectorActions.js';
import { disarmVectorTool } from './vectorTool.js';

/** the shape being edited (uuid) @type {import('svelte/store').Writable<string | null>} */
export const vectorEditObject = writable(null);
/** the picked point @type {import('svelte/store').Writable<{sub: number, index: number} | null>} */
export const vectorEditPick = writable(null);

const PICK_PX = 9;
const CURVE_PX = 7;

/** @type {any} */ let edited = null;
/** @type {null | (() => void)} */ let offPointer = null;
/** @type {null | (() => void)} */ let offRevision = null;
/** @type {null | (() => void)} */ let offSelection = null;
/** @type {THREE.Group | null} */ let helpers = null;
/** the paths as the session sees them (the record's, or the drag's working copy) @type {import('./vectorPath.js').VSubpath[]} */
let working = [];
/** @type {null | {kind: 'node' | 'in' | 'out', sub: number, index: number, moved: boolean}} */ let gesture = null;
let lastDownAt = 0;
/** @type {null | {sub: number, index: number}} */ let lastDownNode = null;
let rafId = 0;

registerKeySessionProbe(() => get(vectorEditObject) !== null);

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
}

/**
 * Open the session on a shape. @param {string} uuid @returns {boolean}
 */
export function enterVectorEdit(uuid) {
	if (get(vectorEditObject) === uuid) return true;
	exitVectorEdit();
	const object = objectOf(uuid);
	if (!isVector(object)) return false;
	if (get(lockedObjects).find((/** @type {any} */ lock) => lock[1] === uuid)) {
		showToast('This object is locked by another peer');
		return false;
	}
	disarmVectorTool();
	const params = vectorParamsOf(object);
	if (params && params.kind !== 'path') {
		// the corner radius / point count stop being live: say so, and it is one undo away
		applyGeometry(uuid, { kind: 'path', paths: vectorSubpaths(params) });
		showToast('Converted to a path to edit its points (undo turns it back)');
	}
	edited = object;
	working = cloneSubpaths(vectorParamsOf(object)?.paths ?? []);
	vectorEditPick.set(null);
	/** @type {any} */
	const controls = get(TControls);
	controls?.detach();
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'lock', uuid, peerId: peer.peer.id });
	vectorEditObject.set(uuid);
	offPointer = registerModulePointer({ down: onDown, move: onMove, up: onUp }, { modes: ['edit'] });
	// a peer's edit or an undo replaced the record: re-read it (never mid-drag)
	offRevision = sceneRevision.subscribe(() => {
		if (!edited || gesture) return;
		if (!objectOf(edited.uuid)) return exitVectorEdit();
		const p = vectorParamsOf(edited);
		if (!p || p.kind !== 'path') return exitVectorEdit();
		working = cloneSubpaths(p.paths);
		const pick = get(vectorEditPick);
		if (pick && !working[pick.sub]?.nodes[pick.index]) vectorEditPick.set(null);
		rebuildHelpers();
	});
	// selecting something else ends the session
	offSelection = selectedObjects.subscribe((list) => {
		if (!edited || !Array.isArray(list) || !list.length) return;
		if (!list.some((/** @type {any} */ o) => (o?.uuid ?? o) === edited.uuid)) queueMicrotask(exitVectorEdit);
	});
	if (typeof window !== 'undefined') window.addEventListener('keydown', onKeydown, true);
	rebuildHelpers();
	tick();
	return true;
}

export function exitVectorEdit() {
	if (!edited) return;
	const uuid = edited.uuid;
	offPointer?.();
	offRevision?.();
	offSelection?.();
	offPointer = offRevision = offSelection = null;
	if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown, true);
	if (rafId && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(rafId);
	rafId = 0;
	disposeHelpers();
	if (gesture) {
		// a drag cut short: put the committed geometry back
		gesture = null;
		const p = vectorParamsOf(edited);
		if (p) swapGeometry(p);
	}
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'unlock', uuid, peerId: peer.peer.id });
	edited = null;
	working = [];
	vectorEditPick.set(null);
	vectorEditObject.set(null);
}

/* ------------------------------------------------------------- geometry ---- */

/** local-only geometry swap (the drag preview) @param {Record<string, any>} params */
function swapGeometry(params) {
	if (!edited) return;
	edited.geometry.dispose();
	edited.geometry = buildVectorGeometry(cleanVector(params));
}

/** commit the working paths: one undo entry, one message */
function commit() {
	if (!edited) return false;
	return applyGeometry(edited.uuid, { paths: cloneSubpaths(working) });
}

/* -------------------------------------------------------------- picking ---- */

/** local (x, y) on the shape's plane -> screen px @param {number} x @param {number} y */
function screenOf(x, y) {
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const renderer = get(globalRenderer);
	if (!camera || !renderer || !edited) return null;
	const rect = renderer.domElement.getBoundingClientRect();
	const v = new THREE.Vector3(x, y, 0).applyMatrix4(edited.matrixWorld).project(camera);
	if (v.z > 1) return null;
	return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height];
}

/** the ray onto the shape's own z = 0 plane, in its local frame @param {THREE.Raycaster} ray */
function toLocal(ray) {
	if (!edited) return null;
	edited.updateMatrixWorld();
	const inv = edited.matrixWorld.clone().invert();
	const r = ray.ray.clone().applyMatrix4(inv);
	const p = r.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
	return p ? [p.x, p.y] : null;
}

/** which handles are on show: the picked point's and its neighbours' */
function visibleHandles() {
	const pick = get(vectorEditPick);
	/** @type {{sub: number, index: number}[]} */
	const out = [];
	if (!pick) return out;
	const sub = working[pick.sub];
	if (!sub) return out;
	const n = sub.nodes.length;
	for (const d of [-1, 0, 1]) {
		let i = pick.index + d;
		if (i < 0 || i >= n) {
			if (!sub.closed) continue;
			i = (i + n) % n;
		}
		if (!out.some((h) => h.index === i)) out.push({ sub: pick.sub, index: i });
	}
	return out;
}

/** what is under the pointer @param {number} cx @param {number} cy */
function pickAt(cx, cy) {
	// handles first (they sit over the outline), then anchors
	/** @type {null | {kind: 'node' | 'in' | 'out', sub: number, index: number}} */
	let best = null;
	let bd = PICK_PX;
	for (const { sub, index } of visibleHandles()) {
		const nd = working[sub].nodes[index];
		for (const which of /** @type {const} */ (['in', 'out'])) {
			const hx = which === 'in' ? nd.ix : nd.ox;
			const hy = which === 'in' ? nd.iy : nd.oy;
			if (!hx && !hy) continue;
			const s = screenOf(nd.x + hx, nd.y + hy);
			const d = s ? Math.hypot(s[0] - cx, s[1] - cy) : Infinity;
			if (d < bd) {
				bd = d;
				best = { kind: which, sub, index };
			}
		}
	}
	if (best) return best;
	bd = PICK_PX;
	working.forEach((sub, si) =>
		sub.nodes.forEach((nd, i) => {
			const s = screenOf(nd.x, nd.y);
			const d = s ? Math.hypot(s[0] - cx, s[1] - cy) : Infinity;
			if (d < bd) {
				bd = d;
				best = { kind: 'node', sub: si, index: i };
			}
		})
	);
	return best;
}

/* -------------------------------------------------------------- pointer ---- */

/** @param {any} _hit @param {any} ctx */
function onDown(_hit, ctx) {
	if (!edited) return false;
	const picked = pickAt(ctx.clientX, ctx.clientY);
	const now = performance.now();
	if (picked?.kind === 'node') {
		const again = lastDownNode && lastDownNode.sub === picked.sub && lastDownNode.index === picked.index && now - lastDownAt < 350;
		lastDownAt = now;
		lastDownNode = { sub: picked.sub, index: picked.index };
		vectorEditPick.set({ sub: picked.sub, index: picked.index });
		if (again) {
			convertPoint(picked.sub, picked.index);
			gesture = null;
			return true;
		}
		gesture = { kind: 'node', sub: picked.sub, index: picked.index, moved: false };
		rebuildHelpers();
		return true;
	}
	if (picked) {
		gesture = { kind: /** @type {'in' | 'out'} */ (picked.kind), sub: picked.sub, index: picked.index, moved: false };
		return true;
	}
	// on the outline: insert a point
	const at = toLocal(ctx.ray);
	if (at) {
		for (let si = 0; si < working.length; si++) {
			const near = nearestOnSubpath(working[si], at);
			if (!near) continue;
			const s = screenOf(near.x, near.y);
			if (s && Math.hypot(s[0] - ctx.clientX, s[1] - ctx.clientY) < CURVE_PX) {
				insertPoint(si, near.seg, near.t);
				return true;
			}
		}
	}
	return false; // empty space: orbit / select as usual
}

/** @param {any} _hit @param {any} ctx */
function onMove(_hit, ctx) {
	if (!edited || !gesture) return;
	const at = toLocal(ctx.ray);
	if (!at) return;
	const sub = working[gesture.sub];
	if (!sub) return;
	working[gesture.sub] =
		gesture.kind === 'node' ? moveNode(sub, gesture.index, at) : moveHandle(sub, gesture.index, gesture.kind, at, { free: altHeld });
	gesture.moved = true;
	const p = vectorParamsOf(edited);
	if (p) swapGeometry({ ...p, paths: working });
	rebuildHelpers();
}

function onUp() {
	if (!gesture) return;
	const moved = gesture.moved;
	gesture = null;
	if (moved) commit();
}

/* ------------------------------------------------------------- commands ---- */

/** insert a point on segment `seg` at t @param {number} sub @param {number} seg @param {number} t */
export function insertPoint(sub, seg, t) {
	if (!edited || !working[sub]) return false;
	working[sub] = insertNodeAt(working[sub], seg, t);
	const pairs = working[sub].nodes.length;
	vectorEditPick.set({ sub, index: Math.min(seg + 1, pairs - 1) });
	return commit();
}

/** corner <-> smooth @param {number} sub @param {number} index */
export function convertPoint(sub, index) {
	if (!edited || !working[sub]?.nodes[index]) return false;
	const nd = working[sub].nodes[index];
	working[sub] = convertNode(working[sub], index, !nd.smooth);
	return commit();
}

/** move a point to local (x, y) as one gesture (suites, VR) @param {number} sub @param {number} index @param {number[]} at */
export function movePoint(sub, index, at) {
	if (!edited || !working[sub]?.nodes[index]) return false;
	working[sub] = moveNode(working[sub], index, at);
	return commit();
}

/** remove the picked point (a subpath keeps two; the last two go with their subpath) */
export function deletePickedPoint() {
	const pick = get(vectorEditPick);
	if (!edited || !pick || !working[pick.sub]) return false;
	const sub = working[pick.sub];
	if (sub.nodes.length <= 2) {
		if (working.length <= 1) {
			showToast('A path needs at least two points — delete the shape instead');
			return false;
		}
		working.splice(pick.sub, 1);
	} else working[pick.sub] = deleteNode(sub, pick.index);
	vectorEditPick.set(null);
	return commit();
}

/* -------------------------------------------------------------- helpers ---- */

const ANCHOR = 0xffffff;
const PICKED = 0x4f8cff;
const HANDLE = 0xffb84f;

function disposeHelpers() {
	if (!helpers) return;
	/** @type {any} */ (get(globalScene))?.remove(helpers);
	helpers.traverse((/** @type {any} */ o) => {
		o.geometry?.dispose();
		o.material?.dispose();
	});
	helpers = null;
}

/** @param {number[]} pos @param {number} color @param {number} size */
function dots(pos, color, size) {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	const p = new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false, transparent: true }));
	p.renderOrder = 20;
	return p;
}

function rebuildHelpers() {
	disposeHelpers();
	const scene = /** @type {any} */ (get(globalScene));
	if (!scene || !edited) return;
	helpers = new THREE.Group();
	helpers.name = 'vector-edit-helpers';
	helpers.userData.isEditOverlay = true;
	const pick = get(vectorEditPick);
	/** @type {number[]} */ const anchors = [];
	/** @type {number[]} */ const picked = [];
	working.forEach((sub, si) =>
		sub.nodes.forEach((nd, i) => (pick && pick.sub === si && pick.index === i ? picked : anchors).push(nd.x, nd.y, 0))
	);
	/** @type {number[]} */ const handleDots = [];
	/** @type {number[]} */ const lines = [];
	for (const { sub, index } of visibleHandles()) {
		const nd = working[sub].nodes[index];
		for (const [hx, hy] of [
			[nd.ix, nd.iy],
			[nd.ox, nd.oy]
		]) {
			if (!hx && !hy) continue;
			handleDots.push(nd.x + hx, nd.y + hy, 0);
			lines.push(nd.x, nd.y, 0, nd.x + hx, nd.y + hy, 0);
		}
	}
	helpers.add(dots(anchors, ANCHOR, 9));
	if (picked.length) helpers.add(dots(picked, PICKED, 11));
	if (handleDots.length) {
		helpers.add(dots(handleDots, HANDLE, 7));
		const lg = new THREE.BufferGeometry();
		lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
		const ls = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: HANDLE, depthTest: false, transparent: true }));
		ls.renderOrder = 19;
		helpers.add(ls);
	}
	helpers.matrixAutoUpdate = false;
	edited.updateMatrixWorld();
	helpers.matrix.copy(edited.matrixWorld);
	scene.add(helpers);
}

/** the helpers live at the scene root: follow the shape when it moves (a peer, the world rig) */
function tick() {
	if (!edited || typeof requestAnimationFrame === 'undefined') return;
	if (helpers) {
		edited.updateMatrixWorld();
		if (!helpers.matrix.equals(edited.matrixWorld)) helpers.matrix.copy(edited.matrixWorld);
		helpers.matrixWorldNeedsUpdate = true;
	}
	rafId = requestAnimationFrame(tick);
}

/* ----------------------------------------------------------------- keys ---- */

let altHeld = false;

/** @param {KeyboardEvent} event */
function onKeydown(event) {
	altHeld = event.altKey;
	if (!edited || !viewportHasKeys(event)) return;
	const target = /** @type {any} */ (event.target);
	if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
	let handled = true;
	if (event.key === 'Escape') exitVectorEdit();
	else if ((event.key === 'Delete' || event.key === 'Backspace') && get(vectorEditPick)) deletePickedPoint();
	else handled = false;
	if (handled) {
		event.preventDefault();
		event.stopImmediatePropagation();
	}
}
if (typeof window !== 'undefined') {
	const track = (/** @type {KeyboardEvent} */ e) => (altHeld = e.altKey);
	window.addEventListener('keydown', track, true);
	window.addEventListener('keyup', track, true);
}

/** suites: the session's state + every anchor's screen position */
export function vectorEditDebug() {
	return {
		uuid: get(vectorEditObject),
		pick: get(vectorEditPick),
		paths: cloneSubpaths(working),
		helpers: !!helpers,
		screen: working.map((sub) => sub.nodes.map((nd) => screenOf(nd.x, nd.y)))
	};
}
