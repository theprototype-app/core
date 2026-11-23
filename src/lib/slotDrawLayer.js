// 105-slots: THE DRAW LAYER, the lazy half of slotDraw.js (read that header first). Loaded the first time a scene
// holds a slot list (slotDraw.js's scan) or by materialSlots.js / 105-slot-shaders, so a scene without slot lists
// pays nothing for it at boot. Holds the stand-ins, the delegation, the products, the park hook and the reconcile.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { registerParkHook } from './parkHooks.js';
import { slotIdsOf, slotOffOf } from './materialSlotsCore.js';
import { seated, ownOf } from './slotDraw.js';

/** own material -> its off stand-in (reused across syncs) @type {WeakMap<any, any>} */
const standIns = new WeakMap();
/** object -> Map<slotId, product material> (105-slot-shaders) @type {WeakMap<any, Map<string, any>>} */
const products = new WeakMap();
/** a seated entry's uuid before it took the slot's @type {WeakMap<any, string>} */
const originalUuid = new WeakMap();
/** objects that currently draw something other than their own materials @type {Set<any>} */
const layered = new Set();

/** The plain default an off slot draws. @returns {any} */
function plainDefault() {
	const m = new THREE.MeshStandardMaterial({ color: 0xbfbfbf, roughness: 0.85, metalness: 0 });
	m.name = 'slot-off';
	return m;
}

/** Seat `entry` in place of `own`: the delegation that keeps it out of every serializer. @param {any} entry @param {any} own */
function seat(entry, own) {
	seated.set(entry, own);
	// THE UUID TOO: Object3D.toJSON keys its material library by the ENTRY's uuid and the object refers to it by
	// that uuid, so an entry under its own uuid wrote the own material's JSON under a key nothing loads it by
	// (measured: delete + undo of an off slot came back with a hole in the list). A seated entry answers to the
	// slot's uuid; a product gets its own back when it is unseated.
	if (!originalUuid.has(entry)) originalUuid.set(entry, entry.uuid);
	entry.uuid = own.uuid;
	Object.defineProperty(entry, 'toJSON', {
		value: (/** @type {any} */ meta) => own.toJSON(meta),
		configurable: true,
		writable: true
	});
	Object.defineProperty(entry, 'clone', {
		value: () => own.clone(),
		configurable: true,
		writable: true
	});
}

/** Take the delegation off a product that is no longer seated (an off stand-in is simply dropped). @param {any} entry */
function unseat(entry) {
	if (!seated.has(entry)) return;
	seated.delete(entry);
	if (originalUuid.has(entry)) {
		entry.uuid = originalUuid.get(entry);
		originalUuid.delete(entry);
	}
	if (Object.prototype.hasOwnProperty.call(entry, 'toJSON')) delete entry.toJSON;
	if (Object.prototype.hasOwnProperty.call(entry, 'clone')) delete entry.clone;
}

/** @param {any} own */
function standInFor(own) {
	let stand = standIns.get(own);
	if (!stand) {
		stand = plainDefault();
		standIns.set(own, stand);
	}
	// the stand-in follows the slot's side (a double-sided leaf stays visible from behind)
	stand.side = own.side ?? THREE.FrontSide;
	if (seated.get(stand) !== own) seat(stand, own);
	return stand;
}

/**
 * What slot `index` should draw: off -> the plain default; a seated product -> it; else its own material.
 * @param {any} object @param {any} own @param {string} id
 */
function wantedFor(object, own, id) {
	if (slotOffOf(own)) return standInFor(own);
	const product = products.get(object)?.get(id);
	return product ?? own;
}

/**
 * Bring an object's drawn materials in line with its slots (off flags, products). Idempotent; call after any write
 * to an object's slot list. A single-material object draws its own material (off needs 2+ slots).
 * @param {any} object @returns {boolean} whether anything changed
 */
export function syncSlotDraw(object) {
	const list = object?.material;
	if (!list) return false;
	if (!Array.isArray(list)) {
		const own = ownOf(list);
		if (own === list) return false;
		object.material = own;
		layered.delete(object);
		return true;
	}
	const own = list.map(ownOf);
	const ids = slotIdsOf(own);
	let changed = false;
	let any = false;
	for (let i = 0; i < list.length; i++) {
		const want = list.length > 1 ? wantedFor(object, own[i], ids[i]) : own[i];
		if (want !== own[i]) {
			any = true;
			if (seated.get(want) !== own[i]) seat(want, own[i]);
		}
		if (list[i] !== want) {
			const before = list[i];
			list[i] = want;
			// a product that stopped drawing loses its delegation; an off stand-in keeps it (it is reused)
			if (before !== own[i] && standIns.get(own[i]) !== before) unseat(before);
			changed = true;
		}
	}
	if (any) layered.add(object);
	else layered.delete(object);
	if (changed) {
		for (const m of list) m.needsUpdate = true;
		pokeScene();
	}
	return changed;
}

/**
 * 105-slot-shaders: seat a compiled material in a slot (or take it off with null). The slot keeps its own material
 * as the truth; the product draws, and serializers see the own material. Off wins over a product.
 * @param {any} object @param {string} slotId @param {any | null} material
 */
export function setSlotProduct(object, slotId, material) {
	if (!object) return false;
	let map = products.get(object);
	const previous = map?.get(slotId) ?? null;
	if (material) {
		if (!map) products.set(object, (map = new Map()));
		map.set(slotId, material);
	} else map?.delete(slotId);
	if (previous && previous !== material && Array.isArray(object.material)) {
		const i = object.material.indexOf(previous);
		if (i >= 0) object.material[i] = ownOf(previous);
		unseat(previous);
	}
	syncSlotDraw(object);
	return true;
}

/** The product seated for a slot id, if any. @param {any} object @param {string} slotId */
export function slotProductOf(object, slotId) {
	return products.get(object)?.get(slotId) ?? null;
}

/**
 * What slot `index` draws right now, and why.
 * @param {any} object @param {number} index @returns {{material: any, kind: 'material' | 'off' | 'shader'} | null}
 */
export function slotDrawn(object, index) {
	const list = Array.isArray(object?.material)
		? object.material
		: object?.material
			? [object.material]
			: [];
	const entry = list[index];
	if (!entry) return null;
	const own = ownOf(entry);
	if (entry === own) return { material: entry, kind: 'material' };
	return { material: entry, kind: standIns.get(own) === entry ? 'off' : 'shader' };
}

// ---- the park ritual: every serializer that parks sees the own materials --------------------------------------
registerParkHook(() => {
	if (!layered.size) return null;
	/** @type {[any, any[]][]} */
	const parked = [];
	for (const object of layered) {
		if (!Array.isArray(object.material)) continue;
		const drawn = object.material.slice();
		for (let i = 0; i < object.material.length; i++) object.material[i] = ownOf(object.material[i]);
		parked.push([object, drawn]);
	}
	return () => {
		for (const [object, drawn] of parked) {
			if (!Array.isArray(object.material) || object.material.length !== drawn.length) continue;
			// only put back what the park itself took off (a write in between wins)
			for (let i = 0; i < drawn.length; i++)
				if (object.material[i] === ownOf(drawn[i])) object.material[i] = drawn[i];
		}
	};
});

// ---- the reconcile: a load, a peer's object, an undo rebuild materials without passing through here -----------
/**
 * Re-seat every multi-slot mesh in the scene. Cheap: one walk, and only arrays are looked at.
 * @returns {number} meshes changed
 */
export function reconcileSlotDraw() {
	let n = 0;
	for (const object of [...layered]) if (!object.parent) layered.delete(object);
	get(objectsGroup)?.traverse?.((/** @type {any} */ node) => {
		if (!node.isMesh || !Array.isArray(node.material)) return;
		const needs =
			layered.has(node) ||
			node.material.some((/** @type {any} */ m) => slotOffOf(ownOf(m)) || seated.has(m)) ||
			products.has(node);
		if (needs && syncSlotDraw(node)) n++;
	});
	return n;
}

/** test/debug view */
export function slotDrawDebug() {
	return { layered: layered.size };
}
