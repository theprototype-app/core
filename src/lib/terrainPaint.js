import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordEntry, registerHistoryKind } from './history';
import { canEditObject, warnViewerReadOnly } from './objectPermissions';
import { createSplat, paintSplatAt, normalizeLayers, base64ToBytes, bytesToBase64, SPLAT_RES } from './terrainPaintCore';
import {
	normalizeScatter,
	decodeInstances,
	encodeInstances,
	scatterInCircle,
	eraseInCircle,
	sourceKey,
	MAX_INSTANCES,
	MAX_SETS
} from './terrainScatterCore';
import {
	liveSplat,
	splatBytesChanged,
	applyTerrainSplat,
	applyTerrainLayers,
	applyTerrainScatter,
	terrainBounds
} from './terrainSurface';

// 47 T1 + T2 — THE WRITE SIDE of terrain paint and scatter: the brushes, their strokes,
// the undo kinds and the wire. The sculpt stroke pattern verbatim (terrainSculpt.js):
// the session SELECTS the terrain (selection = lock, so no second painter), a stroke streams
// throttled PREVIEWS (~5/s) and ends in ONE commit message + ONE undo entry. Radius and
// strength are the sculpt brush's own stores; terrainSculpt dispatches its stroke calls here
// when the op is 'paint' or 'scatter'.
//
// WIRE: the existing `objectParameters` message, three new parameters (absent = an older
// peer ignores them):  terrainSplat {res, bytes: ArrayBuffer | null}  (raw bytes — the
// meshgeo rule: never a 64k-element number array on binarypack) · terrainLayers
// {terrainLayers} · terrainScatter {terrainScatter}. A preview and a commit are the same
// message; only the commit records history.

/** paint: which of the four layers the brush lays down (0..3) */
export const paintLayer = writable(1);
/** scatter: the source the brush paints — a primitive or a Library model by hash */
export const scatterSource = writable(/** @type {any} */ ({ kind: 'primitive', type: 'Cone' }));
/** instances per m² */
export const scatterDensity = writable(0.5);
export const scatterScaleMin = writable(0.8);
export const scatterScaleMax = writable(1.2);
export const scatterRandomRotation = writable(true);
export const scatterAlign = writable(false);
/** 48 B1: the collider a NEW set starts with ('none' | 'box' | 'sphere' | 'hull'). Only a new set
 * takes it — an existing set keeps the one Properties ▸ Scatter gave it, so painting more rocks
 * never strips a collider the author chose. */
export const scatterCollider = writable('none');
/** true = the brush removes the active source's instances */
export const scatterErase = writable(false);

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

/** @param {string} uuid @param {Uint8Array | null} bytes @param {number} res */
function sendSplat(uuid, bytes, res) {
	// a COPY: the live buffer keeps changing under the brush while the wire serializes it
	send({ type: 'objectParameters', parameter: 'terrainSplat', uuid, res, bytes: bytes ? bytes.slice().buffer : null });
}

/** @param {any} object */
function writable_(object) {
	if (!object?.userData?.terrain) {
		showToast('Paint and scatter work on a Terrain');
		return false;
	}
	if (!canEditObject(object)) {
		warnViewerReadOnly();
		return false;
	}
	return true;
}

// ---- paint -----------------------------------------------------------------------------

/** @type {{uuid: string, before: Uint8Array | null, res: number, changed: boolean} | null} */
let paintStroke = null;
let lastPaintPreview = 0;

/** @param {string} uuid */
export function beginPaintStroke(uuid) {
	const object = objectOf(uuid);
	if (!writable_(object)) return false;
	let s = liveSplat(object);
	const before = s ? s.bytes.slice() : null;
	if (!s) {
		// the first stroke on an unpainted terrain creates its map (100 % layer 0, which is
		// "the material" by default — nothing changes on screen until the brush lands)
		applyTerrainSplat(uuid, createSplat(SPLAT_RES), SPLAT_RES);
		s = liveSplat(object);
	}
	if (!s) return false;
	paintStroke = { uuid, before, res: s.res, changed: false };
	return true;
}

/**
 * One paint application at a LOCAL (x, z), exported for the suite (the sculpt applyBrushAt
 * shape). @param {string} uuid @param {number} x @param {number} z @param {number} layer
 * @param {number} radius metres @param {number} strength 0..1 @param {number} [dt]
 */
export function paintAt(uuid, x, z, layer, radius, strength, dt = 0.016) {
	const object = objectOf(uuid);
	const s = object ? liveSplat(object) : null;
	const b = object ? terrainBounds(object) : null;
	if (!s || !b) return false;
	const dirty = paintSplatAt(s.bytes, s.res, (x - b.minX) / b.sizeX, (z - b.minZ) / b.sizeZ, radius / b.sizeX, layer, strength, dt);
	if (!dirty) return false;
	splatBytesChanged(object);
	return true;
}

/** @param {string} uuid @param {number} x @param {number} z @param {number} dt
 * @param {number} radius @param {number} strength */
export function paintStrokeMove(uuid, x, z, dt, radius, strength) {
	if (!paintStroke || paintStroke.uuid !== uuid) return;
	if (!paintAt(uuid, x, z, get(paintLayer), radius, strength, dt)) return;
	paintStroke.changed = true;
	const now = performance.now();
	if (now - lastPaintPreview > PREVIEW_MS) {
		lastPaintPreview = now;
		const s = liveSplat(objectOf(uuid));
		if (s) sendSplat(uuid, s.bytes, s.res);
	}
}

/** Stroke end: ONE commit (the block re-encoded + sent) and ONE undo entry. */
export function endPaintStroke() {
	const stroke = paintStroke;
	paintStroke = null;
	if (!stroke) return;
	const object = objectOf(stroke.uuid);
	const s = object ? liveSplat(object) : null;
	if (!s) return;
	if (!stroke.changed) {
		// a click that painted nothing: an unpainted terrain stays unpainted
		if (!stroke.before) applyTerrainSplat(stroke.uuid, null);
		return;
	}
	const after = s.bytes.slice();
	applyTerrainSplat(stroke.uuid, s.bytes, s.res);
	sendSplat(stroke.uuid, after, s.res);
	recordEntry({ kind: 'terrainSplat', uuid: stroke.uuid, before: { bytes: stroke.before, res: stroke.res }, after: { bytes: after, res: s.res } });
}

registerHistoryKind('terrainSplat', (entry, state) => {
	if (!objectOf(entry.uuid)) {
		showToast('Cannot undo/redo: the terrain no longer exists');
		return false;
	}
	const bytes = state.bytes ? state.bytes.slice() : null;
	applyTerrainSplat(entry.uuid, bytes, state.res);
	sendSplat(entry.uuid, bytes, state.res);
	return true;
});

/** The stored layers (always four, normalized). @param {string} uuid */
export function layersOf(uuid) {
	return normalizeLayers(objectOf(uuid)?.userData?.terrainLayers);
}

/**
 * THE ONE WRITE PATH for a terrain's layers (Inspector): apply, ONE undo entry, ONE message.
 * A gesture (a tiling scrub) previews with `{record: false, send: false}` and commits with
 * `{before}` on release — one entry and one message per drag.
 * @param {string} uuid @param {any} layers @param {{before?: any, record?: boolean, send?: boolean}} [opts]
 */
export function setTerrainLayers(uuid, layers, opts = {}) {
	const object = objectOf(uuid);
	if (!object) return false;
	if (!canEditObject(object)) {
		warnViewerReadOnly();
		return false;
	}
	const before = opts.before !== undefined ? opts.before : object.userData.terrainLayers ?? null;
	const next = layers ? normalizeLayers(layers) : null;
	applyTerrainLayers(uuid, next);
	if (opts.send !== false) send({ type: 'objectParameters', parameter: 'terrainLayers', uuid, terrainLayers: next });
	if (opts.record !== false && JSON.stringify(before) !== JSON.stringify(next))
		recordEntry({ kind: 'terrainLayers', uuid, before: { layers: before }, after: { layers: next } });
	return true;
}

registerHistoryKind('terrainLayers', (entry, state) => {
	if (!objectOf(entry.uuid)) return false;
	applyTerrainLayers(entry.uuid, state.layers);
	send({ type: 'objectParameters', parameter: 'terrainLayers', uuid: entry.uuid, terrainLayers: state.layers ?? null });
	return true;
});

/** Remove the paint entirely (Inspector "Clear paint"): one undo entry. @param {string} uuid */
export function clearTerrainPaint(uuid) {
	const object = objectOf(uuid);
	const s = object ? liveSplat(object) : null;
	if (!s || !canEditObject(object)) return false;
	const before = s.bytes.slice();
	const res = s.res;
	applyTerrainSplat(uuid, null);
	sendSplat(uuid, null, res);
	recordEntry({ kind: 'terrainSplat', uuid, before: { bytes: before, res }, after: { bytes: null, res } });
	return true;
}

// ---- scatter ----------------------------------------------------------------------------

/** @type {{uuid: string, before: any, key: string, list: any[], set: any, others: any[], changed: boolean, seed: number} | null} */
let scatterStroke = null;
let lastScatterPreview = 0;

/** @param {any} object */
function scatterBlockOf(object) {
	return normalizeScatter(object?.userData?.terrainScatter, base64ToBytes);
}

/** @param {string} uuid */
export function beginScatterStroke(uuid) {
	const object = objectOf(uuid);
	if (!writable_(object)) return false;
	const b = terrainBounds(object);
	if (!b) return false;
	const block = scatterBlockOf(object);
	const source = get(scatterSource);
	const key = sourceKey(source);
	if (!key) {
		showToast('Pick a model or primitive to scatter');
		return false;
	}
	const sets = block?.sets ?? [];
	const set = sets.find((s) => sourceKey(s.source) === key) ?? null;
	if (!set && sets.length >= MAX_SETS && !get(scatterErase)) {
		showToast('A terrain holds up to ' + MAX_SETS + ' scatter models');
		return false;
	}
	scatterStroke = {
		uuid,
		before: block && block.sets.length ? block : null,
		key,
		list: set ? decodeInstances(/** @type {Uint8Array} */ (base64ToBytes(set.data)), b) : [],
		// the align toggle is a property of the SET (heights are derived at render time), so
		// the brush's current setting re-stamps it
		set: { ...(set ?? { id: key, source, data: '', count: 0, collider: get(scatterCollider) }), align: get(scatterAlign) },
		others: sets.filter((s) => s !== set),
		changed: false,
		seed: (Math.random() * 2 ** 32) >>> 0
	};
	return true;
}

/** The block the stroke has built so far. @param {NonNullable<typeof scatterStroke>} st @param {any} b */
function strokeBlock(st, b) {
	const sets = [...st.others];
	if (st.list.length) sets.push({ ...st.set, data: bytesToBase64(encodeInstances(st.list, b)), count: st.list.length });
	return sets.length ? { v: 1, sets } : null;
}

/** A tiny seeded rng per stroke (Math.random would do; a seed makes a suite replayable). */
function strokeRng() {
	const st = /** @type {any} */ (scatterStroke);
	return () => {
		st.seed = (st.seed + 0x6d2b79f5) >>> 0;
		let t = st.seed;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * One scatter application at a LOCAL (x, z), exported for the suite. Paint adds up to the
 * density inside the circle; erase removes the active source's instances in it.
 * @param {string} uuid @param {number} x @param {number} z @param {number} radius
 * @returns {number} instances added (negative = removed)
 */
export function scatterAt(uuid, x, z, radius) {
	const st = scatterStroke;
	const object = objectOf(uuid);
	const b = object ? terrainBounds(object) : null;
	if (!st || st.uuid !== uuid || !b) return 0;
	let delta = 0;
	if (get(scatterErase)) {
		const next = eraseInCircle(st.list, x, z, radius);
		delta = next.length - st.list.length;
		st.list = next;
	} else {
		const othersCount = st.others.reduce((sum, s) => sum + s.count, 0);
		const added = scatterInCircle(st.list, {
			cx: x,
			cz: z,
			radius,
			density: get(scatterDensity),
			scaleMin: get(scatterScaleMin),
			scaleMax: get(scatterScaleMax),
			randomRotation: get(scatterRandomRotation),
			bounds: b,
			rng: strokeRng(),
			room: MAX_INSTANCES - othersCount - st.list.length
		});
		st.list.push(...added);
		delta = added.length;
	}
	if (delta) {
		st.changed = true;
		applyTerrainScatter(uuid, strokeBlock(st, b));
	}
	return delta;
}

/** @param {string} uuid @param {number} x @param {number} z @param {number} radius */
export function scatterStrokeMove(uuid, x, z, radius) {
	if (!scatterAt(uuid, x, z, radius)) return;
	const now = performance.now();
	if (now - lastScatterPreview > PREVIEW_MS) {
		lastScatterPreview = now;
		send({ type: 'objectParameters', parameter: 'terrainScatter', uuid, terrainScatter: objectOf(uuid)?.userData?.terrainScatter ?? null });
	}
}

export function endScatterStroke() {
	const st = scatterStroke;
	scatterStroke = null;
	if (!st || !st.changed) return;
	const after = objectOf(st.uuid)?.userData?.terrainScatter ?? null;
	send({ type: 'objectParameters', parameter: 'terrainScatter', uuid: st.uuid, terrainScatter: after });
	recordEntry({ kind: 'terrainScatter', uuid: st.uuid, before: { block: st.before }, after: { block: after } });
}

registerHistoryKind('terrainScatter', (entry, state) => {
	if (!objectOf(entry.uuid)) {
		showToast('Cannot undo/redo: the terrain no longer exists');
		return false;
	}
	applyTerrainScatter(entry.uuid, state.block);
	send({ type: 'objectParameters', parameter: 'terrainScatter', uuid: entry.uuid, terrainScatter: state.block ?? null });
	return true;
});

/**
 * Inspector: change one set (align toggle) or remove it (`patch` null). One undo entry.
 * @param {string} uuid @param {string} setId @param {{align?: boolean, collider?: string} | null} patch
 */
export function editScatterSet(uuid, setId, patch) {
	const object = objectOf(uuid);
	if (!object || !canEditObject(object)) return false;
	const block = scatterBlockOf(object);
	if (!block) return false;
	const sets = patch ? block.sets.map((s) => (s.id === setId ? { ...s, ...patch } : s)) : block.sets.filter((s) => s.id !== setId);
	const next = sets.length ? { v: 1, sets } : null;
	applyTerrainScatter(uuid, next);
	const after = object.userData.terrainScatter ?? null;
	send({ type: 'objectParameters', parameter: 'terrainScatter', uuid, terrainScatter: after });
	recordEntry({ kind: 'terrainScatter', uuid, before: { block }, after: { block: after } });
	return true;
}

/** True while a paint or scatter stroke is open (terrainSculpt's endStroke asks). */
export function terrainStrokeOpen() {
	return !!(paintStroke || scatterStroke);
}

/** Debug / suite: the bytes of a terrain's splat, base64 (equal on two peers = in sync). @param {string} uuid */
export function splatDigest(uuid) {
	const s = liveSplat(objectOf(uuid));
	return s ? bytesToBase64(s.bytes) : null;
}
