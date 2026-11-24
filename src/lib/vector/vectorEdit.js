// 64 D1: EDIT POINTS on a vector shape — the pen's other half. A session on one shape shows its
// anchors (and the handles of the picked one and its neighbours) at the scene root, and takes
// presses through the modulePointer seam:
//   press an anchor ........ pick it and drag it (its handles ride along); Shift adds / removes
//                            it from the picked set, and a drag on a picked point moves the set
//   press a handle ......... drag it (a smooth point keeps the opposite handle collinear; Alt breaks it)
//   press the outline ...... insert a point there (the curve keeps its shape — de Casteljau)
//   double-click an anchor . convert corner <-> smooth
//   Delete / Backspace ..... remove the picked points · Esc ends the session
//   arrows ................. nudge the picked points (Shift = x10; the grid step when grid snap is on)
//   Ctrl+A ................. pick every point · C closes an open path / K splits it at the point
// A parametric shape (rect / star / ...) is converted to a path on entry — ONE geometry entry,
// said in a toast. Every gesture is one `applyGeometry` (one undo entry, one message): a drag
// previews by swapping the local geometry only and commits on release, so the recorded `before`
// is the record as it was when the drag began. Peers are told with the usual lock/unlock pair.
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, globalScene, globalCamera, globalRenderer, TControls, sceneRevision, selectedObjects } from '../../stores/sceneStore';
import { peers, showToast } from '../../stores/appStore';
import { registerModulePointer } from '../modulePointer';
import { registerKeySessionProbe, comboOf, bindingOf } from '../shortcuts';
import { heldByOther, lockMessage } from '../lockHeld'; // 80a
import { viewportHasKeys } from '../keyScope';
import { applyGeometry } from '../geometryEdit';
import { moveNode, moveHandle, convertNode, deleteNode, insertNodeAt, nearestOnSubpath, cloneSubpaths, moveNodesBy, closable, closeSubpath, splitSubpathAt } from './vectorPath.js';
import { snapEnabled, snapSettings } from '../snapping';
import { cleanVector, vectorSubpaths } from './vectorRecord.js';
import { buildVectorGeometry } from './vectorMesh.js';
import { isVector, vectorParamsOf } from './vectorActions.js';
import { selectObject } from '../objectActions';
import { disarmVectorTool } from './vectorTool.js';

// the shape being edited lives in the boot gate (the toolbar mounts on it before this chunk loads)
import { vectorEditObject } from './vectorGate.js';
export { vectorEditObject };
/** the picked point (the PRIMARY one: its handles show, Convert reads it) @type {import('svelte/store').Writable<{sub: number, index: number} | null>} */
export const vectorEditPick = writable(null);
/** 64-vector-edit: EVERY picked point (the primary among them) @type {import('svelte/store').Writable<{sub: number, index: number}[]>} */
export const vectorEditPicks = writable([]);
/** what the toolbar offers for the primary point's subpath @type {import('svelte/store').Writable<{close: boolean, split: boolean}>} */
export const vectorEditCan = writable({ close: false, split: false });

const PICK_PX = 9;
const CURVE_PX = 7;

/** @type {any} */ let edited = null;
/** @type {null | (() => void)} */ let offPointer = null;
/** @type {null | (() => void)} */ let offRevision = null;
/** @type {null | (() => void)} */ let offSelection = null;
/** @type {THREE.Group | null} */ let helpers = null;
/** the paths as the session sees them (the record's, or the drag's working copy) @type {import('./vectorPath.js').VSubpath[]} */
let working = [];
/** @type {null | {kind: 'node' | 'in' | 'out', sub: number, index: number, moved: boolean, from?: number[], base?: import('./vectorPath.js').VSubpath[], picks?: {sub: number, index: number}[]}} */ let gesture = null;
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
	// 80a: a shape another peer holds refuses edits
	if (heldByOther(uuid)) {
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
	setPicks([]);
	// the session belongs to the shape it edits: select it first, or the selection watch below
	// sees whatever else was selected and ends the session on its first emission
	if (!get(selectedObjects)?.some?.((/** @type {any} */ o) => (o?.uuid ?? o) === uuid)) selectObject(uuid);
	/** @type {any} */
	const controls = get(TControls);
	controls?.detach();
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send(lockMessage([uuid], peer.peer.id)); // 80a K3: stamped
	vectorEditObject.set(uuid);
	offPointer = registerModulePointer({ down: onDown, move: onMove, up: onUp }, { modes: ['edit'] });
	// a peer's edit or an undo replaced the record: re-read it (never mid-drag)
	offRevision = sceneRevision.subscribe(() => {
		if (!edited || gesture) return;
		if (!objectOf(edited.uuid)) return exitVectorEdit();
		const p = vectorParamsOf(edited);
		if (!p || p.kind !== 'path') return exitVectorEdit();
		working = cloneSubpaths(p.paths);
		// a pick the new record no longer has goes; the rest stay picked
		const kept = get(vectorEditPicks).filter((p) => working[p.sub]?.nodes[p.index]);
		const pick = get(vectorEditPick);
		setPicks(kept, pick && working[pick.sub]?.nodes[pick.index] ? pick : null);
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
	setPicks([]);
	vectorEditObject.set(null);
}

/* ---------------------------------------------------------------- picks ---- */

/** set the picked set; the primary is `primary` when given, else the last of the set
 * @param {{sub: number, index: number}[]} list @param {{sub: number, index: number} | null} [primary] */
function setPicks(list, primary) {
	const uniq = [];
	for (const p of list) if (!uniq.some((q) => q.sub === p.sub && q.index === p.index)) uniq.push({ sub: p.sub, index: p.index });
	const main = primary && uniq.some((q) => q.sub === primary.sub && q.index === primary.index) ? primary : (uniq[uniq.length - 1] ?? null);
	vectorEditPicks.set(uniq);
	vectorEditPick.set(main ? { sub: main.sub, index: main.index } : null);
	const sub = main ? working[main.sub] : null;
	vectorEditCan.set({
		close: !!sub && closable(sub),
		split: !!sub && !!main && (sub.closed || (main.index > 0 && main.index < sub.nodes.length - 1))
	});
}

/** @param {{sub: number, index: number}} p */
const isPicked = (p) => get(vectorEditPicks).some((q) => q.sub === p.sub && q.index === p.index);

/** pick every point of the shape */
export function pickAllPoints() {
	if (!edited) return false;
	const all = [];
	working.forEach((sub, si) => sub.nodes.forEach((_, i) => all.push({ sub: si, index: i })));
	setPicks(all, get(vectorEditPick));
	rebuildHelpers();
	return true;
}

/** pick points as a suite or the VR laser would @param {{sub: number, index: number}[]} list */
export function pickPoints(list) {
	if (!edited) return false;
	setPicks(list.filter((p) => working[p.sub]?.nodes[p.index]));
	rebuildHelpers();
	return true;
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
		const p = { sub: picked.sub, index: picked.index };
		const additive = !!ctx.shiftKey || shiftHeld;
		const again = !additive && lastDownNode && lastDownNode.sub === p.sub && lastDownNode.index === p.index && now - lastDownAt < 350;
		lastDownAt = now;
		lastDownNode = p;
		if (additive) {
			// Shift: toggle this point in the set (a press that then drags moves the set)
			const list = get(vectorEditPicks);
			if (isPicked(p)) {
				setPicks(list.filter((q) => q.sub !== p.sub || q.index !== p.index));
				gesture = null; // un-picking is the whole gesture: nothing to drag
				rebuildHelpers();
				return true;
			}
			setPicks([...list, p], p);
		} else if (isPicked(p)) setPicks(get(vectorEditPicks), p); // keep the set: a drag moves all of it
		else setPicks([p]);
		if (again) {
			setPicks([p]);
			convertPoint(p.sub, p.index);
			gesture = null;
			return true;
		}
		const from = toLocal(ctx.ray);
		const picks = isPicked(p) ? get(vectorEditPicks) : [p];
		gesture = { kind: 'node', sub: p.sub, index: p.index, moved: false, from: from ?? undefined, base: cloneSubpaths(working), picks };
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
	if (gesture.kind === 'node' && gesture.base && gesture.from && (gesture.picks?.length ?? 0) > 1) {
		// the set moves by the pointer's travel since the press
		working = moveNodesBy(gesture.base, gesture.picks ?? [], at[0] - gesture.from[0], at[1] - gesture.from[1]);
	} else
		working[gesture.sub] =
			gesture.kind === 'node' ? moveNode(sub, gesture.index, at) : moveHandle(sub, gesture.index, gesture.kind, at, { free: altHeld || !!ctx.altKey });
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
	setPicks([{ sub, index: Math.min(seg + 1, pairs - 1) }]);
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

/** remove the picked points, ONE undo entry (a subpath keeps two; a subpath left with fewer goes
 * whole, and the shape's last subpath is refused — delete the shape instead) */
export function deletePickedPoint() {
	const picks = get(vectorEditPicks);
	if (!edited || !picks.length) return false;
	/** @type {Map<number, number[]>} */
	const bySub = new Map();
	for (const p of picks) if (working[p.sub]?.nodes[p.index]) bySub.set(p.sub, [...(bySub.get(p.sub) ?? []), p.index]);
	const next = cloneSubpaths(working);
	/** @type {number[]} */
	const dropSubs = [];
	for (const [si, list] of bySub) {
		const sub = next[si];
		if (sub.nodes.length - list.length < 2) {
			dropSubs.push(si);
			continue;
		}
		let cur = sub;
		for (const i of [...list].sort((a, b) => b - a)) cur = deleteNode(cur, i);
		next[si] = cur;
	}
	if (dropSubs.length >= next.length) {
		showToast('A path needs at least two points — delete the shape instead');
		return false;
	}
	working = next.filter((_, si) => !dropSubs.includes(si));
	setPicks([]);
	return commit();
}

/** convert every picked point to the opposite of what the PRIMARY one is (one undo entry) */
export function convertPicked() {
	const pick = get(vectorEditPick);
	if (!edited || !pick || !working[pick.sub]?.nodes[pick.index]) return false;
	const smooth = !working[pick.sub].nodes[pick.index].smooth;
	for (const p of get(vectorEditPicks)) if (working[p.sub]?.nodes[p.index]) working[p.sub] = convertNode(working[p.sub], p.index, smooth);
	return commit();
}

/** close the primary point's open subpath (the pen's "click the first point", after the fact) */
export function closePickedPath() {
	const pick = get(vectorEditPick);
	const sub = pick ? working[pick.sub] : null;
	if (!edited || !pick || !sub || !closable(sub)) return false;
	working[pick.sub] = closeSubpath(sub);
	setPicks(get(vectorEditPicks), pick);
	return commit();
}

/** split at the primary point: a closed loop opens there, an open path is cut in two */
export function splitAtPick() {
	const pick = get(vectorEditPick);
	const sub = pick ? working[pick.sub] : null;
	if (!edited || !pick || !sub) return false;
	const parts = splitSubpathAt(sub, pick.index);
	if (!parts) {
		showToast('Pick a point inside the path to split it (an end point has nothing to split)');
		return false;
	}
	working.splice(pick.sub, 1, ...parts);
	// the point the cut made: a loop's new start, or the second half's first point
	setPicks([{ sub: pick.sub + parts.length - 1, index: 0 }]);
	return commit();
}

/** the nudge step (metres): the grid step when grid snap is on, else 1 cm; x10 with Shift @param {boolean} big */
export function nudgeStep(big) {
	const grid = get(snapEnabled) ? Number(get(snapSettings)?.translate) || 0 : 0;
	const base = grid > 0 ? grid : 0.01;
	return big && !(grid > 0) ? base * 10 : base;
}

/** move the picked points by (dx, dy) in the shape's plane, one undo entry @param {number} dx @param {number} dy */
export function nudgePicked(dx, dy) {
	const picks = get(vectorEditPicks);
	if (!edited || !picks.length) return false;
	working = moveNodesBy(working, picks, dx, dy);
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
	/** @type {number[]} */ const anchors = [];
	/** @type {number[]} */ const picked = [];
	working.forEach((sub, si) => sub.nodes.forEach((nd, i) => (isPicked({ sub: si, index: i }) ? picked : anchors).push(nd.x, nd.y, 0)));
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
let shiftHeld = false;

/** the arrow rows (rebindable; Shift+ the same key is the big step) */
const NUDGES = /** @type {const} */ ([
	['vector.point-nudge-left', -1, 0],
	['vector.point-nudge-right', 1, 0],
	['vector.point-nudge-up', 0, 1],
	['vector.point-nudge-down', 0, -1]
]);

/** @param {KeyboardEvent} event */
function onKeydown(event) {
	altHeld = event.altKey;
	shiftHeld = event.shiftKey;
	if (!edited || !viewportHasKeys(event)) return;
	const target = /** @type {any} */ (event.target);
	if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
	let handled = true;
	if (event.key === 'Escape') exitVectorEdit();
	// Delete (rebindable: Settings ▸ Shortcuts ▸ Shapes) and Backspace, the laptop's delete key
	else if ((comboOf(event) === bindingOf('vector.point-delete') || event.key === 'Backspace') && get(vectorEditPicks).length) deletePickedPoint();
	else if (comboOf(event) === bindingOf('vector.point-all')) pickAllPoints();
	else if (comboOf(event) === bindingOf('vector.path-close') && get(vectorEditCan).close) closePickedPath();
	else if (comboOf(event) === bindingOf('vector.path-split') && get(vectorEditCan).split) splitAtPick();
	else {
		const combo = comboOf(event);
		const plain = combo.replace(/^Shift\+/, '');
		const row = get(vectorEditPicks).length ? NUDGES.find(([id]) => bindingOf(id) === combo || bindingOf(id) === plain) : null;
		if (row) {
			const step = nudgeStep(combo !== plain);
			nudgePicked(row[1] * step, row[2] * step);
		} else handled = false;
	}
	if (handled) {
		event.preventDefault();
		event.stopImmediatePropagation();
	}
}
if (typeof window !== 'undefined') {
	const track = (/** @type {KeyboardEvent} */ e) => {
		altHeld = e.altKey;
		shiftHeld = e.shiftKey;
	};
	window.addEventListener('keydown', track, true);
	window.addEventListener('keyup', track, true);
}

/** suites: the session's state + every anchor's screen position */
export function vectorEditDebug() {
	return {
		uuid: get(vectorEditObject),
		pick: get(vectorEditPick),
		picks: get(vectorEditPicks),
		can: get(vectorEditCan),
		paths: cloneSubpaths(working),
		helpers: !!helpers,
		screen: working.map((sub) => sub.nodes.map((nd) => screenOf(nd.x, nd.y)))
	};
}
