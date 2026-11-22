// 2.0-int (boot size): the assistant's STORES and its two entry points, as a leaf. The chat window, the
// quick-prompt pill and Welcome read these on the editor boot; the orchestrator (assistant.js) and the
// whole agent tool set behind it (ai/tools, lookTools, flowTools, ~150 KB gz) load on the first prompt.
// assistant.js re-exports these same stores, so both import paths see one conversation.
import { writable } from 'svelte/store';

/**
 * @typedef {{role: 'user'|'assistant'|'tool-status'|'error'|'summary', content: string, streaming?: boolean, images?: {url: string, name: string}[]}} UiMessage
 */

/** @type {import('svelte/store').Writable<UiMessage[]>} */
export const aiMessages = writable([]);
export const aiBusy = writable(false);
/** Transient status while a run is in flight (reasoning models emit thinking tokens
 * for a long time before any content — without this the window looks frozen). */
export const aiStatus = writable('');

/** @type {Promise<typeof import('./assistant.js')> | null} */
let loading = null;
/** @type {typeof import('./assistant.js') | null} */
let loaded = null;
const load = () =>
	(loading ??= import('./assistant.js').then((m) => (loaded = m)).catch((e) => {
		loading = null;
		throw e;
	}));

/** Send a prompt (loads the assistant on first use). @param {string} text @param {any[]} [images] */
export async function runPrompt(text, images = []) {
	const m = await load();
	return m.runPrompt(text, images);
}

/** Cancel the in-flight run. Nothing to cancel before the assistant has loaded. */
export function stopAi() {
	loaded?.stopAi();
}
