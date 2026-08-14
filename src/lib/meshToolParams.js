import { writable, get } from 'svelte/store';

// 18-C2: the Edit Mesh toolbox's TOOL OPTIONS — the parameters a tool reads when
// it commits, plus which tool's options are currently showing.
//
// These were `$state` locals inside MeshEditPopup, which is why the options had
// to live in the same file as the tool grid. They are stores now so the grid and
// the extracted options pane can share one source without prop-drilling a value
// AND a setter for each of eight fields. A side benefit: the numbers survive
// leaving and re-entering a session, which is what a user expects of a tool
// setting.
//
// Pure UI preferences: nothing here replicates, records history or touches the
// operator layer. The operators still take their values as arguments.

/** M5: bevel width. Deliberately NOT `faceEditAmount` — that store is the FACE
 * op's signed distance, so sharing it would make arming Extrude change the
 * bevel width. */
export const bevelWidth = writable(0.1);
export const bevelSegments = writable(1);
/** 0 flat, >0 domes the cap out, <0 dishes it in (vertex + edge bevel) */
export const bevelProfile = writable(0);
/** M3: how many loops a Loop cut inserts — a COUNT, not the extrude distance */
export const loopCuts = writable(1);
/** M6: merge-by-distance threshold */
export const mergeDistance = writable(0.001);
/** M7: symmetrize axis + which half to keep @type {import('svelte/store').Writable<'x'|'y'|'z'>} */
export const symAxis = writable('x');
export const symKeep = writable(1);

/**
 * Which tool's options the pane shows. Not the same thing as the ARMED op
 * (`faceEditOp`): a parameterized one-shot like Bevel is selected — its options
 * are up, waiting for Apply — without changing what a viewport click does.
 * '' = nothing selected, and the pane renders nothing rather than empty chrome.
 * @type {import('svelte/store').Writable<string>}
 */
export const optionsFocus = writable('');

/** @param {string} tool */
export function focusTool(tool) {
	optionsFocus.set(tool);
}

/** Tools whose options pane has content — the rest leave the pane out entirely. */
const WITH_OPTIONS = new Set(['extrude', 'inset', 'move', 'knife', 'bevel', 'loopcut', 'proportional']);

/** @param {string} tool */
export function hasOptions(tool) {
	return WITH_OPTIONS.has(tool);
}

/**
 * What the pane should show when a tab is opened: the armed op in faces/edges
 * (extrude is the session default, so its amount is visible immediately), and
 * nothing in vertices, where no tool is armed until one is picked.
 * @param {string} mode @param {string} armed
 */
export function defaultFocus(mode, armed) {
	if (mode === 'vertices') return '';
	return hasOptions(armed) ? armed : '';
}

/** Reset to the defaults (Settings/tests). */
export function resetToolParams() {
	bevelWidth.set(0.1);
	bevelSegments.set(1);
	bevelProfile.set(0);
	loopCuts.set(1);
	mergeDistance.set(0.001);
	symAxis.set('x');
	symKeep.set(1);
	optionsFocus.set('');
}

/** Snapshot, for tests/debugging. */
export function toolParams() {
	return {
		bevelWidth: get(bevelWidth),
		bevelSegments: get(bevelSegments),
		bevelProfile: get(bevelProfile),
		loopCuts: get(loopCuts),
		mergeDistance: get(mergeDistance),
		symAxis: get(symAxis),
		symKeep: get(symKeep),
		optionsFocus: get(optionsFocus)
	};
}
