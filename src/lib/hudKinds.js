// 21-D1 — THE HUD ELEMENT REGISTRY.
//
// 21-A gave every element kind the same property rows, which is why `image` shipped inside
// HUD_KINDS with no way to choose an image and `bar` had no orientation or percentage. A
// kind is a THING WITH ITS OWN PARAMETERS, so it declares them, and both the properties
// pane and the palette render FROM this table. Adding a kind is one entry here.
//
// The `registerPostEffect` schema / `nodeCatalog` params precedent: fields are DATA, so no
// component has a per-kind branch and nothing can drift between the palette and the pane.
//
// Imports NOTHING, deliberately: `hudDocs` (a leaf), `HudElement`, `HudEditor`, the palette
// and the picker all read it, and it must stay outside every cycle.
//
// TWO SPLITS THAT MATTER:
//
// * `fields` are the element's OWN configuration; `style` names which style keys this kind
//   understands. They are stored in different places (`el.<key>` vs `el.style.<key>`) and
//   the pane needs to know which, so the split is explicit rather than guessed.
// * An element's params are its AUTHORED value — what it shows with no node driving it.
//   A node always wins at runtime (`hudRuntime`), so a bar with `value: 30` is a design-time
//   preview AND the fallback, not a second source of truth.

/** Palette groups, in display order. `Input` kinds are the ones that hold a VALUE. */
export const HUD_KIND_GROUPS = ['Display', 'Input', 'Layout'];

/**
 * @typedef {{
 *   key: string,
 *   kind: 'number' | 'text' | 'select' | 'toggle' | 'color' | 'image' | 'list',
 *   label?: string,
 *   min?: number, max?: number, step?: number,
 *   options?: string[],
 *   placeholder?: string,
 *   hint?: string
 * }} HudField
 * @typedef {{
 *   key: string, label: string, group: string, icon: string,
 *   defaultSize: {w: number, h: number},
 *   interactive?: boolean,
 *   valued?: boolean,
 *   summary: string,
 *   defaults: Record<string, any>,
 *   styleDefaults?: Record<string, any>,
 *   fields: HudField[],
 *   style: HudField[]
 * }} HudKindDef
 */

// ---- shared style fields, so the same knob is spelled the same way everywhere ----
/** @type {Record<string, HudField>} */
const STYLE = {
	size: { key: 'size', kind: 'number', label: 'font size', min: 6, max: 96, step: 1 },
	weight: { key: 'weight', kind: 'select', label: 'weight', options: ['400', '500', '600', '700'] },
	font: { key: 'font', kind: 'text', label: 'font', placeholder: 'inherit' },
	color: { key: 'color', kind: 'color', label: 'color' },
	bg: { key: 'bg', kind: 'color', label: 'background' },
	border: { key: 'border', kind: 'color', label: 'border' },
	radius: { key: 'radius', kind: 'number', label: 'radius', min: 0, max: 64, step: 1 },
	pad: { key: 'pad', kind: 'number', label: 'padding', min: 0, max: 48, step: 1 },
	align: { key: 'align', kind: 'select', label: 'align', options: ['left', 'center', 'right'] },
	opacity: { key: 'opacity', kind: 'number', label: 'opacity', min: 0, max: 1, step: 0.05 }
};

/** the text-ish style set, shared by text/timer/button/panel/list */
const TEXT_STYLE = [STYLE.size, STYLE.weight, STYLE.font, STYLE.color, STYLE.align, STYLE.opacity];

/** @type {HudKindDef[]} */
export const HUD_KIND_DEFS = [
	{
		key: 'text',
		label: 'Text',
		group: 'Display',
		icon: 'type',
		defaultSize: { w: 160, h: 28 },
		summary: 'A line of text. Wire a number into a HUD Text node to make it a live score.',
		defaults: { label: 'Text', wrap: false },
		styleDefaults: { size: 14 },
		fields: [
			{ key: 'label', kind: 'text', label: 'text', placeholder: 'Text', hint: 'Shown when no node drives this element.' },
			{ key: 'wrap', kind: 'toggle', label: 'wrap' }
		],
		style: TEXT_STYLE
	},
	{
		key: 'button',
		label: 'Button',
		group: 'Input',
		icon: 'square-mouse-pointer',
		interactive: true,
		defaultSize: { w: 160, h: 36 },
		summary: 'Fires an event when pressed. Give it an action in the Actions section.',
		defaults: { label: 'Button', enabled: true },
		styleDefaults: { size: 14, align: 'center', bg: 'rgb(17 24 39 / 0.72)', border: 'rgb(75 85 99 / 0.7)', radius: 6, pad: 6 },
		fields: [
			{ key: 'label', kind: 'text', label: 'text', placeholder: 'Button' },
			{ key: 'enabled', kind: 'toggle', label: 'enabled', hint: 'A disabled button dims and ignores presses.' }
		],
		style: [...TEXT_STYLE, STYLE.bg, STYLE.border, STYLE.radius, STYLE.pad]
	},
	{
		key: 'bar',
		label: 'Bar',
		group: 'Display',
		icon: 'square-dashed',
		defaultSize: { w: 220, h: 16 },
		summary: 'A filled bar. The fill is (value - min) / (max - min).',
		// AUTHORED value: what it shows with nothing wired, and the fallback at runtime
		defaults: { min: 0, max: 100, value: 40, orientation: 'horizontal', showPercent: false },
		styleDefaults: { bg: 'rgb(17 24 39 / 0.72)', radius: 4 },
		fields: [
			{ key: 'min', kind: 'number', label: 'min', step: 1 },
			{ key: 'max', kind: 'number', label: 'max', step: 1 },
			{ key: 'value', kind: 'number', label: 'value', step: 1, hint: 'Preview value; a HUD Bar node overrides it.' },
			{ key: 'orientation', kind: 'select', label: 'direction', options: ['horizontal', 'vertical'] },
			{ key: 'showPercent', kind: 'toggle', label: 'show %' }
		],
		style: [STYLE.color, STYLE.bg, STYLE.border, STYLE.radius, STYLE.size, STYLE.opacity]
	},
	{
		key: 'image',
		label: 'Image',
		group: 'Display',
		icon: 'image',
		defaultSize: { w: 128, h: 128 },
		summary: 'An Explorer image. Stored as a content hash, so peers pull the bytes once.',
		// `src` is an Explorer content HASH, never a dataURL: a HUD document replicates WHOLE
		// on every edit, so an embedded image would re-send the bytes on every nudge.
		defaults: { src: '', fit: 'contain' },
		fields: [
			{ key: 'src', kind: 'image', label: 'image' },
			{ key: 'fit', kind: 'select', label: 'fit', options: ['contain', 'cover', 'fill'] }
		],
		style: [STYLE.opacity, STYLE.radius, STYLE.bg, STYLE.border]
	},
	{
		key: 'panel',
		label: 'Panel',
		group: 'Layout',
		icon: 'square',
		defaultSize: { w: 240, h: 120 },
		summary: 'A background box to group things on. Draw it first, then put elements over it.',
		defaults: { label: '' },
		styleDefaults: { bg: 'rgb(17 24 39 / 0.72)', border: 'rgb(75 85 99 / 0.7)', radius: 8, pad: 8 },
		fields: [{ key: 'label', kind: 'text', label: 'text', placeholder: '' }],
		style: [...TEXT_STYLE, STYLE.bg, STYLE.border, STYLE.radius, STYLE.pad]
	},
	{
		key: 'list',
		label: 'List',
		group: 'Display',
		icon: 'list',
		defaultSize: { w: 200, h: 140 },
		summary: 'Rows a module pushes in by element id — a leaderboard or standings.',
		defaults: { title: '', rows: 5, rowHeight: 18 },
		styleDefaults: { size: 12, bg: 'rgb(17 24 39 / 0.72)', radius: 6, pad: 6 },
		fields: [
			{ key: 'title', kind: 'text', label: 'title', placeholder: '' },
			{ key: 'rows', kind: 'number', label: 'max rows', min: 1, max: 32, step: 1 },
			{ key: 'rowHeight', kind: 'number', label: 'row height', min: 10, max: 48, step: 1 }
		],
		style: [...TEXT_STYLE, STYLE.bg, STYLE.border, STYLE.radius, STYLE.pad]
	},
	{
		key: 'timer',
		label: 'Timer',
		group: 'Display',
		icon: 'timer',
		defaultSize: { w: 120, h: 28 },
		summary: 'Counts down from a HUD Timer node, off the shared clock, so peers agree.',
		defaults: { label: '', duration: 60, countDown: true },
		styleDefaults: { size: 16, align: 'center' },
		fields: [
			{ key: 'duration', kind: 'number', label: 'duration', min: 1, max: 3600, step: 1, hint: 'Preview only; the HUD Timer node owns the real one.' },
			{ key: 'countDown', kind: 'toggle', label: 'count down' }
		],
		style: TEXT_STYLE
	},
	{
		key: 'crosshair',
		label: 'Crosshair',
		group: 'Display',
		icon: 'crosshair',
		defaultSize: { w: 24, h: 24 },
		summary: 'A centre reticle. Anchor it to the centre and leave it there.',
		defaults: { thickness: 2, gap: 4, dot: true },
		fields: [
			{ key: 'thickness', kind: 'number', label: 'thickness', min: 1, max: 8, step: 1 },
			{ key: 'gap', kind: 'number', label: 'gap', min: 0, max: 24, step: 1 },
			{ key: 'dot', kind: 'toggle', label: 'centre dot' }
		],
		style: [STYLE.color, STYLE.opacity]
	}
];

/** @type {Record<string, HudKindDef>} */
const BY_KEY = {};
for (const def of HUD_KIND_DEFS) BY_KEY[def.key] = def;

/** Every kind this build can RENDER. An element of any other kind is preserved verbatim in
 * the document and skipped at render (the normalizeAnnotation rule) — so this list is the
 * render capability, never a validation whitelist. */
export const HUD_KINDS = HUD_KIND_DEFS.map((def) => def.key);

/** @param {string} kind @returns {HudKindDef|null} */
export function kindDef(kind) {
	return BY_KEY[kind] ?? null;
}

/** @param {string} kind */
export function isInteractiveKind(kind) {
	return !!BY_KEY[kind]?.interactive;
}

/** Kinds that hold a VALUE (D4 inputs). A `valued` kind gets a `shared` flag. @param {string} kind */
export function isValuedKind(kind) {
	return !!BY_KEY[kind]?.valued;
}

/**
 * The element params a kind understands, with their defaults. Merged UNDER the authored
 * element in normalize, so an absent param gains a default and an authored one is untouched.
 * An UNKNOWN kind answers `{}` — it must pass through unchanged.
 * @param {string} kind @returns {Record<string, any>}
 */
export function defaultsForKind(kind) {
	const def = BY_KEY[kind];
	return def ? { ...def.defaults } : {};
}

/** @param {string} kind @returns {Record<string, any>} */
export function styleDefaultsForKind(kind) {
	const def = BY_KEY[kind];
	return def?.styleDefaults ? { ...def.styleDefaults } : {};
}

/** @param {string} kind @returns {HudField[]} */
export function fieldsForKind(kind) {
	return BY_KEY[kind]?.fields ?? [];
}

/** @param {string} kind @returns {HudField[]} */
export function styleFieldsForKind(kind) {
	return BY_KEY[kind]?.style ?? [];
}

/** The palette, grouped in HUD_KIND_GROUPS order. Groups with no kinds are dropped, so the
 * palette never shows an empty header. @returns {{group: string, items: HudKindDef[]}[]} */
export function paletteGroups() {
	return HUD_KIND_GROUPS.map((group) => ({
		group,
		items: HUD_KIND_DEFS.filter((def) => def.group === group)
	})).filter((entry) => entry.items.length > 0);
}

/** A fresh element body for a kind — what the palette and the Add menu both create.
 * @param {string} kind @returns {Record<string, any>} */
export function newElementOfKind(kind) {
	const def = BY_KEY[kind];
	return {
		kind,
		...defaultsForKind(kind),
		w: def?.defaultSize.w ?? 140,
		h: def?.defaultSize.h ?? 28,
		style: styleDefaultsForKind(kind)
	};
}
