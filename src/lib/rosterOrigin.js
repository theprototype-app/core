// 80a R1: roster changes are tied to the connection that made them. A leaf: stores only.
import { get } from 'svelte/store';
import { userdata } from '../stores/appStore';

/** @type {Map<string, string>} row id -> the connection whose request is still open */
const origin = new Map();

/**
 * A `userdata` from `from` was applied. `before` = the ids in the roster before it.
 * @param {string} from @param {any[]} rows the rows taken from it @param {Set<string>} before
 * @param {boolean} provisional we are still waiting for `from` to approve us
 */
export function noteRosterRows(from, rows, before, provisional) {
	for (const row of rows) {
		const id = Array.isArray(row) ? row[0] : null;
		if (typeof id !== 'string' || id === from) continue;
		if (!provisional) origin.delete(id);
		else if (!before.has(id)) origin.set(id, from);
	}
}

/** `from` approved us: the rows it gave are ours now @param {string} from */
export function confirmRosterRows(from) {
	for (const [id, by] of origin) if (by === from) origin.delete(id);
}

/**
 * The request to `from` ended without an approval.
 * @param {string} from @param {{self?: string | null, linked?: (id: string) => boolean}} [keep]
 * @returns {string[]} the ids removed
 */
export function rollBackRosterRows(from, keep = {}) {
	/** @type {string[]} */
	const gone = [];
	for (const [id, by] of origin) {
		if (by !== from) continue;
		origin.delete(id);
		if (id === keep.self || keep.linked?.(id)) continue;
		gone.push(id);
	}
	if (gone.length) userdata.set(/** @type {any} */ (/** @type {any[]} */ (get(userdata)).filter((u) => !gone.includes(u[0]))));
	return gone;
}

/** which connection a row is waiting on (tests, diagnostics) @param {string} id */
export function rosterOriginOf(id) {
	return origin.get(id) ?? null;
}

/**
 * The rows we hand to others.
 * @param {any[]} rows @param {any[]} waiting `waitingForApproval`
 */
export function shareableRosterRows(rows, waiting) {
	if (!Array.isArray(rows) || !waiting?.length) return rows;
	const asking = new Set(waiting.filter((w) => w?.[1] === 'pending').map((w) => w[0]));
	return asking.size ? rows.filter((r) => !asking.has(r?.[0])) : rows;
}
