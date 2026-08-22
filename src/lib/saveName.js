// 21-I5 — THE SAVE-NAME TEMPLATE (locked answer 5).
//
// Every download this app starts used to name itself, and each one named itself
// DIFFERENTLY: a scene came out as `ThePrototype-<ISO>UTC.tpscene` whatever it was
// called, while a project had learned (21-G9) to use its own name. One template, read
// at every save path, replaces both rules — and its DEFAULT, `[name]`, reproduces the
// project behaviour for everything: a named thing comes out under its name.
//
// THE NO-NAME FALLBACK is why this is not a one-line replace. An unsaved scene and an
// unnamed project have no name to put in the file, and `.tpscene` is not a filename —
// so when the template asks for a name that does not exist, the OLD timestamp shape is
// used verbatim (`NAMELESS_TEMPLATE` below is character-for-character what
// `new Date().toISOString().replace(/[T:.Z]/g, '-')` produced). A save is never nameless.
//
// A deliberate LEAF: svelte/store and localStorage, nothing else — no THREE, no
// Explorer, no manifest. That is what lets the resolver be unit-tested with no browser
// (the `units.js` / `hudArrange.js` precedent), and it is also why the filesystem
// sanitiser lives HERE rather than in projectFile.js: `projectFileBase` was the only
// implementation of it, and there must not be a second one, so that function now
// delegates to `fileNameBase`.

import { writable, get } from 'svelte/store';

/** What a save is called when nothing else is said: the thing's own name. */
export const DEFAULT_TEMPLATE = '[name]';

/**
 * The shape a save takes when there is NO name to use. Byte-for-byte the pre-21-I5
 * `ThePrototype-${new Date().toISOString().replace(/[T:.Z]/g, '-')}UTC` — so an unsaved
 * scene, an unnamed project and a GLTF export of either come out exactly as they always
 * did, and only a NAMED save changes.
 */
export const NAMELESS_TEMPLATE = 'ThePrototype-[YYYY]-[MM]-[DD]-[HH]-[mm]-[ss]-[ms]-UTC';

/** The tokens, in the order the Settings description lists them. */
export const SAVE_NAME_TOKENS = [
	'[name]',
	'[YYYY]',
	'[YY]',
	'[MM]',
	'[DD]',
	'[HH]',
	'[mm]',
	'[ss]',
	'[ms]'
];

const TOKEN_RE = /\[(name|YYYY|YY|MM|DD|HH|mm|ss|ms)\]/g;

/**
 * 21-G9's sanitiser, moved here so there is ONE of it. Everything Windows, macOS and the
 * shell dislike becomes a dash; a name that sanitises to nothing comes back as ''.
 * @param {string} name @returns {string} a safe basename, or '' when nothing survives
 */
export function fileNameBase(name) {
	return String(name ?? '')
		.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-')
		.replace(/\s+/g, ' ')
		.slice(0, 80)
		.replace(/^[-. ]+|[-. ]+$/g, '');
}

/**
 * 21-I5 REVISED — the date part of ONE version's filename, shared by the Explorer's
 * "Download all versions" zip entries and the Version history panel's per-row download.
 *
 * TWO decisions live in this one line. The instant is the version's OWN `createdAt`,
 * never "now": stamping the export moment would make every file in an archive claim to
 * be from the second it was handed over, which is the single fact these names exist to
 * carry. And a COLON is illegal in a Windows filename, so the ISO string loses its two
 * — everything else about it stays readable, and ISO-first still sorts chronologically
 * in any file listing, which is why the date leads.
 *
 * The save-name TEMPLATE deliberately does not apply to these: its date tokens resolve
 * to now, which is exactly the value that must not appear here.
 *
 * @param {number} createdAt epoch ms — a non-finite or non-positive value falls back to now
 * @returns {string} e.g. `2026-01-02T03-04-05.678Z`
 */
export function versionStamp(createdAt) {
	const at = Number(createdAt);
	const iso = new Date(Number.isFinite(at) && at > 0 ? at : Date.now()).toISOString();
	return iso.replace(/:/g, '-');
}

/** @param {number} n @param {number} width */
function pad(n, width = 2) {
	return String(n).padStart(width, '0');
}

/** Substitute the tokens of ONE template. UTC throughout, because the shape it has to
 * reproduce said UTC out loud and a local-time save would sort wrong next to an old one.
 * @param {string} template @param {string} name @param {Date} d */
function substitute(template, name, d) {
	/** @type {Record<string, string>} */
	const map = {
		'[name]': name,
		'[YYYY]': String(d.getUTCFullYear()),
		'[YY]': pad(d.getUTCFullYear() % 100),
		'[MM]': pad(d.getUTCMonth() + 1),
		'[DD]': pad(d.getUTCDate()),
		'[HH]': pad(d.getUTCHours()),
		'[mm]': pad(d.getUTCMinutes()),
		'[ss]': pad(d.getUTCSeconds()),
		'[ms]': pad(d.getUTCMilliseconds(), 3)
	};
	return template.replace(TOKEN_RE, (token) => map[token] ?? token);
}

/**
 * THE RESOLVER — a pure function of (template, name, Date), which is the whole reason it
 * is worth a module: no call site re-implements the token pass, and the table above can
 * be checked without a browser.
 *
 * The fallback fires when the template ASKS for a name there is none of — not merely
 * when there is no name, because a template like `Scene-[YYYY]-[MM]` is perfectly usable
 * without one. A result that sanitises away to nothing falls back too (a template of
 * only punctuation is not a filename either).
 *
 * @param {string} template @param {string} name @param {Date} [date]
 * @returns {string} a filesystem-safe basename, WITHOUT an extension
 */
export function resolveSaveName(template, name, date = new Date()) {
	const clean = String(name ?? '').trim();
	const raw = String(template ?? '').trim() || DEFAULT_TEMPLATE;
	const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
	const wanted = !clean && raw.includes('[name]') ? NAMELESS_TEMPLATE : raw;
	const out = fileNameBase(substitute(wanted, clean, d));
	return out || fileNameBase(substitute(NAMELESS_TEMPLATE, clean, d));
}

// ---- the stored preference ---------------------------------------------------------

const KEY = 'saveNameTemplate';

function readTemplate() {
	try {
		const raw = localStorage.getItem(KEY);
		return raw === null ? DEFAULT_TEMPLATE : String(raw);
	} catch {
		return DEFAULT_TEMPLATE;
	}
}

/** Settings ▸ Files binds to this. LOCAL, never replicated: what your downloads are
 * called is a statement about your machine, exactly like "Keep versions per scene".
 * @type {import('svelte/store').Writable<string>} */
export const saveNameTemplate = writable(readTemplate());

saveNameTemplate.subscribe((value) => {
	try {
		localStorage.setItem(KEY, String(value ?? ''));
	} catch {}
});

/**
 * What every save path calls: the stored template applied to whatever this thing is
 * called. `name` is the SCENE's name for a scene save and the PROJECT's for a .tp.
 * @param {string} name @param {Date} [date] @returns {string} basename, no extension
 */
export function saveFileBase(name, date = new Date()) {
	return resolveSaveName(get(saveNameTemplate), name, date);
}
