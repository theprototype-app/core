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
// What it is NOT: settings, or anything scene-side. Layouts are LOCAL — a fact about this
// screen, like the dock order — and never replicate or ride a save. The `workspace` rule (a
// plain reload is a clean slate) is untouched: a layout is applied only when you pick one.
//
// 42 I8 — A LAYOUT CARRIES THE CHROME TOO, IN TWO PROFILES. The user: "Layouts also should save
// toolbar position, its configuration of which icons added/removed … and sidebar icons, such as
// microphone/ai assistant … (also layout should keep desktop and mobile settings)". The bottom
// toolbar, its corner stacks, the top-right group and the touch tools are ONE record
// (`controlsLayout`, $lib/toolbarLayout), beside the bar's lift / on-top prefs; the folded phone
// draws a different bar (`phoneBar`, 42 I5) under More's Show switches. A v2 record keeps them apart:
// `chrome: {desktop: {key: value}, phone: {key: value}}`, the owners' own stored strings exactly
// like `storage`. SAVE captures the profile of the shell you are in and keeps the other one from
// the same-name record (`upsertLayout` merges); APPLY restores every profile the record has. A
// pre-42 record has no `chrome` and migrates to `{}` — applying it leaves the chrome alone, which
// is what it always did.

/** the dock-family panels whose mode + floating size are component state, by the prefix
 *  their keys use (`<prefix>Docked`, `<prefix>WinW`, `<prefix>WinH`) */
export const PANEL_PREFIXES = ['flow', 'flowCode', 'animation', 'uv', 'shader', 'hud', 'timeline', 'explorer', 'profiler', 'code'];

/** exact keys that belong to the layout */
const EXACT = new Set([
	'dockedWindows',
	'bottomDockActive',
	'flowDockHeight',
	'dockTabOrder',
	// 44 M9: the dock's side-by-side splits ($lib/bottomDock dockSplits)
	'bottomDockSplits',
	'windowTabGroups',
	'objectListRect',
	// panel-gestures item 5: the chrome buttons a person hid ($lib/chromeButtons), per layout
	'chromeButtons',
	// … and the Panels button's mode, which is the hidden state of that one bound button ($lib/panelsButton)
	'panelsButton',
	'profilerDockSized',
	// 42 I6: which floating windows the dock hosts as tabs ($lib/dockHost)
	'objectListDocked',
	'statsDocked',
	'profilerLiveDocked',
	'chatDocked',
	'aiAssistantDocked',
	...PANEL_PREFIXES.flatMap((p) => [p + 'Docked', p + 'WinW', p + 'WinH'])
]);
/** key families that belong to the layout */
const PREFIXES = ['win:', 'dockWidth:', 'dockSplit:', 'sidebarWidth:', 'sidebar:']; // 42 I2/I3: the sidebars' side / width / full height / tabs

/** Is this stored key part of a workspace layout? @param {string} key */
export function isLayoutKey(key) {
	if (typeof key !== 'string') return false;
	return EXACT.has(key) || PREFIXES.some((p) => key.startsWith(p));
}

/** 42 I8: the record version this build writes (1 = before the chrome profiles) */
export const LAYOUT_VERSION = 2;

/** @typedef {'desktop' | 'phone'} ChromeProfile */
/** 42 I8: the stored keys each chrome profile is made of. MUTABLE ON PURPOSE — an owner that adds
 *  a chrome pref adds its key with `addChromeKeys` (the phone bar's owner, for its new toggles),
 *  so this leaf never has to learn another module's names twice.
 *  @type {Record<ChromeProfile, string[]>} */
export const CHROME_KEYS = {
	// the toolbar record (bar, corners, top-right group, touch tools, position), its two lift
	// prefs and always-on-top, and the Connect bar's one optional button
	// 43 J12: + `touchTools` — whether the row beside the logo shows (it holds what Edit positions put there)
	desktop: ['controlsLayout', 'floatingToolbar', 'toolbarOnTop', 'hudStackLift', 'showRoomsButton', 'touchTools'],
	// the folded phone's bottom bar (42 I5's one list) and More's three Show switches
	phone: ['phoneBar', 'phoneSelectionStrip', 'phoneDockTabs', 'phoneGrabHandle']
};
/** @param {ChromeProfile} profile @param {string[]} keys */
export function addChromeKeys(profile, keys) {
	for (const key of keys) if (typeof key === 'string' && key && !CHROME_KEYS[profile].includes(key)) CHROME_KEYS[profile].push(key);
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
 * 42 I8: one chrome profile out of storage — its keys that hold a value (an absent key is the
 * owner's default, and stays absent in the record, so applying it puts the default back).
 * @param {ChromeProfile} profile @param {(key: string) => string | null} read
 * @returns {Record<string, string>}
 */
export function pickChrome(profile, read) {
	/** @type {Record<string, string>} */
	const out = {};
	for (const key of CHROME_KEYS[profile]) {
		const value = read(key);
		if (typeof value === 'string' && value.length <= MAX_VALUE) out[key] = value;
	}
	return out;
}

/**
 * 42 I8: the writes that make storage match one chrome profile — its keys the record has are SET,
 * the rest of the profile's keys are REMOVED (their owners fall back to the default). Keys the
 * profile does not list are never written, whatever the record holds.
 * @param {ChromeProfile} profile @param {Record<string, string>} chrome
 * @returns {{set: [string, string][], remove: string[]}}
 */
export function chromeWrites(profile, chrome) {
	/** @type {[string, string][]} */
	const set = [];
	/** @type {string[]} */
	const remove = [];
	for (const key of CHROME_KEYS[profile]) {
		const value = chrome?.[key];
		if (typeof value === 'string' && value.length <= MAX_VALUE) set.push([key, value]);
		else remove.push(key);
	}
	return { set, remove };
}

/** a stored `chrome` block -> only the known profiles, only string values @param {any} raw */
function normalizeChrome(raw) {
	/** @type {Partial<Record<ChromeProfile, Record<string, string>>>} */
	const out = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const profile of /** @type {ChromeProfile[]} */ (['desktop', 'phone'])) {
		const block = raw[profile];
		if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
		/** @type {Record<string, string>} */
		const keep = {};
		for (const [key, value] of Object.entries(block))
			if (typeof value === 'string' && value.length <= MAX_VALUE && typeof key === 'string' && key.length <= 64) keep[key] = value;
		out[profile] = keep;
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
		v: LAYOUT_VERSION,
		id: raw.id,
		name,
		savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
		open,
		storage,
		// 42 I8: absent on a v1 record = no chrome = applying it leaves the toolbar alone
		chrome: normalizeChrome(raw.chrome)
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
		// 42 I8: the chrome profile this save did not capture (the OTHER shell's) is kept
		next[at] = { ...rec, id: list[at].id, chrome: { ...(list[at].chrome ?? {}), ...rec.chrome } };
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
