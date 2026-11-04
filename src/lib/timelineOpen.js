// 48 S1: open the Timeline on a sequence — the openHudEditor deep-link shape, through
// dynamic imports so a node card (or any leaf) keeps no static edge into the dock.

import { writable } from 'svelte/store';

/** fix-film: a range the Timeline should show next (Film's "Edit in timeline" on one shot): the
 * editor fits its view to it, parks the playhead at its start and selects `item`, then clears it.
 * @type {import('svelte/store').Writable<{seq: string, t0: number, t1: number, item?: string} | null>} */
export const timelineFocus = writable(null);

/** @param {string} [sequenceId] @param {{t0: number, t1: number, item?: string}} [range] */
export async function openTimeline(sequenceId, range) {
	const [appStore, dock, seqs] = await Promise.all([
		import('../stores/appStore.js'),
		import('./bottomDock.js'),
		import('./sequences.js')
	]);
	if (sequenceId) seqs.activeSequence.set(sequenceId);
	if (sequenceId && range) timelineFocus.set({ seq: sequenceId, ...range });
	appStore.timelineClose.set(false);
	dock.activateDock('timeline');
}
