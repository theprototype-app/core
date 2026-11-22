// uir-chat — CHAT AND THE AI ASSISTANT ARE ONE WINDOW, and old saved state still names two.
//
// Until this release the AI assistant was its own floating window with its own key ('aiAssistant')
// in every place a window's whereabouts is stored: the bottom dock's tab order and splits, the
// sidebars' tabs, the floating tab groups, its docked flag and its floating rect — on this device
// and inside every named workspace layout. The one window keeps the key 'chat' (its element is
// still #chat-window), so a stored 'aiAssistant' is read as 'chat' and, when that state named the
// assistant but not chat, the window opens on its Assistant tab.
//
// A LEAF (it imports nothing): appStore runs it over localStorage before any window module reads its
// state, and uiLayouts runs it again over a named layout's keys right after writing them back.

/** the old key and the one window's key */
export const OLD_KEY = 'aiAssistant';
export const NEW_KEY = 'chat';

/** stored keys holding JSON that may name windows */
export const JSON_KEYS = ['dockedWindows', 'dockTabOrder', 'bottomDockSplits', 'windowTabGroups', 'sidebar:order:left', 'sidebar:order:right'];
/** stored keys holding ONE window key as a plain string */
export const PLAIN_KEYS = ['bottomDockActive', 'sidebar:active:left', 'sidebar:active:right'];

/**
 * Rename the old key inside a parsed value: every string equal to it becomes the new key, a string
 * array loses the duplicate that makes, and a dock split whose two halves are now the same window
 * keeps one half.
 * @param {any} value @returns {any}
 */
export function renameIn(value) {
	if (value === OLD_KEY) return NEW_KEY;
	if (Array.isArray(value)) {
		const mapped = value.map(renameIn);
		if (mapped.every((v) => typeof v === 'string')) return [...new Set(mapped)];
		return mapped;
	}
	if (value && typeof value === 'object') {
		/** @type {Record<string, any>} */
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = renameIn(v);
		// a bottom-dock split {a, b, r}: Chat beside the AI assistant is one window now
		if (typeof out.a === 'string' && out.b === out.a) out.b = null;
		return out;
	}
	return value;
}

/** does a parsed value name `key` anywhere? @param {any} value @param {string} key @returns {boolean} */
export function names(value, key) {
	if (value === key) return true;
	if (Array.isArray(value)) return value.some((v) => names(v, key));
	if (value && typeof value === 'object') return Object.values(value).some((v) => names(v, key));
	return false;
}

/**
 * Migrate one storage. `read`/`write`/`remove` are the storage's own (localStorage through
 * safeStorage, or a layout record's map). Returns what it found: `assistant` = the old state named
 * the assistant and not chat (the window should open on the Assistant tab), `changed` = something
 * was rewritten.
 * @param {(key: string) => string | null} read
 * @param {(key: string, value: string) => void} write
 * @param {(key: string) => void} remove
 * @returns {{changed: boolean, assistant: boolean}}
 */
export function migrateChatKeys(read, write, remove) {
	let changed = false;
	let sawOld = false;
	let sawNew = false;
	for (const key of JSON_KEYS) {
		const raw = read(key);
		if (!raw || !raw.includes(OLD_KEY)) {
			if (raw && raw.includes('"' + NEW_KEY + '"')) sawNew = true;
			continue;
		}
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		if (!names(parsed, OLD_KEY)) continue;
		sawOld = true;
		if (names(parsed, NEW_KEY)) sawNew = true;
		write(key, JSON.stringify(renameIn(parsed)));
		changed = true;
	}
	for (const key of PLAIN_KEYS) {
		const v = read(key);
		if (v === OLD_KEY) {
			sawOld = true;
			write(key, NEW_KEY);
			changed = true;
		} else if (v === NEW_KEY) sawNew = true;
	}
	// the docked flag: either one docked = the one window docked
	const oldDocked = read(OLD_KEY + 'Docked');
	if (oldDocked !== null) {
		if (oldDocked === 'true') {
			sawOld = true;
			if (read(NEW_KEY + 'Docked') === 'true') sawNew = true;
			else write(NEW_KEY + 'Docked', 'true');
		}
		remove(OLD_KEY + 'Docked');
		changed = true;
	}
	// the floating rect: the assistant's place is kept only when chat has none of its own
	const oldRect = read('win:' + OLD_KEY);
	if (oldRect !== null) {
		if (read('win:' + NEW_KEY) === null) write('win:' + NEW_KEY, oldRect);
		remove('win:' + OLD_KEY);
		changed = true;
	}
	return { changed, assistant: sawOld && !sawNew };
}
