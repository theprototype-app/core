// 105-slots: the slot facts EVERY page needs at boot — a slot's id (and the id~index rule for duplicates), its off
// flag, its link. Imports NOTHING. The rest of the pure half (group remapping, slot references) is
// materialSlotsCore.js, which re-exports these, so the lazy side and the unit suite read one module.

/** The raw id a slot's material carries: `userData.slot.id`, else its uuid. @param {any} material @returns {string} */
export function slotIdOf(material) {
	const id = material?.userData?.slot?.id;
	return typeof id === 'string' && id ? id : String(material?.uuid ?? '');
}

/**
 * The ids of a slot list, in order. Two slots with one id (an older peer's "add slot" clones the last material,
 * userData included): the later one answers `id~index`, the same on every peer.
 * @param {any[]} materials @returns {string[]}
 */
export function slotIdsOf(materials) {
	const seen = new Set();
	return materials.map((m, i) => {
		let id = slotIdOf(m);
		if (seen.has(id)) id = id + '~' + i;
		seen.add(id);
		return id;
	});
}

/** Is this slot's own material switched off? @param {any} material */
export function slotOffOf(material) {
	return material?.userData?.slot?.off === true;
}

/** 105-slots LINK: the shared-material id a slot's material carries ('' = not linked). @param {any} material */
export function slotLinkOf(material) {
	const link = material?.userData?.slot?.link;
	return typeof link === 'string' && link ? link : '';
}

let linkCounter = 0;
/** A new link id: unique within a session, stable once written (it rides the material). */
export function newLinkId() {
	return 'lnk' + Date.now().toString(36) + (linkCounter++).toString(36);
}
