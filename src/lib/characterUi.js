// 57 — the character tools' OPEN STATE (Apply clip…, Download…, the Skeleton view). A LEAF: the
// stores only, so the Inspector, the object menu and the Animation window can open a dialog
// without importing it — the dialogs and their code load when one opens (CharacterDialogs.svelte).

import { writable } from 'svelte/store';

/** @typedef {import('./humanoid/humanoidRig.js').ClipSource} ClipSource */

/** Apply clip…: what is preselected (null = closed) @type {import('svelte/store').Writable<{targets?: string[], src?: ClipSource} | null>} */
export const applyClipRequest = writable(null);

/** Download…: the objects it downloads (null = closed) @type {import('svelte/store').Writable<{uuids: string[]} | null>} */
export const downloadRequest = writable(null);

/** the Skeleton view's model (null = closed) @type {import('svelte/store').Writable<string | null>} */
export const skeletonTarget = writable(null);

/** @param {{targets?: string[], src?: ClipSource}} [req] */
export function openApplyClip(req = {}) {
	applyClipRequest.set({ ...req });
}

/** @param {string[]} uuids */
export function openDownload(uuids) {
	if (uuids.length) downloadRequest.set({ uuids: [...uuids] });
}

/** @param {string} uuid */
export function openSkeleton(uuid) {
	skeletonTarget.set(uuid);
}
