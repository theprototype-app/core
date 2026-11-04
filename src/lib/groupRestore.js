// mcp-diorama2 (agent report, item 1) — GROUPS SURVIVE THE AUTOSAVE ROUND TRIP. The autosave snapshot is a glTF,
// and three's GLTFLoader builds a THREE.Group only for a node that carries several mesh primitives: an empty node
// with children (every group a person or an agent made) comes back as a plain Object3D. The children stayed inside
// it, but everything that asks "is this a group" (type === 'Group': the object list's drop target, list_scene's
// parentUuid, the agent's parentUuid, the Inspector) stopped answering yes after "Session restored (N objects)".
// The snapshot now lists its groups' uuids (`groups`, beside the `lights` sidecar) and the restore rebuilds those
// nodes as real groups. A snapshot from an older build has no list: its nodes stay Object3D (the agent tools take
// any container as a parent since this lane, so nothing an agent does breaks on one).
import * as THREE from 'three';

/**
 * The uuids of every group under `root` (root excluded).
 * @param {any} root @returns {string[]}
 */
export function groupUuidsOf(root) {
	/** @type {string[]} */
	const out = [];
	root?.traverse?.((/** @type {any} */ o) => {
		if (o !== root && o.isGroup) out.push(o.uuid);
	});
	return out;
}

/**
 * Turn every node under `root` whose uuid is in `uuids` and that is not a group back into a THREE.Group, in place:
 * same uuid, name, transform, visibility, userData and children, at the same index in its parent.
 * @param {any} root @param {Iterable<string> | null | undefined} uuids @returns {number} how many were rebuilt
 */
export function regroup(root, uuids) {
	const wanted = new Set(uuids ?? []);
	if (!wanted.size || !root) return 0;
	/** @type {any[]} */
	const found = [];
	root.traverse((/** @type {any} */ o) => {
		if (o !== root && wanted.has(o.uuid) && !o.isGroup && !o.isMesh && !o.isLight && !o.isCamera) found.push(o);
	});
	for (const node of found) {
		const g = new THREE.Group();
		g.uuid = node.uuid;
		g.name = node.name;
		g.position.copy(node.position);
		g.quaternion.copy(node.quaternion);
		g.scale.copy(node.scale);
		g.visible = node.visible;
		g.renderOrder = node.renderOrder;
		g.frustumCulled = node.frustumCulled;
		g.castShadow = node.castShadow;
		g.receiveShadow = node.receiveShadow;
		g.layers.mask = node.layers.mask;
		g.userData = node.userData;
		g.animations = node.animations ?? [];
		for (const child of [...node.children]) g.add(child);
		const parent = node.parent;
		if (parent) {
			const at = parent.children.indexOf(node);
			parent.children[at] = g;
			g.parent = parent;
			node.parent = null;
		}
		g.updateMatrix();
	}
	return found.length;
}
