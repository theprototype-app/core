// Roadmap 67 P1/P2/P4/P5 — AGENT PANELS, the pure half (imports nothing; the unit layer runs it).
//
// An agent connected through the bridge builds a small tool window for the person it works for: a JSON
// PANEL SPEC (F1: our own small schema, one entry per kit component) that the person's page draws in a
// floating window. This file is the one place that says what a spec may contain — the agent page checks a
// spec before it leaves (open_panel / update_panel), and every receiver checks it AGAIN before drawing it
// (a peer's bytes are never trusted, the wireValidate rule).
//
// THE SPEC (version 1)
//   { v: 1, title, icon?, toolId?, size?: {w, h},
//     tabs?: [{id?, title, sections: [...]}] | sections?: [{title?, controls: [...]}] | controls?: [...] }
// A CONTROL is {type, id, label, help?, disabled?, …}:
//   slider {min, max, step, value, unit?}      number {min?, max?, step?, value, unit?}
//   select {options: [string | {value, label}], value}     toggle {value}     colour {value: '#rrggbb'}
//   text {value, placeholder?, maxLength?}     textarea {value, placeholder?, maxLength?, rows?}
//   button {label, variant?: 'primary'|'secondary'}
//   image {src: data:image/…;base64, alt, pixelated?, frames?: {cols, rows, fps?}}   (a sprite-sheet preview)
//   files {items: [{name, hash?}]}  (Explorer refs)    progress {value: 0..1 | null, text?}
//   status {text, tone?: 'info'|'ok'|'warn'|'error'}  table {columns: [string], rows: [[string|number]]}
// Everything is normalized into a FRESH object: a field this file does not know never reaches the renderer.
//
// GUARDRAILS (P5) — refusals, not repairs, so the agent reads why:
//   · no password / credential inputs: no such control type, and a text / textarea / number control whose
//     id, label, placeholder or help asks for a password, key, token, card number or one-time code is refused;
//   · labels are TEXT: markup (`<b>`, `<a href>`, `javascript:`) is refused, and the renderer never uses HTML;
//   · no links: there is no link control and an image is a data: URL only (a panel never loads a URL);
//   · caps: controls, tabs, options, rows, images and the spec's bytes (images counted apart).
//
// VALUES live beside the spec (`values[id]`), so a patch from the agent and a change from a person are the
// same small object, and `.tppanel` saves both.

export const SPEC_VERSION = 1;
/** open agent panels a page shows at once (and an agent may hold per person) */
export const PANEL_CAP = 6;
/** the spec as JSON, image data counted apart */
export const SPEC_MAX_BYTES = 64 * 1024;
/** one image's data URL */
export const IMAGE_MAX_CHARS = 1_500_000;
export const IMAGES_MAX = 4;
export const CONTROLS_MAX = 60;
export const TABS_MAX = 8;
export const SECTIONS_MAX = 16;
export const OPTIONS_MAX = 50;
export const FILES_MAX = 50;
export const TABLE_COLS_MAX = 8;
export const TABLE_ROWS_MAX = 100;
export const TITLE_MAX = 60;
export const LABEL_MAX = 80;
export const HELP_MAX = 200;
export const TEXT_MAX = 200;
export const TEXTAREA_MAX = 4000;
export const STATUS_MAX = 300;
export const CELL_MAX = 120;
/** size bounds of the window (CSS px) */
export const SIZE_MIN = { w: 240, h: 160 };
export const SIZE_MAX = { w: 720, h: 900 };
export const SIZE_DEFAULT = { w: 320, h: 0 };

export const CONTROL_TYPES = /** @type {const} */ ([
	'slider',
	'number',
	'select',
	'toggle',
	'colour',
	'text',
	'textarea',
	'button',
	'image',
	'files',
	'progress',
	'status',
	'table'
]);
/** controls a person changes (their value travels to the agent) */
export const INPUT_TYPES = new Set(['slider', 'number', 'select', 'toggle', 'colour', 'text', 'textarea']);
/** icons a panel may wear (Icon.svelte names; anything else falls back to the default) */
export const PANEL_ICONS = new Set(['bot', 'sparkles', 'image', 'brush', 'palette', 'wand-sparkles', 'box', 'layers', 'grid-3x3', 'settings', 'sliders-horizontal', 'wrench', 'music', 'map']);
export const DEFAULT_ICON = 'bot';

const ID = /^[A-Za-z0-9_.-]{1,40}$/;
const TOOL_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const COLOUR = /^#[0-9a-fA-F]{6}$/;
const IMAGE_SRC = /^data:image\/(png|webp|jpeg|gif);base64,[A-Za-z0-9+/=\s]*$/;
/** types an agent might reach for to ask for a secret — named so the refusal says what is wrong */
const CREDENTIAL_TYPES = new Set(['password', 'secret', 'credential', 'credentials', 'apikey', 'api_key', 'api-key', 'token', 'pin', 'otp', 'creditcard', 'credit-card', 'card', 'email', 'login']);
/** what a free-text or number field must not ask for (P5) */
const CREDENTIAL_WORDS =
	/pass\s*(word|code|phrase)|\bpwd\b|secret|api[\s_-]*key|access[\s_-]*key|private[\s_-]*key|\btoken\b|credential|credit[\s_-]*card|card[\s_-]*(number|no\b)|\bcvv\b|\bcvc\b|\bpin\b|pin[\s_-]*code|one[\s_-]*time[\s_-]*(code|password)|\botp\b|\b2fa\b|verification[\s_-]*code|\bssn\b|social[\s_-]*security|\biban\b|seed[\s_-]*phrase/i;
/** markup in a label: a tag, an entity-encoded tag, or a script URL */
const MARKUP = /<\s*\/?\s*[a-z!][^>]*>|&lt;\s*\/?\s*[a-z]|javascript:|data:text\/html/i;
const TONES = new Set(['info', 'ok', 'warn', 'error']);
const VARIANTS = new Set(['primary', 'secondary']);

/** @param {string} msg @returns {never} */
function refuse(msg) {
	throw new PanelSpecError(msg);
}

export class PanelSpecError extends Error {
	/** @param {string} msg */
	constructor(msg) {
		super(msg);
		this.name = 'PanelSpecError';
	}
}

/** plain text: control characters out, trimmed, capped; markup refused @param {any} v @param {number} max @param {string} where */
export function plainText(v, max, where) {
	if (v === undefined || v === null) return '';
	if (typeof v !== 'string' && typeof v !== 'number') refuse(where + ' must be text');
	// eslint-disable-next-line no-control-regex
	const s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '').trim();
	if (MARKUP.test(s)) refuse(where + ' is plain text: no HTML or links (' + JSON.stringify(s.slice(0, 40)) + ')');
	return s.slice(0, max);
}

/** @param {any} v @param {number} [fallback] */
const num = (v, fallback = NaN) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);

/** does this text / number field ask for a credential? (exported for the unit test) @param {any} c */
export function asksForCredential(c) {
	const words = [c.id, c.label, c.placeholder, c.help, c.name].filter((x) => typeof x === 'string').join(' ');
	return CREDENTIAL_WORDS.test(words) || c.inputType === 'password' || c.masked === true || c.secret === true || c.autocomplete === 'current-password' || c.autocomplete === 'new-password';
}

/** @param {any[]} raw @param {string} where */
function options(raw, where) {
	if (!Array.isArray(raw) || !raw.length) refuse(where + ' needs options');
	if (raw.length > OPTIONS_MAX) refuse(where + ': at most ' + OPTIONS_MAX + ' options');
	/** @type {{value: string, label: string}[]} */
	const out = [];
	for (const o of raw) {
		const value = typeof o === 'object' && o !== null ? o.value : o;
		if (typeof value !== 'string' && typeof value !== 'number') refuse(where + ': an option value must be text or a number');
		const v = String(value).slice(0, LABEL_MAX);
		if (out.some((x) => x.value === v)) continue;
		const label = typeof o === 'object' && o !== null && o.label !== undefined ? plainText(o.label, LABEL_MAX, where + ' option label') : plainText(v, LABEL_MAX, where + ' option');
		out.push({ value: v, label: label || v });
	}
	return out;
}

/**
 * A control's value made valid for it (clamped, one of the options…), or the control's own default when
 * the value cannot be one. Display controls have no value (undefined).
 * @param {any} c a NORMALIZED control @param {any} v
 */
export function valueFor(c, v) {
	switch (c.type) {
		case 'slider':
		case 'number': {
			let n = num(v, NaN);
			if (!Number.isFinite(n)) return c.value;
			if (Number.isFinite(c.min)) n = Math.max(c.min, n);
			if (Number.isFinite(c.max)) n = Math.min(c.max, n);
			if (Number.isFinite(c.step) && c.step > 0) {
				const base = Number.isFinite(c.min) ? c.min : 0;
				n = base + Math.round((n - base) / c.step) * c.step;
				n = Number(n.toFixed(6));
				if (Number.isFinite(c.max) && n > c.max) n = c.max;
			}
			return n;
		}
		case 'select': {
			const s = v === undefined || v === null ? '' : String(v);
			return c.options.some((/** @type {any} */ o) => o.value === s) ? s : c.value;
		}
		case 'toggle':
			return typeof v === 'boolean' ? v : c.value;
		case 'colour':
			return typeof v === 'string' && COLOUR.test(v) ? v.toLowerCase() : c.value;
		case 'text':
		case 'textarea': {
			if (typeof v !== 'string') return c.value;
			// eslint-disable-next-line no-control-regex
			return v.replace(c.type === 'text' ? /[\u0000-\u001F\u007F]/g : /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, c.maxLength);
		}
		default:
			return undefined;
	}
}

/**
 * One control, normalized. Throws PanelSpecError with the reason.
 * @param {any} raw @param {number} n its position (for an id when a display control has none)
 */
export function normalizeControl(raw, n = 0) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('a control must be an object');
	let type = String(raw.type ?? '').toLowerCase();
	if (type === 'color') type = 'colour';
	if (type === 'checkbox' || type === 'switch') type = 'toggle';
	if (type === 'range') type = 'slider';
	if (CREDENTIAL_TYPES.has(type)) refuse('a panel may not ask for passwords, keys, tokens or card numbers (control type "' + type + '")');
	if (!(/** @type {readonly string[]} */ (CONTROL_TYPES).includes(type))) refuse('unknown control type ' + JSON.stringify(String(raw.type ?? '').slice(0, 20)) + ' (one of ' + CONTROL_TYPES.join(', ') + ')');
	const interactive = INPUT_TYPES.has(type) || type === 'button';
	let id = raw.id === undefined || raw.id === null ? '' : String(raw.id);
	if (!id && !interactive) id = type + '-' + n;
	if (!ID.test(id)) refuse('control ' + JSON.stringify(id.slice(0, 40)) + ': an id is 1-40 letters, digits, "_", "-" or "."');
	const where = 'control "' + id + '"';
	if ((type === 'text' || type === 'textarea' || type === 'number') && asksForCredential(raw))
		refuse(where + ': a panel may not ask for passwords, keys, tokens, card numbers or one-time codes');
	/** @type {any} */
	const c = { type, id, label: plainText(raw.label, LABEL_MAX, where + ' label') };
	const help = plainText(raw.help, HELP_MAX, where + ' help');
	if (help) c.help = help;
	if (raw.disabled === true) c.disabled = true;
	switch (type) {
		case 'slider': {
			const min = num(raw.min, 0);
			const max = num(raw.max, 1);
			if (!(max > min)) refuse(where + ': max must be above min');
			c.min = min;
			c.max = max;
			const step = num(raw.step, NaN);
			c.step = step > 0 ? step : (max - min) / 100;
			const unit = plainText(raw.unit, 12, where + ' unit');
			if (unit) c.unit = unit;
			c.value = min;
			c.value = valueFor(c, raw.value ?? min);
			break;
		}
		case 'number': {
			const min = num(raw.min, NaN);
			const max = num(raw.max, NaN);
			if (Number.isFinite(min)) c.min = min;
			if (Number.isFinite(max)) c.max = max;
			if (Number.isFinite(min) && Number.isFinite(max) && !(max >= min)) refuse(where + ': max must not be below min');
			const step = num(raw.step, NaN);
			if (step > 0) c.step = step;
			const unit = plainText(raw.unit, 12, where + ' unit');
			if (unit) c.unit = unit;
			c.value = Number.isFinite(min) ? min : 0;
			c.value = valueFor(c, raw.value ?? c.value);
			break;
		}
		case 'select':
			c.options = options(raw.options, where);
			c.value = c.options[0].value;
			c.value = valueFor(c, raw.value);
			break;
		case 'toggle':
			c.value = raw.value === true;
			break;
		case 'colour':
			c.value = '#808080';
			c.value = valueFor(c, raw.value);
			break;
		case 'text':
		case 'textarea': {
			const cap = type === 'text' ? TEXT_MAX : TEXTAREA_MAX;
			const want = Math.floor(num(raw.maxLength, cap));
			c.maxLength = Math.max(1, Math.min(cap, want));
			const ph = plainText(raw.placeholder, LABEL_MAX, where + ' placeholder');
			if (ph) c.placeholder = ph;
			if (type === 'textarea') c.rows = Math.max(2, Math.min(12, Math.floor(num(raw.rows, 4))));
			c.value = '';
			c.value = valueFor(c, raw.value ?? '');
			break;
		}
		case 'button':
			if (!c.label) refuse(where + ': a button needs a label');
			if (VARIANTS.has(raw.variant)) c.variant = raw.variant;
			break;
		case 'image': {
			const src = raw.src === undefined || raw.src === null ? '' : String(raw.src);
			if (src) {
				if (src.length > IMAGE_MAX_CHARS) refuse(where + ': the image is ' + Math.round(src.length / 1024) + ' KB of base64; the limit is ' + Math.round(IMAGE_MAX_CHARS / 1024) + ' KB');
				if (!IMAGE_SRC.test(src.slice(0, 200)) || /[^A-Za-z0-9+/=\s]/.test(src.slice(src.indexOf(',') + 1)))
					refuse(where + ': an image is a data:image/png|webp|jpeg|gif;base64 URL (a panel never loads a link)');
				c.src = src;
			} else c.src = '';
			c.alt = plainText(raw.alt ?? c.label, LABEL_MAX, where + ' alt');
			if (raw.pixelated === true) c.pixelated = true;
			if (raw.frames && typeof raw.frames === 'object') {
				const cols = Math.floor(num(raw.frames.cols, 1));
				const rows = Math.floor(num(raw.frames.rows, 1));
				if (cols >= 1 && rows >= 1 && cols <= 64 && rows <= 64 && cols * rows > 1) {
					c.frames = { cols, rows, fps: Math.max(1, Math.min(30, num(raw.frames.fps, 8))) };
				}
			}
			break;
		}
		case 'files': {
			const items = Array.isArray(raw.items) ? raw.items : [];
			if (items.length > FILES_MAX) refuse(where + ': at most ' + FILES_MAX + ' files');
			c.items = items.map((/** @type {any} */ it, /** @type {number} */ i) => {
				const name = plainText(typeof it === 'string' ? it : it?.name, 120, where + ' file name');
				if (!name) refuse(where + ': file ' + (i + 1) + ' needs a name');
				/** @type {any} */
				const row = { name };
				if (it && typeof it === 'object' && typeof it.hash === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(it.hash)) row.hash = it.hash;
				return row;
			});
			break;
		}
		case 'progress': {
			const v = raw.value === null || raw.value === undefined ? null : num(raw.value, NaN);
			c.value = v === null || !Number.isFinite(v) ? null : Math.max(0, Math.min(1, v));
			const text = plainText(raw.text, STATUS_MAX, where + ' text');
			if (text) c.text = text;
			break;
		}
		case 'status':
			c.text = plainText(raw.text, STATUS_MAX, where + ' text');
			c.tone = TONES.has(raw.tone) ? raw.tone : 'info';
			break;
		case 'table': {
			const columns = Array.isArray(raw.columns) ? raw.columns : [];
			if (!columns.length || columns.length > TABLE_COLS_MAX) refuse(where + ': a table has 1-' + TABLE_COLS_MAX + ' columns');
			c.columns = columns.map((/** @type {any} */ h) => plainText(h, LABEL_MAX, where + ' column'));
			const rows = Array.isArray(raw.rows) ? raw.rows : [];
			if (rows.length > TABLE_ROWS_MAX) refuse(where + ': at most ' + TABLE_ROWS_MAX + ' rows');
			c.rows = rows.map((/** @type {any} */ r) =>
				c.columns.map((/** @type {any} */ _h, /** @type {number} */ i) => {
					const cell = Array.isArray(r) ? r[i] : undefined;
					return typeof cell === 'number' && Number.isFinite(cell) ? cell : plainText(cell ?? '', CELL_MAX, where + ' cell');
				})
			);
			break;
		}
	}
	return c;
}

/** JSON size of a spec with image data counted apart @param {any} spec */
export function specWeight(spec) {
	let images = 0;
	let imageChars = 0;
	const json = JSON.stringify(spec, (k, v) => {
		if (k === 'src' && typeof v === 'string' && v) {
			images++;
			imageChars += v.length;
			return '';
		}
		return v;
	});
	return { bytes: json.length, images, imageChars };
}

/** @param {any} raw @param {number} n @param {Set<string>} ids @param {{count: number}} counter */
function normalizeSection(raw, n, ids, counter) {
	if (!raw || typeof raw !== 'object') refuse('a section must be an object');
	const list = Array.isArray(raw.controls) ? raw.controls : [];
	/** @type {any[]} */
	const controls = [];
	for (const rc of list) {
		counter.count++;
		if (counter.count > CONTROLS_MAX) refuse('a panel has at most ' + CONTROLS_MAX + ' controls');
		const c = normalizeControl(rc, counter.count);
		if (ids.has(c.id)) refuse('two controls share the id "' + c.id + '"');
		ids.add(c.id);
		controls.push(c);
	}
	/** @type {any} */
	const s = { controls };
	const title = plainText(raw.title, LABEL_MAX, 'section ' + (n + 1) + ' title');
	if (title) s.title = title;
	return s;
}

/**
 * THE VALIDATOR: a raw spec from an agent (or a peer, or a file) → a normalized spec, or a refusal.
 * @param {any} raw
 * @returns {{ok: true, spec: any} | {ok: false, error: string}}
 */
export function normalizeSpec(raw) {
	try {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('a panel spec is a JSON object');
		const v = raw.v === undefined ? SPEC_VERSION : num(raw.v, NaN);
		if (v !== SPEC_VERSION) refuse('spec version ' + JSON.stringify(raw.v) + ' is not supported (this app reads v' + SPEC_VERSION + ')');
		const title = plainText(raw.title, TITLE_MAX, 'the title');
		if (!title) refuse('a panel needs a title');
		/** @type {any} */
		const spec = { v: SPEC_VERSION, title, icon: PANEL_ICONS.has(raw.icon) ? raw.icon : DEFAULT_ICON };
		if (raw.toolId !== undefined && raw.toolId !== null && raw.toolId !== '') {
			if (typeof raw.toolId !== 'string' || !TOOL_ID.test(raw.toolId)) refuse('toolId is 1-64 letters, digits, "_", "-", "." or ":"');
			spec.toolId = raw.toolId;
		}
		const size = raw.size && typeof raw.size === 'object' ? raw.size : {};
		const w = num(size.w, SIZE_DEFAULT.w);
		const h = num(size.h, SIZE_DEFAULT.h);
		spec.size = { w: Math.round(Math.max(SIZE_MIN.w, Math.min(SIZE_MAX.w, w))), h: h > 0 ? Math.round(Math.max(SIZE_MIN.h, Math.min(SIZE_MAX.h, h))) : 0 };
		const ids = new Set();
		const counter = { count: 0 };
		/** @type {any[]} */
		let rawTabs;
		if (Array.isArray(raw.tabs) && raw.tabs.length) rawTabs = raw.tabs;
		else if (Array.isArray(raw.sections)) rawTabs = [{ title: '', sections: raw.sections }];
		else rawTabs = [{ title: '', sections: [{ controls: Array.isArray(raw.controls) ? raw.controls : [] }] }];
		if (rawTabs.length > TABS_MAX) refuse('a panel has at most ' + TABS_MAX + ' tabs');
		let sectionCount = 0;
		spec.tabs = rawTabs.map((t, i) => {
			if (!t || typeof t !== 'object') refuse('a tab must be an object');
			const tabTitle = plainText(t.title, LABEL_MAX, 'tab ' + (i + 1) + ' title');
			if (rawTabs.length > 1 && !tabTitle) refuse('tab ' + (i + 1) + ' needs a title');
			const secs = Array.isArray(t.sections) ? t.sections : [{ controls: Array.isArray(t.controls) ? t.controls : [] }];
			sectionCount += secs.length;
			if (sectionCount > SECTIONS_MAX) refuse('a panel has at most ' + SECTIONS_MAX + ' sections');
			const id = typeof t.id === 'string' && ID.test(t.id) ? t.id : 'tab-' + i;
			return { id, title: tabTitle, sections: secs.map((/** @type {any} */ s, /** @type {number} */ j) => normalizeSection(s, j, ids, counter)) };
		});
		if (!counter.count) refuse('a panel needs at least one control');
		const weight = specWeight(spec);
		if (weight.bytes > SPEC_MAX_BYTES) refuse('the spec is ' + Math.round(weight.bytes / 1024) + ' KB; the limit is ' + SPEC_MAX_BYTES / 1024 + ' KB (images counted apart)');
		if (weight.images > IMAGES_MAX) refuse('a panel shows at most ' + IMAGES_MAX + ' images');
		return { ok: true, spec };
	} catch (e) {
		if (e instanceof PanelSpecError) return { ok: false, error: e.message };
		return { ok: false, error: 'the spec could not be read (' + (e instanceof Error ? e.message : String(e)) + ')' };
	}
}

/** every control of a normalized spec, in order @param {any} spec @returns {any[]} */
export function controlsOf(spec) {
	return (spec?.tabs ?? []).flatMap((/** @type {any} */ t) => t.sections.flatMap((/** @type {any} */ s) => s.controls));
}

/** @param {any} spec @param {string} id */
export function controlById(spec, id) {
	return controlsOf(spec).find((c) => c.id === id) ?? null;
}

/** the starting values of a spec: each input control's value @param {any} spec @returns {Record<string, any>} */
export function initialValues(spec) {
	/** @type {Record<string, any>} */
	const out = {};
	for (const c of controlsOf(spec)) if (INPUT_TYPES.has(c.type)) out[c.id] = c.value;
	return out;
}

/**
 * Values for a spec: the known ids only, each made valid; the rest keep `base`.
 * @param {any} spec @param {Record<string, any>} base @param {any} incoming
 */
export function mergeValues(spec, base, incoming) {
	/** @type {Record<string, any>} */
	const out = { ...base };
	if (!incoming || typeof incoming !== 'object') return out;
	for (const [id, v] of Object.entries(incoming)) {
		const c = controlById(spec, id);
		if (!c || !INPUT_TYPES.has(c.type)) continue;
		out[id] = valueFor(c, v);
	}
	return out;
}

/** fields of a control a patch may change (its type and id never change) */
const PATCHABLE = ['label', 'help', 'disabled', 'min', 'max', 'step', 'unit', 'options', 'placeholder', 'maxLength', 'rows', 'variant', 'src', 'alt', 'pixelated', 'frames', 'items', 'value', 'text', 'tone', 'columns', 'rows'];

/**
 * An agent's patch: `{title?, values?: {id: v}, controls?: {id: {field: v}}}`. Each patched control is
 * re-normalized (a patch passes the same guardrails as a spec), and the whole spec is re-checked for caps.
 * @param {any} spec @param {Record<string, any>} values @param {any} patch
 * @returns {{ok: true, spec: any, values: Record<string, any>, changed: boolean} | {ok: false, error: string}}
 */
export function applyPatch(spec, values, patch) {
	if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'a patch is an object: {values?, controls?, title?}' };
	try {
		let next = spec;
		if (patch.title !== undefined) {
			const title = plainText(patch.title, TITLE_MAX, 'the title');
			if (!title) refuse('a panel needs a title');
			next = { ...next, title };
		}
		if (patch.controls && typeof patch.controls === 'object') {
			const edits = /** @type {Record<string, any>} */ (patch.controls);
			for (const id of Object.keys(edits)) if (!controlById(next, id)) refuse('no control "' + String(id).slice(0, 40) + '" in this panel');
			next = {
				...next,
				tabs: next.tabs.map((/** @type {any} */ t) => ({
					...t,
					sections: t.sections.map((/** @type {any} */ s) => ({
						...s,
						controls: s.controls.map((/** @type {any} */ c, /** @type {number} */ i) => {
							const edit = edits[c.id];
							if (!edit || typeof edit !== 'object') return c;
							/** @type {any} */
							const merged = { ...c };
							for (const k of PATCHABLE) if (edit[k] !== undefined) merged[k] = edit[k];
							// an input's value travels in `values`, so a re-normalize keeps the current one
							if (INPUT_TYPES.has(c.type) && edit.value === undefined) merged.value = values?.[c.id] ?? c.value;
							return normalizeControl(merged, i);
						})
					}))
				}))
			};
			const weight = specWeight(next);
			if (weight.bytes > SPEC_MAX_BYTES) refuse('the patched spec is ' + Math.round(weight.bytes / 1024) + ' KB; the limit is ' + SPEC_MAX_BYTES / 1024 + ' KB');
			if (weight.images > IMAGES_MAX) refuse('a panel shows at most ' + IMAGES_MAX + ' images');
		}
		// an input control whose value a control patch set: that value is the panel's value now
		/** @type {Record<string, any>} */
		const fromControls = {};
		if (patch.controls && typeof patch.controls === 'object')
			for (const [id, edit] of Object.entries(/** @type {Record<string, any>} */ (patch.controls))) {
				const c = controlById(next, id);
				if (c && INPUT_TYPES.has(c.type) && edit && typeof edit === 'object' && edit.value !== undefined) fromControls[id] = c.value;
			}
		const merged = mergeValues(next, mergeValues(next, values ?? {}, fromControls), patch.values);
		// values of controls that no longer exist are dropped; new input controls start at their value
		/** @type {Record<string, any>} */
		const vals = {};
		for (const c of controlsOf(next)) if (INPUT_TYPES.has(c.type)) vals[c.id] = c.id in merged ? valueFor(c, merged[c.id]) : c.value;
		const changed = next !== spec || JSON.stringify(vals) !== JSON.stringify(values ?? {});
		return { ok: true, spec: next, values: vals, changed };
	} catch (e) {
		if (e instanceof PanelSpecError) return { ok: false, error: e.message };
		return { ok: false, error: 'the patch could not be applied (' + (e instanceof Error ? e.message : String(e)) + ')' };
	}
}

/**
 * A person's event, checked against the panel: a change to an input control (value made valid) or a
 * press of a button. Null = not a valid event for this panel.
 * @param {any} spec @param {any} d `{control, kind: 'change'|'press', value?}`
 * @returns {{control: string, kind: 'change'|'press', value?: any, label: string, type: string} | null}
 */
export function checkEvent(spec, d) {
	if (!d || typeof d !== 'object' || typeof d.control !== 'string') return null;
	const c = controlById(spec, d.control);
	if (!c || c.disabled) return null;
	if (d.kind === 'press') return c.type === 'button' ? { control: c.id, kind: 'press', label: c.label, type: c.type } : null;
	if (d.kind !== 'change' || !INPUT_TYPES.has(c.type)) return null;
	const value = valueFor(c, d.value);
	if (value === undefined) return null;
	return { control: c.id, kind: 'change', value, label: c.label, type: c.type };
}

// ---------------------------------------------------------------- `.tppanel` files (P4)

export const TPPANEL_EXT = '.tppanel';
export const TPPANEL_FORMAT = 'tppanel';

/**
 * The file a panel saves as: its spec, its last values, and who made it (so a reopen can find that agent,
 * or any agent declaring the same tool id).
 * @param {{spec: any, values: Record<string, any>, agentName?: string, machine?: string}} panel @param {number} [now]
 */
export function serializeTppanel(panel, now = Date.now()) {
	/** @type {any} */
	const doc = { format: TPPANEL_FORMAT, v: SPEC_VERSION, spec: panel.spec, values: panel.values ?? {}, savedAt: now };
	if (panel.agentName) doc.agent = { name: String(panel.agentName).slice(0, 64), ...(panel.machine ? { machine: String(panel.machine).slice(0, 64) } : {}) };
	return JSON.stringify(doc, null, '\t');
}

/**
 * A `.tppanel` file's text → `{spec, values, agentName, machine, toolId}` (validated like any spec), or null.
 * @param {string} text
 */
export function parseTppanel(text) {
	let doc;
	try {
		doc = JSON.parse(String(text ?? '').replace(/^﻿/, ''));
	} catch {
		return null;
	}
	if (!doc || typeof doc !== 'object' || doc.format !== TPPANEL_FORMAT) return null;
	const r = normalizeSpec(doc.spec);
	if (!r.ok) return null;
	const values = mergeValues(r.spec, initialValues(r.spec), doc.values);
	const agent = doc.agent && typeof doc.agent === 'object' ? doc.agent : {};
	return {
		spec: r.spec,
		values,
		toolId: r.spec.toolId ?? null,
		agentName: typeof agent.name === 'string' ? agent.name.slice(0, 64) : '',
		machine: typeof agent.machine === 'string' ? agent.machine.slice(0, 64) : ''
	};
}

/** a file name for a panel's save @param {string} title */
export function tppanelFileName(title) {
	const base = String(title ?? 'Panel').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Panel';
	return base + TPPANEL_EXT;
}

/** "Panel by Claude on deck-pc" @param {{agentName?: string, machine?: string}} p */
export function ownershipLabel(p) {
	const who = String(p.agentName || 'an AI agent');
	return 'Panel by ' + who + (p.machine ? ' on ' + p.machine : '');
}
