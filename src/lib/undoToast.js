// 37 R25 — UNDO, OFFERED RIGHT AFTER A DESTRUCTIVE ACTION.
//
// The rule the user approved: the action HAPPENS (no extra confirm stacked on top), and a
// toast offers Undo for ~8 s; pressing it restores exactly what was there, for everyone in
// the session. This module owns only the OFFER — the toast entry, its lifetime and the
// once-only press. What "restore" means belongs to each caller (a scene snapshot re-applied
// through the replicated load path, a module record re-installed, …), handed in as `undo`.
//
// The entry rides the ordinary toast pipeline (Toasts.svelte renders it as an action card,
// the Connect drawer's Toasts tab lists it live), with two differences from showToast:
//  - its LIFETIME is the module's, not the card's. Toasts.svelte's auto-dismiss is an action
//    on the RENDERED card, so a card folded behind "+N more" or hidden while the drawer is
//    open would never expire, and an Undo pressed a minute later would rewind a minute of
//    other people's work. The timer here removes the entry whatever is on screen; the card
//    shows the remaining time as a draining bar (`ttl`, `kind: 'undo'`).
//  - the notification centre gets the TEXT only. An Undo button kept in the history would
//    outlive the window it was offered for.
//
// A LEAF: appStore + svelte/store only, so any caller — including the history family — can
// import it statically.

import { get } from 'svelte/store';
import { toastStore, pushNotification, showToast } from '../stores/appStore';

/** how long an Undo stays on offer, in ms */
export const UNDO_MS = 8000;

/** @type {Map<string, {timer: any, entry: any}>} the live offers, by id */
const live = new Map();
/** the suites' view: offers made, presses, expiries */
const debug = { offered: 0, undone: 0, expired: 0, failed: 0, last: /** @type {string | null} */ (null) };

/** @param {any} entry */
function drop(entry) {
	toastStore.update((list) => list.filter((/** @type {any} */ t) => t !== entry));
}

/**
 * Offer an Undo. A second offer under the same `id` replaces the first (the newer action is
 * the one a person means to take back).
 * @param {{id: string, text: string, undo: () => any, ms?: number, done?: string,
 *   actions?: {label: string, action: () => void}[]}} opts
 *   `done` = the toast after a successful undo; `actions` = extra buttons AFTER Undo
 * @returns {{id: string, cancel: () => void}}
 */
export function offerUndo({ id, text, undo, ms = UNDO_MS, done = 'Undone', actions = [] }) {
	withdrawUndo(id);
	let used = false;
	/** @type {any} */
	const entry = {
		id: 'undo:' + id,
		text,
		kind: 'undo',
		ttl: ms,
		// the card's ✕ (Toasts.svelte calls onDismiss) ends the offer too
		onDismiss: () => {
			used = true;
			clear();
		},
		actions: [
			{
				label: 'Undo',
				action: () => {
					if (used) return;
					used = true;
					clear();
					debug.undone++;
					Promise.resolve()
						.then(() => undo())
						.then(
							(ok) => {
								if (ok !== false && done) showToast(done);
							},
							(error) => {
								debug.failed++;
								console.warn('[undo] failed', error);
								showToast('Could not undo — ' + (error?.message ?? 'something went wrong'));
							}
						);
				}
			},
			...actions.map((a) => ({
				label: a.label,
				action: () => {
					used = true;
					clear();
					a.action();
				}
			}))
		]
	};
	const clear = () => {
		const at = live.get(id);
		if (at?.entry === entry) {
			clearTimeout(at?.timer);
			live.delete(id);
		}
		drop(entry);
	};
	const timer = setTimeout(() => {
		if (live.get(id)?.entry !== entry) return;
		live.delete(id);
		used = true;
		debug.expired++;
		drop(entry);
	}, ms);
	live.set(id, { timer, entry });
	toastStore.update((list) => [...list, entry]);
	pushNotification(text, 'info');
	debug.offered++;
	debug.last = id;
	return { id, cancel: clear };
}

/** Take an offer back (the thing it would undo has moved on). @param {string} id */
export function withdrawUndo(id) {
	const at = live.get(id);
	if (!at) return;
	clearTimeout(at.timer);
	live.delete(id);
	drop(at.entry);
}

/** is an Undo on offer under this id @param {string} id */
export function undoOffered(id) {
	return live.has(id);
}

/** the suites' view */
export function undoToastDebug() {
	return { ...debug, live: [...live.keys()], toasts: get(toastStore).filter((/** @type {any} */ t) => t?.kind === 'undo').length };
}
