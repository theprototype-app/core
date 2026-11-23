// 105-slots: THE DRAW LAYER of a material slot — what a slot DRAWS can differ from what it IS.
//
// A slot is one entry of `object.material` (an array) + its `geometry.groups`; its own data rides its material
// (`material.name`, `material.userData.slot = { id, off }`). Two things draw something else in a slot's place:
// "off" (the plain default material, owner fork 2a) and a seated product (105-slot-shaders: a compiled shader). Both
// are a per-slot SWAP of the array entry, and the slot's own material stays the truth:
//
// - `ownOf(entry)` answers the slot's own material for whatever is seated, so `materialsOf` (materialsHandler) and
//   every edit, payload and Inspector row read the real material, never the stand-in.
// - A seated entry DELEGATES `toJSON` and `clone` to the slot's own material. That is what keeps the swap out of every
//   serializer, including the ones that do not park (the undo snapshot of a delete, a prefab, a duplicate's clone):
//   they all write / copy the slot's own material, with its off flag, so nothing can save the default by accident.
// - The park ritual (`parkAnimatedAtBase` -> parkHooks) puts the own materials back for the readers that do not go
//   through toJSON (the glTF exporter reads properties): an export writes an off slot's own material.
// - A debounced reconcile re-seats after anything rebuilds an object's materials (a load, a peer, undo).
//
// Off is scene data (it rides the material, so it replicates and saves); a peer on the previous release keeps the
// field and draws the slot's own material. One stand-in instance per off slot, each a copy of one plain default:
// the delegation needs to know whose stand-in it is, and same-type materials share one GPU program, so it costs no
// compile.
//
// BOOT vs LAZY (the boot rule): this file is what every page loads — the own-material lookup, the active-slot store
// and a scan that loads `slotDrawLayer.js` the first time the scene holds a slot list (2+ materials). Everything that
// draws (stand-ins, delegation, products, park hook, reconcile) lives there. A LEAF: svelte/store + the scene store.
import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { slotIdOf, slotIdsOf, slotOffOf } from './materialSlotsCore.js';

export { slotIdOf, slotIdsOf, slotOffOf };

/** seated entry -> the slot's own material (written by slotDrawLayer.js) @type {WeakMap<any, any>} */
export const seated = new WeakMap();

/** The slot's own material for whatever is seated in its place. @param {any} entry */
export function ownOf(entry) {
	return seated.get(entry) ?? entry;
}

/** An object's own materials, as an array (empty when it wears none). @param {any} object @returns {any[]} */
export function ownMaterialsOf(object) {
	const material = object?.material;
	if (!material) return [];
	return Array.isArray(material) ? material.map(ownOf) : [ownOf(material)];
}

/**
 * THE active material slot (an index) — the one the Inspector's Material rows, the UV editor and (105-slot-shaders)
 * the Shader editor write. LOCAL. Lives in this leaf so uvEditor's `uvActiveSlot` can be the same store.
 * @type {import('svelte/store').Writable<number>}
 */
export const activeMaterialSlot = writable(0);

/** @type {any} the loaded layer */
let layer = null;
/** @type {Promise<any> | null} */
let loading = null;

/** Load the draw layer (once). @returns {Promise<any>} */
export function loadSlotDrawLayer() {
	loading ??= import('./slotDrawLayer.js').then((m) => (layer = m));
	return loading;
}

/** a slot list = 2+ materials @param {any} object */
const isSlotList = (object) => Array.isArray(object?.material) && object.material.length > 1;

/**
 * Bring an object's drawn materials in line with its slots. Synchronous once the layer is loaded (it is, as soon as
 * a slot list has been in the scene for one reconcile); before that, a slot list loads it and syncs when it lands.
 * @param {any} object @returns {boolean} whether anything changed now
 */
export function syncSlotDraw(object) {
	if (layer) return layer.syncSlotDraw(object);
	if (isSlotList(object)) loadSlotDrawLayer().then((m) => m.syncSlotDraw(object));
	return false;
}

// the reconcile: a load, a peer's object or an undo rebuilds materials without passing through a commit; until the
// scene has held a slot list, only a cheap walk looking for one
/** @type {any} */
let reconcileTimer = null;
objectsGroup.subscribe(() => {
	clearTimeout(reconcileTimer);
	reconcileTimer = setTimeout(() => {
		if (layer) return layer.reconcileSlotDraw();
		let found = false;
		get(objectsGroup)?.traverse?.(
			(/** @type {any} */ node) => (found ||= !!node.isMesh && isSlotList(node))
		);
		if (found) loadSlotDrawLayer().then((m) => m.reconcileSlotDraw());
	}, 150);
});
