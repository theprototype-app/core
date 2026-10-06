import { get } from 'svelte/store';
import { objectsGroup, selectedObject, pokeScene } from '../../stores/sceneStore';
import { peers } from '../../stores/appStore';
import { recordEntry } from '../history';
import { safeStorage } from '../safeStorage';
import { normalizeWater } from './volumes.js';
import { normalizePour } from './pourDrops.js';
import {
	waterPreset,
	presetByKey,
	userPresetFrom,
	applyUserPreset,
	resolveBubbles,
	BUBBLE_DEFAULTS,
	STANDALONE_BUBBLES
} from './presets.js';
import { waterClock } from './waterRuntime.js';

// 36-water — the REPLICATING write path for water (W1: userData.water) and standalone
// bubble emitters (userData.bubbles). Same shape as particleActions: apply locally +
// `objectParameters` (no new message type) + ONE `props` undo entry. A slider drag edits
// locally per move, streams at most every 150 ms and commits ONE undo entry when it settles
// (`gesture`), so a scrub is one Ctrl+Z and not sixty.
//
// This module reaches history — waterRuntime / volumes must NEVER import it.

const STREAM_MS = 150;
const SETTLE_MS = 400;

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid);
}

function poke() {
	pokeScene();
	selectedObject.update((v) => v);
}

/** @param {any} v */
const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));

/** @param {string} uuid @param {'water'|'bubbles'|'pour'} key @param {any} value */
function send(uuid, key, value) {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'objectParameters', parameter: key, uuid, [key]: value ?? null });
}

/** @type {Map<string, {before: any, streamTimer: any, settleTimer: any, lastSent: number}>} */
const gestures = new Map();

/**
 * Write userData[key] now; replicate + record one undo entry, coalescing a burst of edits.
 * @param {string} uuid @param {'water'|'bubbles'|'pour'} key @param {any} value null = remove
 * @param {{immediate?: boolean}} [opts]
 */
function write(uuid, key, value, opts = {}) {
	const object = objectOf(uuid);
	if (!object) return false;
	const gk = uuid + ':' + key;
	let g = gestures.get(gk);
	if (!g) {
		g = {
			before: clone(object.userData[key] ?? null),
			streamTimer: null,
			settleTimer: null,
			lastSent: 0
		};
		gestures.set(gk, g);
	}
	if (value) object.userData[key] = value;
	else delete object.userData[key];
	poke();
	const commit = () => {
		const gg = gestures.get(gk);
		if (!gg) return;
		clearTimeout(gg.streamTimer);
		clearTimeout(gg.settleTimer);
		gestures.delete(gk);
		const o = objectOf(uuid);
		const after = clone(o?.userData[key] ?? null);
		send(uuid, key, after);
		if (JSON.stringify(gg.before) !== JSON.stringify(after))
			recordEntry({ kind: 'props', uuid, before: { [key]: gg.before }, after: { [key]: after } });
	};
	if (opts.immediate) {
		commit();
		return true;
	}
	const now = performance.now();
	clearTimeout(g.streamTimer);
	if (now - g.lastSent >= STREAM_MS) {
		g.lastSent = now;
		send(uuid, key, clone(value));
	} else {
		g.streamTimer = setTimeout(() => {
			const gg = gestures.get(gk);
			if (!gg) return;
			gg.lastSent = performance.now();
			send(uuid, key, clone(objectOf(uuid)?.userData[key] ?? null));
		}, STREAM_MS);
	}
	clearTimeout(g.settleTimer);
	g.settleTimer = setTimeout(commit, SETTLE_MS);
	return true;
}

/** Flush every pending gesture now (a test, or before a save). */
export function flushWaterEdits() {
	for (const [gk, g] of [...gestures]) {
		clearTimeout(g.settleTimer);
		const [uuid, key] = gk.split(':');
		gestures.delete(gk);
		const after = clone(objectOf(uuid)?.userData[key] ?? null);
		send(uuid, /** @type {any} */ (key), after);
		if (JSON.stringify(g.before) !== JSON.stringify(after))
			recordEntry({ kind: 'props', uuid, before: { [key]: g.before }, after: { [key]: after } });
	}
}

// ── water ─────────────────────────────────────────────────────────────────────────────

/**
 * Set (or clear with null) an object's whole water blob. Immediate by default — a preset
 * pick or an add is one discrete action.
 * @param {string} uuid @param {any} blob @param {{gesture?: boolean}} [opts]
 */
export function setObjectWater(uuid, blob, opts = {}) {
	const value = blob ? normalizeWater(blob) : null;
	return write(uuid, 'water', value, { immediate: !opts.gesture });
}

/**
 * Merge a patch into the object's water: top-level keys replace, `look`/`waves`/`bubbles`
 * merge one level deep. A gesture by default (sliders call this per move).
 * @param {string} uuid @param {any} patch @param {{immediate?: boolean}} [opts]
 */
export function updateObjectWater(uuid, patch, opts = {}) {
	const object = objectOf(uuid);
	if (!object?.userData.water) return false;
	const cur = normalizeWater(object.userData.water);
	const next = { ...cur, ...patch };
	for (const k of ['look', 'waves', 'bubbles']) if (patch[k]) next[k] = { ...cur[k], ...patch[k] };
	return write(uuid, 'water', normalizeWater(next), { immediate: !!opts.immediate });
}

/** Apply a built-in preset, keeping the object's shape + level. @param {string} uuid @param {string} key */
export function applyWaterPreset(uuid, key) {
	const object = objectOf(uuid);
	if (!object) return false;
	const cur = object.userData.water ? normalizeWater(object.userData.water) : null;
	const p = presetByKey(key);
	if (!p) return false;
	const blob = waterPreset(key, { shape: cur?.shape ?? p.shape });
	if (!blob) return false;
	if (cur) blob.level = cur.level;
	return setObjectWater(uuid, blob);
}

/** Remove the water (the object becomes a plain mesh again). @param {string} uuid */
export function removeObjectWater(uuid) {
	return setObjectWater(uuid, null);
}

/**
 * Bubble burst for every peer: the burst moment rides the blob (shared clock), so it
 * replicates through the same path and a late joiner sees nothing stale (the shader only
 * draws a burst for one bubble lifetime). @param {string} uuid
 */
export function burstWaterBubbles(uuid) {
	const object = objectOf(uuid);
	if (!object) return false;
	if (object.userData.water) {
		const cur = normalizeWater(object.userData.water);
		return updateObjectWater(
			uuid,
			{ bubbles: { ...cur.bubbles, enabled: true, mode: 'burst', burstAt: waterClock() } },
			{ immediate: true }
		);
	}
	if (object.userData.bubbles)
		return updateObjectBubbles(uuid, { mode: 'burst', burstAt: waterClock() }, { immediate: true });
	return false;
}

// ── standalone bubbles ────────────────────────────────────────────────────────────────

/** @param {string} uuid @param {any} config null = remove */
export function setObjectBubbles(uuid, config) {
	return write(uuid, 'bubbles', config ? { ...BUBBLE_DEFAULTS, ...STANDALONE_BUBBLES, enabled: true, ...config } : null, {
		immediate: true
	});
}

/** @param {string} uuid @param {any} patch @param {{immediate?: boolean}} [opts] */
export function updateObjectBubbles(uuid, patch, opts = {}) {
	const object = objectOf(uuid);
	if (!object?.userData.bubbles) return false;
	const next = resolveBubbles({ ...object.userData.bubbles, ...patch });
	return write(uuid, 'bubbles', next, { immediate: !!opts.immediate });
}

// ── 36-fb-water F17: pour emitters (userData.pour, any object) ────────────────────────────

/** where a pour leaves a WATER object (a tank/pool): over the rim of its +X side, outward */
const RIM_SPOUT = Object.freeze({ at: [1.02, 0.97, 0.5], dir: [1, 0.25, 0] });

/**
 * Add (config) or remove (null) a pour emitter. On a water volume the spout starts on the rim.
 * @param {string} uuid @param {any} config
 */
export function setObjectPour(uuid, config) {
	const object = objectOf(uuid);
	if (!object) return false;
	const base = object.userData?.water ? RIM_SPOUT : {};
	return write(uuid, 'pour', config ? normalizePour({ ...base, ...config, enabled: config.enabled ?? true }) : null, { immediate: true });
}

/** @param {string} uuid @param {any} patch @param {{immediate?: boolean}} [opts] */
export function updateObjectPour(uuid, patch, opts = {}) {
	const object = objectOf(uuid);
	if (!object?.userData.pour) return false;
	return write(uuid, 'pour', normalizePour({ ...object.userData.pour, ...patch }), { immediate: !!opts.immediate });
}

/** Add ▸ Water ▸ Pour: a small spout marker that pours (the Bubbles marker's shape). @param {any} object */
export function makePour(object) {
	if (!object?.uuid) return null;
	/** @type {any} */
	const peer = get(peers);
	object.name = 'Pour';
	if (peer) peer.send({ type: 'name', uuid: object.uuid, name: object.name });
	object.castShadow = false;
	object.userData.shadow = false;
	if (peer) peer.send({ type: 'objectParameters', parameter: 'castShadow', uuid: object.uuid, castShadow: false });
	delete object.userData.physics;
	if (peer) peer.send({ type: 'objectParameters', parameter: 'physics', uuid: object.uuid, physics: null });
	object.userData.pour = normalizePour({});
	send(object.uuid, 'pour', clone(object.userData.pour));
	poke();
	return object;
}

// ── user presets (LOCAL library; the BLOB they produce replicates like any edit) ──────

const USER_KEY = 'water:userPresets';

/** @returns {{name: string, water: any}[]} */
export function userWaterPresets() {
	try {
		const raw = safeStorage.getItem(USER_KEY);
		const list = raw ? JSON.parse(raw) : [];
		return Array.isArray(list)
			? list.filter((r) => r && typeof r.name === 'string' && r.water)
			: [];
	} catch {
		return [];
	}
}

/** @param {{name: string, water: any}[]} list */
function storeUserPresets(list) {
	try {
		safeStorage.setItem(USER_KEY, JSON.stringify(list.slice(0, 50)));
	} catch {}
}

/** "Save as preset": the object's look/waves/bubbles under a name (same name replaces). @param {string} uuid @param {string} name */
export function saveWaterPreset(uuid, name) {
	const object = objectOf(uuid);
	const clean = String(name ?? '').trim();
	if (!object?.userData.water || !clean) return null;
	const record = userPresetFrom(clean, normalizeWater(object.userData.water));
	const list = userWaterPresets().filter((r) => r.name !== record.name);
	list.push(record);
	storeUserPresets(list);
	return record;
}

/** @param {string} name */
export function deleteWaterPreset(name) {
	storeUserPresets(userWaterPresets().filter((r) => r.name !== name));
}

/** @param {string} uuid @param {string} name */
export function applyUserWaterPreset(uuid, name) {
	const object = objectOf(uuid);
	const record = userWaterPresets().find((r) => r.name === name);
	if (!object || !record) return false;
	const cur = normalizeWater(object.userData.water ?? waterPreset('pool'));
	return setObjectWater(uuid, applyUserPreset(record, cur));
}

// ── Create → Water ─────────────────────────────────────────────────────────────────────

/**
 * The Create menu's water kinds: the replicated /create command that makes the container,
 * its name, the preset and the volume shape. An ocean is a wide thin box whose shape is
 * `plane` (no floor: depth grows without limit below the surface).
 */
export const WATER_KINDS = [
	{
		key: 'tank',
		label: 'Water tank',
		command: '/create Box 2 1.2 1',
		preset: 'aquarium',
		shape: 'box'
	},
	{ key: 'pool', label: 'Pool', command: '/create Box 6 1.5 4', preset: 'pool', shape: 'box' },
	{ key: 'ocean', label: 'Ocean', command: '/create Box 80 2 80', preset: 'ocean', shape: 'plane' },
	{
		key: 'cylinder',
		label: 'Round pool',
		command: '/create Cylinder 1.5 1.5 1.2',
		preset: 'pool',
		shape: 'cylinder'
	}
];

/**
 * Turn a just-created object into water of `kind`: name, the preset blob, and a STATIC
 * SENSOR body (bodies fall in — buoyancy is 36-sim's — and it never becomes the solid
 * wall every top-level object would otherwise be). The create entry owns the undo of all
 * of it, as for a particle emitter marker. @param {any} object @param {string} kindKey
 */
export function makeWater(object, kindKey) {
	const kind = WATER_KINDS.find((k) => k.key === kindKey) ?? WATER_KINDS[0];
	if (!object?.uuid) return null;
	/** @type {any} */
	const peer = get(peers);
	object.name = kind.label;
	if (peer) peer.send({ type: 'name', uuid: object.uuid, name: object.name });
	object.castShadow = false;
	object.userData.shadow = false;
	if (peer)
		peer.send({
			type: 'objectParameters',
			parameter: 'castShadow',
			uuid: object.uuid,
			castShadow: false
		});
	object.userData.physics = { mode: 'static', sensor: true };
	if (peer)
		peer.send({
			type: 'objectParameters',
			parameter: 'physics',
			uuid: object.uuid,
			physics: object.userData.physics
		});
	const blob = waterPreset(kind.preset, { shape: kind.shape });
	object.userData.water = normalizeWater(blob);
	send(object.uuid, 'water', clone(object.userData.water));
	poke();
	return object;
}

/** A standalone bubble emitter marker. @param {any} object */
export function makeBubbles(object) {
	if (!object?.uuid) return null;
	/** @type {any} */
	const peer = get(peers);
	object.name = 'Bubbles';
	if (peer) peer.send({ type: 'name', uuid: object.uuid, name: object.name });
	object.castShadow = false;
	object.userData.shadow = false;
	if (peer)
		peer.send({
			type: 'objectParameters',
			parameter: 'castShadow',
			uuid: object.uuid,
			castShadow: false
		});
	delete object.userData.physics;
	if (peer)
		peer.send({ type: 'objectParameters', parameter: 'physics', uuid: object.uuid, physics: null });
	object.userData.bubbles = { ...BUBBLE_DEFAULTS, ...STANDALONE_BUBBLES, enabled: true, spread: 0.3 };
	send(object.uuid, 'bubbles', clone(object.userData.bubbles));
	poke();
	return object;
}
