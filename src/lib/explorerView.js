// ROADMAP 22 ROUND 9 — HOW THE EXPLORER IS LAID OUT: thumbnails, or a sortable list.
//
// WHY A LEAF. Two of the three things here are pure — which column a row sorts on, and
// how two rows compare — and a comparator is exactly the kind of code that is cheap to
// get subtly wrong and cheap to pin with a test. Stores plus arithmetic, no idb, no
// protocol, nothing imported from the Explorer (the `transferLedger` / `hudArrange`
// shape), so the whole of `sortEntries` is testable with no browser and no library.
//
// LOCAL, always. A view mode, a column set and a sort direction are facts about this
// screen. Nothing here replicates, saves into a scene or undoes — which is also why the
// persistence is a bare localStorage mirror rather than anything in the manifest.
//
// THE SPLIT THAT MATTERS: the view MODE is ONE global preference while COLUMNS and SORT
// are per VIEW. A single segmented control in the header must not appear to do nothing
// when you walk into another folder, so the mode is global. Columns cannot be: the
// Deleted view owns two columns the library has no value for ("deleted by", "deleted
// at") and the library owns ones a log row cannot answer (a bin row has no size, and its
// "added" date IS its deleted date), so one shared set would either hide the only
// columns that distinguish the bin or leave dead columns in the library.

import { writable, get } from 'svelte/store';

/**
 * @typedef {{key: string, label: string, always?: boolean, numeric?: boolean, width?: string}} ExplorerColumn
 */

/**
 * The library's columns, in their fixed left-to-right order. NAME is `always`: every
 * other column describes a row, and a row with no name cannot be identified at all — so
 * it is the one column the per-column menu does not offer to hide.
 * @type {ExplorerColumn[]}
 */
export const LIBRARY_COLUMNS = [
	// R22 round 11: NAME carries a width like every other column now. It used to be the
	// only one without, so `table-layout: fixed` handed it whatever was left — which is
	// exactly the behaviour a resize grip cannot coexist with (drag another column and
	// this one silently absorbs the difference). The remainder is a SPACER cell's job.
	{ key: 'name', label: 'Name', always: true, width: '220px' },
	{ key: 'kind', label: 'Type', width: '72px' },
	{ key: 'size', label: 'Size', numeric: true, width: '76px' },
	{ key: 'added', label: 'Added', numeric: true, width: '104px' },
	{ key: 'owner', label: 'Owner', width: '112px' }
];

/**
 * The bin's columns. `size` is deliberately absent — the log records what a file WAS, not
 * how big it was, and once the bytes are reclaimed the number can never be derived again,
 * so a column of zeroes would be a lie rather than a gap.
 * @type {ExplorerColumn[]}
 */
export const DELETED_COLUMNS = [
	{ key: 'name', label: 'Name', always: true, width: '220px' },
	{ key: 'kind', label: 'Type', width: '72px' },
	{ key: 'deletedBy', label: 'Deleted by', width: '116px' },
	{ key: 'deletedAt', label: 'Deleted at', numeric: true, width: '124px' }
];

/** Which column set a view uses. @param {string} view @returns {ExplorerColumn[]} */
export function columnsFor(view) {
	return view === 'deleted' ? DELETED_COLUMNS : LIBRARY_COLUMNS;
}

const MODE_KEY = 'explorer:viewMode';
const COLS_KEY = 'explorer:columns';
const SORT_KEY = 'explorer:sort';
const GROUP_KEY = 'explorer:deletedGroup';

/** @param {string} key @param {any} fallback */
function load(key, fallback) {
	if (typeof localStorage === 'undefined') return fallback;
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return fallback;
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? { ...fallback, ...parsed } : fallback;
	} catch {
		return fallback;
	}
}

/** @param {string} key @param {any} value */
function save(key, value) {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {}
}

/**
 * 'thumbnails' (the grid the Explorer has always been) or 'list'. GLOBAL — see the header.
 * @type {import('svelte/store').Writable<'thumbnails'|'list'>}
 */
export const explorerViewMode = writable(
	/** @type {'thumbnails'|'list'} */ (
		typeof localStorage !== 'undefined' && localStorage.getItem(MODE_KEY) === 'list'
			? 'list'
			: 'thumbnails'
	)
);
explorerViewMode.subscribe((v) => {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(MODE_KEY, v);
	} catch {}
});

/**
 * Which columns are visible, per view. Stored as the VISIBLE keys rather than the hidden
 * ones so a column added in a later release shows by default instead of being silently
 * suppressed by every existing install's saved set.
 * @type {import('svelte/store').Writable<Record<string, string[]>>}
 */
export const explorerColumns = writable(
	load(COLS_KEY, {
		library: LIBRARY_COLUMNS.map((c) => c.key),
		deleted: DELETED_COLUMNS.map((c) => c.key)
	})
);
explorerColumns.subscribe((v) => save(COLS_KEY, v));

/**
 * The sort, per view. `dir` is 1 ascending / -1 descending. The bin defaults to newest
 * first, which is the only useful default for a log.
 * @type {import('svelte/store').Writable<Record<string, {key: string, dir: number}>>}
 */
export const explorerSort = writable(
	load(SORT_KEY, {
		library: { key: 'name', dir: 1 },
		deleted: { key: 'deletedAt', dir: -1 }
	})
);
explorerSort.subscribe((v) => save(SORT_KEY, v));

/**
 * How the bin is grouped: 'none' or by 'deleter'. Its own store rather than a column
 * flag, because grouping changes the SHAPE of the view (it mints folder rows) where a
 * column only changes what a row shows.
 * @type {import('svelte/store').Writable<'none'|'deleter'>}
 */
export const explorerDeletedGroup = writable(
	/** @type {'none'|'deleter'} */ (
		typeof localStorage !== 'undefined' && localStorage.getItem(GROUP_KEY) === 'deleter'
			? 'deleter'
			: 'none'
	)
);
explorerDeletedGroup.subscribe((v) => {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(GROUP_KEY, v);
	} catch {}
});

const WIDTH_KEY = 'explorer:columnWidths';
const ORDER_KEY = 'explorer:columnOrder';

/** the narrowest a column may be dragged, and the widest. A column under ~48px shows no
 * text at all, and one over 600px is a scrollbar with a header on it. */
export const MIN_COLUMN_W = 48;
export const MAX_COLUMN_W = 600;

/**
 * R22 round 11 (user): "should allow ajust size of columns and drag order".
 *
 * PER VIEW, like the visible set and the sort, and for the same reason the leaf's header
 * gives: the bin and the library do not share a column set, so they cannot share widths
 * keyed by column name either — "Deleted at" is not "Added" and a width dragged on one is
 * meaningless on the other.
 *
 * Stored as `{view: {key: px}}` and SPARSE: a column with no entry uses the width it
 * declares above, so a column whose default changes in a later release moves for everyone
 * who never dragged it.
 * @type {import('svelte/store').Writable<Record<string, Record<string, number>>>}
 */
export const explorerColumnWidths = writable(load(WIDTH_KEY, { library: {}, deleted: {} }));
explorerColumnWidths.subscribe((v) => save(WIDTH_KEY, v));

/**
 * The user's column ORDER, per view, as a key array.
 *
 * A key array rather than an index map, and APPEND-not-hide for anything it does not
 * mention — the same rule `explorerColumns` states for the visible set, and it is the rule
 * that decides what happens to a column added in a later release: it appears, at the end,
 * rather than being silently suppressed by every saved pref in existence.
 * @type {import('svelte/store').Writable<Record<string, string[]>>}
 */
export const explorerColumnOrder = writable(load(ORDER_KEY, { library: [], deleted: [] }));
explorerColumnOrder.subscribe((v) => save(ORDER_KEY, v));

/**
 * Apply a stored order to a canonical column list. PURE.
 *
 * NAME IS PINNED FIRST and cannot be dragged away from the left edge. That is a decision,
 * not a limitation: the name cell is also the row's drag handle, its inline-rename target
 * and where its status dot lives, so it is the row's identity rather than one of its
 * facts — which is why Finder pins it too. Every other column is free.
 *
 * @param {ExplorerColumn[]} cols the canonical list, in declaration order
 * @param {string[]} [order] the stored key order; anything missing keeps its canonical
 *   place relative to the columns that ARE named
 * @returns {ExplorerColumn[]} a new array
 */
export function orderColumns(cols, order) {
	const list = cols ?? [];
	const wanted = (order ?? []).filter((k) => list.some((c) => c.key === k));
	if (!wanted.length) return [...list];
	const named = wanted.map((k) => list.find((c) => c.key === k)).filter(Boolean);
	// unknown to the pref (a column added since it was saved) keeps its canonical index,
	// which is what "appended rather than hidden" means when the addition is in the middle
	const rest = list.filter((c) => !wanted.includes(c.key));
	/** @type {any[]} */
	const out = [];
	let n = 0;
	for (const col of list) {
		if (rest.includes(col)) out.push(col);
		else out.push(named[n++]);
	}
	// ...then the pin. A stored order from a build that allowed it, or a hand-edited
	// localStorage, must not be able to strand the identity column in the middle.
	const nameAt = out.findIndex((c) => c.always);
	if (nameAt > 0) out.unshift(out.splice(nameAt, 1)[0]);
	return out;
}

/**
 * How wide one column is drawn, in px. Falls back to its declared width, then to a
 * readable default for a column that declares none.
 * @param {ExplorerColumn} col
 * @param {Record<string, number>} [stored] this view's width map
 * @returns {number}
 */
export function widthOf(col, stored) {
	const px = stored?.[col?.key ?? ''];
	if (Number.isFinite(px)) return clampColumnWidth(/** @type {number} */ (px));
	const declared = parseInt(String(col?.width ?? ''), 10);
	return Number.isFinite(declared) ? declared : 120;
}

/** @param {number} px */
export function clampColumnWidth(px) {
	return Math.max(MIN_COLUMN_W, Math.min(MAX_COLUMN_W, Math.round(px)));
}

/** Store one width. @param {string} view @param {string} key @param {number} px */
export function setColumnWidth(view, key, px) {
	explorerColumnWidths.update((all) => ({
		...all,
		[view]: { ...(all[view] ?? {}), [key]: clampColumnWidth(px) }
	}));
}

/** Forget one width, so the column goes back to its declared default (double-click on a
 * grip — this app's established meaning for that gesture). @param {string} view @param {string} key */
export function resetColumnWidth(view, key) {
	explorerColumnWidths.update((all) => {
		const next = { ...(all[view] ?? {}) };
		delete next[key];
		return { ...all, [view]: next };
	});
}

/**
 * Move `key` so it sits at `index` in the CURRENT visible order. Refuses to move NAME and
 * refuses to put anything before it (see orderColumns).
 * @param {string} view @param {string[]} current the keys as they are drawn right now
 * @param {string} key @param {number} index
 */
export function moveColumn(view, current, key, index) {
	const list = (current ?? []).filter(Boolean);
	const from = list.indexOf(key);
	if (from < 0) return;
	const pinned = list[0] === 'name' ? 1 : 0;
	if (from < pinned) return;
	const to = Math.max(pinned, Math.min(list.length - 1, index));
	if (to === from) return;
	const next = [...list];
	next.splice(from, 1);
	next.splice(to, 0, key);
	explorerColumnOrder.update((all) => ({ ...all, [view]: next }));
}

/**
 * Is this column showing? NAME can never be hidden.
 * @param {string} view @param {string} key
 * @param {Record<string, string[]>} [sets] pass the store value from a component (the
 *   reactivity rule: a `get()` inside a helper registers no dependency)
 */
export function columnVisible(view, key, sets) {
	const col = columnsFor(view).find((c) => c.key === key);
	if (col?.always) return true;
	const all = sets ?? get(explorerColumns);
	const set = all[view];
	// an unknown view (or a stored set from before this column existed) shows everything
	return set ? set.includes(key) : true;
}

/** Show/hide one column. Refuses to hide an `always` column. @param {string} view @param {string} key */
export function toggleColumn(view, key) {
	const col = columnsFor(view).find((c) => c.key === key);
	if (!col || col.always) return;
	explorerColumns.update((all) => {
		const current = all[view] ?? columnsFor(view).map((c) => c.key);
		const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
		// R22 round 11: this keeps the stored SET canonical, which is now only about
		// membership — `orderColumns` decides what the header actually shows, so re-showing
		// a column returns it to wherever the user's order puts it rather than to its
		// declaration index.
		const ordered = columnsFor(view)
			.map((c) => c.key)
			.filter((k) => next.includes(k));
		return { ...all, [view]: ordered };
	});
}

/**
 * Click a header. The same column flips direction; a different one takes over — starting
 * NEWEST FIRST for a date, because that is what anybody clicking "Added" is asking for,
 * and ascending for everything else.
 * @param {string} view @param {string} key
 */
export function sortBy(view, key) {
	explorerSort.update((all) => {
		const prev = all[view];
		if (prev?.key === key) return { ...all, [view]: { key, dir: prev.dir === 1 ? -1 : 1 } };
		const dateish = key === 'added' || key === 'deletedAt';
		return { ...all, [view]: { key, dir: dateish ? -1 : 1 } };
	});
}

/**
 * The value a row sorts by. PURE, and it takes its display labels from the caller: a
 * row's owner is a peer id that only the Explorer can turn into a name (the roster lives
 * there), and sorting on the id while showing the name would be indefensible.
 * @param {any} row
 * @param {string} key
 * @param {{ownerLabel?: (row: any) => string}} [ctx]
 * @returns {string|number}
 */
export function valueFor(row, key, ctx = {}) {
	const label = ctx.ownerLabel ?? ((/** @type {any} */ r) => String(r?.owner?.name ?? r?.owner?.id ?? ''));
	switch (key) {
		case 'name':
			return String(row?.name ?? '').toLowerCase();
		case 'kind':
			return String(row?.kind ?? '').toLowerCase();
		case 'size':
			return Number(row?.size) || 0;
		case 'added':
		case 'deletedAt':
			return Number(row?.createdAt) || 0;
		case 'owner':
		case 'deletedBy':
			return label(row).toLowerCase();
		default:
			return String(row?.name ?? '').toLowerCase();
	}
}

/**
 * Sort a view's rows. Two rules beyond the obvious one:
 *
 * - FOLDERS FIRST, always, whatever the sort. Every file manager does this, and the
 *   reason is that a folder is a place and a file is a thing: interleaving them by size
 *   or date makes a tree unnavigable.
 * - A TIE FALLS BACK TO THE NAME, then to the id. `Array.prototype.sort` is stable, so a
 *   tie would otherwise keep whatever order the derivation happened to produce — which
 *   for a grid assembled from five branches plus two remote sources is not an order
 *   anybody can predict, and would differ between two peers looking at one project.
 *
 * @param {any[]} rows each `{folder: true}` or a plain item row
 * @param {{key: string, dir: number}} sort
 * @param {{ownerLabel?: (row: any) => string}} [ctx]
 * @returns {any[]} a new array
 */
export function sortEntries(rows, sort, ctx = {}) {
	const { key = 'name', dir = 1 } = sort ?? {};
	const cmp = (/** @type {any} */ a, /** @type {any} */ b) => {
		if (!!a.folder !== !!b.folder) return a.folder ? -1 : 1;
		const av = valueFor(a, key, ctx);
		const bv = valueFor(b, key, ctx);
		let d = 0;
		if (typeof av === 'number' && typeof bv === 'number') d = av - bv;
		else d = String(av).localeCompare(String(bv));
		if (d !== 0) return d * dir;
		// a deterministic tiebreak, INDEPENDENT of dir: two rows that tie must not swap
		// places just because the arrow flipped
		const n = String(a.name ?? '').localeCompare(String(b.name ?? ''));
		if (n !== 0) return n;
		return String(a.id ?? '').localeCompare(String(b.id ?? ''));
	};
	return [...rows].sort(cmp);
}

/**
 * Group bin rows by who deleted them, as synthetic FOLDER rows ("Deleted by me" first,
 * then everybody else by name). Synthetic and derived, like the bin cards themselves —
 * there is no folder record anywhere, so there is nothing to keep in step.
 * @param {any[]} rows
 * @param {{ownerLabel?: (row: any) => string, myId?: string|null}} [ctx]
 * @returns {{id: string, name: string, mine: boolean, unknown: boolean, rows: any[]}[]}
 */
export function groupByDeleter(rows, ctx = {}) {
	const label = ctx.ownerLabel ?? ((/** @type {any} */ r) => String(r?.owner?.name ?? ''));
	const me = String(ctx.myId ?? '');
	/** @type {Map<string, {id: string, name: string, mine: boolean, unknown: boolean, rows: any[]}>} */
	const byKey = new Map();
	for (const row of rows) {
		const id = String(row?.owner?.id ?? '');
		// A ROW WITH NO PEER ID IS UNATTRIBUTED, not somebody else's. It happens for real:
		// `meAsOwner` stamps whatever `peer.id` holds, and a deletion performed before the
		// mesh has assigned one records an empty id. Reading that as a peer produced a
		// section headed "Deleted by peer" — a label naming nobody — so it gets its own
		// section, and it sorts LAST because a name is more use than its absence.
		const known = id !== '';
		const mine = known && id === me;
		const gid = mine ? '__me__' : known ? id : '__unknown__';
		if (!byKey.has(gid))
			byKey.set(gid, {
				id: gid,
				name: mine
					? 'Deleted by me'
					: known
						? 'Deleted by ' + (label(row) || 'someone')
						: 'Deleted by someone',
				mine,
				unknown: !known,
				rows: []
			});
		byKey.get(gid)?.rows.push(row);
	}
	return [...byKey.values()].sort((a, b) => {
		if (a.mine !== b.mine) return a.mine ? -1 : 1;
		if (!!a.unknown !== !!b.unknown) return a.unknown ? 1 : -1;
		return a.name.localeCompare(b.name);
	});
}
