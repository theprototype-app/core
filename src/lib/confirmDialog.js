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

/** Settle the active dialog. A boolean dialog gets true/false; a `choices` dialog
 * gets the chosen value STRING (its own resolve wrapper normalizes anything else
 * to null), which is why this no longer coerces with `!!`.
 * @param {boolean|string} answer */
export function resolveConfirm(answer) {
	confirmDialog.update((current) => {
		if (current?.resolve) current.resolve(typeof answer === 'string' ? answer : !!answer);
		return null;
	});
}

/**
 * A6.2: the same dialog with MORE THAN TWO answers — the module-requirement prompt
 * needs Install / Enable / Load anyway / Cancel, and a boolean cannot carry that.
 *
 * Resolves the chosen entry's `value`, or `null` for cancel / Esc / outside-close,
 * so a caller can `if (!choice) return` exactly like the boolean form. The boolean
 * `showConfirm` above is untouched: it is the same store with no `choices` field,
 * which is what ConfirmModal branches on.
 * @param {{title?: string, message: string, choices: {value: string, label: string,
 *   color?: string}[], cancelLabel?: string}} opts
 * @returns {Promise<string|null>}
 */
export function showChoice(opts) {
	return new Promise((resolve) => {
		confirmDialog.update((previous) => {
			if (previous?.resolve) previous.resolve(false);
			return {
				title: opts.title || 'Choose',
				message: opts.message || '',
				choices: opts.choices ?? [],
				cancelLabel: opts.cancelLabel || 'Cancel',
				// ConfirmModal calls resolveConfirm(value) for a choice and
				// resolveConfirm(false) for cancel; normalize both here so the caller
				// only ever sees a string or null
				resolve: (/** @type {any} */ answer) =>
					resolve(typeof answer === 'string' && answer ? answer : null)
			};
		});
	});
}
