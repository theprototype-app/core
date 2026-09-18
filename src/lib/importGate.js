import { writable, get } from 'svelte/store';
import { objectsGroup, globalRenderer } from '../stores/sceneStore';
import { profileFor } from './sceneBudget';
import { modelCost, importVerdict, describeRow, shortCount } from './importBudget';
import { showChoice } from './confirmDialog';

// 26-F — THE IMPORT HALF OF THE INGEST GATE (roadmap 26 section 4, Stage 2).
//
// ONE STORY, NOT TWO: the question is asked through the SAME dialog the file-open ask
// (26-C, `sessions.confirmSceneSize`) uses, in the same words — "above the N recommended
// for this device" — with the same Cancel. A model and a scene are the two things a
// person opens from disk, and a heavy one of either must read as the same kind of event.
//
// It runs AFTER the parse and BEFORE the model touches the scene, which is the only
// moment the cost is exact and nothing is paid yet: the loader has built the tree
// (textures decoded, geometry in memory), no frame has drawn it, no peer has been sent
// it, no undo entry exists. Cancel therefore leaves the scene byte-identical.
//
// A LEAF over stores + the pure budget + the dialog: fileHandler (history family) calls
// it, it calls nothing that reaches history.

/** The last verdict the gate computed, whether or not it asked. LOCAL — a fact about
 * this device's budget, read by the suite and by nothing that replicates.
 * @type {import('svelte/store').Writable<any>} */
export const lastImportVerdict = writable(null);

/** What the scene already holds, in the unit the verdict compares. */
export function sceneCost() {
	return modelCost(get(objectsGroup));
}

/**
 * The verdict for a parsed model against the live scene on this device. PURE apart from
 * reading the two stores. @param {any} root
 */
export function verdictFor(root) {
	const verdict = importVerdict(sceneCost(), modelCost(root), profileFor(get(globalRenderer)));
	lastImportVerdict.set(verdict);
	return verdict;
}

/** The sentence the dialog says. @param {any} verdict @param {string} name */
export function gateMessage(verdict, name) {
	const reasons = verdict.asking.map(describeRow);
	const head =
		'"' + name + '" is ' + shortCount(verdict.incoming.triangles) + ' triangles in ' +
		verdict.incoming.meshes + ' mesh' + (verdict.incoming.meshes === 1 ? '' : 'es') + '. ';
	return (
		head +
		'Imported as it is, ' + reasons.join('; ') +
		' for this device. It may be slow, and on a phone or headset the tab can be closed by the browser.'
	);
}

/**
 * Ask when a parsed model would take this device past its budget.
 * Resolves `'load'` (let it in as it is) or `null` (cancelled). A model within budget
 * resolves `'load'` without a word.
 *
 * `extraChoices` is where a caller that can do better than all-or-nothing offers it
 * (the decimation choice is added by the caller that owns the Worker), so the dialog
 * stays ONE dialog however many ways out it has.
 *
 * @param {any} root the parsed tree
 * @param {{name?: string, extraChoices?: (verdict: any) => {value: string, label: string}[]}} [opts]
 * @returns {Promise<string|null>}
 */
export async function admitModel(root, opts = {}) {
	const verdict = verdictFor(root);
	if (!verdict.gate) return 'load';
	const name = String(opts.name ?? root?.name ?? '').trim() || 'This model';
	/** @type {{value: string, label: string}[]} */
	let extra = [];
	try {
		extra = opts.extraChoices ? opts.extraChoices(verdict) : [];
	} catch {
		extra = [];
	}
	try {
		return await showChoice({
			title: 'This model is heavy',
			message: gateMessage(verdict, name),
			choices: [...extra, { value: 'load', label: 'Load anyway' }],
			cancelLabel: 'Cancel'
		});
	} catch {
		// the ask is a courtesy; never let it stop an import it could not evaluate
		return 'load';
	}
}
