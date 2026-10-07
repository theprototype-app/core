// 37 R14 — NAMED WORKSPACE LAYOUTS, the part with no runtime: which stored keys ARE the
// layout, what a saved record looks like, the list operations, and the reload registry
// the live windows answer to. A LEAF (imports nothing) so the unit layer covers it.
//
// WHY A LAYOUT IS A SET OF STORAGE KEYS. The window geometry of this app is scattered
// over ~40 keys, each owned by the module that draws the window (dragWindow's `win:*`,
// docking's sides/widths/splits, the bottom dock's tab/height/order, every panel's
// docked flag + floating size, the tab groups, the object list's rect). Every owner
// already reads its key and already writes it on every user change — so a snapshot of
// those keys IS the layout, captured in the owners' own formats, and nothing new has to
// learn how a window describes itself. Restoring is the reverse plus one thing the owners
// lacked: a way to RE-READ their key while they are mounted (`onLayoutRestore`).
//
// What it is NOT: the toolbar roster (`controlsLayout`, a separate customisation),
// settings, or anything scene-side. Layouts are LOCAL — a fact about this screen, like
// the dock order — and never replicate or ride a save. The `workspace` rule (a plain
// reload is a clean slate) is untouched: a layout is applied only when you pick one.

/** the dock-family panels whose mode + floating size are component state, by the prefix
 *  their keys use (`<prefix>Docked`, `<prefix>WinW`, `<prefix>WinH`) */
export const PANEL_PREFIXES = ['flow', 'flowCode', 'animation', 'uv', 'shader', 'hud', 'explorer', 'profiler', 'code'];

/** exact keys that belong to the layout */
const EXACT = new Set([
	'dockedWindows',
	'bottomDockActive',
	'flowDockHeight',
	'dockTabOrder',
	'windowTabGroups',
	'objectListRect',
	'profilerDockSized',
	...PANEL_PREFIXES.flatMap((p) => [p + 'Docked', p + 'WinW', p + 'WinH'])
]);
/** key families that belong to the layout */
const PREFIXES = ['win:', 'dockWidth:', 'dockSplit:'];

/** Is this stored key part of a workspace layout? @param {string} key */
export function isLayoutKey(key) {
	if (typeof key !== 'string') return false;
	return EXACT.has(key) || PREFIXES.some((p) => key.startsWith(p));
}

/** the most layouts kept; the oldest unnamed overflow is refused rather than evicted */
export const MAX_LAYOUTS = 24;
/** the longest name */
export const MAX_NAME = 40;
/** a stored value longer than this is not geometry and is not copied */
const MAX_VALUE = 4096;

/** @param {any} name */
export function cleanName(name) {
	return String(name ?? '')
		.replace(/[\u0000-\u001f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_NAME);
}

/**
 * The layout keys out of a key list + reader.
 * @param {string[]} keys @param {(key: string) => string | null} read
 * @returns {Record<string, string>}
 */
export function pickLayoutStorage(keys, read) {
	/** @type {Record<string, string>} */
	const out = {};
	for (const key of [...keys].sort()) {
		if (!isLayoutKey(key)) continue;
		const value = read(key);
		if (typeof value === 'string' && value.length <= MAX_VALUE) out[key] = value;
	}
	return out;
}

/**
 * The writes that make storage match a layout: every layout key the record has is SET,
 * every layout key storage has and the record does not is REMOVED (its owner falls back
 * to its default — the same thing "Reset window layout" relies on).
 * @param {Record<string, string>} storage the record's keys
 * @param {string[]} currentKeys what storage holds now
 * @returns {{set: [string, string][], remove: string[]}}
 */
export function layoutWrites(storage, currentKeys) {
	/** @type {[string, string][]} */
	const set = [];
	for (const [key, value] of Object.entries(storage ?? {}))
		if (isLayoutKey(key) && typeof value === 'string' && value.length <= MAX_VALUE) set.push([key, value]);
	const remove = currentKeys.filter((key) => isLayoutKey(key) && !Object.prototype.hasOwnProperty.call(storage ?? {}, key));
	return { set, remove };
}

/**
 * A stored record -> a usable one, or null. Unknown fields are kept (a newer build's
 * record restores what this build knows), wrong-typed ones are dropped.
 * @param {any} raw
 */
export function normalizeLayout(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const name = cleanName(raw.name);
	if (!name || typeof raw.id !== 'string' || !raw.id) return null;
	/** @type {Record<string, string>} */
	const storage = {};
	if (raw.storage && typeof raw.storage === 'object')
		for (const [key, value] of Object.entries(raw.storage))
			if (isLayoutKey(key) && typeof value === 'string' && value.length <= MAX_VALUE) storage[key] = value;
	/** @type {Record<string, boolean>} */
	const open = {};
	if (raw.open && typeof raw.open === 'object')
		for (const [key, value] of Object.entries(raw.open)) if (typeof value === 'boolean') open[key] = value;
	return {
		...raw,
		v: 1,
		id: raw.id,
		name,
		savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
		open,
		storage
	};
}

/** @param {any} text a stored list @returns {any[]} */
export function parseLayouts(text) {
	try {
		const list = JSON.parse(text ?? '[]');
		if (!Array.isArray(list)) return [];
		/** @type {any[]} */
		const out = [];
		const seen = new Set();
		for (const raw of list) {
			const rec = normalizeLayout(raw);
			if (!rec || seen.has(rec.id)) continue;
			seen.add(rec.id);
			out.push(rec);
		}
		return out.slice(0, MAX_LAYOUTS);
	} catch {
		return [];
	}
}

/**
 * Save `record` into `list`: a layout with the SAME NAME (case-insensitive) is
 * overwritten in place and keeps its id — "save as Modeling" twice is an update, not two
 * rows called Modeling. Returns null when the list is full and the name is new.
 * @param {any[]} list @param {any} record
 */
export function upsertLayout(list, record) {
	const rec = normalizeLayout(record);
	if (!rec) return null;
	const at = list.findIndex((l) => l.name.toLowerCase() === rec.name.toLowerCase());
	if (at >= 0) {
		const next = [...list];
		next[at] = { ...rec, id: list[at].id };
		return next;
	}
	if (list.length >= MAX_LAYOUTS) return null;
	return [...list, rec];
}

/** @param {any[]} list @param {string} id */
export function removeLayout(list, id) {
	return list.filter((l) => l.id !== id);
}

/** @param {any[]} list @param {string} id @param {string} name */
export function renameLayout(list, id, name) {
	const clean = cleanName(name);
	if (!clean) return null;
	if (list.some((l) => l.id !== id && l.name.toLowerCase() === clean.toLowerCase())) return null;
	return list.map((l) => (l.id === id ? { ...l, name: clean } : l));
}

// ---------------------------------------------------------------- the reload registry

/** @type {Set<() => void>} */
const reloaders = new Set();

/**
 * A live window that reads its geometry from storage ONCE (at mount) registers here to
 * re-read it when a layout is applied. Returns the unregister function, so a component
 * can hand it straight back from `onMount`.
 * @param {() => void} fn
 */
export function onLayoutRestore(fn) {
	reloaders.add(fn);
	return () => {
		reloaders.delete(fn);
	};
}

/** run every registered re-read; one that throws does not stop the rest */
export function runLayoutReloaders() {
	let ran = 0;
	for (const fn of [...reloaders]) {
		try {
			fn();
			ran++;
		} catch {}
	}
	return ran;
}

/**
 * A dock-family panel's stored mode + floating size, the read every one of them did
 * inline at mount (defaults: docked, the panel's own default size).
 * @param {(key: string) => string | null} read @param {string} prefix
 * @param {number} defW @param {number} defH
 */
export function storedPanelLayout(read, prefix, defW, defH) {
	return {
		docked: read(prefix + 'Docked') !== 'false',
		w: parseInt(read(prefix + 'WinW') ?? String(defW)) || defW,
		h: parseInt(read(prefix + 'WinH') ?? String(defH)) || defH
	};
}
