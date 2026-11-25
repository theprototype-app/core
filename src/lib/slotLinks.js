// 105-slots LINK — a slot can point at a material another slot already uses; they are then ONE shared material:
// editing it changes every slot that uses it (owner choice 22 Nov; wire + save form: QUESTIONS-105-slots 4).
//
// THE FORM (additive): `material.userData.slot.link = '<linkId>'`, and every holder keeps a FULL copy of the material,
// so an old file and a peer on the previous release see ordinary materials. NOT one shared THREE instance (the D2
// model for whole objects): a slot's name, id and off flag live on its material, so two slots sharing an instance
// would share those too. Instead an edit to a linked slot is FANNED: the same operation runs on every other holder
// (object + slot), locally and on the wire as that holder's own existing per-slot message — no new message type,
// and an older peer applies each one it receives.
//
// What fans: every look edit (values, colour, type, preset, the base map and the map slots, tiling, strength). What
// does not: the slot's own data — name, off, id — and the list (remove, move, duplicate).
//
// The honest cost (the D2 one, per slot): a peer on the previous release that edits a linked slot fans nothing, so
// only that object changes; the copies then differ until somebody on a current build edits that property again or
// presses Make unique. A LEAF: the scene store, the pure core and the slotDraw gate (history arrives through it).
import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { slotLinkOf } from './slotIds.js';
import { ownMaterialsOf, registerSlotLinks, linkHistory } from './slotDraw.js';

// history through the gate (materialsHandler fills it): see slotDraw.linkHistory
const beginHistoryBatch = () => linkHistory.begin?.();
const endHistoryBatch = (/** @type {string} */ label) => linkHistory.end?.(label);
const historyBatchOpen = () => !!linkHistory.open?.();
const historyApplying = () => !!linkHistory.applying?.();

/**
 * Every slot in the scene that holds `link`, in a deterministic order (object uuid, then slot index).
 * @param {string} link @returns {{object: any, index: number}[]}
 */
export function holdersOf(link) {
	/** @type {{object: any, index: number}[]} */
	const out = [];
	if (!link) return out;
	get(objectsGroup)?.traverse?.((/** @type {any} */ node) => {
		if (!node.isMesh || !node.material) return;
		ownMaterialsOf(node).forEach((m, index) => {
			if (slotLinkOf(m) === link) out.push({ object: node, index });
		});
	});
	return out.sort((a, b) =>
		a.object.uuid < b.object.uuid ? -1 : a.object.uuid > b.object.uuid ? 1 : a.index - b.index
	);
}

/** How many slots share this slot's material (1 = it is not shared). @param {any} material */
export function sharedCount(material) {
	const link = slotLinkOf(material);
	return link ? holdersOf(link).length : 1;
}

/**
 * The OTHER holders of the link on (object, slot). Empty — and no scene walk — for an unlinked slot, which is every
 * slot until somebody links one.
 * @param {any} object @param {number} slot @returns {{object: any, index: number}[]}
 */
export function linkedOthers(object, slot) {
	const own = ownMaterialsOf(object)[slot];
	const link = slotLinkOf(own);
	if (!link) return [];
	return holdersOf(link).filter((h) => !(h.object === object && h.index === slot));
}

let fanning = false;

/**
 * Run `apply(uuid, slot)` on every other holder of (object, slot)'s link, as ONE undo step with the caller's own
 * change when no batch is open. Re-entrant calls (the holders' own edits) do not fan again.
 * @param {any} object @param {number} slot @param {(uuid: string, slot: number) => void} apply @param {string} [label]
 * @returns {number} holders reached
 */
export function fanLinked(object, slot, apply, label = 'Shared material') {
	if (fanning || !object) return 0;
	const others = linkedOthers(object, slot);
	if (!others.length) return 0;
	fanning = true;
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	try {
		for (const h of others) apply(h.object.uuid, h.index);
	} finally {
		if (own) endHistoryBatch(label + ' (' + (others.length + 1) + ' slots)');
		fanning = false;
	}
	return others.length;
}

/**
 * THE wrapper every look edit goes through: `self()` is the edit on (object, slot); for a linked slot `other(uuid,
 * slot)` then runs the same edit on each other holder, and the lot is ONE undo step. An unlinked slot, a re-entrant
 * call and an undo / redo replay (whose batch already holds every holder's entry) just run `self()`.
 * @template T @param {any} object @param {number} slot @param {() => T} self @param {(uuid: string, slot: number) => void} other
 * @param {string} [label] @returns {T}
 */
export function linkedEdit(object, slot, self, other, label = 'Shared material') {
	if (fanning || !object || historyApplying()) return self();
	const others = linkedOthers(object, slot);
	if (!others.length) return self();
	fanning = true;
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	try {
		const result = self();
		for (const h of others) other(h.object.uuid, h.index);
		return result;
	} finally {
		if (own) endHistoryBatch(label + ' (' + (others.length + 1) + ' slots)');
		fanning = false;
	}
}

/** The async twin (texture writes decode first). @template T @param {any} object @param {number} slot
 * @param {() => Promise<T>} self @param {(uuid: string, slot: number) => Promise<any>} other @param {string} [label] @returns {Promise<T>} */
export async function linkedEditAsync(object, slot, self, other, label = 'Shared material') {
	if (fanning || !object || historyApplying()) return self();
	const others = linkedOthers(object, slot);
	if (!others.length) return self();
	fanning = true;
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	try {
		const result = await self();
		for (const h of others) await other(h.object.uuid, h.index);
		return result;
	} finally {
		if (own) endHistoryBatch(label + ' (' + (others.length + 1) + ' slots)');
		fanning = false;
	}
}

/** For a caller that fans asynchronously (texture writes): is a fan running? */
export function isFanning() {
	return fanning;
}

/** How many slots hold each link in the scene (one walk). @returns {Map<string, number>} */
export function linkCounts() {
	/** @type {Map<string, number>} */
	const out = new Map();
	get(objectsGroup)?.traverse?.((/** @type {any} */ node) => {
		if (!node.isMesh || !node.material) return;
		for (const m of ownMaterialsOf(node)) {
			const link = slotLinkOf(m);
			if (link) out.set(link, (out.get(link) ?? 0) + 1);
		}
	});
	return out;
}

// the boot gate (slotDraw.js) routes every look edit here from now on
registerSlotLinks({ linkedEdit, linkedOthers, sharedCount });
