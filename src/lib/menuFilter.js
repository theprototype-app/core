// Flatten + rank helpers for the shared context-menu type-to-filter (16-P1).
// Split out of ContextMenu.svelte so the ranking is ONE implementation: the node
// editor used to carry its own search box with its own scoring (16-P2), and the
// pure functions are unit-testable from e2e without opening a menu.

/**
 * Every runnable LEAF of a menu tree, with the submenu path that reaches it.
 * Section labels and the header strip are skipped (they aren't actions).
 * @param {any[]} list
 * @param {string[]} [path]
 * @param {{item: any, path: string[]}[]} [out]
 * @returns {{item: any, path: string[]}[]}
 */
export function collectLeaves(list, path = [], out = []) {
	for (const item of list ?? []) {
		// `revealFilter` rows (the node editor's "Search nodes…") open the search box
		// itself — matching them inside their own results is noise (16-Q1)
		if (!item || item.section || item.header || item.revealFilter) continue;
		if (item.children) collectLeaves(item.children, [...path, item.label], out);
		else if (item.label) out.push({ item, path });
	}
	return out;
}

/** every query char appears in order (fuzzy fallback)
 * @param {string} text @param {string} query */
function subsequence(text, query) {
	let i = 0;
	for (const ch of text) if (ch === query[i]) i++;
	return i >= query.length;
}

/** result cap — the menu scrolls, but a 300-row list is nobody's friend */
const MAX_MATCHES = 40;

/**
 * Rank leaves against a query: label prefix beats path prefix beats substring
 * beats fuzzy; ties sort alphabetically. Returns the SAME entry shape as
 * `collectLeaves` (plus `rank`) so callers keep rendering `path ▸ label`.
 * @param {{item: any, path: string[]}[]} leaves
 * @param {string} query
 * @param {number} [max]
 */
export function rankMatches(leaves, query, max = MAX_MATCHES) {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	return leaves
		.map((entry) => {
			const label = String(entry.item.label ?? '').toLowerCase();
			const text = [...entry.path, entry.item.label].join(' ').toLowerCase();
			const rank = label.startsWith(q)
				? 0
				: text.startsWith(q)
					? 1
					: text.includes(q)
						? 2
						: subsequence(text, q)
							? 3
							: 4;
			return { ...entry, rank };
		})
		.filter((entry) => entry.rank < 4)
		.sort(
			(a, b) =>
				a.rank - b.rank || String(a.item.label).localeCompare(String(b.item.label))
		)
		.slice(0, max);
}
