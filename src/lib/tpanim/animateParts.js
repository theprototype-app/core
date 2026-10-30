// 57 M12 — ANIMATE IMPORTED PARTS: a clip keyed on a model's NAMED NODES (a rotor, a door, a
// lid — what 56 C9's import_model keeps from an img2threejs GLB), written as a node-name `.tpanim`
// (the skeleton-clip shape: the parts' rest nodes + one animation) and assigned to the model in ONE
// undo step. The core of the agent tool `animate_parts` and of anything else that keys parts by
// name — so Claude can make a rotor spin or a door open through the same replicated, undoable path
// a person's edit takes.

import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore';
import { clipRefsOf, setClipRefs, setAnimationState, ensureClipModel, restPoseOf } from '../animatedImports';
import { buildPartsClip } from './partsClip.js';
import { saveClip } from './clipEdit.js';

/** @typedef {import('./partsClip.js').PartTrack} PartTrack */

/**
 * animateParts — write ONE clip on a model's named parts, assign it (one undo step) and, unless
 * `play` is false, play it on every peer. `object` = a uuid or a name.
 * @param {{object: string, clip: string, tracks: PartTrack[], loop?: boolean, mode?: 'relative'|'absolute', play?: boolean}} spec
 * @returns {Promise<{ok: true, uuid: string, clip: string, hash: string, parts: string[], missing: string[]} | {error: string, missing?: string[]}>}
 */
export async function animateParts(spec) {
	const group = get(objectsGroup);
	const want = String(spec?.object ?? '');
	const root = group?.getObjectByProperty('uuid', want) ?? group?.children.find((/** @type {any} */ c) => c.name === want) ?? null;
	if (!root) return { error: 'no object "' + want + '" — pass its uuid (list_scene) or exact name' };
	if (!Array.isArray(spec.tracks) || !spec.tracks.length) return { error: 'tracks is empty — pass [{part, keys: [{t, rot: [x, y, z]}]}]' };
	if (!ensureClipModel(root)) return { error: '"' + root.name + '" is a functional item (it has its own behaviour) and cannot take a clip' };
	const { tp, parts, missing } = buildPartsClip(root, spec, restPoseOf(root.uuid));
	if (!tp) {
		/** @type {string[]} */
		const names = [];
		root.traverse((/** @type {any} */ o) => o !== root && o.name && names.push(o.name));
		return { error: 'none of the parts were found (or no keys had times) — the model has: ' + names.slice(0, 40).join(', '), missing };
	}
	const saved = await saveClip(tp, (root.name ? root.name + ' - ' : '') + tp.name);
	if (!saved) return { error: 'the clip could not be written to the Explorer' };
	const refs = clipRefsOf(root).filter((r) => r.name !== tp.name);
	setClipRefs(root.uuid, [...refs, { hash: saved.hash, name: tp.name, ...(spec.loop === false ? { loop: false } : {}) }]);
	if (spec.play !== false) setAnimationState(root.uuid, { clip: tp.name, playing: true });
	return { ok: true, uuid: root.uuid, clip: tp.name, hash: saved.hash, parts, missing };
}
