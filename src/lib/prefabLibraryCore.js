// 37 R4 — THE PREFAB LIBRARY'S ORGANISATION, as pure functions (imports nothing).
//
// A prefab record may carry `folder` (a path, segments joined by '/', '' = the root) and
// `tags` (lower-case strings). Folders also exist on their own (an EMPTY folder you just
// made is a place too), so the view is built from the records AND an explicit path list.
// Everything here is LOCAL — the library is personal, only placed instances replicate.

/** @param {any} tag */
export function normTag(tag) {
	return String(tag ?? '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.replace(/,/g, '')
		.slice(0, 32);
}

/** A list of tags from user text ("wood, chair  outdoor" -> three), de-duplicated.
 * @param {any} text @returns {string[]} */
export function parseTags(text) {
	/** @type {string[]} */
	const out = [];
	for (const raw of String(text ?? '').split(',')) {
		const tag = normTag(raw);
		if (tag && !out.includes(tag)) out.push(tag);
	}
	return out;
}

/** One folder NAME (no separators). @param {any} name */
export function normFolderName(name) {
	return String(name ?? '')
		.replace(/[/\\]/g, ' ')
		.trim()
		.replace(/\s+/g, ' ')
		.slice(0, 64);
}

/** A folder path: each segment cleaned, empties dropped. @param {any} path */
export function normFolder(path) {
	return String(path ?? '')
		.split('/')
		.map(normFolderName)
		.filter(Boolean)
		.join('/');
}

/** @param {string} path */
export function parentOf(path) {
	const i = path.lastIndexOf('/');
	return i < 0 ? '' : path.slice(0, i);
}

/** @param {string} path */
export function nameOf(path) {
	return path.slice(path.lastIndexOf('/') + 1);
}

/** Is `path` at or below `folder`? @param {string} path @param {string} folder */
export function within(path, folder) {
	return !folder || path === folder || path.startsWith(folder + '/');
}

/** Every folder that exists: the explicit list, every record's folder, and all their
 * ancestors. @param {any[]} prefabs @param {string[]} explicit @returns {Set<string>} */
export function folderPaths(prefabs, explicit) {
	/** @type {Set<string>} */
	const out = new Set();
	const add = (/** @type {string} */ p) => {
		for (let cur = normFolder(p); cur; cur = parentOf(cur)) out.add(cur);
	};
	for (const p of explicit ?? []) add(p);
	for (const p of prefabs ?? []) add(p?.folder ?? '');
	return out;
}

/** Every tag in use with its count, most used first. @param {any[]} prefabs */
export function allTags(prefabs) {
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const p of prefabs ?? []) for (const t of p?.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
	return [...counts]
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * What the Prefabs view shows: the sub-folders of `folder` and the prefabs in it — or, as
 * soon as a search or a tag filter is on, every matching prefab at or below `folder` and
 * no folder cards (a filter is a question about prefabs, the Explorer's search rule).
 * Tags combine with AND; the search matches the name or any tag.
 * @param {any[]} prefabs @param {string[]} explicit @param {string} folder
 * @param {string[]} tags @param {string} query
 * @returns {{folders: {path: string, name: string, count: number}[], items: any[]}}
 */
export function prefabView(prefabs, explicit, folder, tags, query) {
	const here = normFolder(folder);
	const q = String(query ?? '')
		.trim()
		.toLowerCase();
	const filtering = !!q || (tags?.length ?? 0) > 0;
	const list = prefabs ?? [];
	if (filtering) {
		const items = list.filter((p) => {
			const ptags = p?.tags ?? [];
			if (!within(normFolder(p?.folder), here)) return false;
			if (!(tags ?? []).every((t) => ptags.includes(t))) return false;
			if (!q) return true;
			return String(p?.name ?? '').toLowerCase().includes(q) || ptags.some((/** @type {string} */ t) => t.includes(q));
		});
		return { folders: [], items };
	}
	const paths = folderPaths(list, explicit);
	const folders = [...paths]
		.filter((p) => parentOf(p) === here)
		.map((path) => ({
			path,
			name: nameOf(path),
			count: list.filter((p) => within(normFolder(p?.folder), path)).length
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	return { folders, items: list.filter((p) => normFolder(p?.folder) === here) };
}

/** A name for a new folder under `parent` that is not taken. @param {Set<string>} paths
 * @param {string} parent @param {string} [base] */
export function freeFolderName(paths, parent, base = 'New folder') {
	const stem = normFolderName(base) || 'New folder';
	const join = (/** @type {string} */ n) => (parent ? parent + '/' + n : n);
	if (!paths.has(join(stem))) return stem;
	for (let i = 2; ; i++) if (!paths.has(join(stem + ' ' + i))) return stem + ' ' + i;
}

/** Re-home a path when folder `from` becomes `to` (a rename or a move). @param {string} path
 * @param {string} from @param {string} to */
export function rebase(path, from, to) {
	if (path === from) return to;
	if (path.startsWith(from + '/')) return (to ? to + '/' : '') + path.slice(from.length + 1);
	return path;
}
