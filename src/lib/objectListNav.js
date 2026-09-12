// 24-B2: keyboard navigation for the object list — the pure part. The Explorer's
// gridKeydown precedent: a FLAT visible order, then ±1 over it. This module imports
// nothing (the inputDevice.js shape), so the row component, the host and the suite
// can all use it.

/**
 * @typedef {{ uuid: string, depth: number, hasKids: boolean, parent: string | null, name: string }} ObjectRow
 */

/**
 * The rows the list is SHOWING, top to bottom: a DFS over the replicated group that
 * skips local-only objects (the host filters them), honours the expansion set, and —
 * while a search filter is on — skips rows the filter hides (their expanded ancestors
 * still count, exactly as they render).
 * @param {any} group objectsGroup
 * @param {Set<string>} expanded
 * @param {Set<string> | null | undefined} filter visible-uuid set, null = no filter
 * @returns {ObjectRow[]}
 */
export function visibleObjectRows(group, expanded, filter) {
	/** @type {ObjectRow[]} */
	const rows = [];
	/** @param {any} object @param {number} depth @param {string | null} parent */
	const walk = (object, depth, parent) => {
		if (!object || object.userData?.__localOnly) return;
		if (filter && !filter.has(object.uuid)) return;
		const kids = object.children ?? [];
		rows.push({ uuid: object.uuid, depth, hasKids: kids.length > 0, parent, name: object.name || object.type || '' });
		if (kids.length && expanded?.has(object.uuid)) for (const kid of kids) walk(kid, depth + 1, object.uuid);
	};
	for (const child of group?.children ?? []) walk(child, 0, null);
	return rows;
}

/** A new expansion set with `uuid` added or removed (stores want a fresh Set).
 * @param {Set<string>} set @param {string} uuid @param {boolean} on */
export function withExpanded(set, uuid, on) {
	const next = new Set(set ?? []);
	if (on) next.add(uuid);
	else next.delete(uuid);
	return next;
}

/**
 * Type-ahead: the next row (cyclically, AFTER `from`) whose name starts with `prefix`,
 * or -1. Case-insensitive; a one-letter prefix skips the current row so repeated
 * presses of the same letter cycle (the OS-outliner convention).
 * @param {ObjectRow[]} rows @param {string} prefix @param {number} from
 */
export function typeAheadIndex(rows, prefix, from) {
	const p = String(prefix || '').toLowerCase();
	if (!p || !rows.length) return -1;
	const n = rows.length;
	const start = prefix.length > 1 ? from : from + 1;
	for (let i = 0; i < n; i++) {
		const index = (((start + i) % n) + n) % n;
		if (rows[index].name.toLowerCase().startsWith(p)) return index;
	}
	return -1;
}
