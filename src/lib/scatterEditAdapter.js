// 51 E4/E5 — THE ONE PLACE 51-edit touches the scatter SET FORMAT (owner: 51-sources).
//
// Everything that edits instances (scatterEdit.js: picking, the gizmo, box select, the
// rotate/scale/relax/erase brushes, convert both ways) works on plain instance LISTS and
// reads and writes a terrain's scatter through the functions below (QUESTIONS-51-edit.md Q1):
//
//   readScatter(object)          -> {bounds, sets: [{id, source, align, collider, list, stored, base}]}
//   blockOf(sets, bounds)        -> the stored block (null = no scatter)
//   instanceIdOf(set, index)     -> the stable id an override is keyed by
//   newSet(source, list, extra)  -> a fresh set (convert-to-scatter)
//
// 51-union re-pointed it at 51-sources' format (params + seed + overrides, QUESTIONS-51-sources
// A1): a list is what the set DRAWS (terrainSurface.scatterSetInstances — overrides, masks and
// the shared cap applied), each entry carrying its string id ('g<k>' a generated slot, 'p<j>' a
// painted record). blockOf diffs each edited list against the one it was read as and writes the
// difference through `withOverrides` — a moved/turned/scaled slot becomes an override, a dropped
// one a `del`, a painted record is rewritten — so the seed, the fill params and every other set
// field ride through untouched. An entry with NO id (objects -> scatter) is a new painted record.
import {
	normalizeScatter,
	encodeInstances,
	withOverrides,
	blockVersion,
	sourceKey,
	MAX_INSTANCES,
	MAX_SETS
} from './terrainScatterCore';
import { base64ToBytes, bytesToBase64 } from './terrainPaintCore';
import { terrainBounds, scatterSetInstances } from './terrainSurface';
import { surfaceRecords } from './scatterSurfaceCore';

/** @typedef {import('./scatterEditCore').Instance & {id?: string, src?: number, tint?: number}} Instance */
/** @typedef {{id: string, source: any, align: boolean, collider?: string, sources?: {source: any, w: number}[],
 *   sink?: number, list: Instance[], stored?: any, base?: Map<string, Instance>}} EditSet */

export { MAX_INSTANCES, MAX_SETS, sourceKey };

/** A terrain's scatter as editable lists (null when it is not a terrain). @param {any} object
 * @returns {{bounds: {minX: number, minZ: number, sizeX: number, sizeZ: number}, sets: EditSet[]} | null} */
export function readScatter(object) {
	if (!object?.userData?.terrain) return null;
	const bounds = terrainBounds(object);
	if (!bounds) return null;
	const block = normalizeScatter(object.userData.terrainScatter, base64ToBytes);
	const sets = (block?.sets ?? []).map((s) => {
		/** @type {Instance[]} */
		const list = scatterSetInstances(object, s.id).map((/** @type {any} */ i) => ({ id: i.id, x: i.x, z: i.z, yaw: i.yaw, scale: i.scale, src: i.src ?? 0, tint: i.tint }));
		return {
			id: s.id,
			source: s.source,
			align: s.align,
			...(s.collider ? { collider: s.collider } : {}),
			...(s.sources ? { sources: s.sources } : {}),
			...(s.sink ? { sink: s.sink } : {}),
			list,
			stored: s,
			base: new Map(list.map((i) => [/** @type {string} */ (i.id), i]))
		};
	});
	return { bounds, sets };
}

const POSE = /** @type {const} */ (['x', 'z', 'yaw', 'scale']);

/** One stored set written back from its edited list. @param {EditSet} s @param {any} bounds */
function storedOf(s, bounds) {
	const io = { bounds, decode: base64ToBytes, encode: bytesToBase64, records: surfaceRecords };
	if (!s.stored) {
		// a NEW set (objects -> scatter): every instance a painted record
		return { id: s.id, source: s.source, align: !!s.align, data: bytesToBase64(encodeInstances(s.list, bounds)), count: s.list.length, ...(s.collider && s.collider !== 'none' ? { collider: s.collider } : {}) };
	}
	/** @type {Record<string, any>} */
	const patch = {};
	const seen = new Set();
	/** @type {Instance[]} */
	const added = [];
	for (const inst of s.list) {
		const was = inst.id ? s.base?.get(inst.id) : null;
		if (!was) {
			added.push(inst);
			continue;
		}
		seen.add(inst.id);
		/** @type {Record<string, number>} */
		const edit = {};
		for (const k of POSE) if (inst[k] !== was[k]) edit[k] = inst[k];
		if (Object.keys(edit).length) patch[/** @type {string} */ (inst.id)] = edit;
	}
	for (const id of s.base?.keys() ?? []) if (!seen.has(id)) patch[id] = { del: true };
	let next = Object.keys(patch).length ? withOverrides(s.stored, patch, io) : s.stored;
	if (added.length) {
		// objects -> scatter into an existing set: appended painted records (source 0 of a mix)
		const old = next.count && next.data ? base64ToBytes(next.data) : null;
		const bytes = encodeInstances(added, bounds);
		const data = new Uint8Array((old?.length ?? 0) + bytes.length);
		if (old) data.set(old);
		data.set(bytes, old?.length ?? 0);
		next = { ...next, data: bytesToBase64(data), count: next.count + added.length };
		if (next.pick) {
			const pick = /** @type {Uint8Array} */ (base64ToBytes(next.pick));
			next.pick = bytesToBase64(new Uint8Array([...pick, ...new Array(added.length).fill(0)]));
		}
	}
	return next;
}

/** Lists back to the stored block. A set whose list was emptied is dropped (an erased-out model
 * leaves no row); no sets at all = null, which clears the block. @param {EditSet[]} sets @param {any} bounds */
export function blockOf(sets, bounds) {
	const out = [];
	for (const s of sets) {
		if (!s.list.length) continue;
		out.push(storedOf(s, bounds));
	}
	return out.length ? { v: blockVersion(out), sets: out } : null;
}

/** The id an instance's override is keyed by ('g<k>' / 'p<j>'). @param {EditSet} set @param {number} index */
export function instanceIdOf(set, index) {
	return set.list[index]?.id ?? null;
}

/** The list index drawing instance `id` (what picking maps `mesh.userData.instanceIds` through).
 * @param {EditSet} set @param {string} id */
export function indexOfInstance(set, id) {
	return set.list.findIndex((i) => i.id === id);
}

/** A new set holding `list` (convert-to-scatter). @param {any} source @param {Instance[]} list
 * @param {{align?: boolean, collider?: string}} [extra] @returns {EditSet} */
export function newSet(source, list, extra = {}) {
	return { id: sourceKey(source), source, align: !!extra.align, ...(extra.collider ? { collider: extra.collider } : {}), list };
}

/** Total instances across sets. @param {EditSet[]} sets */
export function totalOf(sets) {
	return sets.reduce((n, s) => n + s.list.length, 0);
}
