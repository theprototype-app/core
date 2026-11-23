// fix-late-joiners row 6 — the JOINER's half of the slot layout (slotGroups.slotLayoutOf is the sender's): validate a
// layout that came from a peer and fold the glTF loader's per-group primitives back into the one mesh. Its own
// module so the boot does not carry it: commandsHandler imports it only when a message carries `slots`.
import * as THREE from 'three';

/** caps on a layout that came from a peer (untrusted): it sizes typed arrays */
const MAX_LAYOUT_SLOTS = 256;
const MAX_LAYOUT_GROUPS = 4096;
const MAX_LAYOUT_INDEX = 48_000_000;

/** @param {any} layout @returns {boolean} */
function layoutOk(layout) {
	if (!layout || typeof layout !== 'object' || !Array.isArray(layout.groups)) return false;
	const { slots, count, groups } = layout;
	if (!Number.isInteger(slots) || slots < 1 || slots > MAX_LAYOUT_SLOTS) return false;
	if (!Number.isInteger(count) || count < 0 || count > MAX_LAYOUT_INDEX) return false;
	if (!groups.length || groups.length > MAX_LAYOUT_GROUPS) return false;
	return groups.every(
		(/** @type {any} */ g) =>
			g && Number.isInteger(g.start) && Number.isInteger(g.count) && Number.isInteger(g.materialIndex) &&
			g.start >= 0 && g.count >= 0 && g.start + g.count <= count && g.materialIndex >= 0 && g.materialIndex < slots
	);
}

/**
 * One mesh again from the primitives GLTFLoader built for a multi-slot mesh: `node` is the loaded node (a Group of
 * one mesh per group, in group order, or the Mesh itself for a single group). Same attributes, the original index
 * (each primitive's range written back at its group's start), the groups, and the materials on their slots (a slot
 * no group uses never reached the glTF: it gets a plain stand-in, and draws nothing either way). Null when the
 * shape does not match the layout (the caller keeps what the loader built: what every build before this did).
 * @param {any} node @param {any} layout from `slotLayoutOf` on the sender
 * @returns {any | null}
 */
export function rejoinSlotPrimitives(node, layout) {
	if (!node || !layoutOk(layout)) return null;
	const prims = node.isMesh ? [node] : (node.children ?? []).filter((/** @type {any} */ c) => c.isMesh);
	if (prims.length !== layout.groups.length) return null;
	const first = prims[0].geometry;
	if (!first?.attributes?.position) return null;
	if (prims.some((/** @type {any} */ p) => p.geometry?.attributes?.position !== first.attributes.position)) return null;
	const geometry = new THREE.BufferGeometry();
	for (const [name, attribute] of Object.entries(first.attributes)) geometry.setAttribute(name, /** @type {any} */ (attribute));
	geometry.userData = { ...(first.userData ?? {}) };
	const vertices = first.attributes.position.count;
	if (layout.indexed) {
		// size the index from what the glTF really holds, before allocating: a layout's count alone is a peer's number
		let supplied = 0;
		for (let i = 0; i < prims.length; i++) {
			const src = prims[i].geometry.index;
			if (layout.groups[i].count && (!src || src.count < layout.groups[i].count)) return null;
			supplied += src?.count ?? 0;
		}
		if (layout.count > supplied) return null;
		const index = vertices > 65535 ? new Uint32Array(layout.count) : new Uint16Array(layout.count);
		for (let i = 0; i < prims.length; i++) {
			const g = layout.groups[i];
			const src = prims[i].geometry.index;
			if (!g.count) continue;
			if (!src || src.count < g.count) return null;
			for (let k = 0; k < g.count; k++) index[g.start + k] = src.getX(k);
		}
		geometry.setIndex(new THREE.BufferAttribute(index, 1));
	} else if (layout.count !== vertices) return null;
	for (const g of layout.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
	/** @type {any[]} */
	const materials = new Array(layout.slots).fill(null);
	layout.groups.forEach((/** @type {any} */ g, /** @type {number} */ i) => {
		if (!materials[g.materialIndex]) materials[g.materialIndex] = prims[i].material;
	});
	for (let s = 0; s < materials.length; s++) if (!materials[s]) materials[s] = new THREE.MeshStandardMaterial();
	const mesh = new THREE.Mesh(geometry, materials);
	mesh.name = node.name;
	mesh.position.copy(node.position);
	mesh.quaternion.copy(node.quaternion);
	mesh.scale.copy(node.scale);
	mesh.visible = node.visible;
	mesh.castShadow = prims[0].castShadow;
	mesh.receiveShadow = prims[0].receiveShadow;
	mesh.userData = { ...(node.userData ?? {}) };
	return mesh;
}
