import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordEntry, registerHistoryKind } from './history';
import { canEditObject, warnViewerReadOnly } from './objectPermissions';
import { createSplat, paintSplatAt, normalizeLayers, base64ToBytes, bytesToBase64, SPLAT_RES, SPLAT_RES_CHOICES, resampleSplat } from './terrainPaintCore';
import {
	normalizeScatter,
	decodeInstances,
	encodeInstances,
	scatterInCircle,
	withOverrides,
	withSeed,
	withSourceAdded,
	withSourceRemoved,
	newSeed,
	pickSource,
	blockVersion,
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
	terrainBounds,
	surfaceOf,
	scatterSetInstances
} from './terrainSurface';
import { surfaceDab, eraseInSphere, triangleIndex, surfaceRecords } from './scatterSurfaceCore';

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

/** @param {any} object @param {boolean} [anyMesh] 51-surface: scatter works on ANY mesh, paint stays terrain-only */
function writable_(object, anyMesh = false) {
	if (!object?.userData?.terrain && !(anyMesh && isMeshHost(object))) {
		showToast(anyMesh ? 'Scatter works on a mesh object' : 'Paint and scatter work on a Terrain');
		return false;
	}
	if (!canEditObject(object)) {
		warnViewerReadOnly();
		return false;
	}
	return true;
}

/** 51-surface: a non-terrain object that can carry scatter — a mesh (its own triangles are the
 * surface) or a GROUP with meshes under it (a placed model: its children's surface, in its frame).
 * @param {any} object */
export function isMeshHost(object) {
	if (!object || object.userData?.terrain || object.isLight || object.isCamera) return false;
	if (object.isMesh) return !!object.geometry?.attributes?.position;
	let found = false;
	object.traverse?.((/** @type {any} */ m) => {
		if (!found && m !== object && m.isMesh && !m.isInstancedMesh && m.geometry?.attributes?.position) found = true;
	});
	return found;
}

/** the host's largest world scale — the brush ring is in world metres, the instances live in the
 * host's LOCAL frame @param {any} object */
function hostScale(object) {
	const e = object?.matrixWorld?.elements;
	if (!e) return 1;
	const s = Math.max(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10]));
	return s > 1e-6 ? s : 1;
}

/** object -> the brush's triangle grid over its surface (rebuilt with the surface) @type {WeakMap<any, {surface: any, index: any}>} */
const brushIndex = new WeakMap();
/** @param {any} object */
function brushIndexOf(object) {
	const surface = surfaceOf(object);
	if (!surface) return null;
	let entry = brushIndex.get(object);
	if (!entry || entry.surface !== surface) {
		entry = { surface, index: triangleIndex(surface) };
		brushIndex.set(object, entry);
	}
	return entry;
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

/**
 * 51 E4: PER-TERRAIN splat resolution (Inspector ▸ Terrain paint). A painted map is resampled
 * (weights re-normalised, coverage kept); an unpainted terrain gets a fresh map at that size,
 * all layer 1 — nothing changes on screen, the next stroke paints at the new detail. ONE undo
 * entry + ONE message, the `terrainSplat` kind and wire as they are.
 * @param {string} uuid @param {number} res one of SPLAT_RES_CHOICES
 */
export function setSplatResolution(uuid, res) {
	const object = objectOf(uuid);
	if (!object?.userData?.terrain || !SPLAT_RES_CHOICES.includes(res)) return false;
	if (!canEditObject(object)) {
		warnViewerReadOnly();
		return false;
	}
	const s = liveSplat(object);
	if (s && s.res === res) return false;
	const before = s ? { bytes: s.bytes.slice(), res: s.res } : { bytes: null, res: SPLAT_RES };
	const bytes = s ? resampleSplat(s.bytes, s.res, res) : createSplat(res);
	applyTerrainSplat(uuid, bytes, res);
	sendSplat(uuid, bytes, res);
	recordEntry({ kind: 'terrainSplat', uuid, before, after: { bytes: bytes.slice(), res } });
	return true;
}

/** The splat resolution a terrain paints at (its map's, else the default). @param {string} uuid */
export function splatResolutionOf(uuid) {
	return liveSplat(objectOf(uuid))?.res ?? SPLAT_RES;
}

// ---- scatter ----------------------------------------------------------------------------

/** @type {{uuid: string, before: any, key: string, list: any[], set: any, others: any[], changed: boolean, seed: number,
 *   generated: any[], erased: Set<string>, mesh?: boolean} | null} */
let scatterStroke = null;
let lastScatterPreview = 0;

/** @param {any} object */
function scatterBlockOf(object) {
	return normalizeScatter(object?.userData?.terrainScatter, base64ToBytes);
}

/** @param {string} uuid */
export function beginScatterStroke(uuid) {
	const object = objectOf(uuid);
	if (!writable_(object, true)) return false;
	const mesh = isMeshHost(object);
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
	const set = sets.find((s) => sourceKey(s.source) === key && !s.host === !mesh) ?? null;
	if (!set && sets.length >= MAX_SETS && !get(scatterErase)) {
		showToast('A terrain holds up to ' + MAX_SETS + ' scatter models');
		return false;
	}
	/** @type {any[]} */
	let list = [];
	if (set?.count) {
		// 51: a painted record keeps the source it picked (a mixed set) through every erase
		const pick = set.pick ? base64ToBytes(set.pick) : null;
		const bytes = /** @type {Uint8Array} */ (base64ToBytes(set.data));
		// 51-surface: a mesh host's records are 16 bytes (xyz + normal) over the set's stored box
		list = (mesh ? surfaceRecords.decode(bytes, set) : decodeInstances(bytes, b)).map((inst, j) => ({ ...inst, src: pick?.[j] ?? 0 }));
	}
	scatterStroke = {
		uuid,
		before: block && block.sets.length ? block : null,
		key,
		list,
		// the align toggle is a property of the SET (heights are derived at render time), so
		// the brush's current setting re-stamps it
		set: { ...(set ?? { id: key, source, data: '', count: 0, collider: get(scatterCollider), ...(mesh ? { host: 'mesh' } : {}) }), align: get(scatterAlign) },
		others: sets.filter((s) => s !== set),
		changed: false,
		seed: (Math.random() * 2 ** 32) >>> 0,
		// 51: the set's GENERATED instances count toward the brush's density (painting over a
		// filled patch adds nothing) and an erase deletes them as hand edits
		// (51-surface: read exactly as drawn — the fill's mask and the block's shared cap included)
		generated: set?.gen ? scatterSetInstances(object, set.id).filter((i) => i.slot != null) : [],
		erased: new Set(),
		mesh
	};
	return true;
}

/** The block the stroke has built so far. @param {NonNullable<typeof scatterStroke>} st @param {any} b */
function strokeBlock(st, b) {
	const sets = [...st.others];
	/** @type {any} */
	let set = { ...st.set, data: '', count: st.list.length };
	if (st.mesh) {
		const enc = surfaceRecords.encode(st.list);
		if (st.list.length) (set.data = bytesToBase64(enc.bytes)), (set.box = enc.box);
		else delete set.box;
	} else if (st.list.length) set.data = bytesToBase64(encodeInstances(st.list, b));
	if (set.sources && st.list.length) set.pick = bytesToBase64(new Uint8Array(st.list.map((i) => i.src ?? 0)));
	else delete set.pick;
	if (st.erased.size) {
		/** @type {Record<string, any>} */
		const patch = {};
		for (const id of st.erased) patch[id] = { del: true };
		set = withOverrides(set, patch, { bounds: b, decode: base64ToBytes, encode: bytesToBase64, records: surfaceRecords });
	}
	if (set.count || set.gen) sets.push(set);
	return sets.length ? { v: blockVersion(sets), sets } : null;
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
 * density inside the circle; erase removes the active source's instances in it (a generated
 * one becomes a deleted hand edit, so a re-roll does not bring it back).
 * 51-surface: on a MESH host the point is a local (x, y, z) on its surface and the brush is a sphere
 * (meshScatterAt); `y` is ignored on a terrain.
 * @param {string} uuid @param {number} x @param {number} z @param {number} radius @param {number} [y]
 * @returns {number} instances added (negative = removed)
 */
export function scatterAt(uuid, x, z, radius, y = 0) {
	const st = scatterStroke;
	const object = objectOf(uuid);
	const b = object ? terrainBounds(object) : null;
	if (!st || st.uuid !== uuid || !b) return 0;
	if (st.mesh) return meshScatterAt(st, object, b, x, y, z, radius);
	let delta = 0;
	if (get(scatterErase)) {
		const next = st.list.filter((p) => Math.hypot(p.x - x, p.z - z) > radius);
		delta = next.length - st.list.length;
		st.list = next;
		for (const g of st.generated)
			if (!st.erased.has(g.id) && Math.hypot(g.x - x, g.z - z) <= radius) {
				st.erased.add(g.id);
				delta--;
			}
	} else {
		const othersCount = st.others.reduce((sum, s) => sum + s.count + (s.gen?.count ?? 0), 0);
		const live = st.generated.filter((g) => !st.erased.has(g.id));
		const rng = strokeRng();
		const added = scatterInCircle([...st.list, ...live], {
			cx: x,
			cz: z,
			radius,
			density: get(scatterDensity),
			scaleMin: get(scatterScaleMin),
			scaleMax: get(scatterScaleMax),
			randomRotation: get(scatterRandomRotation),
			bounds: b,
			rng,
			room: MAX_INSTANCES - othersCount - st.list.length - live.length
		});
		// 51 E1: a mixed set's new instance draws its source by weight
		for (const inst of added) /** @type {any} */ (inst).src = pickSource(st.set.sources, rng());
		st.list.push(...added);
		delta = added.length;
	}
	if (delta) {
		st.changed = true;
		applyTerrainScatter(uuid, strokeBlock(st, b));
	}
	return delta;
}

/**
 * 51-surface: the brush on a mesh — a SPHERE around the surface point (local), its radius the ring's
 * world radius over the host's scale; paint fills the patch up to the density (what is already there,
 * painted or generated, counts), erase removes inside the sphere (a generated one = a deleted edit).
 * @param {NonNullable<typeof scatterStroke>} st @param {any} object @param {any} b
 * @param {number} x @param {number} y @param {number} z @param {number} worldRadius
 */
function meshScatterAt(st, object, b, x, y, z, worldRadius) {
	const radius = worldRadius / hostScale(object);
	const r2 = radius * radius;
	const inside = (/** @type {any} */ p) => (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2 <= r2;
	let delta = 0;
	if (get(scatterErase)) {
		const next = eraseInSphere(st.list, x, y, z, radius);
		delta = next.length - st.list.length;
		st.list = next;
		for (const g of st.generated)
			if (!st.erased.has(g.id) && inside(g)) {
				st.erased.add(g.id);
				delta--;
			}
	} else {
		const brush = brushIndexOf(object);
		if (!brush) return 0;
		const othersCount = st.others.reduce((sum, s) => sum + s.count + (s.gen?.count ?? 0), 0);
		const live = st.generated.filter((g) => !st.erased.has(g.id));
		const rng = strokeRng();
		const added = surfaceDab([...st.list, ...live], brush.surface, brush.index, {
			cx: x,
			cy: y,
			cz: z,
			radius,
			density: get(scatterDensity),
			scaleMin: get(scatterScaleMin),
			scaleMax: get(scatterScaleMax),
			randomRotation: get(scatterRandomRotation),
			rng,
			room: MAX_INSTANCES - othersCount - st.list.length - live.length,
			spacing: st.set.gen?.spacing
		});
		for (const inst of added) /** @type {any} */ (inst).src = pickSource(st.set.sources, rng());
		st.list.push(...added);
		delta = added.length;
	}
	if (delta) {
		st.changed = true;
		applyTerrainScatter(st.uuid, strokeBlock(st, b));
	}
	return delta;
}

/** @param {string} uuid @param {number} x @param {number} z @param {number} radius @param {number} [y] the mesh host's local y */
export function scatterStrokeMove(uuid, x, z, radius, y = 0) {
	if (!scatterAt(uuid, x, z, radius, y)) return;
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
 * THE ONE WRITE PATH for a terrain's scatter block outside a brush stroke: apply, send, ONE undo
 * entry. A gesture previews with `{record: false}` (and `{send: false}` while it streams faster
 * than the wire wants) and commits with `{before}` on release — one entry per drag.
 * @param {string} uuid @param {(block: {v: number, sets: any[]}) => any[] | null} edit returns the new sets (null = no change)
 * @param {{before?: any, record?: boolean, send?: boolean}} [opts]
 */
export function writeScatter(uuid, edit, opts = {}) {
	const object = objectOf(uuid);
	if (!object) return false;
	if (!canEditObject(object)) {
		warnViewerReadOnly();
		return false;
	}
	const block = scatterBlockOf(object) ?? { v: 1, sets: [] };
	const sets = edit(block);
	if (!sets) return false;
	const before = opts.before !== undefined ? opts.before : block.sets.length ? block : null;
	applyTerrainScatter(uuid, sets.length ? { v: blockVersion(sets), sets } : null);
	const after = object.userData.terrainScatter ?? null;
	if (opts.send !== false) send({ type: 'objectParameters', parameter: 'terrainScatter', uuid, terrainScatter: after });
	if (opts.record !== false && JSON.stringify(before) !== JSON.stringify(after))
		recordEntry({ kind: 'terrainScatter', uuid, before: { block: before }, after: { block: after } });
	return true;
}

/**
 * Inspector: change one set (align, collider, and since 51 any set field — gen, seed, sources,
 * tint, sink; a null value clears it) or remove it (`patch` null). One undo entry.
 * @param {string} uuid @param {string} setId @param {Record<string, any> | null} patch
 * @param {{before?: any, record?: boolean, send?: boolean}} [opts]
 */
export function editScatterSet(uuid, setId, patch, opts) {
	return writeScatter(
		uuid,
		(block) => {
			if (!block.sets.some((s) => s.id === setId)) return null;
			return patch ? block.sets.map((s) => (s.id === setId ? { ...s, ...patch } : s)) : block.sets.filter((s) => s.id !== setId);
		},
		opts
	);
}

/**
 * 51: hand edits on single instances — `patch` = {[id]: {x?, z?, yaw?, scale?, del?: true} | null}
 * (ids 'g<k>' / 'p<j>' from `scatterInstancesOf`; null clears a generated slot's edit). The
 * write path 51-edit's gizmo, box ops and brushes go through. One undo entry (see writeScatter).
 * @param {string} uuid @param {string} setId @param {Record<string, any>} patch
 * @param {{before?: any, record?: boolean, send?: boolean}} [opts]
 */
export function editScatterInstances(uuid, setId, patch, opts) {
	const b = terrainBounds(objectOf(uuid));
	if (!b) return false;
	return writeScatter(
		uuid,
		(block) => {
			const set = block.sets.find((s) => s.id === setId);
			if (!set) return null;
			const next = withOverrides(set, patch, { bounds: b, decode: base64ToBytes, encode: bytesToBase64, records: surfaceRecords });
			return block.sets.map((s) => (s === set ? next : s)).filter((s) => s.count || s.gen);
		},
		opts
	);
}

/** 51: re-roll a seeded set (a new seed; hand edits kept). @param {string} uuid @param {string} setId @param {number} [seed] */
export function rerollScatterSet(uuid, setId, seed = newSeed()) {
	const set = scatterBlockOf(objectOf(uuid))?.sets.find((s) => s.id === setId);
	if (!set?.gen) return false;
	return editScatterSet(uuid, setId, { seed: withSeed(set, seed).seed });
}

/**
 * 51: add a set (a seeded fill, or a source picked from a pack / prefab / the selection). The id
 * is made unique on this terrain; returns it (null when refused).
 * @param {string} uuid @param {Record<string, any>} set
 */
export function addScatterSet(uuid, set) {
	/** @type {string | null} */
	let id = null;
	// 51-surface: a set added to a non-terrain mesh lives on its triangles (and stands on their
	// normals unless asked otherwise — upright rocks on a sphere's side look wrong)
	const meshHost = isMeshHost(objectOf(uuid));
	if (!meshHost && !objectOf(uuid)?.userData?.terrain) {
		showToast('Scatter works on a mesh object');
		return null;
	}
	const ok = writeScatter(uuid, (block) => {
		if (block.sets.length >= MAX_SETS) {
			showToast((meshHost ? 'An object' : 'A terrain') + ' holds up to ' + MAX_SETS + ' scatter sets');
			return null;
		}
		const base = String(set.id || sourceKey(set.source) || 'set').slice(0, 34);
		id = base;
		for (let n = 2; block.sets.some((s) => s.id === id); n++) id = base + '~' + n;
		const next = {
			data: '',
			count: 0,
			align: meshHost,
			...set,
			id,
			...(meshHost ? { host: 'mesh' } : {}),
			...(set.gen && set.seed == null ? { seed: newSeed() } : {})
		};
		return [...block.sets, next];
	});
	return ok ? id : null;
}

/** @param {string} uuid @param {string} setId @param {(set: any, io: any) => any} fn one set, rewritten */
function rewriteSet(uuid, setId, fn) {
	const b = terrainBounds(objectOf(uuid));
	if (!b) return false;
	const io = { bounds: b, decode: base64ToBytes, encode: bytesToBase64, records: surfaceRecords };
	return writeScatter(uuid, (block) => {
		const set = block.sets.find((s) => s.id === setId);
		if (!set) return null;
		const next = fn(set, io);
		if (next === set) return null;
		return block.sets.map((s) => (s === set ? next : s)).filter((s) => s.count || s.gen);
	});
}

/** 51 E1: add a model to a set (it becomes a weighted mix). @param {string} uuid @param {string} setId @param {any} source @param {number} [w] */
export function addScatterSource(uuid, setId, source, w = 1) {
	return rewriteSet(uuid, setId, (set, io) => withSourceAdded(set, source, w, io));
}

/** 51 E1: drop model i from a mix (its painted instances go with it). @param {string} uuid @param {string} setId @param {number} i */
export function removeScatterSource(uuid, setId, i) {
	return rewriteSet(uuid, setId, (set, io) => withSourceRemoved(set, i, io));
}

/** 51 E1: one model's weight in a mix (a scrub previews with {record: false} and commits with {before}).
 * @param {string} uuid @param {string} setId @param {number} i @param {number} w @param {{before?: any, record?: boolean, send?: boolean}} [opts] */
export function setScatterSourceWeight(uuid, setId, i, w, opts) {
	const set = scatterBlockOf(objectOf(uuid))?.sets.find((s) => s.id === setId);
	if (!set?.sources?.[i]) return false;
	const sources = set.sources.map((e, k) => (k === i ? { ...e, w: Math.max(0.01, w) } : e));
	return editScatterSet(uuid, setId, { sources }, opts);
}

/** The block as it stands (a gesture's `before`). @param {string} uuid */
export function scatterBlockNow(uuid) {
	const block = scatterBlockOf(objectOf(uuid));
	return block?.sets.length ? block : null;
}

/** 51: every instance a terrain's set draws, with ids — what an edit tool reads.
 * @param {string} uuid @param {string} setId */
export function scatterInstancesOf(uuid, setId) {
	const object = objectOf(uuid);
	const b = terrainBounds(object);
	// 51-surface: the drawn list (a fill's mask, a mesh host's surface, the block's shared cap)
	return b ? scatterSetInstances(object, setId) : [];
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
