// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, globalScene, globalRenderer, TControls, marqueeRect, sceneRevision } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { viewportHasKeys } from './keyScope';
import { recordEntry } from './history';
import { canEditObject, warnViewerReadOnly } from './objectPermissions';
import { applyTerrainScatter, scatterHolderOf } from './terrainSurface';
import { buildHeightGrid, sampleHeight, rng32 } from './terrainScatterCore';
import { scatterScaleMin, scatterScaleMax, scatterRandomRotation } from './terrainPaint';
import { readScatter, blockOf, totalOf, indexOfInstance } from './scatterEditAdapter';
import {
	indicesInRect,
	rotateEach,
	scaleEach,
	transformGroup,
	deleteSelected,
	rerollSelected,
	centroid,
	rotateBrush,
	scaleBrush,
	relaxBrush,
	eraseBrush,
	yawOfQuaternion
} from './scatterEditCore';

// 51 E4 — EDIT SCATTER INSTANCES: the runtime half of scatterEditCore. It rides the Sculpt
// toolbox's Scatter brush (same session, lock, radius, strength), adding TOOLS beside Paint:
//
//   erase / rotate / scale / relax   brushes — one stroke = ONE undo entry + ONE commit
//                                    message, previews streamed ~5/s (terrainPaint's shape)
//   select                           click an instance (Shift/Ctrl adds), drag a box, Ctrl+A;
//                                    the gizmo moves / turns / scales the selection, and the
//                                    toolbox rotates, scales, deletes and re-rolls it
//
// "Affects" filters every tool to one model (a set) or all of them — the per-source erase.
//
// WIRE + UNDO + SAVE are the 1.38 ones verbatim: every op ends in `applyTerrainScatter`, the
// existing `objectParameters terrainScatter` message and a `terrainScatter` history entry
// (registered by terrainPaint), so peers, reload and undo need nothing new. HOW an edit is
// stored is scatterEditAdapter's business (51-sources' overrides + painted records since the
// 51 union), which is why nothing here touches the format.

/** @typedef {import('./scatterEditCore').Instance} Instance */
/** @typedef {'paint'|'erase'|'rotate'|'scale'|'relax'|'select'} ScatterTool */

/** which scatter tool is armed while the Sculpt brush is Scatter */
export const scatterTool = writable(/** @type {ScatterTool} */ ('paint'));
/** '' = every model on the terrain, else one set id: what the tools may touch */
export const scatterAffects = writable('');
/** rotate brush turns the other way, scale brush shrinks */
export const scatterBrushReverse = writable(false);
/** how many instances the select tool holds (the toolbox reads it) */
export const scatterSelectionCount = writable(0);
/** the gizmo's mode on the selection */
export const scatterGizmoMode = writable(/** @type {'translate'|'rotate'|'scale'} */ ('translate'));

const BRUSH_TOOLS = new Set(['erase', 'rotate', 'scale', 'relax']);
const PREVIEW_MS = 200;

/** @param {string} uuid */
function objectOf(uuid) {
	return /** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', uuid) ?? null;
}

/** @param {any} message */
function send(message) {
	/** @type {any} */
	const peer = get(peers);
	peer?.send?.(message);
}

/** @param {string} uuid */
function sendScatter(uuid) {
	send({ type: 'objectParameters', parameter: 'terrainScatter', uuid, terrainScatter: objectOf(uuid)?.userData?.terrainScatter ?? null });
}

/** @param {any} block */
const cloneBlock = (block) => (block ? JSON.parse(JSON.stringify(block)) : null);

/** the block this module last wrote (a different one arriving = someone else's edit / an undo) */
let lastWritten = /** @type {any} */ (null);

/** Apply `sets` locally (a preview). @param {string} uuid @param {any[]} sets @param {any} bounds */
function preview(uuid, sets, bounds) {
	applyTerrainScatter(uuid, blockOf(sets, bounds));
	lastWritten = objectOf(uuid)?.userData?.terrainScatter ?? null;
}

/** ONE commit: apply, send, ONE undo entry (nothing recorded when nothing changed).
 * @param {string} uuid @param {any} before the block before the op @param {any[]} sets @param {any} bounds */
function commit(uuid, before, sets, bounds) {
	preview(uuid, sets, bounds);
	const after = objectOf(uuid)?.userData?.terrainScatter ?? null;
	if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return false;
	sendScatter(uuid);
	recordEntry({ kind: 'terrainScatter', uuid, before: { block: before }, after: { block: cloneBlock(after) } });
	return true;
}

/** @param {any} object */
function editable(object) {
	if (!object?.userData?.terrain) {
		showToast('Scatter editing works on a Terrain');
		return false;
	}
	if (!canEditObject(object)) {
		warnViewerReadOnly();
		return false;
	}
	return true;
}

/** @param {{id: string}} set */
function affected(set) {
	const only = get(scatterAffects);
	return !only || set.id === only;
}

// ---- brushes ----------------------------------------------------------------------------

/** @type {{uuid: string, before: any, data: NonNullable<ReturnType<typeof readScatter>>, changed: boolean} | null} */
let stroke = null;
let lastPreviewAt = 0;

/** Is a brush tool armed (Scatter brush + erase/rotate/scale/relax)? terrainSculpt asks. */
export function scatterBrushArmed() {
	return BRUSH_TOOLS.has(get(scatterTool));
}

/** Is the select tool armed (Scatter brush, in a terrain sculpt session)? Scene asks before
 * it treats a press as a stroke. */
export function scatterSelectArmed() {
	return get(scatterTool) === 'select' && scatterOpOn();
}

/** @param {string} uuid */
export function beginEditStroke(uuid) {
	const object = objectOf(uuid);
	if (!editable(object)) return false;
	const data = readScatter(object);
	if (!data) return false;
	stroke = { uuid, before: cloneBlock(object.userData.terrainScatter ?? null), data, changed: false };
	return true;
}

/**
 * One brush application at a terrain-LOCAL (x, z), exported for the suite.
 * @param {string} uuid @param {number} x @param {number} z @param {number} radius
 * @param {number} strength @param {number} dt @returns {number} instances touched
 */
export function editBrushAt(uuid, x, z, radius, strength, dt = 0.016) {
	const st = stroke;
	if (!st || st.uuid !== uuid) return 0;
	const tool = get(scatterTool);
	const reverse = get(scatterBrushReverse);
	let touched = 0;
	for (const set of st.data.sets) {
		if (!affected(set)) continue;
		let result;
		if (tool === 'erase') result = eraseBrush(set.list, x, z, radius);
		else if (tool === 'rotate') result = rotateBrush(set.list, x, z, radius, strength, dt, reverse);
		else if (tool === 'scale') result = scaleBrush(set.list, x, z, radius, strength, dt, reverse);
		else if (tool === 'relax') result = relaxBrush(set.list, x, z, radius, strength, dt, st.data.bounds);
		else continue;
		if (!result.changed) continue;
		set.list = result.list;
		touched += result.changed;
	}
	if (touched) {
		st.changed = true;
		preview(uuid, st.data.sets, st.data.bounds);
	}
	return touched;
}

/** @param {string} uuid @param {number} x @param {number} z @param {number} radius @param {number} strength @param {number} dt */
export function editStrokeMove(uuid, x, z, radius, strength, dt) {
	if (!editBrushAt(uuid, x, z, radius, strength, dt)) return;
	const now = performance.now();
	if (now - lastPreviewAt > PREVIEW_MS) {
		lastPreviewAt = now;
		sendScatter(uuid);
	}
}

export function endEditStroke() {
	const st = stroke;
	stroke = null;
	if (!st || !st.changed) return;
	commit(st.uuid, st.before, st.data.sets, st.data.bounds);
}

/** True while a brush stroke is open (terrainSculpt's endStroke asks). */
export function editStrokeOpen() {
	return !!stroke;
}

// ---- the selection ----------------------------------------------------------------------

/** @type {{uuid: string, picks: Map<string, Set<number>>} | null} */
let sel = null;
/** @type {any} scene-root markers on the selected instances */
let marks = null;
/** @type {any} the gizmo's target */
let proxy = null;
/** @type {{x: number, y: number, add: boolean, moved: boolean} | null} */
let press = null;
/** @type {{data: NonNullable<ReturnType<typeof readScatter>>, before: any, local: any, yaw: number, pivot: {x: number, z: number}} | null} */
let drag = null;
let dragPreviewAt = 0;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

/** @type {WeakMap<any, {key: string, grid: any}>} */
const grids = new WeakMap();
/** The terrain's height grid, cached on its position attribute's identity + version. @param {any} terrain */
function gridOf(terrain) {
	const pos = terrain.geometry?.attributes?.position;
	if (!pos) return null;
	const key = pos.version + ':' + pos.count;
	const cached = grids.get(pos);
	if (cached && cached.key === key) return cached.grid;
	const grid = buildHeightGrid(pos.array);
	grids.set(pos, { key, grid });
	return grid;
}

/** World position of an instance's base. @param {any} terrain @param {Instance} inst @param {any} out */
function instanceWorld(terrain, inst, out) {
	const grid = gridOf(terrain);
	const y = grid ? sampleHeight(grid, inst.x, inst.z).y : 0;
	terrain.updateWorldMatrix(true, false);
	return out.set(inst.x, y, inst.z).applyMatrix4(terrain.matrixWorld);
}

function selectionTotal() {
	let n = 0;
	for (const ids of sel?.picks.values() ?? []) n += ids.size;
	return n;
}

/** The selection as [{set, ids}] against freshly read data (stale indices dropped).
 * @param {NonNullable<ReturnType<typeof readScatter>>} data */
function picksIn(data) {
	/** @type {{set: any, ids: Set<number>}[]} */
	const out = [];
	for (const set of data.sets) {
		const ids = sel?.picks.get(set.id);
		if (!ids?.size) continue;
		const valid = new Set([...ids].filter((i) => i < set.list.length));
		if (valid.size) out.push({ set, ids: valid });
	}
	return out;
}

/** Read-only view for the toolbox / suite: {setId: [indices]}. */
export function scatterSelection() {
	/** @type {Record<string, number[]>} */
	const out = {};
	for (const [id, ids] of sel?.picks ?? []) if (ids.size) out[id] = [...ids].sort((a, b) => a - b);
	return out;
}

/** Replace (or with `add`, toggle into) the selection. @param {string} uuid
 * @param {Map<string, Set<number>>} picks @param {boolean} [add] */
export function setScatterSelection(uuid, picks, add = false) {
	if (!sel || sel.uuid !== uuid || !add) sel = { uuid, picks: new Map() };
	// a selection is taken against the scatter AS IT IS NOW (after an undo or a peer's edit
	// too), so that block is the one a later change is measured against
	lastWritten = objectOf(uuid)?.userData?.terrainScatter ?? null;
	for (const [id, ids] of picks) {
		const cur = sel.picks.get(id) ?? new Set();
		for (const i of ids) {
			if (add && cur.has(i)) cur.delete(i);
			else cur.add(i);
		}
		sel.picks.set(id, cur);
	}
	refreshSelection();
}

export function clearScatterSelection() {
	sel = null;
	refreshSelection();
}

/** Re-draw the markers, re-seat the gizmo, publish the count. */
function refreshSelection() {
	const n = selectionTotal();
	scatterSelectionCount.set(n);
	drawMarks();
	seatGizmo();
	if (n && !unsubRevision) unsubRevision = sceneRevision.subscribe(onRevision);
}

/** @type {(() => void) | null} */
let unsubRevision = null;
/** Somebody else changed the scatter under the selection (an undo, a peer): indices no
 * longer name what was picked, so the selection is dropped rather than retargeted. */
function onRevision() {
	if (!sel) return;
	if (drag) return;
	const object = objectOf(sel.uuid);
	if (!object) return void endScatterEditSession();
	if ((object.userData?.terrainScatter ?? null) !== lastWritten) {
		sel = null;
		scatterSelectionCount.set(0);
		drawMarks();
		seatGizmo();
	} else drawMarks();
}

function drawMarks() {
	const scene = /** @type {any} */ (get(globalScene));
	const object = sel ? objectOf(sel.uuid) : null;
	const data = object ? readScatter(object) : null;
	const items = data ? picksIn(data) : [];
	const count = items.reduce((n, p) => n + p.ids.size, 0);
	if (!count || !scene) {
		if (marks) marks.visible = false;
		return;
	}
	if (!marks || marks.count < count) {
		if (marks) {
			marks.parent?.remove(marks);
			marks.dispose?.();
		}
		const geo = new THREE.RingGeometry(0.42, 0.5, 24).rotateX(-Math.PI / 2);
		const mat = new THREE.MeshBasicMaterial({ color: 0xffc44d, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide });
		marks = new THREE.InstancedMesh(geo, mat, Math.max(16, count * 2));
		marks.name = 'scatter-edit-marks';
		marks.renderOrder = 996;
		marks.frustumCulled = false;
	}
	if (marks.parent !== scene) scene.add(marks);
	let k = 0;
	for (const { set, ids } of items)
		for (const i of ids) {
			const inst = set.list[i];
			instanceWorld(object, inst, _v);
			_v.y += 0.03;
			const s = Math.max(0.4, inst.scale) * 1.2;
			marks.setMatrixAt(k++, _m.compose(_v, _q.identity(), new THREE.Vector3(s, s, s)));
		}
	marks.count = k;
	marks.instanceMatrix.needsUpdate = true;
	marks.visible = true;
}

// ---- picking ----------------------------------------------------------------------------

/** @param {number} clientX @param {number} clientY @param {any} camera */
function rayAt(clientX, clientY, camera) {
	const canvas = /** @type {any} */ (get(globalRenderer))?.domElement;
	const rect = canvas?.getBoundingClientRect?.();
	const ray = new THREE.Raycaster();
	if (!rect || !camera) return null;
	ray.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), camera);
	return ray;
}

/** The instance under a screen point: {setId, index} or null. Exported for the suite.
 * @param {string} uuid @param {number} clientX @param {number} clientY @param {any} camera */
export function pickInstanceAt(uuid, clientX, clientY, camera) {
	const object = objectOf(uuid);
	const holder = object ? scatterHolderOf(object) : null;
	const ray = rayAt(clientX, clientY, camera);
	if (!holder || !ray) return null;
	holder.updateMatrixWorld(true);
	const hits = ray.intersectObjects(holder.children, false);
	/** @type {ReturnType<typeof readScatter>} */
	let data = null;
	for (const hit of hits) {
		const ud = hit.object?.userData;
		if (!ud?.scatterSet || hit.instanceId == null) continue;
		if (get(scatterAffects) && ud.scatterSet !== get(scatterAffects)) continue;
		// 51-union: a mesh's slot i draws instance `instanceIds[i]` (thinning compacts and reorders
		// slots per device, a LOD cell holds a subset) — map it to its index in the set's list
		const id = ud.instanceIds?.[hit.instanceId];
		if (id == null) continue;
		data ??= readScatter(object);
		const set = data?.sets.find((s) => s.id === ud.scatterSet);
		const index = set ? indexOfInstance(set, id) : -1;
		if (index < 0) continue;
		return { setId: /** @type {string} */ (ud.scatterSet), index: /** @type {number} */ (index) };
	}
	return null;
}

/** Every instance whose base projects inside the screen rect. Exported for the suite.
 * @param {string} uuid @param {{x0: number, y0: number, x1: number, y1: number}} rect client px @param {any} camera */
export function instancesInScreenRect(uuid, rect, camera) {
	const object = objectOf(uuid);
	const data = object ? readScatter(object) : null;
	const canvas = /** @type {any} */ (get(globalRenderer))?.domElement;
	const box = canvas?.getBoundingClientRect?.();
	/** @type {Map<string, Set<number>>} */
	const out = new Map();
	if (!data || !box || !camera) return out;
	camera.updateMatrixWorld?.();
	for (const set of data.sets) {
		if (!affected(set)) continue;
		const projected = set.list.map((inst) => {
			instanceWorld(object, inst, _v).project(camera);
			return {
				sx: box.left + ((_v.x + 1) / 2) * box.width,
				sy: box.top + ((1 - _v.y) / 2) * box.height,
				visible: _v.z > -1 && _v.z < 1
			};
		});
		const ids = indicesInRect(projected, rect);
		if (ids.size) out.set(set.id, ids);
	}
	return out;
}

/** Select every (affected) instance on the terrain — Ctrl+A in the select tool. @param {string} uuid */
export function selectAllInstances(uuid) {
	const object = objectOf(uuid);
	const data = object ? readScatter(object) : null;
	if (!data) return 0;
	/** @type {Map<string, Set<number>>} */
	const picks = new Map();
	for (const set of data.sets) if (affected(set)) picks.set(set.id, new Set(set.list.map((_, i) => i)));
	setScatterSelection(uuid, picks);
	return selectionTotal();
}

/** Scene pointerdown in the select tool (a gizmo handle under the pointer is the gizmo's).
 * @param {string} uuid @param {PointerEvent} event */
export function scatterSelectDown(uuid, event) {
	press = { x: event.clientX, y: event.clientY, add: event.shiftKey || event.ctrlKey || event.metaKey, moved: false };
	if (!sel || sel.uuid !== uuid) sel = { uuid, picks: new Map() };
}

/** @param {PointerEvent} event */
export function scatterSelectMove(event) {
	if (!press) return;
	if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) press.moved = true;
	if (press.moved)
		marqueeRect.set({
			x0: Math.min(press.x, event.clientX),
			y0: Math.min(press.y, event.clientY),
			x1: Math.max(press.x, event.clientX),
			y1: Math.max(press.y, event.clientY)
		});
}

/** @param {string} uuid @param {PointerEvent} event @param {any} camera */
export function scatterSelectUp(uuid, event, camera) {
	const p = press;
	press = null;
	marqueeRect.set(null);
	if (!p) return;
	if (p.moved) {
		const picks = instancesInScreenRect(uuid, { x0: p.x, y0: p.y, x1: event.clientX, y1: event.clientY }, camera);
		if (p.add) {
			// a box with Shift ADDS (never toggles off what it sweeps)
			for (const [id, ids] of picks) for (const i of sel?.picks.get(id) ?? []) ids.delete(i);
		}
		setScatterSelection(uuid, picks, p.add);
		return;
	}
	const hit = pickInstanceAt(uuid, event.clientX, event.clientY, camera);
	if (!hit) {
		if (!p.add) clearScatterSelection();
		return;
	}
	setScatterSelection(uuid, new Map([[hit.setId, new Set([hit.index])]]), p.add);
}

// ---- the gizmo --------------------------------------------------------------------------

/** Seat (or drop) the gizmo on the selection. */
function seatGizmo() {
	/** @type {any} */
	const controls = get(TControls);
	const scene = /** @type {any} */ (get(globalScene));
	const object = sel ? objectOf(sel.uuid) : null;
	const data = object ? readScatter(object) : null;
	const items = data ? picksIn(data) : [];
	if (!items.length || !controls || !scene) {
		if (proxy && controls?.object === proxy) controls.detach();
		return;
	}
	if (!proxy) {
		proxy = new THREE.Object3D();
		proxy.name = 'scatter-edit-proxy';
		proxy.userData.isScatterProxy = true;
	}
	if (proxy.parent !== scene) scene.add(proxy);
	const c = pivotOf(items);
	instanceWorld(object, { x: c.x, z: c.z, yaw: 0, scale: 1 }, proxy.position);
	// one instance: the gizmo shows ITS turn; several: the group's frame
	const single = items.length === 1 && items[0].ids.size === 1 ? items[0].set.list[[...items[0].ids][0]] : null;
	object.updateWorldMatrix(true, false);
	object.getWorldQuaternion(proxy.quaternion);
	if (single) proxy.quaternion.multiply(_q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), single.yaw));
	proxy.scale.set(1, 1, 1);
	proxy.updateMatrixWorld(true);
	applyGizmoMode(controls);
	if (controls.object !== proxy) controls.attach(proxy);
}

/** @param {{set: any, ids: Set<number>}[]} items */
function pivotOf(items) {
	let x = 0;
	let z = 0;
	let n = 0;
	for (const { set, ids } of items) {
		const c = centroid(set.list, ids);
		if (!c) continue;
		x += c.x * ids.size;
		z += c.z * ids.size;
		n += ids.size;
	}
	return n ? { x: x / n, z: z / n } : { x: 0, z: 0 };
}

/** Height is the terrain's, so the gizmo offers only what an instance can do: slide on the
 * ground, turn about up, scale uniformly. @param {any} controls */
function applyGizmoMode(controls) {
	const mode = get(scatterGizmoMode);
	controls.setMode(mode);
	controls.showX = mode !== 'rotate';
	controls.showY = mode !== 'translate';
	controls.showZ = mode !== 'rotate';
}

/** The toolbox's Move / Rotate / Scale. @param {'translate'|'rotate'|'scale'} mode */
export function setScatterGizmoMode(mode) {
	scatterGizmoMode.set(mode);
	/** @type {any} */
	const controls = get(TControls);
	if (controls && proxy && controls.object === proxy) applyGizmoMode(controls);
}

/** Scene.svelte's `dragging-changed` while the proxy is attached. @param {boolean} dragging */
export function onScatterProxyDragChanged(dragging) {
	const object = sel ? objectOf(sel.uuid) : null;
	if (!object || !sel) return;
	if (dragging) {
		const data = readScatter(object);
		if (!data || !editable(object)) return;
		const items = picksIn(data);
		object.updateWorldMatrix(true, false);
		const local = object.worldToLocal(proxy.position.clone());
		drag = {
			data,
			before: cloneBlock(object.userData.terrainScatter ?? null),
			local,
			yaw: localYaw(object),
			pivot: pivotOf(items)
		};
		return;
	}
	const d = drag;
	drag = null;
	if (!d) return;
	const sets = transformed(object, d);
	commit(sel.uuid, d.before, sets, d.data.bounds);
	refreshSelection();
}

/** The proxy's turn about the terrain's up axis. @param {any} terrain */
function localYaw(terrain) {
	terrain.getWorldQuaternion(_q);
	const local = _q.invert().multiply(proxy.quaternion);
	return yawOfQuaternion(local);
}

/** The drag's lists: the drag-START lists moved by the proxy's change since then (absolute
 * from the snapshot, so a long drag cannot drift). @param {any} terrain @param {NonNullable<typeof drag>} d */
function transformed(terrain, d) {
	const now = terrain.worldToLocal(proxy.position.clone());
	const s = proxy.scale;
	// the axis handle that moved furthest decides the uniform factor
	const factor = [s.x, s.y, s.z].reduce((best, v) => (Math.abs(v - 1) > Math.abs(best - 1) ? v : best), 1);
	let dyaw = localYaw(terrain) - d.yaw;
	if (dyaw > Math.PI) dyaw -= Math.PI * 2;
	if (dyaw < -Math.PI) dyaw += Math.PI * 2;
	const t = { dx: now.x - d.local.x, dz: now.z - d.local.z, dyaw, factor: Math.max(0.01, factor), pivot: d.pivot };
	return d.data.sets.map((set) => {
		const ids = sel?.picks.get(set.id);
		if (!ids?.size) return set;
		return { ...set, list: transformGroup(set.list, ids, t) };
	});
}

/** Scene.svelte's gizmo `onchange` while the proxy is attached: preview the move. */
export function onScatterProxyMoved() {
	const object = sel ? objectOf(sel.uuid) : null;
	if (!object || !drag || !sel) return;
	const sets = transformed(object, drag);
	preview(sel.uuid, sets, drag.data.bounds);
	drawMarks();
	const now = performance.now();
	if (now - dragPreviewAt > PREVIEW_MS) {
		dragPreviewAt = now;
		sendScatter(sel.uuid);
	}
}

// ---- selection ops (the toolbox; each ONE undo entry) ----------------------------------

/** @param {(list: Instance[], ids: Set<number>) => Instance[]} op @returns {boolean} */
function onSelection(op) {
	const object = sel ? objectOf(sel.uuid) : null;
	if (!object || !sel || !editable(object)) return false;
	const data = readScatter(object);
	if (!data) return false;
	const before = cloneBlock(object.userData.terrainScatter ?? null);
	const sets = data.sets.map((set) => {
		const ids = sel?.picks.get(set.id);
		return ids?.size ? { ...set, list: op(set.list, new Set([...ids].filter((i) => i < set.list.length))) } : set;
	});
	const changed = commit(sel.uuid, before, sets, data.bounds);
	refreshSelection();
	return changed;
}

/** Turn every selected instance by `degrees` about its own up axis. @param {number} degrees */
export function rotateSelectedInstances(degrees) {
	return onSelection((list, ids) => rotateEach(list, ids, (degrees * Math.PI) / 180));
}

/** @param {number} factor */
export function scaleSelectedInstances(factor) {
	return onSelection((list, ids) => scaleEach(list, ids, factor));
}

/** New yaw + scale for the selection from the brush's own settings; everything else stays. */
export function rerollSelectedInstances() {
	const rng = rng32((Math.random() * 2 ** 32) >>> 0);
	const o = { scaleMin: get(scatterScaleMin), scaleMax: get(scatterScaleMax), randomRotation: get(scatterRandomRotation) };
	return onSelection((list, ids) => rerollSelected(list, ids, rng, o));
}

export function deleteSelectedInstances() {
	const object = sel ? objectOf(sel.uuid) : null;
	if (!object || !sel || !editable(object)) return 0;
	const data = readScatter(object);
	if (!data) return 0;
	const before = cloneBlock(object.userData.terrainScatter ?? null);
	let removed = 0;
	const sets = data.sets.map((set) => {
		const ids = sel?.picks.get(set.id);
		if (!ids?.size) return set;
		const { list } = deleteSelected(set.list, ids);
		removed += set.list.length - list.length;
		return { ...set, list };
	});
	commit(sel.uuid, before, sets, data.bounds);
	sel = null;
	refreshSelection();
	return removed;
}

/** The selected instances as [{set, list (all), ids}] — what convert-to-objects reads. */
export function selectedInstanceGroups() {
	const object = sel ? objectOf(sel.uuid) : null;
	const data = object ? readScatter(object) : null;
	return data ? { uuid: /** @type {string} */ (sel?.uuid), data, items: picksIn(data) } : null;
}

// ---- the session ------------------------------------------------------------------------

/** @param {KeyboardEvent} event */
function onKeydown(event) {
	if (!scatterSelectArmed()) return;
	if (!viewportHasKeys(event)) return; // a key in another pane is that pane's (36 U11)
	const consume = () => {
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	if ((event.key === 'Delete' || event.key === 'Backspace') && selectionTotal()) {
		consume();
		deleteSelectedInstances();
	} else if (event.key === 'Escape' && selectionTotal()) {
		// first Escape drops the selection, the next one leaves the Sculpt session
		consume();
		clearScatterSelection();
	} else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
		const uuid = sculptUuid();
		if (!uuid) return;
		consume();
		selectAllInstances(uuid);
	}
}

/** @type {() => string | null} */
let sculptUuid = () => null;
/** @type {() => boolean} */
let scatterOpOn = () => false;
let listening = false;

/** terrainSculpt hands over the session (its own stores, without an import cycle).
 * @param {() => string | null} uuidOf the terrain being sculpted @param {() => boolean} scatterOn the Scatter brush is armed */
export function startScatterEditSession(uuidOf, scatterOn) {
	sculptUuid = uuidOf;
	scatterOpOn = () => !!uuidOf() && scatterOn();
	if (!listening && typeof window !== 'undefined') {
		window.addEventListener('keydown', onKeydown, true);
		listening = true;
	}
}

/** Leave: commit a stroke in flight, drop the selection, the markers and the proxy. */
export function endScatterEditSession() {
	if (stroke) endEditStroke();
	sel = null;
	press = null;
	drag = null;
	scatterSelectionCount.set(0);
	unsubRevision?.();
	unsubRevision = null;
	if (marks) marks.visible = false;
	/** @type {any} */
	const controls = get(TControls);
	if (proxy) {
		if (controls?.object === proxy) controls.detach();
		proxy.parent?.remove(proxy);
		if (controls) controls.showX = controls.showY = controls.showZ = true;
	}
	if (listening && typeof window !== 'undefined') {
		window.removeEventListener('keydown', onKeydown, true);
		listening = false;
	}
	sculptUuid = () => null;
	scatterOpOn = () => false;
}

/** Arm a tool. Leaving Select drops its selection (the gizmo belongs to it). @param {ScatterTool} tool */
export function setScatterTool(tool) {
	if (tool !== 'select' && sel) clearScatterSelection();
	scatterTool.set(tool);
}

/** Debug / suite. */
export function scatterEditState() {
	return {
		tool: get(scatterTool),
		affects: get(scatterAffects),
		selection: scatterSelection(),
		count: selectionTotal(),
		gizmo: !!(proxy && /** @type {any} */ (get(TControls))?.object === proxy),
		stroke: !!stroke,
		total: (() => {
			const object = sel ? objectOf(sel.uuid) : null;
			const data = object ? readScatter(object) : null;
			return data ? totalOf(data.sets) : null;
		})()
	};
}
