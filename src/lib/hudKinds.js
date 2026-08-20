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
// Imports ONE SIBLING LEAF and nothing else. `hudDocs` (a leaf), `HudElement`, `HudEditor`,
// the palette and the picker all read this module, so it must stay outside every cycle -
// and `moduleHudKinds` (21-E7.4) imports only `svelte/store`, exactly as
// `moduleToolboxes`/`moduleNodeIO` do, so reading it closes none.
//
// 21-E7: FOUR SOURCES of an element kind now, and all four arrive through this one table -
// the built-ins, the two PACKS (game + menu), the user-scripted `custom` kind, and a
// module's own kinds through the registry above. So the palette and the properties pane
// still have no per-kind branch anywhere, which is the whole point of the table.
//
// TWO SPLITS THAT MATTER:
//
// * `fields` are the element's OWN configuration; `style` names which style keys this kind
//   understands. They are stored in different places (`el.<key>` vs `el.style.<key>`) and
//   the pane needs to know which, so the split is explicit rather than guessed.
// * An element's params are its AUTHORED value — what it shows with no node driving it.
//   A node always wins at runtime (`hudRuntime`), so a bar with `value: 30` is a design-time
//   preview AND the fallback, not a second source of truth.

import { moduleHudKindDef, moduleHudKindList } from './moduleHudKinds';

/** Palette groups, in display order. `Input` kinds are the ones that hold a VALUE. */
export const HUD_KIND_GROUPS = ['Display', 'Input', 'Layout'];

/**
 * @typedef {{
 *   key: string,
 *   kind: 'number' | 'text' | 'select' | 'toggle' | 'color' | 'image' | 'list' | 'code',
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
 *   indexValued?: boolean,
 *   subPress?: string[],
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
		summary: 'Rows, one per line — a leaderboard, standings, an inventory. Type them here, push them from a HUD Rows node, or from a module.',
		// 21-E7.1: `rowsText` is the AUTHORED row list, one row per line - the third door
		// onto one store and the one that was missing. A list could ONLY be filled through
		// `setHudRows`, which lived in flowRuntime and was reachable from neither the editor
		// nor the SDK, so the kind shipped with no authoring path at all while its own
		// summary promised an API that did not exist.
		defaults: { title: '', rowsText: '', rows: 5, rowHeight: 18 },
		styleDefaults: { size: 12, bg: 'rgb(17 24 39 / 0.72)', radius: 6, pad: 6 },
		fields: [
			{ key: 'title', kind: 'text', label: 'title', placeholder: '' },
			{
				key: 'rowsText',
				kind: 'list',
				label: 'rows',
				placeholder: '1. Ada / 2. Grace',
				hint: 'One row per line. Shown when nothing is pushing rows in; a HUD Rows node or a module wins at runtime.'
			},
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
	},
	// ---- 21-D4: the INPUTS. A HUD with no input cannot be a settings menu, and the four
	// below are what a menu is made of. Each HOLDS A VALUE, which is the new thing: an
	// element that is read as well as rendered.
	//
	// The value is LOCAL per peer by default and `shared` promotes it. That default is the
	// interesting decision and it is deliberate: a volume slider is mine, a difficulty
	// setting is the host's, and the wrong default is the one that makes my own volume
	// change everyone else's. The flag is per element, so one menu can hold both.
	{
		key: 'slider',
		label: 'Slider',
		group: 'Input',
		icon: 'sliders-horizontal',
		interactive: true,
		valued: true,
		defaultSize: { w: 220, h: 28 },
		summary: 'Drag for a number. Read it with a HUD Input node.',
		defaults: { label: '', min: 0, max: 100, step: 1, value: 50, shared: false, enabled: true },
		styleDefaults: { size: 12, color: '#e5e7eb' },
		fields: [
			{ key: 'label', kind: 'text', label: 'label', placeholder: '(none)' },
			{ key: 'min', kind: 'number', label: 'min', step: 1 },
			{ key: 'max', kind: 'number', label: 'max', step: 1 },
			{ key: 'step', kind: 'number', label: 'step', min: 0, step: 0.01 },
			{ key: 'value', kind: 'number', label: 'start value', step: 1, hint: 'Where it sits before anyone touches it.' },
			{ key: 'enabled', kind: 'toggle', label: 'enabled' },
		{ key: 'shared', kind: 'toggle', label: 'shared', hint: 'OFF: this value is yours alone (a volume slider). ON: every peer sees the same value (a host setting).' }
		],
		style: [...TEXT_STYLE, STYLE.bg, STYLE.radius]
	},
	{
		key: 'toggle',
		label: 'Toggle',
		group: 'Input',
		icon: 'toggle-left',
		interactive: true,
		valued: true,
		defaultSize: { w: 180, h: 28 },
		summary: 'On or off. Reads as 1 or 0 through a HUD Input node.',
		defaults: { label: 'Toggle', value: false, shared: false, enabled: true },
		styleDefaults: { size: 13, color: '#e5e7eb' },
		fields: [
			{ key: 'label', kind: 'text', label: 'label', placeholder: 'Toggle' },
			{ key: 'value', kind: 'toggle', label: 'starts on' },
			{ key: 'enabled', kind: 'toggle', label: 'enabled' },
		{ key: 'shared', kind: 'toggle', label: 'shared', hint: 'OFF: this value is yours alone (a volume slider). ON: every peer sees the same value (a host setting).' }
		],
		style: [...TEXT_STYLE, STYLE.bg, STYLE.radius, STYLE.pad]
	},
	{
		key: 'dropdown',
		label: 'Dropdown',
		group: 'Input',
		icon: 'chevron-down',
		interactive: true,
		valued: true,
		defaultSize: { w: 200, h: 30 },
		summary: 'One of a list. A HUD Input node reads its INDEX, or its text.',
		// options as ONE comma-separated string: a document field has to survive
		// normalize/replicate/undo, and a list of short words is exactly what a text field
		// is good at (the `text` param kind commits on change, never per keystroke)
		defaults: { label: '', options: 'Easy, Normal, Hard', value: 'Normal', shared: false, enabled: true },
		styleDefaults: { size: 13, color: '#e5e7eb', bg: 'rgb(17 24 39 / 0.72)', radius: 4, pad: 4 },
		fields: [
			{ key: 'label', kind: 'text', label: 'label', placeholder: '(none)' },
			{ key: 'options', kind: 'text', label: 'options', placeholder: 'One, Two, Three', hint: 'Comma separated.' },
			{ key: 'value', kind: 'text', label: 'start value' },
			{ key: 'enabled', kind: 'toggle', label: 'enabled' },
		{ key: 'shared', kind: 'toggle', label: 'shared', hint: 'OFF: this value is yours alone (a volume slider). ON: every peer sees the same value (a host setting).' }
		],
		style: [...TEXT_STYLE, STYLE.bg, STYLE.border, STYLE.radius, STYLE.pad]
	},
	{
		key: 'textfield',
		label: 'Text field',
		group: 'Input',
		icon: 'type',
		interactive: true,
		valued: true,
		defaultSize: { w: 220, h: 30 },
		summary: 'Typed text - a player name, a room code. Commits on Enter or blur.',
		defaults: { label: '', value: '', placeholder: 'type here', maxLength: 64, shared: false, enabled: true },
		styleDefaults: { size: 13, color: '#e5e7eb', bg: 'rgb(17 24 39 / 0.72)', border: 'rgb(75 85 99 / 0.7)', radius: 4, pad: 4 },
		fields: [
			{ key: 'label', kind: 'text', label: 'label', placeholder: '(none)' },
			{ key: 'value', kind: 'text', label: 'start text' },
			{ key: 'placeholder', kind: 'text', label: 'placeholder' },
			{ key: 'maxLength', kind: 'number', label: 'max length', min: 1, max: 512, step: 1 },
			{ key: 'enabled', kind: 'toggle', label: 'enabled' },
		{ key: 'shared', kind: 'toggle', label: 'shared', hint: 'OFF: this value is yours alone (a volume slider). ON: every peer sees the same value (a host setting).' }
		],
		style: [...TEXT_STYLE, STYLE.bg, STYLE.border, STYLE.radius, STYLE.pad]
	},
	// ---- 21-E7.3: RICH TEXT ---------------------------------------------------------
	// A whitelist MARKUP parsed to runs by `hudRichText.js` and rendered with svelte text
	// interpolation only. NO innerHTML anywhere in the pipeline, which is the whole design:
	// an element's text is replicated scene data typed by whoever is in the session, so a
	// hostile string must not be 'sanitized' - it must never be markup in the first place.
	{
		key: 'richtext',
		label: 'Rich text',
		group: 'Display',
		icon: 'text-quote',
		defaultSize: { w: 260, h: 72 },
		summary: 'Text with **bold**, *italic*, {color:accent}colour{/color} and {icon:heart} glyphs. Anything else is plain text.',
		defaults: { label: '**Ready.** Press {icon:play} to start.' },
		styleDefaults: { size: 14 },
		fields: [
			{
				key: 'label',
				kind: 'list',
				label: 'text',
				placeholder: '**Bold** and {color:accent}colour{/color}',
				hint: '**bold** / *italic* / {color:#hex or a token}...{/color} / {icon:lucide-name}. A newline is a line break.'
			}
		],
		style: [...TEXT_STYLE, STYLE.bg, STYLE.border, STYLE.radius, STYLE.pad]
	},
	// ---- 21-E7.5: THE USER-SCRIPTED ELEMENT -----------------------------------------
	// The `customNodeDefs` trust model verbatim: script nodes already run replicated code
	// on every peer, so a render function carried in a replicated document is the SAME
	// posture and not a new one. The body is `(el, runtime, container) => void`, compiled
	// with `new Function` inside a try/catch - a throw renders an inert error chip rather
	// than taking the whole layer down with it.
	{
		key: 'custom',
		label: 'Custom (code)',
		group: 'Display',
		icon: 'code',
		defaultSize: { w: 200, h: 64 },
		summary: 'You write the render function. Double-click it on the board to edit the code; it replicates with the document and hot-applies.',
		defaults: {
			code:
				'// (el, runtime, container) -> void. Runs on every peer; keep it deterministic.\n' +
				'// el = the element (your own fields too), runtime = what a node is driving,\n' +
				'// container = your own div. Plain DOM, no imports, no network.\n' +
				"container.textContent = String(runtime?.text ?? el.label ?? 'custom');"
		},
		styleDefaults: { size: 13 },
		fields: [
			{ key: 'label', kind: 'text', label: 'text', placeholder: '' },
			{ key: 'code', kind: 'code', label: 'code', hint: 'A render function body. Double-click the element on the board to open the editor.' }
		],
		style: [...TEXT_STYLE, STYLE.bg, STYLE.border, STYLE.radius, STYLE.pad]
	},
	// ==================================================================================
	// 21-E7.6 THE GAME PACK. Each is ONE entry here plus ONE renderer branch in
	// HudElement - the pane and the palette pick them up with no UI code of their own,
	// which is the drift-proof rule this table exists for.
	// ==================================================================================
	{
		key: 'minimap',
		label: 'Minimap',
		group: 'Display',
		icon: 'map',
		defaultSize: { w: 180, h: 180 },
		summary: 'A top-down plot of the scene, you and your peers as dots, plus any userData.play markers.',
		defaults: { range: 40, follow: true, dots: true, shapes: true },
		styleDefaults: { bg: 'rgb(10 12 16 / 0.85)', border: 'rgb(75 85 99 / 0.7)', radius: 6 },
		fields: [
			{ key: 'range', kind: 'number', label: 'range', min: 5, max: 500, step: 5, hint: 'World units across the whole map.' },
			{ key: 'follow', kind: 'toggle', label: 'follow me', hint: 'OFF centres on the world origin instead.' },
			{ key: 'shapes', kind: 'toggle', label: 'show scene' },
			{ key: 'dots', kind: 'toggle', label: 'show players' }
		],
		style: [STYLE.color, STYLE.bg, STYLE.border, STYLE.radius, STYLE.opacity]
	},
	{
		key: 'iconrow',
		label: 'Icon row',
		group: 'Display',
		icon: 'heart',
		defaultSize: { w: 140, h: 24 },
		summary: 'N repeated icons off a number - hearts, ammo, keys. Wire a HUD Bar node into it.',
		defaults: { icon: 'heart', min: 0, value: 3, max: 5, empty: true },
		styleDefaults: { size: 18, color: '#f87171' },
		fields: [
			{ key: 'icon', kind: 'text', label: 'icon', placeholder: 'heart', hint: 'A lucide icon name.' },
			{ key: 'value', kind: 'number', label: 'value', step: 1, hint: 'Preview count; a HUD Bar node overrides it.' },
			{ key: 'max', kind: 'number', label: 'max', min: 1, max: 20, step: 1 },
			{ key: 'empty', kind: 'toggle', label: 'show empty', hint: 'Draw the unfilled slots dim instead of hiding them.' }
		],
		style: [STYLE.color, STYLE.size, STYLE.align, STYLE.opacity]
	},
	{
		key: 'progressradial',
		label: 'Radial progress',
		group: 'Display',
		icon: 'circle-dashed',
		defaultSize: { w: 64, h: 64 },
		summary: 'A ring that fills - a cooldown, a cast bar, a charge. The same value/min/max a Bar takes.',
		defaults: { min: 0, max: 100, value: 65, thickness: 6, showPercent: true, clockwise: true },
		styleDefaults: { size: 12, bg: 'rgb(17 24 39 / 0.55)' },
		fields: [
			{ key: 'min', kind: 'number', label: 'min', step: 1 },
			{ key: 'max', kind: 'number', label: 'max', step: 1 },
			{ key: 'value', kind: 'number', label: 'value', step: 1, hint: 'Preview value; a HUD Bar node overrides it.' },
			{ key: 'thickness', kind: 'number', label: 'thickness', min: 1, max: 24, step: 1 },
			{ key: 'clockwise', kind: 'toggle', label: 'clockwise' },
			{ key: 'showPercent', kind: 'toggle', label: 'show %' }
		],
		// TEXT_STYLE already carries opacity; listing it again gives the pane an each-block
		// with a DUPLICATE KEY, which throws and takes the whole properties pane down
		style: [...TEXT_STYLE, STYLE.bg]
	},
	{
		key: 'hotbar',
		label: 'Hotbar',
		group: 'Display',
		icon: 'layout-grid',
		defaultSize: { w: 260, h: 44 },
		summary: 'N slots with one selected. Drive the selected index with a HUD Bar node, or read a Switcher into it.',
		defaults: { slots: 6, value: 0, labels: '', numbers: true },
		styleDefaults: { size: 12, bg: 'rgb(17 24 39 / 0.6)', border: 'rgb(75 85 99 / 0.7)', radius: 6, pad: 4 },
		fields: [
			{ key: 'slots', kind: 'number', label: 'slots', min: 1, max: 12, step: 1 },
			{ key: 'value', kind: 'number', label: 'selected', min: 0, step: 1, hint: 'Zero-based. Preview only; a node overrides it.' },
			{ key: 'labels', kind: 'text', label: 'labels', placeholder: 'Axe, Bow, Rope', hint: 'Comma separated, one per slot.' },
			{ key: 'numbers', kind: 'toggle', label: 'show numbers' }
		],
		style: [...TEXT_STYLE, STYLE.bg, STYLE.border, STYLE.radius, STYLE.pad]
	},
	{
		key: 'damageflash',
		label: 'Damage flash',
		group: 'Display',
		icon: 'zap',
		// the whole reference stage: this is a full-screen tint, so its authored size IS
		// the stage and its slot fills the layer
		defaultSize: { w: 1280, h: 720 },
		summary: 'A full-screen tint that spikes when something pulses it, then fades. Any HUD trigger aimed at this element flashes it.',
		defaults: { fade: 0.45 },
		styleDefaults: { bg: '#ef4444', opacity: 0.45 },
		fields: [
			{ key: 'fade', kind: 'number', label: 'fade', min: 0.05, max: 3, step: 0.05, hint: 'Seconds to fade back out. A CSS animation, so it costs no frames.' }
		],
		style: [STYLE.bg, STYLE.opacity]
	},
	// ==================================================================================
	// 21-E7.6 THE MENU PACK.
	// ==================================================================================
	{
		key: 'keyhint',
		label: 'Key hint',
		group: 'Display',
		icon: 'keyboard',
		defaultSize: { w: 130, h: 26 },
		summary: 'A key glyph and what it does - [E] Interact. The thing every game needs and nobody wants to draw.',
		defaults: { keyName: 'E', label: 'Interact' },
		styleDefaults: { size: 12, color: '#e5e7eb' },
		fields: [
			{ key: 'keyName', kind: 'text', label: 'key', placeholder: 'E' },
			{ key: 'label', kind: 'text', label: 'text', placeholder: 'Interact' }
		],
		style: [...TEXT_STYLE, STYLE.bg, STYLE.border, STYLE.radius, STYLE.pad]
	},
	{
		key: 'tabs',
		label: 'Tabs',
		group: 'Input',
		icon: 'columns-3',
		interactive: true,
		valued: true,
		// its VALUE is the tab INDEX, not the tab's text - so `hudinput`'s `index` read
		// answers it directly instead of looking the held text up in an option list. A
		// dropdown holds its text and keeps the lookup; declaring which is which here is
		// what keeps one read working correctly for both.
		indexValued: true,
		defaultSize: { w: 280, h: 30 },
		summary: 'A segmented pager. Its value is the selected INDEX - read it with a HUD Input node (read: index) and switch on it. It is not a screen switch.',
		defaults: { options: 'Video, Audio, Controls', value: 0, shared: false, enabled: true },
		styleDefaults: { size: 12, color: '#e5e7eb', bg: 'rgb(17 24 39 / 0.72)', radius: 5, pad: 3 },
		fields: [
			{ key: 'options', kind: 'text', label: 'tabs', placeholder: 'One, Two, Three', hint: 'Comma separated.' },
			{ key: 'value', kind: 'number', label: 'start tab', min: 0, step: 1, hint: 'Zero-based.' },
			{ key: 'enabled', kind: 'toggle', label: 'enabled' },
			{ key: 'shared', kind: 'toggle', label: 'shared', hint: 'OFF: which tab I am on is mine alone. ON: every peer follows.' }
		],
		style: [...TEXT_STYLE, STYLE.bg, STYLE.border, STYLE.radius, STYLE.pad]
	},
	{
		key: 'scrollpanel',
		label: 'Scroll panel',
		group: 'Layout',
		icon: 'scroll-text',
		defaultSize: { w: 280, h: 160 },
		summary: 'A scrollable box of rich text - credits, a rulebook, a quest log. The same markup as Rich text.',
		defaults: { title: '', label: 'Line one.\n\n**Line two** with {color:accent}colour{/color}.' },
		styleDefaults: { size: 13, bg: 'rgb(17 24 39 / 0.78)', border: 'rgb(75 85 99 / 0.7)', radius: 8, pad: 8 },
		fields: [
			{ key: 'title', kind: 'text', label: 'title', placeholder: '' },
			{ key: 'label', kind: 'list', label: 'text', hint: 'The Rich text markup, and it scrolls when it overflows.' }
		],
		style: [...TEXT_STYLE, STYLE.bg, STYLE.border, STYLE.radius, STYLE.pad]
	},
	{
		key: 'confirm',
		label: 'Confirm',
		group: 'Input',
		icon: 'circle-check',
		interactive: true,
		// NOT in hudActions' PRESSABLE list, and that is the point: this element's OWN id
		// never fires. Its two buttons fire the SUB-IDS below, so a HUD Button node binds
		// to `<id>-yes` or `<id>-no` - which is what makes 'are you sure' one element
		// instead of three that have to be kept in sync. The renderer derives both ids
		// from this array, so it is the source of truth and not a comment.
		subPress: ['yes', 'no'],
		defaultSize: { w: 240, h: 64 },
		summary: 'A question and two buttons. They fire <id>-yes and <id>-no, so a HUD Button node binds to those, not to this element.',
		defaults: { label: 'Are you sure?', yes: 'Yes', no: 'No', enabled: true },
		styleDefaults: { size: 13, color: '#e5e7eb', bg: 'rgb(17 24 39 / 0.78)', border: 'rgb(75 85 99 / 0.7)', radius: 8, pad: 8 },
		fields: [
			{ key: 'label', kind: 'text', label: 'question', placeholder: 'Are you sure?' },
			{ key: 'yes', kind: 'text', label: 'confirm', placeholder: 'Yes' },
			{ key: 'no', kind: 'text', label: 'cancel', placeholder: 'No' },
			{ key: 'enabled', kind: 'toggle', label: 'enabled' }
		],
		style: [...TEXT_STYLE, STYLE.bg, STYLE.border, STYLE.radius, STYLE.pad]
	}
];

/** @type {Record<string, HudKindDef>} */
const BY_KEY = {};
for (const def of HUD_KIND_DEFS) BY_KEY[def.key] = def;

/** Every kind this build can RENDER. An element of any other kind is preserved verbatim in
 * the document and skipped at render (the normalizeAnnotation rule) — so this list is the
 * render capability, never a validation whitelist. */
export const HUD_KINDS = HUD_KIND_DEFS.map((def) => def.key);

/**
 * The def behind a kind: a built-in first, then a MODULE-supplied one (21-E7.4).
 *
 * Every other reader goes through here, which is what makes a module kind a first-class
 * kind — the properties pane, the palette, normalize's defaults merge, `newElementOfKind`
 * and the renderer all learn about it from this one fall-through. A kind that is in
 * NEITHER table answers null, and that is not an error: the element is preserved verbatim
 * in the document and skipped at render (the normalizeAnnotation rule), which is exactly
 * what a peer without the module sees.
 * @param {string} kind @returns {HudKindDef|null}
 */
export function kindDef(kind) {
	return BY_KEY[kind] ?? /** @type {any} */ (moduleHudKindDef(kind)) ?? null;
}

/** Can this build DRAW this kind? `HUD_KINDS` cannot answer it any more: that list is the
 * built-in table (and is asserted to BE it), while a module kind is renderable and is not
 * in it. Every render-time filter reads this instead. @param {string} kind */
export function isRenderableKind(kind) {
	return !!kindDef(kind);
}

/** @param {string} kind */
export function isInteractiveKind(kind) {
	return !!kindDef(kind)?.interactive;
}

/** Kinds that hold a VALUE (D4 inputs). A `valued` kind gets a `shared` flag. @param {string} kind */
export function isValuedKind(kind) {
	return !!kindDef(kind)?.valued;
}

/** Does this kind's VALUE hold an index rather than the option's text? `tabs` does, a
 * `dropdown` does not — and `hudinput`'s `index` read needs to know which, or it looks a
 * number up in a list of words and answers the fallback. @param {string} kind */
export function isIndexValuedKind(kind) {
	return !!kindDef(kind)?.indexValued;
}

/** The SUB-IDS a kind fires instead of its own id (21-E7.6 `confirm` fires
 * `<id>-yes`/`<id>-no`). The renderer derives its buttons from this, so the array is the
 * source of truth and a HUD Button node binds to what it says. @param {string} kind
 * @returns {string[]} */
export function subPressIds(kind) {
	const list = kindDef(kind)?.subPress;
	return Array.isArray(list) ? list : [];
}

/**
 * The element params a kind understands, with their defaults. Merged UNDER the authored
 * element in normalize, so an absent param gains a default and an authored one is untouched.
 * An UNKNOWN kind answers `{}` — it must pass through unchanged.
 * @param {string} kind @returns {Record<string, any>}
 */
export function defaultsForKind(kind) {
	const def = kindDef(kind);
	return def ? { ...def.defaults } : {};
}

/** @param {string} kind @returns {Record<string, any>} */
export function styleDefaultsForKind(kind) {
	const def = kindDef(kind);
	return def?.styleDefaults ? { ...def.styleDefaults } : {};
}

/** @param {string} kind @returns {HudField[]} */
export function fieldsForKind(kind) {
	return kindDef(kind)?.fields ?? [];
}

/** @param {string} kind @returns {HudField[]} */
export function styleFieldsForKind(kind) {
	return kindDef(kind)?.style ?? [];
}

/** The palette, grouped in HUD_KIND_GROUPS order. Groups with no kinds are dropped, so the
 * palette never shows an empty header. @returns {{group: string, items: HudKindDef[]}[]} */
export function paletteGroups() {
	const built = HUD_KIND_GROUPS.map((group) => ({
		group,
		items: HUD_KIND_DEFS.filter((def) => def.group === group)
	})).filter((entry) => entry.items.length > 0);
	// 21-E7.4: a module's kinds come AFTER the built-ins, grouped under the module's own
	// name — the registerNodeGroup convention, so a user reads "Racing HUD" rather than
	// finding a stranger's element filed under Display.
	/** @type {{group: string, items: any[]}[]} */
	const mods = [];
	for (const def of moduleHudKindList()) {
		let entry = mods.find((e) => e.group === def.group);
		if (!entry) mods.push((entry = { group: def.group, items: [] }));
		// the palette reads `key`, so a module def is presented in the built-in shape
		entry.items.push({ ...def, key: def.kind });
	}
	return [...built, ...mods];
}

/** A fresh element body for a kind — what the palette and the Add menu both create.
 * @param {string} kind @returns {Record<string, any>} */
export function newElementOfKind(kind) {
	const def = kindDef(kind);
	return {
		kind,
		...defaultsForKind(kind),
		w: def?.defaultSize.w ?? 140,
		h: def?.defaultSize.h ?? 28,
		style: styleDefaultsForKind(kind)
	};
}

// ---- 21-E7.7: STYLE PRESETS ------------------------------------------------------
//
// A HUD has ten style knobs per element and a menu has ten elements, so making one look
// deliberate by hand is a hundred decisions. A preset is a coordinated set of the same
// style keys the pane already writes — PLAIN DOCUMENT DATA, no new concept, no new field,
// nothing to replicate or restore. Applying one is an ordinary document edit, so it
// replicates and undoes like any other.
//
// Applied THROUGH the registry: `presetStyleFor` intersects the preset with the kind's own
// declared style fields, so a crosshair (colour and opacity only) does not silently gain a
// background it cannot draw, and a kind added later needs no edit here.

/** @type {{key: string, label: string, hint: string, style: Record<string, any>}[]} */
export const HUD_STYLE_PRESETS = [
	{
		key: 'scifi',
		label: 'Sci-fi',
		hint: 'Cyan edges, monospace, hard corners.',
		style: { bg: 'rgb(8 20 28 / 0.72)', border: 'rgb(56 189 248 / 0.65)', color: '#d8f6ff', radius: 2, pad: 6, font: 'ui-monospace, monospace', weight: '500' }
	},
	{
		key: 'fantasy',
		label: 'Fantasy',
		hint: 'Parchment and gold, soft corners, serif.',
		style: { bg: 'rgb(41 26 12 / 0.78)', border: 'rgb(197 154 74 / 0.7)', color: '#f6e6c6', radius: 10, pad: 8, font: 'Georgia, serif', weight: '600' }
	},
	{
		key: 'minimal',
		label: 'Minimal',
		// an EMPTY border is how HudElement is told to draw none, so this really does strip
		// the chrome rather than painting a transparent one over it
		hint: 'No boxes at all — just the text.',
		style: { bg: 'transparent', border: '', color: '#f3f4f6', radius: 0, pad: 0, font: '', weight: '400' }
	},
	{
		key: 'clean',
		label: 'Clean',
		hint: 'Light cards on a dark scene.',
		style: { bg: 'rgb(255 255 255 / 0.9)', border: 'rgb(15 23 42 / 0.14)', color: '#0f172a', radius: 8, pad: 8, font: '', weight: '500' }
	},
	{
		key: 'themed',
		label: 'Follow my theme',
		// TOKENS, not literals: this one preset looks different per viewer on purpose, which
		// is the thing tokens are for and the only preset that can honour a custom theme
		hint: 'Theme tokens, so it follows each viewer\'s own colours.',
		style: { bg: 'surface', border: 'border', color: 'text', radius: 6, pad: 6, font: '', weight: '500' }
	}
];

/** @param {string} key */
export function stylePreset(key) {
	return HUD_STYLE_PRESETS.find((p) => p.key === key) ?? null;
}

/**
 * The part of a preset a given kind can actually use. Intersecting with the kind's own
 * declared `style` fields is what keeps this drift-proof: nothing here lists kinds, and a
 * kind that declares no `bg` simply does not receive one.
 * @param {string} kind @param {string} presetKey @returns {Record<string, any>}
 */
export function presetStyleFor(kind, presetKey) {
	const preset = stylePreset(presetKey);
	if (!preset) return {};
	const allowed = new Set(styleFieldsForKind(kind).map((field) => field.key));
	/** @type {Record<string, any>} */
	const out = {};
	for (const [key, value] of Object.entries(preset.style)) if (allowed.has(key)) out[key] = value;
	return out;
}
