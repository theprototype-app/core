// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, selectedObject, pokeScene } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordObjectPresence, recordEntry, registerHistoryKind, beginHistoryBatch, endHistoryBatch, historyBatchOpen } from './history';
import { normalizeMeasure, chainStats, formatLength } from './measureCore';

// 48 B2 — MEASUREMENTS ARE SCENE ITEMS, the way strokes and splines are (the user's words: "kept
// as an item in object list, similar to how its done for strokes"). This REPLACES 47's LOCAL,
// session-only pins.
//
// A kept measurement is an EMPTY Object3D named "Measurement" in objectsGroup, its chain on
// `userData.measure = {v, points}` in the OBJECT's local frame (the spline precedent: points
// re-seated around their centroid, so the gizmo pivot is sane and moving the item carries its
// dimension lines). An empty node has no geometry, so it needs no exclusion anywhere: no physics
// body (colliderSpec finds no box), nothing in an export's draw calls, nothing for the budget
// meter, and a hidden flag hides it like any object. What it is drawn as — lines, dots, labels —
// is scene-root decoration (MeasureOverlay) derived from the record on every peer.
//
// Everything rides EXISTING channels: creation is an `object` message (toJSON; sendObject routes
// a measurement through toJSON too, never the GLTF exporter) and a `create` undo entry; delete,
// rename, hide, move, save/load and the late-joiner sync are the object pipeline's. An EDIT of
// the points is the record only — `objectParameters` parameter `measure` + one `measure` history
// entry per edit — and every peer rebuilds the picture from it (golden rule 8).

/** @param {any} o */
export function isMeasurement(o) {
	return !!o && Array.isArray(o.userData?.measure?.points);
}

/** @param {string} uuid */
export function measurementOf(uuid) {
	const o = /** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', uuid);
	return isMeasurement(o) ? o : null;
}

/** Every measurement item in the scene (top level or inside groups). */
export function measurementItems() {
	/** @type {any[]} */
	const out = [];
	/** @type {any} */ (get(objectsGroup))?.traverse((/** @type {any} */ o) => {
		if (isMeasurement(o)) out.push(o);
	});
	return out;
}

const _v = new THREE.Vector3();

/** The item's chain in WORLD space (its own transform applied). @param {any} object */
export function worldPointsOf(object) {
	const rec = normalizeMeasure(object?.userData?.measure);
	if (!rec) return [];
	object.updateWorldMatrix(true, false);
	return rec.points.map((p) => _v.set(p[0], p[1], p[2]).applyMatrix4(object.matrixWorld).toArray());
}

/** WORLD points -> the item's local frame. @param {any} object @param {number[][]} world */
export function localPointsOf(object, world) {
	object.updateWorldMatrix(true, false);
	const inv = new THREE.Matrix4().copy(object.matrixWorld).invert();
	return world.map((p) => _v.set(p[0], p[1], p[2]).applyMatrix4(inv).toArray());
}

/** "Measurement · 2.000 m" for a chain — the row the Inspector and the object list read. @param {any} object */
export function measurementSummary(object) {
	const rec = normalizeMeasure(object?.userData?.measure);
	if (!rec) return '';
	const s = chainStats(rec.points.map((p) => _v.set(p[0], p[1], p[2]).multiply(object.scale).toArray()));
	return s.segments.length > 1 ? `Total ${formatLength(s.total)} · ${s.segments.length} segments` : formatLength(s.total);
}

/**
 * Keep a chain as a scene item: ONE object in objectsGroup, replicated + undoable exactly like
 * any created object. World points in (the tool resolves them in real space); null when there
 * is no chain to keep.
 * @param {number[][]} worldPoints @returns {any | null}
 */
export function createMeasurement(worldPoints) {
	const rec = normalizeMeasure({ points: worldPoints });
	const group = /** @type {any} */ (get(objectsGroup));
	if (!rec || !group) return null;
	// the chain lands in objectsGroup, which may sit under a grabbed/scaled world rig (the
	// stroke rule): convert, then re-seat around the centroid
	group.updateMatrixWorld(true);
	const local = rec.points.map((p) => group.worldToLocal(new THREE.Vector3(p[0], p[1], p[2])));
	const centre = local.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / local.length);
	const object = new THREE.Object3D();
	object.name = 'Measurement';
	object.position.copy(centre);
	object.userData.measure = { v: rec.v, points: local.map((p) => p.sub(centre).toArray()) };
	// toJSON writes `matrix`, which only the next RENDER composes from `position` — sent before
	// that, a peer would get the item at the origin (golden rule 10's restoreBase note)
	object.updateMatrix();
	group.add(object);
	pokeScene();
	recordObjectPresence('create', object);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'object', element: object.toJSON() });
	return object;
}

/**
 * THE ONE WRITE of a record (a local edit, undo/redo, a peer's message). Never sends.
 * @param {string} uuid @param {any} record @returns {boolean}
 */
export function applyMeasureEdit(uuid, record) {
	const object = measurementOf(uuid);
	const rec = normalizeMeasure(record);
	if (!object || !rec) return false;
	object.userData.measure = rec;
	pokeScene();
	selectedObject.update((v) => v); // the Inspector's Measurement rows
	return true;
}

/** @param {string} uuid @param {any} record */
function broadcastMeasure(uuid, record) {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'objectParameters', parameter: 'measure', uuid, measure: normalizeMeasure(record) });
}

/**
 * An edit: apply + broadcast + ONE undo entry holding both whole records (a chain is a handful of
 * numbers, the spline rule).
 * @param {string} uuid @param {any} before @param {any} after @returns {boolean}
 */
export function commitMeasureEdit(uuid, before, after) {
	const prev = normalizeMeasure(before);
	const next = normalizeMeasure(after);
	if (!next || !applyMeasureEdit(uuid, next)) return false;
	broadcastMeasure(uuid, next);
	if (prev && JSON.stringify(prev) !== JSON.stringify(next)) recordEntry({ kind: 'measure', uuid, before: prev, after: next });
	return true;
}

registerHistoryKind('measure', (entry, state) => {
	if (!applyMeasureEdit(entry.uuid, state)) {
		showToast('Cannot undo/redo: that measurement no longer exists');
		return false;
	}
	broadcastMeasure(entry.uuid, state);
	return true;
});

/** The remote applier (commandsHandler objectParameters 'measure'). @param {any} data */
export function applyRemoteMeasure(data) {
	return applyMeasureEdit(data.uuid, data.measure);
}

/** "Delete measurements": every measurement item, ONE undo entry, replicated. */
export async function deleteAllMeasurements() {
	const uuids = measurementItems().map((o) => o.uuid);
	if (!uuids.length) return 0;
	const { deleteObjectsByUuid } = await import('./objectActions');
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	deleteObjectsByUuid(uuids);
	if (own) endHistoryBatch('Delete measurements');
	showToast(`Deleted ${uuids.length} measurement${uuids.length === 1 ? '' : 's'} — Ctrl+Z brings them back`);
	return uuids.length;
}
