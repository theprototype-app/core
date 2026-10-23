import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { hasAnimatedImport, animatedImportPayload, animatedImportKind } from './animatedImports';
import { gltfBytesFor } from './fileHandler.svelte';
import { isGlb, stampTpExtras } from './glbEdit';
import { isEditOverlay } from './editOverlays';
import { EDIT_IN_BLENDER_DOCS, BLENDER_EXPORT_SETTINGS, editInBlenderCard } from './editInBlenderState';

// 59 T2 — EDIT IN BLENDER (manual). The object's model goes out as `<name>.glb` and comes back
// through Replace (T1): no add-on, no server, any tool that reads and writes glTF (Blender, Maya,
// 3ds Max, Cascadeur …) on any computer.
//
// WHAT THE FILE IS: an animated import's ORIGINAL bytes (its rig, weights and clips exactly as
// they replicate), a static model exported from the live tree. Either way the object's own
// transform is NOT in the file — the file is the model, the object is where it stands, and a
// replace puts the new file back under the same transform. So a static model exports its root's
// CHILDREN as the scene's roots (a lone mesh exports as a copy at the origin), and a round trip
// keeps the tree's shape: the same names in the same order, so even the parts keep their uuids.
// T7b: the file carries `extras.theprototype = {uuid, name}` on the scene and its roots, so the
// exported file dropped ANYWHERE asks "Update <name>?" (Blender keeps it as a Custom Property
// when Include ▸ Custom Properties is ticked — the card says so).

export { EDIT_IN_BLENDER_DOCS, BLENDER_EXPORT_SETTINGS, editInBlenderCard };

/** @param {string} uuid */
function objectOf(uuid) {
	/** @type {any} */
	const group = get(objectsGroup);
	return group?.getObjectByProperty('uuid', uuid) ?? null;
}

/** a file name from an object name @param {string} name */
export function fileBaseFor(name) {
	return String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 120) || 'model';
}

/**
 * The model of `uuid` as a file: `{bytes, fileName, format, stamped}`, or null.
 * @param {string} uuid
 * @returns {Promise<{bytes: ArrayBuffer, fileName: string, format: 'glb'|'gltf'|'fbx', stamped: boolean} | null>}
 */
export async function modelFileFor(uuid) {
	const live = objectOf(uuid);
	if (!live) return null;
	const base = fileBaseFor(live.name || 'model');
	const stamp = { uuid: live.uuid, name: live.name || '' };
	if (hasAnimatedImport(uuid)) {
		const bytes = /** @type {ArrayBuffer | null} */ (animatedImportPayload(uuid));
		if (!bytes) return null;
		if (animatedImportKind(uuid) === 'fbx') return { bytes, fileName: base + '.fbx', format: 'fbx', stamped: false };
		if (isGlb(bytes)) return { bytes: stampTpExtras(bytes, stamp), fileName: base + '.glb', format: 'glb', stamped: true };
		return { bytes, fileName: base + '.gltf', format: 'gltf', stamped: false };
	}
	/** @type {any[]} */
	let roots = live.children.filter((/** @type {any} */ c) => !isEditOverlay(c));
	if (live.isMesh || !roots.length) {
		// a lone mesh (a primitive, an STL): a copy of it at the origin, its object transform left behind
		const copy = live.clone(false);
		copy.position.set(0, 0, 0);
		copy.quaternion.identity();
		copy.scale.set(1, 1, 1);
		copy.userData = {};
		copy.updateMatrix();
		roots = [copy];
	}
	const bytes = await gltfBytesFor(roots, { binary: true });
	if (!bytes) return null;
	return { bytes: stampTpExtras(bytes, stamp), fileName: base + '.glb', format: 'glb', stamped: true };
}

/** @param {ArrayBuffer} bytes @param {string} fileName */
function download(bytes, fileName) {
	const blob = new Blob([bytes], { type: fileName.endsWith('.glb') ? 'model/gltf-binary' : 'application/octet-stream' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = fileName;
	a.style.display = 'none';
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * T2: download the object's model and open the guide card.
 * @param {string} uuid @returns {Promise<boolean>}
 */
export async function editInBlender(uuid) {
	const live = objectOf(uuid);
	if (!live) return false;
	const file = await modelFileFor(uuid);
	if (!file) {
		showToast('Could not write "' + (live.name || 'this model') + '" as a file.');
		return false;
	}
	download(file.bytes, file.fileName);
	editInBlenderCard.set({ uuid, name: live.name || 'Model', fileName: file.fileName, format: file.format, stamped: file.stamped });
	return true;
}

/** the card's "Download again" @param {string} uuid */
export async function downloadAgain(uuid) {
	const file = await modelFileFor(uuid);
	if (file) download(file.bytes, file.fileName);
}
