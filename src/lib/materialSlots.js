// 105-slots: material slots you can manage. A slot = one entry of `object.material` + its `geometry.groups`; its own
// data rides its material (`material.name`, `material.userData.slot = { id, off }`); `slotIdOf` (slotDraw.js) is
// `userData.slot.id`, else the material's uuid (the same on every peer: every carrier of a slot list is toJSON).
//
// Every list operation here is ONE `materials` commit (materialsHandler.commitMaterialList: the list and the
// remapped groups together, adjacent groups of one slot merged) and ONE undo step, so a peer on the previous release
// applies it too and no new message type exists. The pure halves (`remapGroups`, `slotIndexOf`) take plain data so
// the unit suite needs no scene.
//
// Remove / reorder / duplicate refuse while the object is open in Edit Mesh: the edit session keeps a per-face slot
// inside its kernel and does not see a group rewrite, so the next mesh operator would write the old slots back
// (research 105, "99"). Rename and off do not move an index and are allowed.
import { showToast } from '../stores/appStore';
import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { commitMaterialList, materialsOf, keepSlotIdentity } from './materialsHandler';
import { isEditingMesh } from './editSession';
import { activeMaterialSlot } from './slotDraw.js';
// the lazy draw layer: anything that manages slots has a slot list in front of it, so it loads with this module
import { slotDrawn } from './slotDrawLayer.js';
import {
	slotIdsOf,
	slotOffOf,
	remapGroups,
	facesPerSlot,
	slotIndexOf,
	removalMap,
	swapMap,
	insertAfterMap,
	slotLinkOf,
	newLinkId
} from './materialSlotsCore.js';
import { linkCounts } from './slotLinks.js'; // 105-slots LINK
import { beginHistoryBatch, endHistoryBatch, historyBatchOpen } from './history';
import { materialIdOf } from './materialSharing';

export { slotDrawn, activeMaterialSlot };
export * from './materialSlotsCore.js';
export { ownOf, syncSlotDraw, loadSlotDrawLayer } from './slotDraw.js';
export { setSlotProduct, slotProductOf, reconcileSlotDraw } from './slotDrawLayer.js';

export const EDIT_MESH_REFUSAL = 'Leave Edit Mesh to change the slot list';

/** @param {string} uuid */
function objectOf(uuid) {
	return /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', uuid) ?? null;
}

/**
 * The slots of an object, in order.
 * @param {any} object
 * @returns {{index: number, id: string, name: string, off: boolean, faces: number, type: string, kind: 'material' | 'off' | 'shader', link: string, shared: number}[]}
 */
export function slotsOf(object) {
	const own = materialsOf(object);
	if (!own.length) return [];
	const ids = slotIdsOf(own);
	const groups = (object.geometry?.groups ?? []).map((/** @type {any} */ g) => ({
		start: g.start,
		count: g.count,
		materialIndex: g.materialIndex || 0
	}));
	const geometry = object.geometry;
	const total = Math.floor(
		(geometry?.index ? geometry.index.count : (geometry?.attributes?.position?.count ?? 0)) / 3
	);
	// a single material draws every face, whatever groups a primitive ships
	const faces = own.length === 1 ? [total] : facesPerSlot(groups, own.length);
	// 105-slots LINK: how many slots share each link (one scene walk, only when this object holds one)
	const counts = own.some((m) => slotLinkOf(m)) ? linkCounts() : null;
	return own.map((m, i) => ({
		index: i,
		id: ids[i],
		name: m?.name ?? '',
		off: own.length > 1 && slotOffOf(m),
		faces: faces[i] ?? 0,
		type: m?.type ?? '',
		kind: slotDrawn(object, i)?.kind ?? 'material',
		link: slotLinkOf(m),
		shared: counts ? (counts.get(slotLinkOf(m)) ?? 1) : 1
	}));
}

/** @param {string} uuid @param {string} action @returns {boolean} true = refused */
function refusedWhileEditing(uuid, action) {
	if (!isEditingMesh(uuid)) return false;
	showToast(EDIT_MESH_REFUSAL);
	console.log('slot ' + action + ' refused: the object is open in Edit Mesh');
	return true;
}

/** @param {string} uuid @param {number | string} ref */
function resolve(uuid, ref) {
	const object = objectOf(uuid);
	const own = materialsOf(object);
	const index = slotIndexOf(own, ref);
	return { object, own, index };
}

/**
 * Remove a slot. Its faces go to slot `to` (an index / id / name; default the first remaining slot). Removing the
 * last-but-one slot returns the object to a single material (no groups, no off).
 * @param {string} uuid @param {number | string} ref @param {number | string} [to]
 */
export function removeSlot(uuid, ref, to) {
	const { object, own, index } = resolve(uuid, ref);
	if (!object || index < 0 || own.length < 2) return false;
	if (refusedWhileEditing(uuid, 'remove')) return false;
	let target = to === undefined || to === null ? (index === 0 ? 1 : 0) : slotIndexOf(own, to);
	if (target < 0 || target === index) target = index === 0 ? 1 : 0;
	const ok = commitMaterialList(uuid, (materials, groups) => {
		const map = removalMap(materials.length, index, target);
		const rest = materials.filter((_, i) => i !== index);
		if (rest.length === 1) {
			const survivor = rest[0];
			if (survivor.userData?.slot) {
				delete survivor.userData.slot.off;
				if (!Object.keys(survivor.userData.slot).length) delete survivor.userData.slot;
			}
			return { materials: rest, groups: [] };
		}
		return { materials: rest, groups: remapGroups(groups, map) };
	});
	if (ok) clampActive(uuid);
	return ok;
}

/**
 * Move a slot up (-1) or down (+1) one place. Draws the same picture: the groups follow their materials.
 * @param {string} uuid @param {number | string} ref @param {number} delta
 */
export function moveSlot(uuid, ref, delta) {
	const { object, own, index } = resolve(uuid, ref);
	const to = index + Math.sign(delta || 0);
	if (!object || index < 0 || to < 0 || to >= own.length || to === index) return false;
	if (refusedWhileEditing(uuid, 'move')) return false;
	const ok = commitMaterialList(uuid, (materials, groups) => {
		[materials[index], materials[to]] = [materials[to], materials[index]];
		const map = swapMap(materials.length, index, to);
		return { materials, groups: remapGroups(groups, map) };
	});
	// the active slot follows the slot it was on
	if (ok && get(activeMaterialSlot) === index) activeMaterialSlot.set(to);
	else if (ok && get(activeMaterialSlot) === to) activeMaterialSlot.set(index);
	return ok;
}

/** @param {string} uuid @param {number | string} ref @param {string} name */
export function renameSlot(uuid, ref, name) {
	const { object, index } = resolve(uuid, ref);
	const next = String(name ?? '')
		.trim()
		.slice(0, 80);
	if (!object || index < 0) return false;
	if ((materialsOf(object)[index].name ?? '') === next) return true;
	return commitMaterialList(uuid, (materials) => {
		materials[index].name = next;
		return { materials };
	});
}

/**
 * Duplicate a slot right after itself: the same look and off flag, a new id (its own uuid), no faces yet.
 * @param {string} uuid @param {number | string} ref @returns {number} the new slot's index, or -1
 */
export function duplicateSlot(uuid, ref) {
	const { object, own, index } = resolve(uuid, ref);
	if (!object || index < 0) return -1;
	if (own.length > 1 && refusedWhileEditing(uuid, 'duplicate')) return -1;
	const ok = commitMaterialList(uuid, (materials, groups) => {
		const copy = materials[index].clone();
		copy.name = (materials[index].name || 'Slot ' + (index + 1)) + ' copy';
		if (copy.userData?.slot) {
			delete copy.userData.slot.id;
			delete copy.userData.slot.link; // 105-slots LINK: a duplicate is a working copy, not another holder
			if (!Object.keys(copy.userData.slot).length) delete copy.userData.slot;
		}
		if (materials.length === 1) {
			// growing from one material: every face stays on slot 0 (addMaterialSlot's rule)
			const count =
				object.geometry?.index?.count ?? object.geometry?.attributes?.position?.count ?? 0;
			return { materials: [materials[0], copy], groups: [{ start: 0, count, materialIndex: 0 }] };
		}
		const map = insertAfterMap(materials.length, index);
		materials.splice(index + 1, 0, copy);
		return { materials, groups: remapGroups(groups, map) };
	});
	return ok ? index + 1 : -1;
}

/**
 * Switch a slot off (it draws the plain default) or on again. Scene data: it rides the slot's material.
 * @param {string} uuid @param {number | string} ref @param {boolean} off
 */
export function setSlotOff(uuid, ref, off) {
	const { object, own, index } = resolve(uuid, ref);
	if (!object || index < 0 || own.length < 2) return false;
	if (slotOffOf(own[index]) === !!off) return true;
	return commitMaterialList(uuid, (materials) => {
		const m = materials[index];
		const slot = { ...(m.userData.slot ?? {}) };
		if (off) slot.off = true;
		else delete slot.off;
		if (Object.keys(slot).length) m.userData.slot = slot;
		else delete m.userData.slot;
		return { materials };
	});
}

/**
 * Put another material instance in a slot (a preset, a library material, a copy of another slot's look). The new
 * instance keeps the slot: its name, id and off flag are written onto it.
 * @param {string} uuid @param {number | string} ref @param {any} material a THREE material this object may own
 */
export function replaceSlotMaterial(uuid, ref, material) {
	const { object, index } = resolve(uuid, ref);
	if (!object || index < 0 || !material?.isMaterial) return false;
	return commitMaterialList(uuid, (materials) => {
		materials[index] = keepSlotIdentity(materials[index], material);
		material.userData.tpEdited = true; // 59 T1
		return { materials };
	});
}

// ---- 105-slots LINK: one shared material across slots (QUESTIONS-105-slots 4) --------------------------------

export const D2_REFUSAL = 'This object already shares its whole material with a copy; Unlink it first';

/** @param {any} material @param {string} link */
function withLink(material, link) {
	material.userData.slot = { ...(material.userData.slot ?? {}), link };
	material.userData.tpEdited = true; // 59 T1
	return material;
}

/**
 * Point slot `targetRef` of `targetUuid` at the material slot `sourceRef` of `sourceUuid` already uses: the target gets
 * a copy of that material (keeping its own name, id and off flag) and both carry the source's link id (minted when it
 * has none). From then on a look edit on either reaches both. ONE undo step; on the wire one `materials` message per
 * object that changed (a peer on the previous release applies it as an ordinary material copy).
 * @param {string} targetUuid @param {number | string} targetRef @param {string} sourceUuid @param {number | string} sourceRef
 */
export function linkSlotTo(targetUuid, targetRef, sourceUuid, sourceRef) {
	const target = resolve(targetUuid, targetRef);
	const source = resolve(sourceUuid, sourceRef);
	if (!target.object || !source.object || target.index < 0 || source.index < 0) return false;
	if (target.object === source.object && target.index === source.index) return false;
	// D2 (an object-level `materialId` share) and a slot link must never claim one instance
	if (materialIdOf(target.object) || materialIdOf(source.object)) {
		showToast(D2_REFUSAL);
		return false;
	}
	const sourceMaterial = source.own[source.index];
	const link = slotLinkOf(sourceMaterial) || newLinkId();
	if (slotLinkOf(target.own[target.index]) === link) return true;
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	try {
		if (target.object === source.object)
			return commitMaterialList(targetUuid, (materials) => {
				withLink(materials[source.index], link);
				materials[target.index] = withLink(keepSlotIdentity(materials[target.index], sourceMaterial.clone()), link);
				return { materials };
			});
		if (!slotLinkOf(sourceMaterial))
			commitMaterialList(sourceUuid, (materials) => {
				withLink(materials[source.index], link);
				return { materials };
			});
		return commitMaterialList(targetUuid, (materials) => {
			materials[target.index] = withLink(keepSlotIdentity(materials[target.index], sourceMaterial.clone()), link);
			return { materials };
		});
	} finally {
		if (own) endHistoryBatch('Link material');
	}
}

/**
 * Make unique: this slot keeps its copy of the shared material and leaves the link (the others stay linked).
 * @param {string} uuid @param {number | string} ref
 */
export function makeSlotUnique(uuid, ref) {
	const { object, own, index } = resolve(uuid, ref);
	if (!object || index < 0 || !slotLinkOf(own[index])) return false;
	return commitMaterialList(uuid, (materials) => {
		const slot = { ...(materials[index].userData.slot ?? {}) };
		delete slot.link;
		if (Object.keys(slot).length) materials[index].userData.slot = slot;
		else delete materials[index].userData.slot;
		return { materials };
	});
}

/** keep the active index inside the list after a removal @param {string} uuid */
function clampActive(uuid) {
	const n = materialsOf(objectOf(uuid)).length;
	if (get(activeMaterialSlot) >= n) activeMaterialSlot.set(Math.max(0, n - 1));
}
