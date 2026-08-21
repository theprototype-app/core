// 21-F2: the options a game RECIPE asks for before it builds anything.
//
// `confirmDialog.js`'s shape verbatim — a promise-based store plus a component that
// renders it — and deliberately not a new pattern. A svelte/store-only LEAF, so
// `gameRecipes.js` (which reaches history through flowGraphs) can import it without
// closing anything, exactly like sessions.js imports the confirm dialog.
//
// WHY A DIALOG AT ALL, when "Make collectible" prompts nothing: the plain entry has to
// stay a ONE-CLICK answer — that is the whole point of a recipe — so the questions live
// on a second entry ("Make collectible into…") for the moment you want a different
// variable or a respawn. Same split as a menu item with and without an ellipsis
// everywhere else in this app.
import { writable } from 'svelte/store';

/**
 * @typedef {{ variable: string, respawn: number }} CollectibleOptions
 */

/** The active recipe dialog, or null. Rendered by `menu/CollectibleDialog.svelte`.
 * @type {import('svelte/store').Writable<any>} */
export const recipeDialog = writable(null);

/**
 * Ask for a collectible's variable and respawn. Resolves the chosen options, or `null`
 * for cancel / Esc / outside-close, so a caller can `if (!answer) return`.
 *
 * A second dialog replaces the first and resolves it null — a dangling promise is how a
 * recipe would silently never run (read-then-set, never write a store from its own
 * subscriber).
 * @param {{ variables?: string[], variable?: string, respawn?: number, count?: number }} opts
 * @returns {Promise<CollectibleOptions|null>}
 */
export function showCollectibleOptions(opts = {}) {
	return new Promise((resolve) => {
		recipeDialog.update((previous) => {
			if (previous?.resolve) previous.resolve(null);
			return {
				kind: 'collectible',
				variables: opts.variables ?? [],
				variable: opts.variable ?? '',
				respawn: Number(opts.respawn) || 0,
				count: opts.count ?? 1,
				resolve
			};
		});
	});
}

/** Settle the active dialog: the chosen options, or null for every kind of cancel.
 * @param {CollectibleOptions|null} answer */
export function resolveRecipeDialog(answer) {
	recipeDialog.update((current) => {
		if (current?.resolve) current.resolve(answer && answer.variable ? answer : null);
		return null;
	});
}
