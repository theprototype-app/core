// Roadmap 85 H1 / H2 + the `hud {panel}` shape — the PURE half of the HUD tools (imports nothing; the unit
// layer runs it). hudTools.js applies what this plans through hudDocs' single write path.
//
// An agent describes an element in the words the HUD editor uses (kind, text, anchor, x / y / w / h, style)
// and gets ids back to bind a `hudtext` / `hudbar` / `hudtimer` node to (their `element` field). A PANEL is
// the existing `panel` kind as a backdrop with rows laid out top-down inside it; every row carries
// `panel: <panelId>` (normalizeHudElement keeps unknown fields verbatim), so moving or removing the panel
// moves or removes its rows. Nothing here knows about a store, so 67's scene panels can reuse it.

export const HUD_ANCHOR_NAMES = [
	'top-left',
	'top-center',
	'top-right',
	'middle-left',
	'center',
	'middle-right',
	'bottom-left',
	'bottom-center',
	'bottom-right'
];

/** spellings an agent reaches for → the 9-grid name */
const ANCHOR_ALIASES = /** @type {Record<string, string>} */ ({
	top: 'top-center',
	bottom: 'bottom-center',
	left: 'middle-left',
	right: 'middle-right',
	middle: 'center',
	centre: 'center',
	'middle-center': 'center',
	'center-center': 'center',
	'top-middle': 'top-center',
	'bottom-middle': 'bottom-center',
	'center-left': 'middle-left',
	'center-right': 'middle-right'
});

/** the style keys the editor's style rows write (hudKinds STYLE) */
export const HUD_STYLE_KEYS = ['size', 'weight', 'font', 'color', 'bg', 'border', 'radius', 'pad', 'align', 'opacity'];

/** fields every element has; the rest are the kind's own (hudKinds fields) */
const COMMON = new Set(['kind', 'text', 'label', 'anchor', 'x', 'y', 'w', 'h', 'z', 'style', 'id', 'panel', 'ref']);

export const MAX_ELEMENTS_PER_CALL = 60;
export const MAX_SCREENS_PER_CALL = 8;
export const MAX_ROWS_PER_PANEL = 24;
export const SHOW_WHILE = ['', 'menu', 'playing', 'paused', 'over'];

/** @param {any} v */
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** @param {any} raw @returns {string | null} the 9-grid name, or null */
export function anchorOf(raw) {
	if (typeof raw !== 'string') return null;
	const k = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
	if (HUD_ANCHOR_NAMES.includes(k)) return k;
	return ANCHOR_ALIASES[k] ?? null;
}

/**
 * One agent element spec → the fields of a HUD element (no id; the store mints it).
 * @param {any} spec
 * @param {{kinds: string[], fieldsOf: (kind: string) => string[]}} reg the registry's kinds and each kind's field keys
 * @returns {{element: Record<string, any>, warnings: string[]} | {error: string}}
 */
export function planElement(spec, reg) {
	if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { error: 'an element is an object like {"kind": "text", "text": "Score: 0"}' };
	const kind = typeof spec.kind === 'string' ? spec.kind.trim().toLowerCase() : 'text';
	if (!reg.kinds.includes(kind)) return { error: 'kind "' + String(spec.kind).slice(0, 30) + '": one of ' + reg.kinds.join(', ') };
	/** @type {Record<string, any>} */
	const element = { kind };
	/** @type {string[]} */
	const warnings = [];
	const text = spec.text ?? spec.label;
	if (text !== undefined) {
		if (typeof text !== 'string' && !finite(text)) return { error: kind + ': text is a string' };
		element.label = String(text).slice(0, 500);
	}
	if (spec.anchor !== undefined) {
		const a = anchorOf(spec.anchor);
		if (!a) return { error: 'anchor "' + String(spec.anchor).slice(0, 30) + '": one of ' + HUD_ANCHOR_NAMES.join(', ') };
		element.anchor = a;
	}
	for (const key of ['x', 'y', 'w', 'h', 'z']) {
		if (spec[key] === undefined) continue;
		if (!finite(spec[key])) return { error: kind + ': ' + key + ' is a number of pixels' };
		const lo = key === 'w' || key === 'h' ? 8 : -4000;
		element[key] = Math.round(Math.min(4000, Math.max(lo, spec[key])));
	}
	if (spec.style !== undefined) {
		if (!spec.style || typeof spec.style !== 'object' || Array.isArray(spec.style)) return { error: kind + ': style is an object like {"size": 20, "color": "#ffffff"}' };
		/** @type {Record<string, any>} */
		const style = {};
		for (const [k, v] of Object.entries(spec.style)) {
			if (!HUD_STYLE_KEYS.includes(k)) {
				warnings.push('style.' + k + ' is not a HUD style (' + HUD_STYLE_KEYS.join(', ') + ')');
				continue;
			}
			if (typeof v !== 'string' && !finite(v)) continue;
			style[k] = typeof v === 'string' ? v.slice(0, 80) : v;
		}
		element.style = style;
	}
	const own = new Set(reg.fieldsOf(kind));
	for (const [k, v] of Object.entries(spec)) {
		if (COMMON.has(k)) continue;
		if (!own.has(k)) {
			warnings.push(kind + ' has no field "' + k + '"' + (own.size ? ' (its fields: ' + [...own].join(', ') + ')' : ''));
			continue;
		}
		if (v === null || typeof v === 'function') continue;
		element[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
	}
	return { element, warnings };
}

/**
 * A patch for an existing element: the same words, every field optional; `kind` cannot change.
 * @param {any} spec @param {string} kind the element's kind @param {{kinds: string[], fieldsOf: (kind: string) => string[]}} reg
 * @returns {{patch: Record<string, any>, warnings: string[]} | {error: string}}
 */
export function planElementPatch(spec, kind, reg) {
	if (spec?.kind !== undefined && String(spec.kind).toLowerCase() !== kind) return { error: 'kind cannot change (' + kind + '): remove it and create a new one' };
	const planned = planElement({ ...spec, kind }, reg);
	if ('error' in planned) return planned;
	const { kind: _k, ...patch } = planned.element;
	return { patch, warnings: planned.warnings };
}

/**
 * Lay a panel out: the backdrop + one element per row, top-down inside it.
 * @param {any} spec {title?, anchor?, x?, y?, w?, rows: [...element specs], gap?, pad?, style?}
 * @param {{kinds: string[], fieldsOf: (kind: string) => string[], heightOf: (kind: string) => number}} reg
 * @returns {{panel: Record<string, any>, rows: Record<string, any>[], warnings: string[]} | {error: string}}
 */
export function planPanel(spec, reg) {
	if (!spec || typeof spec !== 'object') return { error: 'panel: an object like {"title": "Settings", "rows": [{"kind": "slider", "text": "Volume"}]}' };
	const rowsIn = Array.isArray(spec.rows) ? spec.rows : [];
	if (rowsIn.length > MAX_ROWS_PER_PANEL) return { error: 'panel: at most ' + MAX_ROWS_PER_PANEL + ' rows' };
	const pad = finite(spec.pad) ? Math.max(0, Math.min(48, spec.pad)) : 12;
	const gap = finite(spec.gap) ? Math.max(0, Math.min(48, spec.gap)) : 8;
	const w = finite(spec.w) ? Math.max(80, Math.min(1600, spec.w)) : 260;
	const anchor = spec.anchor === undefined ? 'center' : anchorOf(spec.anchor);
	if (!anchor) return { error: 'panel anchor: one of ' + HUD_ANCHOR_NAMES.join(', ') };
	/** @type {string[]} */
	const warnings = [];
	/** @type {Record<string, any>[]} */
	const rows = [];
	let y = pad;
	const title = typeof spec.title === 'string' && spec.title.trim() ? spec.title.trim().slice(0, 120) : '';
	if (title) {
		rows.push({ kind: 'text', label: title, x: pad, y, w: w - pad * 2, h: 28, style: { size: 18, weight: '600' } });
		y += 28 + gap;
	}
	for (const [i, row] of rowsIn.entries()) {
		const planned = planElement(row, reg);
		if ('error' in planned) return { error: 'rows[' + i + ']: ' + planned.error };
		warnings.push(...planned.warnings.map((m) => 'rows[' + i + ']: ' + m));
		const el = planned.element;
		const h = finite(el.h) ? el.h : reg.heightOf(el.kind);
		// rows sit inside the panel: their x / y are offsets from its top-left corner
		rows.push({ ...el, x: pad + (finite(el.x) ? el.x : 0), y, w: finite(el.w) ? el.w : w - pad * 2, h });
		y += h + gap;
	}
	const h = finite(spec.h) ? Math.max(40, Math.min(2000, spec.h)) : Math.max(40, y - gap + pad);
	/** @type {Record<string, any>} */
	const panel = { kind: 'panel', label: '', anchor, x: finite(spec.x) ? Math.round(spec.x) : 0, y: finite(spec.y) ? Math.round(spec.y) : 0, w, h };
	if (spec.style && typeof spec.style === 'object') {
		const planned = planElement({ kind: 'panel', style: spec.style }, reg);
		if (!('error' in planned) && planned.element.style) panel.style = planned.element.style;
	}
	return { panel, rows, warnings };
}

/**
 * Where a panel row sits on screen, from the panel's anchor + offset and the row's offset inside it.
 * Rows share the panel's anchor; for a right / bottom / centre anchor the row's own box is placed so it stays
 * inside the panel (the anchor reads from the frame edge to the element's matching edge).
 * @param {{anchor: string, x: number, y: number, w: number, h: number}} panel @param {{x: number, y: number, w: number, h: number}} row
 * @returns {{anchor: string, x: number, y: number}}
 */
export function rowPlacement(panel, row) {
	const [v, hz] = panel.anchor === 'center' ? ['middle', 'center'] : panel.anchor.split('-');
	// the row's left / top inside the frame, measured the way the panel's anchor measures
	const x = hz === 'left' ? panel.x + row.x : hz === 'right' ? panel.x + (panel.w - row.x - row.w) : panel.x + (row.x + row.w / 2 - panel.w / 2);
	const y = v === 'top' ? panel.y + row.y : v === 'bottom' ? panel.y + (panel.h - row.y - row.h) : panel.y + (row.y + row.h / 2 - panel.h / 2);
	return { anchor: panel.anchor, x: Math.round(x), y: Math.round(y) };
}

/**
 * What list_hud answers for one document: screens, their elements in the agent's words, and bindings.
 * @param {any} doc a normalized HUD doc @param {(id: string) => string[]} [boundBy] the node words wired to an element
 * @returns {any}
 */
export function describeHudDoc(doc, boundBy = () => []) {
	return {
		active: doc.active,
		screens: doc.screens.map((/** @type {any} */ s) => ({
			id: s.id,
			name: s.name,
			...(s.showWhile ? { showWhile: s.showWhile } : {}),
			...(s.input === 'menu' ? { input: 'menu' } : {}),
			active: s.id === doc.active,
			elements: s.elements.map((/** @type {any} */ el) => {
				/** @type {Record<string, any>} */
				const out = { id: el.id, kind: el.kind };
				if (el.label) out.text = el.label;
				out.anchor = el.anchor;
				out.x = el.x;
				out.y = el.y;
				out.w = el.w;
				out.h = el.h;
				if (el.panel) out.panel = el.panel;
				for (const k of ['min', 'max', 'value', 'duration', 'countDown', 'src', 'options', 'shared', 'enabled']) if (el[k] !== undefined && el[k] !== '') out[k] = el[k];
				const bound = boundBy(el.id);
				if (bound.length) out.boundTo = bound;
				return out;
			})
		}))
	};
}
