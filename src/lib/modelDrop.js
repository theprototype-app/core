import { get } from 'svelte/store';
import { objectsGroup, selectedObject } from '../stores/sceneStore';
import { importFile } from './fileHandler.svelte';
import { readTpExtras } from './glbEdit';
import { showChoiceEx } from './confirmDialog';

// 59 T1 / T7b — WHAT A DROPPED MODEL FILE MEANS. Before 59 every model dropped on the viewport was
// a new object. Two drops now mean "this is a new version of one I have":
//   · T7b AUTO-MATCH: a file carrying `extras.theprototype.uuid` (our own "Edit in Blender" export,
//     back from the tool) names its object — dropped ANYWHERE it asks "Update <name>?", no
//     selection needed. Checked first: the file says which object it is, the cursor only guesses.
//   · F1: a file dropped ONTO the selected object asks Replace or Add, with "remember for this
//     session" (forgotten on reload; a deliberate choice, not a setting to hunt for later).
// Anything else — several model files at once, a drop on empty ground, nothing selected — imports
// exactly as it always did. The asks are local; only what the answer does replicates.

/** F1's remembered answer for this session ('replace' | 'add' | null) */
let remembered = /** @type {string | null} */ (null);

/** forget F1's remembered answer (the suites, and a future "ask again" row) */
export function forgetDropChoice() {
	remembered = null;
}
export function rememberedDropChoice() {
	return remembered;
}

/** @param {string} uuid */
function objectOf(uuid) {
	/** @type {any} */
	const group = get(objectsGroup);
	return group?.getObjectByProperty('uuid', uuid) ?? null;
}

/** does the drop point land on `target` (itself or a part of it)? @param {any} target @param {number} x @param {number} y */
async function dropLandsOn(target, x, y) {
	if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
	const { dropTarget } = await import('./explorerDrop');
	const hit = dropTarget(x, y);
	for (let o = hit?.hit ?? hit?.object ?? null; o; o = o.parent) if (o === target) return true;
	return false;
}

/**
 * Route ONE dropped model file. Resolves what happened: 'update' | 'replace' | 'add' | 'cancel'.
 * @param {File} file @param {{companions?: any[], clientX?: number, clientY?: number}} [opts]
 */
export async function dropModelFile(file, opts = {}) {
	const companions = opts.companions ?? [];
	const name = file.name.replace(/\.(glb|gltf|obj|stl|fbx)$/i, '');
	const add = () => importFile(file, name, undefined, undefined, companions);
	const { replaceModelFromFile, isReplaceableModel } = await import('./modelReplace');
	// T7b: the file names its object
	if (/\.(glb|gltf)$/i.test(file.name)) {
		/** @type {any} */
		let stamp = null;
		try {
			stamp = readTpExtras(await file.arrayBuffer());
		} catch {
			stamp = null;
		}
		const target = stamp ? objectOf(stamp.uuid) : null;
		if (target) {
			const label = target.name || stamp.name || 'the model';
			const answer = await showChoiceEx({
				id: 'model-drop-update',
				title: 'Update "' + label + '"?',
				message: file.name + ' was exported from "' + label + '". Put it back in place of that model — its position, links and flows stay — or add it as a new object?',
				choices: [
					{ value: 'update', label: 'Update "' + label + '"' },
					{ value: 'add', label: 'Add as a new object' }
				],
				cancelLabel: 'Cancel'
			});
			if (!answer) return 'cancel';
			if (answer.value === 'add') {
				void add();
				return 'add';
			}
			await replaceModelFromFile(target.uuid, file, { companions, source: 'update' });
			return 'update';
		}
	}
	// F1: onto the selected object
	/** @type {any} */
	const selected = get(selectedObject);
	const target = selected?.uuid ? objectOf(selected.uuid) : null;
	if (target && isReplaceableModel(target) && (await dropLandsOn(target, Number(opts.clientX), Number(opts.clientY)))) {
		let choice = remembered;
		if (!choice) {
			const label = target.name || 'the selected object';
			const answer = await showChoiceEx({
				id: 'model-drop-replace',
				title: 'Replace or add?',
				message: 'You dropped ' + file.name + ' on "' + label + '".',
				checkbox: { label: 'Remember for this session' },
				choices: [
					{ value: 'replace', label: 'Replace "' + label + '"' },
					{ value: 'add', label: 'Add as a new object' }
				],
				cancelLabel: 'Cancel'
			});
			if (!answer) return 'cancel';
			choice = answer.value;
			if (answer.checked) remembered = choice;
		}
		if (choice === 'replace') {
			await replaceModelFromFile(target.uuid, file, { companions, source: 'drop' });
			return 'replace';
		}
	}
	void add();
	return 'add';
}
