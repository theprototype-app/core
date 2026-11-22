// 43 J3 — THE FIELD MENU: copy / paste / reset on a Properties or Configure Scene row, a vector
// and a whole section. The text forms are `fieldClipboard.js` (a pure leaf); this module is
// the part that touches the browser: the system clipboard, the one shared menu, the hover
// keys and the long press.
//
//   use:fieldClip={() => spec}        a row (PropRow does it for you)
//   use:fieldClip={() => sectionSpec} a section header (Section does it for you)
//
// A FIELD spec: {kind: number|vector|color|enum|bool, name, key?, get, set, reset?, unit?,
// options?, min?, max?}. `get`/`set`/`reset` speak the INTERNAL value (metres, radians); the
// text a person copies is in the units the panel SHOWS (units.js), converted here.
// A SECTION spec: {section: true, name, fields(): FieldSpec[], pasteAll?(values), fans?,
// count?, prepare?()}.
//
// Every paste — one value, a vector, a section — runs inside ONE history gesture token
// ($lib/historyGesture), so it is ONE undo step however many setters it calls, including the
// Inspector's debounced 500 ms transform seal (it captures the token when the change happens).
//
// THE GESTURES: right-click (desktop); a LONG PRESS (touch — Android also fires a native
// contextmenu for it, deduped); Ctrl+C / Ctrl+V while the pointer HOVERS a field and no text
// box has focus (Blender's convention) — through the copy/paste EVENTS, which carry the
// clipboard with no permission prompt. The menu's own Paste reads navigator.clipboard (the
// browser may ask once) and falls back to the last copy made here.
import { getContext, setContext, tick } from 'svelte';
import { get, writable } from 'svelte/store';
import { coerce, coerceSection, formatField, keyOf, parseClipboard, parseComponent } from './fieldClipboard.js';
import { fromDisplay, parseValue, toDisplay, unitStoreFor } from './units.js';
import { withHistoryGesture } from './historyGesture.js';
import { showToastById } from '../stores/appStore.js';

/** @typedef {{kind: 'number'|'vector'|'color'|'enum'|'bool', name: string, key?: string, get: () => any, set: (v: any) => void, reset?: any, unit?: string, options?: {value: any, label?: string, name?: string}[], min?: number, max?: number, disabled?: boolean}} FieldSpec */
/** @typedef {{section: true, name: string, fields: () => FieldSpec[], pasteAll?: (values: Record<string, any>) => void, count?: () => number, fans?: boolean, prepare?: () => Promise<void> | void}} SectionSpec */

/** The one open menu: {x, y, items, title} or null. FieldMenuHost renders it. */
export const fieldMenu = writable(/** @type {{x: number, y: number, items: any[]} | null} */ (null));

/** The last copy made here — the fallback when the clipboard cannot be read, and the exact
 *  JSON behind a text the clipboard still holds. @type {{text: string, json: string} | null} */
let lastCopy = null;

const say = (/** @type {string} */ text) => showToastById('field-clip', text);

// ---- units -----------------------------------------------------------------------------
/** @param {FieldSpec} f */
const unitOf = (f) => (f.unit === 'length' || f.unit === 'angle' || f.unit === 'angleDeg' ? f.unit : '');
/** internal -> shown @param {FieldSpec} f @param {number} v */
function shown(f, v) {
	const u = unitOf(f);
	return u ? toDisplay(v, u, get(unitStoreFor(u))) : Number(v);
}
/** shown (or a suffixed token) -> internal, clamped @param {FieldSpec} f @param {number} v @param {string} [raw] */
function internal(f, v, raw) {
	const u = unitOf(f);
	let n = Number(v);
	if (u) {
		const display = get(unitStoreFor(u));
		n = raw && /[a-z°'"]/i.test(raw) ? parseValue(raw, u, display) : fromDisplay(n, u, display);
	}
	if (!Number.isFinite(n)) n = 0;
	if (typeof f.min === 'number' && n < f.min) n = f.min;
	if (typeof f.max === 'number' && n > f.max) n = f.max;
	return n;
}

/** A field's value as the codec takes it (shown units, a choice as its value). @param {FieldSpec} f */
function valueOf(f) {
	const v = f.get();
	if (f.kind === 'number') return shown(f, v);
	if (f.kind === 'vector') return (v ?? [0, 0, 0]).slice(0, 3).map((/** @type {number} */ n) => shown(f, n));
	if (f.kind === 'bool') return !!v;
	return v;
}
/** @param {FieldSpec} f */
const optionsOf = (f) => (f.options ?? []).map((o) => ({ value: o.value, label: o.label ?? o.name ?? String(o.value) }));
/** @param {FieldSpec} f */
const keyFor = (f) => f.key ?? keyOf(f.name);
/** @param {FieldSpec} f */
function labelOf(f) {
	if (f.kind !== 'enum') return undefined;
	const v = f.get();
	return optionsOf(f).find((o) => o.value === v)?.label;
}

// ---- the system clipboard ----------------------------------------------------------------
const JSON_TYPE = 'web application/json';

/** @param {{text: string, json: string}} c */
export async function writeClip(c) {
	lastCopy = c;
	const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
	try {
		const CI = /** @type {any} */ (globalThis).ClipboardItem;
		if (CI && clip?.write && CI.supports?.(JSON_TYPE)) {
			await clip.write([
				new CI({
					'text/plain': new Blob([c.text], { type: 'text/plain' }),
					[JSON_TYPE]: new Blob([c.json], { type: 'application/json' })
				})
			]);
			return true;
		}
	} catch {
		// a custom format refused: plain text below still carries everything
	}
	try {
		await clip?.writeText(c.text);
		return true;
	} catch {
		return false;
	}
}

/** What a paste should parse: the JSON form when this app wrote it, else the text.
 *  Throws a short reason when nothing can be read. */
export async function readClip() {
	const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
	try {
		if (clip?.read) {
			const items = await clip.read();
			for (const item of items) {
				if (item.types.includes(JSON_TYPE)) return await (await item.getType(JSON_TYPE)).text();
				if (item.types.includes('text/plain')) return preferJson(await (await item.getType('text/plain')).text());
			}
			return '';
		}
	} catch {
		// read() refused or unsupported: readText below
	}
	try {
		if (clip?.readText) return preferJson(await clip.readText());
	} catch {
		// permission refused
	}
	if (lastCopy) return lastCopy.json;
	throw new Error('The clipboard cannot be read here — hover the field and press Ctrl+V');
}

/** The text the clipboard holds -> our exact JSON for it when we wrote it. @param {string} text */
function preferJson(text) {
	return lastCopy && text === lastCopy.text ? lastCopy.json : text;
}

// ---- copy ----------------------------------------------------------------------------------
/** @param {FieldSpec} f */
export function fieldCopyText(f) {
	return formatField({ kind: f.kind, name: f.name, value: valueOf(f), label: labelOf(f) });
}
/** One axis of a vector as a number. @param {FieldSpec} f @param {number} i */
function axisCopyText(f, i) {
	return formatField({ kind: 'number', name: f.name + ' ' + 'XYZ'[i], value: valueOf(f)[i] });
}
/** @param {SectionSpec} s @param {boolean} [pretty] */
export function sectionCopyText(s, pretty = false) {
	/** @type {Record<string, any>} */
	const value = {};
	for (const f of s.fields()) value[keyFor(f)] = f.kind === 'enum' ? f.get() : valueOf(f);
	const c = formatField({ kind: 'section', name: s.name, value });
	if (!pretty) return c;
	const text = JSON.stringify(JSON.parse(c.json), null, 2);
	return { text, json: c.json };
}

/** @param {{text: string, json: string}} c @param {string} what */
async function copyOut(c, what) {
	const ok = await writeClip(c);
	say(ok ? `Copied ${what}` : `Copied ${what} (inside the app only — the system clipboard refused)`);
}

// ---- paste ---------------------------------------------------------------------------------
/** Apply `fn` as ONE undo step. @param {() => void} fn */
function asOneStep(fn) {
	withHistoryGesture({}, fn);
}

/** @param {FieldSpec} f @param {any} value internal */
function setField(f, value) {
	if (f.disabled) return;
	f.set(value);
}

/** Parsed value (shown units) -> internal, per kind. @param {FieldSpec} f @param {any} v @param {any} [raw] */
function toInternal(f, v, raw) {
	if (f.kind === 'number') return internal(f, v, raw);
	if (f.kind === 'vector') return [0, 1, 2].map((i) => internal(f, v[i], raw?.[i]));
	return v;
}

/** Paste text into one field; returns a reason when refused. @param {FieldSpec} f @param {string} text */
export function pasteFieldText(f, text) {
	const clip = parseClipboard(text);
	if ('error' in clip) return clip.error;
	const res = coerce(clip, { kind: f.kind, name: f.name, label: f.name, options: optionsOf(f) });
	if (!res.ok) return res.reason;
	asOneStep(() => setField(f, toInternal(f, res.value, res.raw)));
	return null;
}

/** Paste one axis (a lone number, or that component of a vector). @param {FieldSpec} f @param {number} i @param {string} text */
export function pasteAxisText(f, i, text) {
	const res = parseComponent(text, i, f.name);
	if (!res.ok) return res.reason;
	const next = (f.get() ?? [0, 0, 0]).slice(0, 3);
	next[i] = internal(f, res.value, res.raw);
	asOneStep(() => setField(f, next));
	return null;
}

/** @param {SectionSpec} s */
function sectionTarget(s) {
	/** @type {Record<string, any>} */
	const keys = {};
	for (const f of s.fields()) keys[keyFor(f)] = { kind: f.kind, label: f.name, options: optionsOf(f) };
	return { kind: /** @type {const} */ ('section'), name: s.name, label: s.name, keys };
}

/**
 * Paste a section: only matching keys, all as ONE step. `all` routes through the section's
 * pasteAll (every selected object) when it has one.
 * @param {SectionSpec} s @param {string} text @param {boolean} [all]
 * @returns {{reason: string} | {applied: string[], skipped: string[]}}
 */
export function pasteSectionText(s, text, all = false) {
	const clip = parseClipboard(text);
	if ('error' in clip) return { reason: clip.error };
	const res = coerceSection(clip, sectionTarget(s));
	if (!res.ok) return { reason: res.reason };
	const fields = new Map(s.fields().map((f) => [keyFor(f), f]));
	/** @type {Record<string, any>} */
	const values = {};
	for (const [key, v] of Object.entries(res.value)) {
		const f = fields.get(key);
		if (f) values[key] = toInternal(f, v, res.raw[key]);
	}
	asOneStep(() => {
		if (all && s.pasteAll) s.pasteAll(values);
		else for (const [key, v] of Object.entries(values)) setField(/** @type {FieldSpec} */ (fields.get(key)), v);
	});
	return { applied: Object.keys(values), skipped: res.skipped };
}

/** @param {FieldSpec} f */
const hasReset = (f) => f.reset !== undefined;
/** @param {FieldSpec} f */
function resetField(f) {
	if (typeof f.reset === 'function') f.reset();
	else setField(f, Array.isArray(f.reset) ? f.reset.slice() : f.reset);
}

/** @param {() => Promise<string|null>} run */
async function pasteWith(run) {
	try {
		const reason = await run();
		if (reason) say('Paste refused — ' + reason);
	} catch (err) {
		say('Paste failed — ' + (/** @type {any} */ (err)?.message ?? err));
	}
}

// ---- menus ---------------------------------------------------------------------------------
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '') ? '⌘' : 'Ctrl+';
/** the shortcut beside a row — none on a touch screen, where there is no keyboard to press it on
 *  @param {string} key */
const keyHint = (key) => (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches ? undefined : MOD + key);

/** Per value: Copy, Paste, Reset to default. @param {FieldSpec} f */
function valueItems(f) {
	return [
		{ section: f.name },
		{ label: 'Copy', icon: 'copy', hint: keyHint('C'), action: () => copyOut(fieldCopyText(f), f.name) },
		{ label: 'Paste', icon: 'clipboard-paste', hint: keyHint('V'), disabled: f.disabled, action: () => pasteWith(async () => pasteFieldText(f, await readClip())) },
		{ label: 'Reset to default', icon: 'rotate-ccw', disabled: f.disabled || !hasReset(f), action: () => asOneStep(() => resetField(f)) }
	];
}

/** Per vector axis: Copy / Paste / Reset that axis. @param {FieldSpec} f @param {number} i */
function axisItems(f, i) {
	const axis = 'XYZ'[i];
	return [
		{ section: `${f.name} ${axis}` },
		{ label: 'Copy', icon: 'copy', hint: keyHint('C'), action: () => copyOut(axisCopyText(f, i), `${f.name} ${axis}`) },
		{ label: 'Paste', icon: 'clipboard-paste', hint: keyHint('V'), disabled: f.disabled, action: () => pasteWith(async () => pasteAxisText(f, i, await readClip())) },
		{
			label: 'Reset to default',
			icon: 'rotate-ccw',
			disabled: f.disabled || !Array.isArray(f.reset),
			action: () =>
				asOneStep(() => {
					const next = (f.get() ?? [0, 0, 0]).slice(0, 3);
					next[i] = f.reset[i];
					setField(f, next);
				})
		}
	];
}

/** Per vector name: Copy vector, Paste vector, Reset, Paste X/Y/Z only. @param {FieldSpec} f */
function vectorItems(f) {
	return [
		{ section: f.name },
		{ label: 'Copy vector', icon: 'copy', hint: keyHint('C'), action: () => copyOut(fieldCopyText(f), f.name) },
		{ label: 'Paste vector', icon: 'clipboard-paste', hint: keyHint('V'), disabled: f.disabled, action: () => pasteWith(async () => pasteFieldText(f, await readClip())) },
		{ label: 'Reset', icon: 'rotate-ccw', disabled: f.disabled || !hasReset(f), action: () => asOneStep(() => resetField(f)) },
		{ section: 'One axis' },
		...[0, 1, 2].map((i) => ({
			label: `Paste ${'XYZ'[i]} only`,
			disabled: f.disabled,
			action: () => pasteWith(async () => pasteAxisText(f, i, await readClip()))
		}))
	];
}

/** Per section header: Copy section, Copy as JSON, Paste section (+ to all selected), Reset. @param {SectionSpec} s */
function sectionItems(s) {
	const fields = s.fields();
	const count = s.count?.() ?? 1;
	const multi = count > 1 && (!!s.pasteAll || !!s.fans);
	const pasteSection = (/** @type {boolean} */ all) =>
		pasteWith(async () => {
			await s.prepare?.();
			const res = pasteSectionText(s, await readClip(), all);
			if ('reason' in res) return res.reason;
			if (res.skipped.length) say(`Pasted ${res.applied.length} of ${res.applied.length + res.skipped.length} — skipped: ${res.skipped.join(', ')}`);
			return null;
		});
	const copy = (/** @type {boolean} */ pretty) => async () => {
		await s.prepare?.();
		if (!s.fields().length) return say(`Nothing to copy in ${s.name}`);
		copyOut(sectionCopyText(s, pretty), s.name);
	};
	/** @type {any[]} */
	const items = [
		{ section: s.name },
		{ label: 'Copy section', icon: 'copy', hint: keyHint('C'), action: copy(false) },
		{ label: 'Copy as JSON', icon: 'clipboard-copy', action: copy(true) },
		{ label: 'Paste section', icon: 'clipboard-paste', hint: keyHint('V'), action: () => pasteSection(false) }
	];
	if (multi && s.pasteAll) items.push({ label: `Paste to all selected (${count})`, icon: 'clipboard-paste', action: () => pasteSection(true) });
	else if (multi) items[3].label = `Paste to all selected (${count})`;
	const resettable = (/** @type {FieldSpec[]} */ list) => list.filter((f) => hasReset(f) && !f.disabled);
	items.push({
		label: 'Reset section',
		icon: 'rotate-ccw',
		// a collapsed section has no rows mounted yet: it expands first, then decides
		disabled: fields.length > 0 && !resettable(fields).length,
		action: async () => {
			await s.prepare?.();
			const list = resettable(s.fields());
			if (!list.length) return say(`Nothing in ${s.name} has a default`);
			asOneStep(() => list.forEach(resetField));
		}
	});
	return items;
}

// ---- the scope: which rows answer, and the section each one belongs to ----------------------
// The Inspector (Properties + Configure Scene) PROVIDES the scope; a Section inside it opens a
// registry its rows join on mount, which is what makes "Copy section" automatic for every
// section — a section's fields are whatever rows it is showing. A PropRow outside the scope
// (an image editor's sliders) stays as it was.
const SCOPE = 'tp:fieldClip';

/** Call in the component that hosts the rows (component init). */
export function provideFieldClip() {
	setContext(SCOPE, { enabled: true, section: null });
}

/** @returns {{enabled: boolean, section: ReturnType<typeof makeRegistry> | null} | undefined} */
export function fieldClipScope() {
	return getContext(SCOPE);
}

function makeRegistry() {
	/** @type {Set<() => FieldSpec | null>} */
	const rows = new Set();
	return {
		/** @param {() => FieldSpec | null} getSpec @returns {() => void} */
		add(getSpec) {
			rows.add(getSpec);
			return () => rows.delete(getSpec);
		},
		/** the rows on show, in mount order, each with a key unique in the section */
		fields() {
			/** @type {FieldSpec[]} */
			const out = [];
			const seen = new Map();
			for (const getSpec of rows) {
				const f = getSpec();
				// a row may answer on its own and still not belong to its section's copy
				// (the object's origin sits under Transform; a transform is position/rotation/scale)
				if (!f || /** @type {any} */ (f).inSection === false) continue;
				let key = keyFor(f);
				const n = (seen.get(key) ?? 0) + 1;
				seen.set(key, n);
				if (n > 1) key += n;
				out.push({ ...f, key });
			}
			return out;
		}
	};
}

/**
 * Call in a row component (init) that answers for itself: the fields drawn INSIDE it (a
 * vector row's three axis boxes, a slider row's value box) must not register again.
 */
export function claimFieldScope() {
	const scope = fieldClipScope();
	if (scope?.enabled) setContext(SCOPE, { ...scope, claimed: true });
}

/** A field component may answer on its own: inside the scope, and not inside a row that does. */
export function autoFieldScope() {
	const scope = fieldClipScope();
	return scope?.enabled && !(/** @type {any} */ (scope).claimed) ? scope : null;
}

/**
 * The words a person reads beside a field: the label span before it, or the first label-ish
 * text of its row. Used for a field that carries no label of its own.
 * @param {Element|null|undefined} node @returns {string}
 */
export function nameNear(node) {
	const clean = (/** @type {string|null|undefined} */ t) => String(t ?? '').replace(/\s+/g, ' ').trim();
	// inside a PropRow: its label column
	const rowLabel = node?.closest('.pr')?.querySelector(':scope > .pr-label');
	if (rowLabel) return clean(rowLabel.textContent);
	let el = node?.previousElementSibling;
	while (el) {
		const text = clean(el.textContent);
		if (text && text.length <= 40) return text;
		el = el.previousElementSibling;
	}
	const row = node?.parentElement;
	const label = row?.querySelector(':scope > span, :scope > label');
	return clean(label?.textContent) || '';
}

/** Call in a Section (component init) inside the scope: its rows register here. @returns {ReturnType<typeof makeRegistry> | null} */
export function openSectionScope() {
	const scope = fieldClipScope();
	if (!scope?.enabled) return null;
	const registry = makeRegistry();
	setContext(SCOPE, { ...scope, section: registry });
	return registry;
}

/** Wait for a just-expanded section's rows to mount (and register). */
export async function settle() {
	await tick();
	await new Promise((r) => requestAnimationFrame(() => r(null)));
}

// ---- the action ----------------------------------------------------------------------------
/** Every node the action is on -> its spec getter. The field for Ctrl+C / Ctrl+V is found
 *  from the element under the MOUSE at key time (the nearest ancestor that answers), so a
 *  row whose value boxes answer nothing still answers over its boxes.
 *  @type {WeakMap<Element, (at?: any) => any>} */
const answering = new WeakMap();
/** the last mouse position (a touch has no hover) */
let mouseAt = /** @type {{x: number, y: number} | null} */ (null);
let installed = false;

/** The field under the mouse, or null. */
function hoveredField() {
	if (!mouseAt || typeof document === 'undefined') return null;
	let el = /** @type {Element|null} */ (document.elementFromPoint(mouseAt.x, mouseAt.y));
	const start = el;
	while (el) {
		const spec = answering.get(el)?.(start);
		if (spec) return { node: el, spec };
		el = el.parentElement;
	}
	return null;
}

/**
 * The fallback for fields drawn with NO clipboard support of their own (the sub-panels'
 * colour swatches, a bare kit switch): a native `<input type="color">` and a kit Toggle
 * (`button.tg[aria-pressed]`) answer through their own DOM — read the value, write it the way
 * a person would (a value + input/change events, a click). The Inspector root carries it.
 * They are not section members (only rows that register are), but copy / paste work.
 * @param {EventTarget|null} [target] @returns {FieldSpec | null}
 */
export function nativeFieldSpec(target) {
	const el = /** @type {any} */ (target instanceof Element ? target : null);
	if (!el) return null;
	const name = (/** @type {any} */ e) => e.getAttribute('aria-label') || e.title || nameNear(e) || 'Value';
	if (el.tagName === 'INPUT' && el.type === 'color' && !el.disabled)
		return {
			kind: 'color',
			name: name(el),
			get: () => el.value,
			set: (/** @type {string} */ hex) => {
				if (el.value === hex) return;
				el.value = hex;
				el.dispatchEvent(new Event('input', { bubbles: true }));
				el.dispatchEvent(new Event('change', { bubbles: true }));
			}
		};
	const toggle = el.closest?.('button.tg[aria-pressed]');
	if (toggle && !toggle.disabled) {
		const label = toggle.getAttribute('aria-labelledby');
		return {
			kind: 'bool',
			name: (label && document.getElementById(label)?.textContent?.trim()) || name(toggle),
			get: () => toggle.getAttribute('aria-pressed') === 'true',
			set: (/** @type {boolean} */ on) => {
				if ((toggle.getAttribute('aria-pressed') === 'true') !== !!on) toggle.click();
			}
		};
	}
	return null;
}
let menuOpenedAt = 0;

/** A text box (or anything editable) with focus owns the keyboard and the native menu. @param {any} el */
function editable(el) {
	if (!el) return false;
	if (el.isContentEditable) return true;
	if (el.tagName === 'TEXTAREA') return true;
	if (el.tagName === 'INPUT') return !/^(button|checkbox|radio|range|color|file|submit|reset)$/i.test(el.type || 'text');
	return false;
}
const typing = () => editable(typeof document !== 'undefined' ? document.activeElement : null);
const textSelected = () => !!(typeof document !== 'undefined' && String(document.getSelection?.() ?? '').length);

/**
 * Which menu a press on `node` opens, by where it landed.
 * @param {HTMLElement} node @param {any} spec @param {EventTarget|null} target
 */
export function itemsFor(node, spec, target) {
	if (!spec) return null;
	if (spec.section) return sectionItems(spec);
	const el = /** @type {Element|null} */ (target instanceof Element ? target : null);
	if (spec.kind === 'vector') {
		const wraps = [...node.querySelectorAll('.dn-wrap')];
		const box = el?.closest('.dn-wrap');
		const i = box ? wraps.indexOf(box) : -1;
		if (i >= 0 && i < 3 && !el?.closest('.pr-label')) return axisItems(spec, i);
		return vectorItems(spec);
	}
	return valueItems(spec);
}

/** @param {number} x @param {number} y @param {any[]|null} items */
function open(x, y, items) {
	if (!items) return false;
	menuOpenedAt = Date.now();
	fieldMenu.set({ x, y, items });
	return true;
}

/** Ctrl+C / Ctrl+V over a hovered field: let the browser fire copy/paste, and own them. */
function install() {
	if (installed || typeof window === 'undefined') return;
	installed = true;
	window.addEventListener(
		'pointermove',
		(e) => {
			mouseAt = e.pointerType === 'mouse' ? { x: e.clientX, y: e.clientY } : null;
		},
		{ capture: true, passive: true }
	);
	// capture: an app shortcut further down must not ALSO act on the keys we own here
	window.addEventListener(
		'keydown',
		(e) => {
			if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
			if (e.code !== 'KeyC' && e.code !== 'KeyV') return;
			if (typing() || textSelected() || !hoveredField()) return;
			e.stopPropagation(); // no preventDefault: that would cancel the copy/paste event
		},
		true
	);
	document.addEventListener('copy', (e) => {
		if (typing() || textSelected()) return;
		const spec = hoveredField()?.spec;
		if (!spec) return;
		const c = spec.section ? sectionCopyText(spec) : fieldCopyText(spec);
		e.preventDefault();
		e.clipboardData?.setData('text/plain', c.text);
		try {
			e.clipboardData?.setData('application/json', c.json);
		} catch {
			// a browser refusing the second type still has the text
		}
		lastCopy = c;
		say(`Copied ${spec.name}`);
	});
	document.addEventListener('paste', (e) => {
		if (typing()) return;
		const spec = hoveredField()?.spec;
		if (!spec) return;
		e.preventDefault();
		const json = e.clipboardData?.getData('application/json');
		const text = json || preferJson(e.clipboardData?.getData('text/plain') ?? '');
		if (spec.section) {
			const res = pasteSectionText(spec, text);
			if ('reason' in res) say('Paste refused — ' + res.reason);
			else if (res.skipped.length) say(`Pasted ${res.applied.length} of ${res.applied.length + res.skipped.length} — skipped: ${res.skipped.join(', ')}`);
			return;
		}
		const reason = pasteFieldText(spec, text);
		if (reason) say('Paste refused — ' + reason);
	});
}

const LONG_PRESS_MS = 500;
const SLOP = 10;
/** 98-int (device-lab-3, HONOR): a slow finger drag on a slider moved < 10 px in the first 500 ms and opened this
 *  menu instead of dragging. A range thumb has no long-press meaning; the row's label and value box keep the menu.
 *  @param {EventTarget|null} t */
const onSlider = (t) => !!(/** @type {any} */ (t)?.closest?.('input[type="range"], [role="slider"]'));

/**
 * Svelte action: copy / paste / reset on a field or a section header.
 * @param {HTMLElement} node @param {(target?: EventTarget|null) => any} getSpec returns a FieldSpec, a SectionSpec or null
 *   (it may look at the element the press or the hover started on — the root fallback does)
 */
export function fieldClip(node, getSpec) {
	install();
	let spec = getSpec;
	/** @type {any} */ let timer = null;
	let startX = 0;
	let startY = 0;
	/** this touch already travelled past the slop: it is a drag (98-int) */
	let dragged = false;
	let swallow = false;
	/** what had focus BEFORE this press — a right mouse-down focuses the box it lands on
	 *  @type {Element|null} */
	let focusAtPress = null;

	/** @param {MouseEvent} e */
	function onContext(e) {
		// the native menu stays on a text box you were ALREADY typing in (cut / copy / paste of TEXT)
		if (editable(e.target) && e.target === focusAtPress) return;
		// a touch long-press on a slider is the start of a drag, not a menu (see onSlider); and Chrome's own
		// long-press can still fire after a slow drag left the slop (device-lab-3: a 0.9 s scrub) — a drag, not a menu
		if (/** @type {any} */ (e).pointerType === 'touch' && (onSlider(e.target) || dragged)) {
			e.preventDefault();
			return;
		}
		// Android fires its own contextmenu for the long press we already answered
		if (Date.now() - menuOpenedAt < 800) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		const s = spec?.(e.target);
		if (!s) return;
		e.preventDefault();
		e.stopPropagation(); // the innermost field wins (a row inside a section)
		// the right mouse-down focused the box under it: give the keyboard back, or a Ctrl+V
		// after the menu would type into the box instead of pasting the field
		const active = /** @type {any} */ (document.activeElement);
		if (active && active !== focusAtPress && editable(active) && node.contains(active)) active.blur?.();
		open(e.clientX, e.clientY, itemsFor(node, s, e.target));
	}
	/** @param {PointerEvent} e */
	function onDown(e) {
		swallow = false;
		dragged = false;
		focusAtPress = document.activeElement;
		if (e.pointerType === 'mouse' || !e.isPrimary) return;
		startX = e.clientX;
		startY = e.clientY;
		clearTimeout(timer);
		const target = e.target;
		// capture runs outermost first, so the LAST field that ANSWERS to stamp the event is the
		// innermost — that one owns the press (a toggle inside a row; a vector row's axis boxes
		// answer nothing, so the row keeps it)
		if (spec?.(e.target)) /** @type {any} */ (e).__fieldClipOwner = node;
		timer = setTimeout(() => {
			timer = null;
			if (onSlider(target)) return;
			const s = spec?.(target);
			if (!s || /** @type {any} */ (e).__fieldClipOwner !== node) return;
			swallow = open(startX, startY, itemsFor(node, s, target));
			if (swallow) navigator.vibrate?.(10);
		}, LONG_PRESS_MS);
	}
	/** @param {PointerEvent} e */
	function onMove(e) {
		if (e.pointerType !== 'mouse' && Math.hypot(e.clientX - startX, e.clientY - startY) > SLOP) dragged = true;
		if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > SLOP) {
			clearTimeout(timer);
			timer = null;
		}
	}
	function onCancel() {
		clearTimeout(timer);
		timer = null;
	}
	/** the release that ends a long press must not ALSO start typing in the field under it @param {Event} e */
	function onUp(e) {
		clearTimeout(timer);
		timer = null;
		if (!swallow) return;
		// IMMEDIATE: the field's own release listener can sit on this very node (DragRow)
		e.stopImmediatePropagation();
		e.preventDefault();
		if (e.type === 'click') swallow = false;
	}
	answering.set(node, (/** @type {any} */ at) => spec?.(at));

	node.addEventListener('contextmenu', onContext);
	node.addEventListener('pointerdown', onDown, true);
	node.addEventListener('pointermove', onMove, true);
	node.addEventListener('pointercancel', onCancel, true);
	node.addEventListener('pointerup', onUp, true);
	node.addEventListener('click', onUp, true);
	return {
		/** @param {(target?: EventTarget|null) => any} next */
		update(next) {
			spec = next;
		},
		destroy() {
			clearTimeout(timer);
			answering.delete(node);
			node.removeEventListener('contextmenu', onContext);
			node.removeEventListener('pointerdown', onDown, true);
			node.removeEventListener('pointermove', onMove, true);
			node.removeEventListener('pointercancel', onCancel, true);
			node.removeEventListener('pointerup', onUp, true);
			node.removeEventListener('click', onUp, true);
		}
	};
}

/** Test seam: the hovered field and the last copy. */
export const fieldClipDebug = {
	hovered: () => hoveredField()?.spec?.name ?? null,
	lastCopy: () => lastCopy,
	itemsFor
};
