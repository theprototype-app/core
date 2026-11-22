// 105 T1: the Explorer picker's arithmetic — which library files a picker shows, in what order, and the
// "recent" list. PURE (imports nothing), so the filtering is unit-tested with no browser.

/** how many recent picks are remembered */
export const RECENT_MAX = 12;

/**
 * Does this library record match the kinds a picker accepts?
 * `accept` is a list of item kinds ('image') and/or file extensions ('.svg'); empty = everything.
 * @param {{kind?: string | null, name?: string}} item @param {string[]} accept
 */
export function acceptsItem(item, accept) {
	if (!accept?.length) return true;
	const name = String(item?.name ?? '').toLowerCase();
	return accept.some((rule) => (rule.startsWith('.') ? name.endsWith(rule.toLowerCase()) : item?.kind === rule));
}

/**
 * Every folder id at or under `folderId` (the folder plus its subtree), from the flat folder list.
 * @param {{id: string, parentId: string | null}[]} folders @param {string} folderId @returns {Set<string>}
 */
export function subtreeIds(folders, folderId) {
	const out = new Set([folderId]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const folder of folders) {
			if (folder.parentId && out.has(folder.parentId) && !out.has(folder.id)) {
				out.add(folder.id);
				grew = true;
			}
		}
	}
	return out;
}

/**
 * The files a picker lists.
 *   query    — every word must appear in the name (case-insensitive)
 *   folderId — undefined/'all' = everywhere; null/'root' = the Library root only; an id = that folder and
 *              everything under it (a folder is a place you look IN, so its subfolders count)
 * Sorted newest first, then name, then id, so two pickers over one library agree on the order.
 * @template {{id: string, name?: string, kind?: string | null, folderId?: string | null, createdAt?: number}} T
 * @param {T[]} items
 * @param {{id: string, parentId: string | null}[]} folders
 * @param {{query?: string, folderId?: string | null, accept?: string[]}} [opts]
 * @returns {T[]}
 */
export function filterPickerItems(items, folders, opts = {}) {
	const words = String(opts.query ?? '')
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	const folderId = opts.folderId;
	/** @type {Set<string> | null} */
	const inFolders = folderId && folderId !== 'all' && folderId !== 'root' ? subtreeIds(folders ?? [], folderId) : null;
	const rootOnly = folderId === null || folderId === 'root';
	return (items ?? [])
		.filter((item) => {
			if (!acceptsItem(item, opts.accept ?? [])) return false;
			if (rootOnly && item.folderId) return false;
			if (inFolders && !inFolders.has(String(item.folderId ?? ''))) return false;
			const name = String(item.name ?? '').toLowerCase();
			return words.every((word) => name.includes(word));
		})
		.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || String(a.name ?? '').localeCompare(String(b.name ?? '')) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The folders worth offering: those holding at least one accepted file somewhere under them, with their
 * path for the label, sorted by path.
 * @param {{id: string, kind?: string | null, name?: string, folderId?: string | null}[]} items
 * @param {{id: string, name: string, parentId: string | null}[]} folders
 * @param {string[]} [accept]
 * @returns {{id: string, path: string}[]}
 */
export function pickerFolders(items, folders, accept = []) {
	const byId = new Map((folders ?? []).map((folder) => [folder.id, folder]));
	/** @type {Set<string>} */
	const used = new Set();
	for (const item of items ?? []) {
		if (!acceptsItem(item, accept)) continue;
		let id = item.folderId ?? null;
		let guard = 0;
		while (id && byId.has(id) && !used.has(id) && guard++ < 64) {
			used.add(id);
			id = byId.get(id)?.parentId ?? null;
		}
	}
	/** @param {string} id */
	const pathOf = (id) => {
		/** @type {string[]} */
		const names = [];
		let at = byId.get(id);
		let guard = 0;
		while (at && guard++ < 64) {
			names.unshift(at.name);
			at = at.parentId ? byId.get(at.parentId) : undefined;
		}
		return names.join(' / ');
	};
	return [...used].map((id) => ({ id, path: pathOf(id) })).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The recent list after picking `id`: it moves to the front, no duplicates, capped.
 * @param {string[]} recent @param {string} id @returns {string[]}
 */
export function withRecent(recent, id) {
	return [id, ...(recent ?? []).filter((other) => other !== id)].slice(0, RECENT_MAX);
}

/**
 * The recent picks that still exist and still match, in recent order.
 * @template {{id: string}} T @param {string[]} recent @param {T[]} listed @returns {T[]}
 */
export function recentItems(recent, listed) {
	const byId = new Map((listed ?? []).map((item) => [item.id, item]));
	return (recent ?? []).map((id) => byId.get(id)).filter((item) => !!item);
}
