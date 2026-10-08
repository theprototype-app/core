// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalRenderer, globalCamera, orbitControls, objectsGroup } from '../stores/sceneStore';
import { snapEnabled, snapSettings, snapTargets } from './snapping';
import { dimsOf, dimsRevision, loadMeasuredDims, measureDims, dimsLabel, costLabel } from './placementDims';
import { placementPreview, placementTriBudget, placementShowDims, currentGhostTier } from './placementPrefs';
import { showGhost, poseGhost, hideGhost, setGhostModel, ghostInfo } from './placeGhost';
import { registerDebugHook } from './debugHooks';

// 39 P1 — DRAG TO PLACE. An Explorer card dragged onto the viewport shows a ghost where the
// item will land, and releasing there spawns it — the content-browser drag of Unity / Unreal /
// Blender's asset browser.
//
// THIS IS A POINTER GESTURE, NOT HTML5 DnD. A native drag delivers no keydown and no wheel
// while it runs (the OS drag loop owns the input), so R / the wheel could never rotate the ghost
// and Esc could only be the browser's own cancel. Explorer cancels a TRUSTED dragstart on a
// placeable card and hands the gesture here; everything that used to receive that card's HTML5
// drag still does, because over any element that is NOT the viewport canvas this module
// dispatches the same `application/x-explorer-item` payload as synthetic dragenter / dragover /
// dragleave / drop events (marked `application/x-tp-place-bridge`, which App's window drop
// handler ignores so a release over a panel can never place). So Explorer folders, packs, the
// bin, the Inspector's texture slot and the LOD panel keep working with no change.
//
// THE RULES: release over the viewport = spawn at the ghost (ONE undo step, replicated like any
// add — the spawn itself is explorerDrop.placeFromGhost). Esc, releasing anywhere else, or
// dropping back on the Explorer = nothing spawns and nothing enters the undo stack. R / Shift+R
// and the wheel turn the ghost in 15° steps; Shift = free (no grid snap); Alt at release = drop at
// the camera's focus point; `snapTargets.alignNormal` turns the item onto the surface. A touch
// long-press drag works the same with the Explorer sheet collapsed out of the way.
//
// LOCAL: the ghost and this state never leave the machine.

const STEP_DEG = 15;
/** gap between items dropped as a row (metres) */
const ROW_GAP = 0.25;
/** a spot further than this from the origin is "off the world" */
const WORLD_LIMIT = 5000;
/** share of the ghost's volume inside another object that turns it amber */
const OVERLAP_WARN = 0.5;

/**
 * @typedef {{payload: any, dims: import('./placementDims').Dims, url: string | null,
 *   libId: string | null, prefabId: string | null, label: string}} DragItem
 */

/**
 * What the overlay draws. null when no drag is running.
 * @type {import('svelte/store').Writable<null | {x: number, y: number, label: string, count: number,
 *   over: 'viewport' | 'explorer' | 'other', state: 'ok' | 'warn' | 'bad', dims: string, cost: string,
 *   unknown: boolean, rotation: number, pointerType: string, alt: boolean, collapse: boolean}>}
 */
export const placeDrag = writable(null);

/** the current gesture (module state; the store is its view) @type {any} */
let drag = null;
/** @type {any} */
let dropRef = null;
/** @type {any} */
let packRefsRef = null;
/** @type {any} */
let explorerRef = null;
/** @type {any} */
let prefabsRef = null;
const primed = Promise.all([
	import('./explorerDrop').then((m) => (dropRef = m)),
	import('./packRefs').then((m) => (packRefsRef = m)),
	import('./explorer').then((m) => (explorerRef = m)),
	import('./prefabs').then((m) => (prefabsRef = m))
]).catch(() => {});

/** library / prefab models decoded for a ghost, newest last (a small LRU) @type {Map<string, any>} */
const decoded = new Map();
const DECODED_MAX = 4;
/** @param {string} key @param {any} root */
function keepDecoded(key, root) {
	decoded.delete(key);
	decoded.set(key, root);
	while (decoded.size > DECODED_MAX) decoded.delete(/** @type {string} */ (decoded.keys().next().value));
}

/** Is an Explorer card something that places as an object? @param {any} item */
export function isPlaceable(item) {
	if (!item) return false;
	if (item.prefabId || item.kind === 'prefab') return true;
	if (item.kind !== 'object') return false;
	if (item.deletedEntry || item.remoteScene || item.volumeItem) return false;
	return !!(item.glbUrl || item.id);
}

/** @returns {boolean} */
export function placeDragActive() {
	return !!drag;
}

/** @param {any} p @returns {DragItem} */
function toItem(p) {
	const library = !p.url && !p.prefabId && p.id ? get(explorerRef?.explorerItems ?? writable([])).find((/** @type {any} */ r) => r.id === p.id) : null;
	const src = p.dims ? p : library ?? p;
	return {
		payload: p,
		dims: dimsOf({ ...src, glbUrl: p.url ?? null }),
		url: p.url ?? null,
		libId: !p.url && !p.prefabId ? p.id ?? null : null,
		prefabId: p.prefabId ?? null,
		label: String(p.name || 'item')
	};
}

/**
 * Begin a place drag. `payload` is Explorer's drag payload (a single card, or one carrying an
 * `items` array for a multi-selection).
 * @param {{payload: any, x: number, y: number, pointerType?: string, pointerId?: number, source?: HTMLElement | null, collapse?: boolean}} opts
 */
export function beginPlaceDrag(opts) {
	if (drag) cancelPlaceDrag('restart');
	void loadMeasuredDims();
	const list = Array.isArray(opts.payload?.items) && opts.payload.items.length > 1 ? opts.payload.items : [opts.payload];
	const items = list.map(toItem);
	drag = {
		payload: opts.payload,
		items,
		x: opts.x,
		y: opts.y,
		pointerType: opts.pointerType ?? 'mouse',
		pointerId: opts.pointerId ?? -1,
		source: opts.source ?? null,
		collapse: !!opts.collapse,
		rotation: 0,
		shift: false,
		alt: false,
		over: /** @type {'viewport'|'explorer'|'other'} */ ('other'),
		state: /** @type {'ok'|'warn'|'bad'} */ ('ok'),
		placements: /** @type {any[]} */ ([]),
		bridgeEl: /** @type {Element | null} */ (null),
		prefetched: false,
		ghostUp: false,
		tiers: items.map(() => 'box'),
		obstacles: /** @type {any[] | null} */ (null),
		unsubDims: /** @type {(() => void) | null} */ (null)
	};
	drag.unsubDims = dimsRevision.subscribe(() => drag && refreshDims());
	window.addEventListener('pointermove', onMove, true);
	window.addEventListener('pointerup', onUp, true);
	window.addEventListener('pointercancel', onCancelEvent, true);
	window.addEventListener('keydown', onKey, true);
	window.addEventListener('keyup', onKeyUp, true);
	window.addEventListener('wheel', onWheel, { capture: true, passive: false });
	window.addEventListener('blur', onBlur);
	// a touch drag: the browser must not take the finger as a PAN (touch-action is decided at
	// touchstart, before the long-press made this a drag) — that ends in a pointercancel
	window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
	document.documentElement.classList.add('tp-place-dragging');
	if (opts.collapse) document.documentElement.classList.add('tp-place-collapse');
	update(opts.x, opts.y);
	return true;
}

function refreshDims() {
	if (!drag) return;
	drag.items = drag.items.map((/** @type {DragItem} */ it) => ({ ...it, dims: it.dims.known ? it.dims : dimsOf({ ...it.payload, glbUrl: it.url }) }));
	if (drag.ghostUp) {
		// sizes changed: rebuild the boxes (the model tiers re-apply below)
		showGhost(drag.items.map((/** @type {DragItem} */ it) => ({ box: it.dims.box })));
		drag.tiers = drag.items.map(() => 'box');
		applyTiers();
	}
	update(drag.x, drag.y);
}

/** @param {PointerEvent} e */
function onMove(e) {
	if (!drag || (drag.pointerId >= 0 && e.pointerId !== drag.pointerId && drag.pointerType !== 'mouse')) return;
	drag.shift = e.shiftKey;
	drag.alt = e.altKey;
	if (drag.pointerType !== 'mouse') e.preventDefault();
	update(e.clientX, e.clientY);
}

/** @param {PointerEvent} e */
function onUp(e) {
	if (!drag) return;
	if (drag.pointerType !== 'mouse' && drag.pointerId >= 0 && e.pointerId !== drag.pointerId) return;
	drag.shift = e.shiftKey;
	drag.alt = e.altKey;
	update(e.clientX, e.clientY);
	if (drag.over === 'viewport') {
		// the release is ours — the canvas must not read it as a click
		e.stopPropagation();
		e.preventDefault();
		commit();
		return;
	}
	if (drag.pointerType === 'mouse' && drag.bridgeEl) bridgeDrop(e.clientX, e.clientY);
	end('released-elsewhere');
}

/** @param {TouchEvent} e */
function onTouchMove(e) {
	if (drag && drag.pointerType !== 'mouse' && e.cancelable) e.preventDefault();
}

function onCancelEvent() {
	cancelPlaceDrag('pointercancel');
}
function onBlur() {
	cancelPlaceDrag('blur');
}

/** @param {KeyboardEvent} e */
function onKey(e) {
	if (!drag) return;
	if (e.key === 'Escape') {
		e.preventDefault();
		e.stopPropagation();
		cancelPlaceDrag('escape');
		return;
	}
	drag.shift = e.shiftKey;
	drag.alt = e.altKey;
	if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey) {
		e.preventDefault();
		e.stopPropagation();
		rotateBy(e.shiftKey ? -1 : 1);
		return;
	}
	if (e.key === 'Alt' || e.key === 'Shift') {
		e.preventDefault();
		update(drag.x, drag.y);
	}
}
/** @param {KeyboardEvent} e */
function onKeyUp(e) {
	if (!drag) return;
	drag.shift = e.shiftKey;
	drag.alt = e.altKey;
	if (e.key === 'Alt' || e.key === 'Shift') update(drag.x, drag.y);
}

/** @param {WheelEvent} e */
function onWheel(e) {
	if (!drag || drag.over !== 'viewport' || !e.deltaY) return;
	// the wheel turns the ghost — the camera must not zoom underneath it
	e.preventDefault();
	e.stopPropagation();
	rotateBy(e.deltaY > 0 ? 1 : -1);
}

/** @param {number} steps */
export function rotateBy(steps) {
	if (!drag) return;
	drag.rotation = (((drag.rotation + steps * STEP_DEG) % 360) + 360) % 360;
	update(drag.x, drag.y);
}

/** the viewport canvas, if the point is over it @param {number} x @param {number} y */
function viewportAt(x, y) {
	/** @type {any} */
	const renderer = get(globalRenderer);
	const canvas = renderer?.domElement;
	if (!canvas) return { over: /** @type {const} */ ('other'), el: null };
	const el = document.elementFromPoint(x, y);
	if (el === canvas) return { over: /** @type {const} */ ('viewport'), el };
	if (el?.closest?.('#explorer-window, #explorer-list')) return { over: /** @type {const} */ ('explorer'), el };
	return { over: /** @type {const} */ ('other'), el };
}

/** @param {number} x @param {number} y */
function update(x, y) {
	if (!drag) return;
	drag.x = x;
	drag.y = y;
	const { over, el } = viewportAt(x, y);
	drag.over = over;
	if (over === 'viewport') {
		bridgeLeave();
		if (!drag.ghostUp) {
			drag.ghostUp = showGhost(drag.items.map((/** @type {DragItem} */ it) => ({ box: it.dims.box })));
			applyTiers();
		}
		if (!drag.prefetched) prefetch();
		place(x, y);
		poseGhost(drag.placements, drag.state, drag.placements.length > 0);
	} else {
		poseGhost([], drag.state, false);
		if (drag.pointerType === 'mouse') bridgeOver(el, x, y);
	}
	publish();
}

function publish() {
	if (!drag) return placeDrag.set(null);
	const first = drag.items[0];
	const many = drag.items.length;
	placeDrag.set({
		x: drag.x,
		y: drag.y,
		label: many > 1 ? `${first.label} + ${many - 1} more` : first.label,
		count: many,
		over: drag.over,
		state: drag.state,
		dims: get(placementShowDims) ? (first.dims.known ? dimsLabel(first.dims.size) : 'size unknown') : '',
		cost: get(placementShowDims) ? costLabel(first.dims) : '',
		unknown: !first.dims.known,
		rotation: drag.rotation,
		pointerType: drag.pointerType,
		alt: drag.alt,
		collapse: drag.collapse
	});
}

// ---- where it lands ------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
const _nl = new THREE.Vector3();
const _qi = new THREE.Quaternion();
const _yaw = new THREE.Quaternion();
const _align = new THREE.Quaternion();
const _right = new THREE.Vector3();
const _box = new THREE.Box3();

/** world AABBs of every top-level object, read once per drag (the scene does not move under a drag) */
function obstacles() {
	if (drag.obstacles) return drag.obstacles;
	/** @type {any} */
	const group = get(objectsGroup);
	/** @type {any[]} */
	const out = [];
	for (const child of group?.children ?? []) {
		if (!child.visible) continue;
		const b = new THREE.Box3().setFromObject(child);
		if (b.isEmpty() || !Number.isFinite(b.min.x)) continue;
		out.push(b);
	}
	drag.obstacles = out;
	return out;
}

/**
 * The lowest point of a box (in its own frame) along `nl`, i.e. min over the box of dot(nl, p).
 * @param {number[]} box @param {any} nl
 */
function supportMin(box, nl) {
	return (nl.x >= 0 ? box[0] : box[3]) * nl.x + (nl.y >= 0 ? box[1] : box[4]) * nl.y + (nl.z >= 0 ? box[2] : box[5]) * nl.z;
}

/** @param {number} v @param {number} step */
function snapTo(v, step) {
	return step > 0 ? Math.round(v / step) * step : v;
}

/** @param {number} x @param {number} y */
function place(x, y) {
	if (!dropRef) return (drag.placements = []);
	let point = null;
	let normal = UP.clone();
	/** @type {any} */
	const controls = get(orbitControls);
	if (drag.alt && controls?.target) {
		// the focus point is usually in the air: drop it onto whatever is below it
		const below = dropRef.surfaceBelow(controls.target.toArray());
		if (below) {
			point = new THREE.Vector3().fromArray(below.point);
			normal = new THREE.Vector3().fromArray(below.normal).normalize();
		}
	} else {
		const t = dropRef.dropTarget(x, y);
		if (t.point) {
			point = new THREE.Vector3().fromArray(t.point);
			if (t.normal) normal = new THREE.Vector3().fromArray(t.normal).normalize();
		}
	}
	if (!point || point.length() > WORLD_LIMIT) {
		drag.state = 'bad';
		drag.placements = point ? drag.items.map(() => ({ position: point.clone(), quaternion: new THREE.Quaternion() })) : [];
		drag.target = null;
		return;
	}
	// grid snap on the two world axes the surface spans (Shift = free)
	if (get(snapEnabled) && !drag.shift) {
		const step = Number(get(snapSettings)?.translate) || 0;
		const ax = Math.abs(normal.x);
		const ay = Math.abs(normal.y);
		const az = Math.abs(normal.z);
		const along = ay >= ax && ay >= az ? 'y' : ax >= az ? 'x' : 'z';
		const p = /** @type {any} */ (point);
		for (const a of ['x', 'y', 'z']) if (a !== along) p[a] = snapTo(p[a], step);
	}
	_yaw.setFromAxisAngle(UP, THREE.MathUtils.degToRad(drag.rotation));
	const align = !!get(snapTargets)?.alignNormal && normal.distanceTo(UP) > 1e-6;
	if (align) _align.setFromUnitVectors(UP, normal);
	else _align.identity();
	const q = _align.clone().multiply(_yaw);
	// a row of several items, laid out along the camera's right (on the surface)
	/** @type {any} */
	const camera = get(globalCamera);
	_right.set(1, 0, 0);
	if (camera) _right.setFromMatrixColumn(camera.matrixWorld, 0);
	_right.addScaledVector(normal, -_right.dot(normal));
	if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0).addScaledVector(normal, -normal.x);
	_right.normalize();
	_qi.copy(q).invert();
	_nl.copy(normal).applyQuaternion(_qi);
	const widths = drag.items.map((/** @type {DragItem} */ it) => {
		const b = it.dims.box;
		const half = new THREE.Vector3((b[3] - b[0]) / 2, (b[4] - b[1]) / 2, (b[5] - b[2]) / 2);
		const r = _right.clone().applyQuaternion(_qi);
		return 2 * (Math.abs(r.x) * half.x + Math.abs(r.y) * half.y + Math.abs(r.z) * half.z);
	});
	const total = widths.reduce((/** @type {number} */ s, /** @type {number} */ w) => s + w, 0) + ROW_GAP * (widths.length - 1);
	let cursor = -total / 2;
	/** @type {any[]} */
	const placements = [];
	let worst = 0;
	drag.items.forEach((/** @type {DragItem} */ it, /** @type {number} */ i) => {
		const b = it.dims.box;
		// the row slot is measured to the box CENTRE; shift so the box (not the pivot) sits there
		const centre = new THREE.Vector3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2).applyQuaternion(q);
		const slot = drag.items.length > 1 ? cursor + widths[i] / 2 : 0;
		cursor += widths[i] + ROW_GAP;
		const pos = point.clone().addScaledVector(_right, slot);
		if (drag.items.length > 1) pos.addScaledVector(_right, -centre.dot(_right));
		// rest the box ON the surface: its lowest point along the normal touches the hit plane
		pos.addScaledVector(normal, -supportMin(b, _nl));
		placements.push({ position: pos, quaternion: q.clone() });
		// overlap with other objects (amber, still placeable)
		const world = boxWorld(b, pos, q);
		const vol = Math.max(volume(world), 1e-9);
		for (const ob of obstacles()) {
			const inter = world.clone().intersect(ob);
			if (inter.isEmpty()) continue;
			worst = Math.max(worst, volume(inter) / vol);
		}
	});
	drag.placements = placements;
	drag.target = { point: point.toArray(), normal: normal.toArray() };
	drag.state = worst > OVERLAP_WARN ? 'warn' : 'ok';
}

/** @param {number[]} b @param {any} pos @param {any} q */
function boxWorld(b, pos, q) {
	_box.makeEmpty();
	const m = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1));
	const shrink = 0.02; // a box resting ON a surface is not inside it
	for (const x of [b[0] + shrink, b[3] - shrink])
		for (const y of [b[1] + shrink, b[4] - shrink])
			for (const z of [b[2] + shrink, b[5] - shrink]) _box.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(m));
	return _box.clone();
}
/** @param {any} b */
function volume(b) {
	if (b.isEmpty()) return 0;
	return (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z);
}

// ---- tiers + prefetch -----------------------------------------------------------------

/** the decoded model of an item, if one is in memory (sync) @param {DragItem} it */
function decodedOf(it) {
	if (it.url) {
		if (it.dims.animated || it.payload.behavior) return null;
		return packRefsRef?.peekPackTemplate?.(it.url)?.scene ?? null;
	}
	if (it.libId) return decoded.get('lib:' + it.libId) ?? null;
	if (it.prefabId) return decoded.get('prefab:' + it.prefabId) ?? null;
	return null;
}

function applyTiers() {
	if (!drag?.ghostUp) return;
	drag.items.forEach((/** @type {DragItem} */ it, /** @type {number} */ i) => {
		const scene = decodedOf(it);
		// the budget is checked BEFORE anything is built
		const tier = currentGhostTier({ decoded: !!scene, tris: it.dims.tris ?? (scene ? measureDims(scene)?.tris ?? null : null) });
		if (tier === drag.tiers[i]) return;
		drag.tiers[i] = tier;
		setGhostModel(i, tier === 'model' ? scene : null, tier === 'model' ? 'model' : 'box');
	});
}

/** Hovering the viewport starts the downloads (and decodes) a drop will need. */
function prefetch() {
	drag.prefetched = true;
	const host = drag;
	for (const it of /** @type {DragItem[]} */ (drag.items)) {
		if (it.url) {
			if (it.dims.animated || it.payload.behavior) {
				const url = it.url;
				import('./packCache').then((m) => m.fetchPackBuffer(url).catch(() => {}));
				continue;
			}
			const job = packRefsRef?.loadPackTemplate?.(it.url);
			job?.then(() => drag === host && (refreshDims(), applyTiers())).catch(() => {});
			continue;
		}
		const wantModel = get(placementPreview) !== 'box';
		if (it.libId && wantModel && !decoded.has('lib:' + it.libId)) {
			// a library model whose size is known to be over the budget is not decoded for a box
			if (get(placementPreview) === 'budget' && it.dims.tris != null && it.dims.tris > get(placementTriBudget)) continue;
			decodeLibrary(it.libId).then(() => drag === host && (refreshDims(), applyTiers()));
		}
		if (it.prefabId && wantModel && !decoded.has('prefab:' + it.prefabId)) {
			decodePrefab(it.prefabId);
			if (drag === host) (refreshDims(), applyTiers());
		}
	}
}

/** @param {string} id */
async function decodeLibrary(id) {
	try {
		const record = get(explorerRef.explorerItems).find((/** @type {any} */ r) => r.id === id);
		const blob = await explorerRef.itemBlob(id);
		if (!record || !blob) return;
		const ext = String(record.name).split('.').pop()?.toLowerCase() ?? 'glb';
		const root = await explorerRef.parseObjectFile(await blob.arrayBuffer(), ext);
		keepDecoded('lib:' + id, root);
		// P4: a library record learns its size the first time it is decoded
		if (!record.dims) {
			const dims = measureDims(root, { bytes: record.size ?? null, animated: !!root.animations?.length });
			if (dims) explorerRef.patchRecord(id, { dims: { size: dims.size, box: dims.box, tris: dims.tris, bytes: dims.bytes } });
		}
	} catch {}
}

/** @param {string} id */
function decodePrefab(id) {
	try {
		const prefab = get(prefabsRef.prefabs).find((/** @type {any} */ p) => p.id === id);
		if (!prefab?.element) return;
		const root = new THREE.ObjectLoader().parse(prefab.element);
		keepDecoded('prefab:' + id, root);
	} catch {}
}

// ---- the HTML5 bridge (over anything that is not the viewport) -------------------------

/** a DataTransfer carrying the card's payload, flagged as ours */
function bridgeData() {
	const dt = new DataTransfer();
	dt.setData('application/x-explorer-item', JSON.stringify(drag.payload));
	dt.setData('application/x-tp-place-bridge', '1');
	return dt;
}

/** @param {Element | null} el @param {string} type @param {number} x @param {number} y */
function fire(el, type, x, y) {
	if (!el) return;
	try {
		el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: bridgeData() }));
	} catch {}
}

/** @param {Element | null} el @param {number} x @param {number} y */
function bridgeOver(el, x, y) {
	if (el !== drag.bridgeEl) {
		if (drag.bridgeEl) fire(drag.bridgeEl, 'dragleave', x, y);
		drag.bridgeEl = el;
		if (el) fire(el, 'dragenter', x, y);
	}
	if (el) fire(el, 'dragover', x, y);
}

function bridgeLeave() {
	if (!drag?.bridgeEl) return;
	fire(drag.bridgeEl, 'dragleave', drag.x, drag.y);
	drag.bridgeEl = null;
}

/** @param {number} x @param {number} y */
function bridgeDrop(x, y) {
	const el = drag.bridgeEl;
	if (!el) return;
	fire(el, 'drop', x, y);
	drag.bridgeEl = null;
}

// ---- the end ----------------------------------------------------------------------------

function commit() {
	const host = drag;
	if (host.state === 'bad' || !host.placements.length) return end('invalid');
	const placements = host.placements.map((/** @type {any} */ p) => ({ position: p.position.toArray(), quaternion: p.quaternion.toArray() }));
	const items = host.items.map((/** @type {DragItem} */ it) => ({ payload: it.payload, dims: it.dims }));
	end('committed');
	lastCommit = { at: Date.now(), count: items.length, placements };
	primed.then(() => dropRef?.placeFromGhost(items, placements));
}

/** Cancel the running drag: nothing spawns, nothing enters the undo stack. @param {string} [why] */
export function cancelPlaceDrag(why = 'cancel') {
	if (!drag) return;
	end(why);
}

/** @param {string} why */
function end(why) {
	if (!drag) return;
	const host = drag;
	if (host.bridgeEl) fire(host.bridgeEl, 'dragleave', host.x, host.y);
	// the HTML5 consumers clear their highlight state on the SOURCE's dragend
	if (host.pointerType === 'mouse') fire(host.source, 'dragend', host.x, host.y);
	host.unsubDims?.();
	window.removeEventListener('pointermove', onMove, true);
	window.removeEventListener('pointerup', onUp, true);
	window.removeEventListener('pointercancel', onCancelEvent, true);
	window.removeEventListener('keydown', onKey, true);
	window.removeEventListener('keyup', onKeyUp, true);
	window.removeEventListener('wheel', onWheel, true);
	window.removeEventListener('blur', onBlur);
	window.removeEventListener('touchmove', onTouchMove, true);
	document.documentElement.classList.remove('tp-place-dragging', 'tp-place-collapse');
	hideGhost();
	drag = null;
	lastEnd = why;
	placeDrag.set(null);
}

/** for the suites @type {string | null} */
let lastEnd = null;
/** @type {any} */
let lastCommit = null;

registerDebugHook('placeDrag', {
	placeDrag,
	placeDragActive,
	beginPlaceDrag,
	cancelPlaceDrag,
	rotateBy,
	ghostInfo,
	isPlaceable,
	state: () =>
		drag
			? {
					over: drag.over,
					state: drag.state,
					rotation: drag.rotation,
					tiers: [...drag.tiers],
					items: drag.items.map((/** @type {DragItem} */ it) => ({ label: it.label, dims: it.dims })),
					placements: drag.placements.map((/** @type {any} */ p) => ({ position: p.position.toArray(), quaternion: p.quaternion.toArray() })),
					target: drag.target ?? null
				}
			: null,
	last: () => ({ end: lastEnd, commit: lastCommit }),
	decodedKeys: () => [...decoded.keys()]
});
