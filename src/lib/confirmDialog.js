// V4 (versioning): a promise-based confirm dialog for load-anyway decisions
// (newer .tpscene/.tpmodule formats). Svelte/store-only LEAF — safe to import
// from sessions.js / userModules.js without closing a cycle.
import { writable } from 'svelte/store';

/** The active dialog, or null. `{title, message, confirmLabel, cancelLabel, resolve}`
 * @type {import('svelte/store').Writable<any>} */
export const confirmDialog = writable(null);

/**
 * Show a confirm dialog and resolve true (confirm) / false (cancel or outside
 * close). A second dialog replaces the first, resolving it false — the previous
 * promise must never dangle. (Read-then-set, never write the store from its own
 * subscriber.)
 * @param {{title?: string, message: string, confirmLabel?: string, cancelLabel?: string}} opts
 * @returns {Promise<boolean>}
 */
export function showConfirm(opts) {
	return new Promise((resolve) => {
		confirmDialog.update((previous) => {
			if (previous?.resolve) previous.resolve(false);
			return {
				title: opts.title || 'Are you sure?',
				message: opts.message || '',
				confirmLabel: opts.confirmLabel || 'OK',
				cancelLabel: opts.cancelLabel || 'Cancel',
				resolve
			};
		});
	});
}

/** Settle the active dialog (ConfirmModal buttons + outside-close). @param {boolean} answer */
export function resolveConfirm(answer) {
	confirmDialog.update((current) => {
		if (current?.resolve) current.resolve(!!answer);
		return null;
	});
}
