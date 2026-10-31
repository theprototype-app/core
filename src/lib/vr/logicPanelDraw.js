// VR controls — 74 VH1: PAINT the logic panel and its wrist pad. DOM is invisible in a headset, so each is
// one canvas on one plane (ONE draw call each — a node graph of meshes + troika labels would cost a draw
// per card, per socket, per wire). Pure over its arguments (imports nothing): it paints one view and
// returns the pressable rects, the shape the laser hit test reads (the assetBrowserDraw / shellPanelDraw
// convention). The GRAPH area is not a list of rects — logicPanel.js hit-tests it through
// logicGraphCore.hitGraph against the same layout painted here.
//
// Canvas colours are literals (a canvas cannot read a CSS var()), the headset-panel exception the other VR
// panels take; body text keeps >= 7:1 on the panel ground. Sockets say their type by SHAPE as well as by
// hue (53 A2: number disc, vector3 diamond, boolean square, color hexagon, object pentagon, event arrow,
// effect star, anything else a capsule), so colour is never the only cue.

/** the graph panel's canvas (pinned in the world, ~0.96 m wide: ~1.33 px/mm, read from ~0.8 m) */
export const PANEL_PX = { w: 1280, h: 800 };
/** where the graph is drawn on the panel canvas */
export const GRAPH_AREA = { x: 12, y: 96, w: 1256, h: 636 };
/** the wrist pad's canvas (0.2 m on the wrist, the Asset Browser's size) */
export const PAD_PX = { w: 768, h: 896 };
/** value rows per pad page */
export const PAD_ROWS = 6;
/** palette: groups per column page, item cards per page */
export const PAL_GROUPS = 9;
export const PAL_COLS = 3;
export const PAL_ROWS = 6;
export const PAL_PAGE = PAL_COLS * PAL_ROWS;

/** @typedef {{id: string, x: number, y: number, w: number, h: number}} PanelHit */

const C = {
	bg: 'rgba(17, 21, 28, 0.96)',
	border: '#2f3846',
	title: '#f1f4f8',
	body: '#d5dbe4',
	dim: '#97a1b0',
	grid: 'rgba(255, 255, 255, 0.05)',
	card: '#232934',
	cardHead: '#2c3442',
	cardHover: '#33405a',
	cardSel: '#5aa2ff',
	note: 'rgba(250, 204, 21, 0.10)',
	noteBorder: 'rgba(250, 204, 21, 0.45)',
	button: '#2a313d',
	buttonHover: '#3b4658',
	on: '#2563eb',
	accent: '#5aa2ff',
	warn: '#fbbf24',
	bad: '#f87171',
	ok: '#3fb950',
	wire: '#7d8796',
	inset: '#11151c',
	danger: '#7f1d1d'
};

/** socket type -> hue (the desktop theme's dark socket tints, as literals) */
export const SOCKET_HUES = {
	number: '#5aa2ff',
	vector3: '#c084fc',
	boolean: '#f59e0b',
	color: '#ec4899',
	object: '#22c55e',
	event: '#f87171',
	effect: '#facc15',
	any: '#9ca3af'
};
/** group name -> the card's accent strip (unknown groups — modules — take the module accent) */
const GROUP_HUES = /** @type {Record<string, string>} */ ({
	Input: '#5aa2ff',
	Scene: '#22c55e',
	'Object Flow': '#14b8a6',
	Game: '#f59e0b',
	Character: '#fb923c',
	HUD: '#e879f9',
	Logic: '#a78bfa',
	Triggers: '#f87171',
	Animation: '#38bdf8',
	Physics: '#84cc16',
	Effects: '#facc15',
	Music: '#f472b6'
});
/** @param {string | null | undefined} group */
export function groupHue(group) {
	return (group && GROUP_HUES[group]) || '#94a3b8';
}

/** @param {CanvasRenderingContext2D} g @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r */
function roundRect(g, x, y, w, h, r) {
	const rr = Math.max(0, Math.min(r, w / 2, h / 2));
	g.beginPath();
	g.moveTo(x + rr, y);
	g.arcTo(x + w, y, x + w, y + h, rr);
	g.arcTo(x + w, y + h, x, y + h, rr);
	g.arcTo(x, y + h, x, y, rr);
	g.arcTo(x, y, x + w, y, rr);
	g.closePath();
}

/** one line, shortened with an ellipsis to fit `maxW` @param {CanvasRenderingContext2D} g @param {string} text @param {number} maxW */
export function fitText(g, text, maxW) {
	const s = String(text ?? '');
	if (maxW <= 0) return '';
	if (g.measureText(s).width <= maxW) return s;
	let lo = 0;
	let hi = s.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (g.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid;
		else hi = mid - 1;
	}
	return s.slice(0, lo) + '…';
}

/** a socket glyph centred on (x, y), radius r, shaped by type @param {CanvasRenderingContext2D} g @param {string} type @param {number} x @param {number} y @param {number} r */
function socketGlyph(g, type, x, y, r) {
	const poly = (/** @type {number} */ n, /** @type {number} */ rot, /** @type {number} */ rad = r) => {
		g.beginPath();
		for (let i = 0; i < n; i++) {
			const a = rot + (i * Math.PI * 2) / n;
			const px = x + Math.cos(a) * rad;
			const py = y + Math.sin(a) * rad;
			if (i) g.lineTo(px, py);
			else g.moveTo(px, py);
		}
		g.closePath();
	};
	if (type === 'number') {
		g.beginPath();
		g.arc(x, y, r, 0, Math.PI * 2);
	} else if (type === 'vector3') poly(4, 0, r * 1.15);
	else if (type === 'boolean') poly(4, Math.PI / 4, r * 1.2);
	else if (type === 'color') poly(6, 0, r * 1.05);
	else if (type === 'object') poly(5, -Math.PI / 2, r * 1.1);
	else if (type === 'event') poly(3, 0, r * 1.2);
	else if (type === 'effect') {
		g.beginPath();
		for (let i = 0; i < 10; i++) {
			const a = -Math.PI / 2 + (i * Math.PI) / 5;
			const rad = i % 2 ? r * 0.55 : r * 1.25;
			const px = x + Math.cos(a) * rad;
			const py = y + Math.sin(a) * rad;
			if (i) g.lineTo(px, py);
			else g.moveTo(px, py);
		}
		g.closePath();
	} else roundRect(g, x - r * 1.3, y - r * 0.75, r * 2.6, r * 1.5, r * 0.75);
	g.fillStyle = SOCKET_HUES[/** @type {keyof typeof SOCKET_HUES} */ (type)] ?? SOCKET_HUES.any;
	g.fill();
	g.lineWidth = Math.max(1, r * 0.25);
	g.strokeStyle = '#0b0e13';
	g.stroke();
}

/** a bezier wire between two canvas points @param {CanvasRenderingContext2D} g @param {{x: number, y: number}} a @param {{x: number, y: number}} b */
function wirePath(g, a, b) {
	const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
	g.beginPath();
	g.moveTo(a.x, a.y);
	g.bezierCurveTo(a.x + dx, a.y, b.x - dx, b.y, b.x, b.y);
}

/**
 * @typedef {{id: string, x: number, y: number, w: number, h: number, kind: 'node' | 'note' | 'group', label: string,
 *   sub?: string, group?: string | null, selected?: boolean, hover?: boolean, dragging?: boolean, muted?: boolean,
 *   noteColor?: string,
 *   inputs: {id: string | null, label: string, x: number, y: number, type: string, hot?: boolean}[],
 *   outputs: {id: string | null, label: string, x: number, y: number, type: string, hot?: boolean}[]}} PaintCard
 */
/** @typedef {{a: {x: number, y: number}, b: {x: number, y: number}, type: string, proxy?: boolean, hot?: boolean, detached?: boolean}} PaintWire */
/**
 * @typedef {{title: string, tabs: {id: string, label: string, on: boolean}[], cards: PaintCard[], wires: PaintWire[],
 *   view: {s: number, ox: number, oy: number},
 *   rubber: {a: {x: number, y: number}, b: {x: number, y: number}, ok: boolean | null, type: string} | null,
 *   status: string, statusTone?: 'info' | 'warn' | 'bad', empty: string, readOnly: boolean, canUndo: boolean, canRedo: boolean,
 *   palette: null | {groups: string[], group: number, gpage: number, gpages: number, items: {type: string, label: string}[], page: number, pages: number}}} LogicView
 */

/**
 * Paint the graph panel. Wires and cards are in GRAPH units and go through `view.view`; the rubber band is
 * in canvas px already. Returns the header / palette buttons.
 * @param {CanvasRenderingContext2D} g @param {LogicView} view @param {{hover: string | null}} opts
 * @returns {PanelHit[]}
 */
export function drawLogicPanel(g, view, opts) {
	const { w: W, h: H } = PANEL_PX;
	/** @type {PanelHit[]} */
	const hits = [];
	const hot = (/** @type {string} */ id) => opts.hover === id;
	g.clearRect(0, 0, W, H);
	roundRect(g, 2, 2, W - 4, H - 4, 28);
	g.fillStyle = C.bg;
	g.fill();
	g.lineWidth = 3;
	g.strokeStyle = C.border;
	g.stroke();
	g.textBaseline = 'middle';

	/** @param {string} id @param {string} label @param {number} x @param {number} y @param {number} w @param {number} h @param {{on?: boolean, disabled?: boolean, danger?: boolean}} [o] */
	const button = (id, label, x, y, w, h, o = {}) => {
		roundRect(g, x, y, w, h, 14);
		g.fillStyle = o.on ? C.on : o.danger ? C.danger : hot(id) && !o.disabled ? C.buttonHover : C.button;
		g.fill();
		g.fillStyle = o.disabled ? C.dim : C.title;
		g.textAlign = 'center';
		g.fillText(fitText(g, label, w - 16), x + w / 2, y + h / 2 + 1);
		if (!o.disabled) hits.push({ id, x, y, w, h });
	};

	// ---- header: title · graph tabs · tools · close --------------------------------------------------
	g.fillStyle = C.title;
	g.font = '600 38px system-ui, sans-serif';
	g.textAlign = 'left';
	g.fillText('Logic', 28, 48);
	g.font = '500 26px system-ui, sans-serif';
	let tx = 140;
	for (const t of view.tabs) {
		const tw = Math.min(260, Math.max(130, g.measureText(t.label).width + 40));
		button(t.id, t.label, tx, 18, tw, 60, { on: t.on });
		tx += tw + 12;
	}
	const right = [
		['add', '+ Node', 150, { disabled: view.readOnly, on: !!view.palette }],
		['undo', '↶', 64, { disabled: !view.canUndo }],
		['redo', '↷', 64, { disabled: !view.canRedo }],
		['fit', 'Fit', 84, {}],
		['zoom:-1', '−', 64, {}],
		['zoom:1', '+', 64, {}],
		['close', '✕', 64, {}]
	];
	let rx = W - 20;
	for (let i = right.length - 1; i >= 0; i--) {
		const [id, label, bw, o] = /** @type {[string, string, number, any]} */ (right[i]);
		rx -= bw;
		button(id, label, rx, 18, bw, 60, o);
		rx -= 10;
	}

	// ---- the graph ---------------------------------------------------------------------------------------
	const A = GRAPH_AREA;
	roundRect(g, A.x, A.y, A.w, A.h, 18);
	g.fillStyle = C.inset;
	g.fill();
	g.save();
	roundRect(g, A.x, A.y, A.w, A.h, 18);
	g.clip();
	const v = view.view;
	// a dot grid every 40 graph units, so a pan reads as movement
	const step = 40 * v.s;
	if (step >= 12) {
		g.fillStyle = C.grid;
		const x0 = A.x + (((v.ox - A.x) % step) + step) % step;
		const y0 = A.y + (((v.oy - A.y) % step) + step) % step;
		for (let x = x0; x < A.x + A.w; x += step) for (let y = y0; y < A.y + A.h; y += step) g.fillRect(x - 1.5, y - 1.5, 3, 3);
	}
	if (view.palette) drawPalette(g, view.palette, button, hot, hits);
	else {
		const P = (/** @type {number} */ gx, /** @type {number} */ gy) => ({ x: gx * v.s + v.ox, y: gy * v.s + v.oy });
		// notes first (a backdrop), then wires, then cards
		for (const c of view.cards) if (c.kind === 'note') drawNote(g, c, v, P);
		for (const w of view.wires) {
			if (w.detached) continue;
			wirePath(g, P(w.a.x, w.a.y), P(w.b.x, w.b.y));
			g.lineWidth = Math.max(2, (w.hot ? 5 : 3) * Math.min(1.4, v.s));
			g.strokeStyle = w.hot ? C.accent : w.proxy ? 'rgba(125, 135, 150, 0.55)' : SOCKET_HUES[/** @type {keyof typeof SOCKET_HUES} */ (w.type)] ?? C.wire;
			if (w.proxy) g.setLineDash([10, 8]);
			g.stroke();
			g.setLineDash([]);
		}
		for (const c of view.cards) if (c.kind !== 'note') drawCard(g, c, v, P);
		if (view.rubber) {
			const { a, b, ok } = view.rubber;
			wirePath(g, a, b);
			g.lineWidth = 5;
			g.strokeStyle = ok === false ? C.bad : ok ? C.ok : SOCKET_HUES[/** @type {keyof typeof SOCKET_HUES} */ (view.rubber.type)] ?? C.accent;
			g.setLineDash(ok ? [] : [12, 8]);
			g.stroke();
			g.setLineDash([]);
			g.beginPath();
			g.arc(b.x, b.y, 9, 0, Math.PI * 2);
			g.fillStyle = g.strokeStyle;
			g.fill();
		}
		if (!view.cards.length) {
			g.fillStyle = C.dim;
			g.font = '400 30px system-ui, sans-serif';
			g.textAlign = 'center';
			g.fillText(view.empty, A.x + A.w / 2, A.y + A.h / 2);
		}
	}
	g.restore();

	// ---- footer: status -------------------------------------------------------------------------------------
	g.textAlign = 'left';
	g.font = '500 26px system-ui, sans-serif';
	g.fillStyle = view.statusTone === 'bad' ? C.bad : view.statusTone === 'warn' ? C.warn : C.body;
	g.fillText(fitText(g, view.status, W - 56), 28, 766);
	return hits;
}

/** @param {CanvasRenderingContext2D} g @param {PaintCard} c @param {{s: number}} v @param {(x: number, y: number) => {x: number, y: number}} P */
function drawNote(g, c, v, P) {
	const p = P(c.x, c.y);
	const w = c.w * v.s;
	const h = c.h * v.s;
	roundRect(g, p.x, p.y, w, h, 10 * v.s);
	g.fillStyle = C.note;
	g.fill();
	g.lineWidth = c.selected ? 4 : 2;
	g.strokeStyle = c.selected ? C.cardSel : c.hover ? C.accent : C.noteBorder;
	g.stroke();
	const fs = 15 * v.s;
	if (fs >= 7) {
		g.fillStyle = C.body;
		g.font = `600 ${fs}px system-ui, sans-serif`;
		g.textAlign = 'left';
		g.fillText(fitText(g, c.label, w - 16 * v.s), p.x + 10 * v.s, p.y + 14 * v.s);
	}
}

/** @param {CanvasRenderingContext2D} g @param {PaintCard} c @param {{s: number}} v @param {(x: number, y: number) => {x: number, y: number}} P */
function drawCard(g, c, v, P) {
	const p = P(c.x, c.y);
	const w = c.w * v.s;
	const h = c.h * v.s;
	const r = 10 * v.s;
	if (c.dragging) {
		roundRect(g, p.x + 6, p.y + 8, w, h, r);
		g.fillStyle = 'rgba(0, 0, 0, 0.35)';
		g.fill();
	}
	roundRect(g, p.x, p.y, w, h, r);
	g.fillStyle = c.hover ? C.cardHover : C.card;
	g.fill();
	// the title row, tinted by the palette group
	g.save();
	roundRect(g, p.x, p.y, w, h, r);
	g.clip();
	g.fillStyle = C.cardHead;
	g.fillRect(p.x, p.y, w, 30 * v.s);
	g.fillStyle = groupHue(c.group);
	g.fillRect(p.x, p.y, Math.max(3, 6 * v.s), h);
	g.restore();
	roundRect(g, p.x, p.y, w, h, r);
	g.lineWidth = c.selected ? 4 : c.hover ? 3 : 1.5;
	g.strokeStyle = c.selected ? C.cardSel : c.hover ? C.accent : C.border;
	if (c.kind === 'group') g.setLineDash([8, 5]);
	g.stroke();
	g.setLineDash([]);
	const fs = 15 * v.s;
	if (fs >= 7) {
		g.textAlign = 'left';
		g.font = `600 ${fs}px system-ui, sans-serif`;
		g.fillStyle = c.muted ? C.dim : C.title;
		g.fillText(fitText(g, c.label, w - 34 * v.s), p.x + 14 * v.s, p.y + 15 * v.s);
		const ls = 12 * v.s;
		g.font = `400 ${ls}px system-ui, sans-serif`;
		g.fillStyle = C.body;
		for (const s of c.inputs) {
			if (!s.label) continue;
			const q = P(s.x, s.y);
			g.textAlign = 'left';
			g.fillText(fitText(g, s.label, w / 2 - 14 * v.s), q.x + 12 * v.s, q.y);
		}
		for (const s of c.outputs) {
			if (!s.label) continue;
			const q = P(s.x, s.y);
			g.textAlign = 'right';
			g.fillText(fitText(g, s.label, w / 2 - 14 * v.s), q.x - 12 * v.s, q.y);
		}
		if (c.sub) {
			g.textAlign = 'center';
			g.fillStyle = C.dim;
			g.fillText(fitText(g, c.sub, w - 24 * v.s), p.x + w / 2, p.y + h - 14 * v.s);
		}
	}
	const sr = Math.max(4, 6 * v.s);
	for (const s of [...c.inputs, ...c.outputs]) {
		const q = P(s.x, s.y);
		if (s.hot) {
			g.beginPath();
			g.arc(q.x, q.y, sr * 2.2, 0, Math.PI * 2);
			g.fillStyle = 'rgba(90, 162, 255, 0.35)';
			g.fill();
		}
		socketGlyph(g, s.type, q.x, q.y, sr);
	}
}

/**
 * The add-a-node palette over the graph area: group list on the left, the group's node types as cards on the
 * right. @param {CanvasRenderingContext2D} g @param {NonNullable<LogicView['palette']>} pal
 * @param {(id: string, label: string, x: number, y: number, w: number, h: number, o?: any) => void} button
 * @param {(id: string) => boolean} hot @param {PanelHit[]} hits
 */
function drawPalette(g, pal, button, hot, hits) {
	const A = GRAPH_AREA;
	g.font = '500 26px system-ui, sans-serif';
	const gx = A.x + 16;
	const gw = 300;
	const gh = 56;
	const first = pal.gpage * PAL_GROUPS;
	pal.groups.slice(first, first + PAL_GROUPS).forEach((name, i) => {
		const index = first + i;
		button('pal:group:' + index, name, gx, A.y + 16 + i * (gh + 8), gw, gh, { on: index === pal.group });
	});
	if (pal.gpages > 1) {
		button('pal:gpage:-1', '‹', gx, A.y + A.h - 64, 140, 52);
		button('pal:gpage:1', '›', gx + gw - 140, A.y + A.h - 64, 140, 52);
	}
	const ix = gx + gw + 24;
	const iw = (A.x + A.w - 16 - ix - (PAL_COLS - 1) * 12) / PAL_COLS;
	const ih = 76;
	pal.items.forEach((it, i) => {
		const col = i % PAL_COLS;
		const row = Math.floor(i / PAL_COLS);
		const x = ix + col * (iw + 12);
		const y = A.y + 16 + row * (ih + 10);
		const id = 'pal:item:' + it.type;
		roundRect(g, x, y, iw, ih, 14);
		g.fillStyle = hot(id) ? C.cardHover : C.card;
		g.fill();
		g.fillStyle = groupHue(pal.groups[pal.group]);
		g.fillRect(x, y + 10, 6, ih - 20);
		if (hot(id)) {
			roundRect(g, x, y, iw, ih, 14);
			g.lineWidth = 3;
			g.strokeStyle = C.accent;
			g.stroke();
		}
		g.textAlign = 'left';
		g.fillStyle = C.title;
		g.font = '500 26px system-ui, sans-serif';
		g.fillText(fitText(g, it.label, iw - 36), x + 22, y + ih / 2 - 10);
		g.fillStyle = C.dim;
		g.font = '400 18px system-ui, sans-serif';
		g.fillText(fitText(g, it.type, iw - 36), x + 22, y + ih / 2 + 18);
		hits.push({ id, x, y, w: iw, h: ih });
	});
	if (pal.pages > 1) {
		g.font = '500 26px system-ui, sans-serif';
		button('pal:page:-1', '‹ Prev', ix, A.y + A.h - 64, 160, 52);
		button('pal:page:1', 'Next ›', A.x + A.w - 16 - 160, A.y + A.h - 64, 160, 52);
		g.fillStyle = C.dim;
		g.textAlign = 'center';
		g.fillText(`${pal.page + 1} / ${pal.pages}`, (ix + A.x + A.w - 16) / 2, A.y + A.h - 38);
	}
}

/**
 * @typedef {{key: string, kind: string, label: string, text: string, wired?: boolean, swatch?: string}} PadRow
 * @typedef {{title: string, sub: string, rows: PadRow[], page: number, pages: number, status: string,
 *   statusTone?: 'info' | 'warn' | 'bad', hasNode: boolean, readOnly: boolean, canDisconnect: boolean}} PadView
 */

/**
 * Paint the wrist pad: the selected node's values, a row each — − value + for numbers (the value box opens
 * the VR keyboard), ‹ value › for choices and colours, the box itself for a toggle or text.
 * @param {CanvasRenderingContext2D} g @param {PadView} view @param {{hover: string | null}} opts @returns {PanelHit[]}
 */
export function drawLogicPad(g, view, opts) {
	const { w: W, h: H } = PAD_PX;
	/** @type {PanelHit[]} */
	const hits = [];
	const hot = (/** @type {string} */ id) => opts.hover === id;
	g.clearRect(0, 0, W, H);
	roundRect(g, 2, 2, W - 4, H - 4, 28);
	g.fillStyle = C.bg;
	g.fill();
	g.lineWidth = 3;
	g.strokeStyle = C.border;
	g.stroke();
	g.textBaseline = 'middle';
	/** @param {string} id @param {string} label @param {number} x @param {number} y @param {number} w @param {number} h @param {{on?: boolean, disabled?: boolean, danger?: boolean, fill?: string}} [o] */
	const button = (id, label, x, y, w, h, o = {}) => {
		roundRect(g, x, y, w, h, 14);
		g.fillStyle = o.fill ?? (o.on ? C.on : o.danger ? C.danger : hot(id) && !o.disabled ? C.buttonHover : C.button);
		g.fill();
		if (hot(id) && !o.disabled) {
			g.lineWidth = 3;
			g.strokeStyle = C.accent;
			g.stroke();
		}
		g.fillStyle = o.disabled ? C.dim : C.title;
		g.textAlign = 'center';
		g.fillText(fitText(g, label, w - 16), x + w / 2, y + h / 2 + 1);
		if (!o.disabled) hits.push({ id, x, y, w, h });
	};

	g.textAlign = 'left';
	g.fillStyle = C.title;
	g.font = '600 36px system-ui, sans-serif';
	g.fillText(fitText(g, view.title, W - 56), 28, 48);
	g.fillStyle = C.dim;
	g.font = '400 24px system-ui, sans-serif';
	g.fillText(fitText(g, view.sub, W - 56), 28, 92);

	if (!view.hasNode) {
		g.fillStyle = C.body;
		g.font = '400 28px system-ui, sans-serif';
		g.textAlign = 'center';
		const lines = ['Point at a node on the Logic', 'panel and pull the trigger', 'to edit its values here.'];
		lines.forEach((l, i) => g.fillText(l, W / 2, 360 + i * 44));
	} else {
		const top = 128;
		const rowH = 100;
		view.rows.forEach((r, i) => {
			const y = top + i * rowH;
			g.textAlign = 'left';
			g.fillStyle = C.body;
			g.font = '500 24px system-ui, sans-serif';
			g.fillText(fitText(g, r.label + (r.wired ? '  ◈ wired' : ''), W - 56), 28, y + 16);
			const by = y + 34;
			const bh = 58;
			const dis = view.readOnly;
			g.font = '500 30px system-ui, sans-serif';
			if (r.kind === 'number') {
				button(`f:${r.key}:-`, '−', 20, by, 120, bh, { disabled: dis });
				button(`f:${r.key}:type`, r.text, 152, by, W - 304, bh, { disabled: dis, fill: C.inset });
				button(`f:${r.key}:+`, '+', W - 140, by, 120, bh, { disabled: dis });
			} else if (r.kind === 'select' || r.kind === 'color') {
				button(`f:${r.key}:prev`, '‹', 20, by, 120, bh, { disabled: dis });
				button(`f:${r.key}:next`, r.text, 152, by, W - 304, bh, { disabled: dis, fill: C.inset });
				if (r.swatch) {
					roundRect(g, 168, by + 12, 34, 34, 8);
					g.fillStyle = r.swatch;
					g.fill();
				}
				button(`f:${r.key}:next`, '›', W - 140, by, 120, bh, { disabled: dis });
			} else if (r.kind === 'toggle') {
				button(`f:${r.key}:toggle`, r.text, 20, by, W - 40, bh, { disabled: dis, on: r.text === 'On' });
			} else {
				button(`f:${r.key}:type`, r.text || '—', 20, by, W - 40, bh, { disabled: dis, fill: C.inset });
			}
		});
		if (!view.rows.length) {
			g.fillStyle = C.dim;
			g.font = '400 26px system-ui, sans-serif';
			g.textAlign = 'center';
			g.fillText('No values to set here — wire it, or', W / 2, 330);
			g.fillText('open it on the desktop', W / 2, 370);
		}
		g.font = '500 28px system-ui, sans-serif';
		if (view.pages > 1) {
			button('page:-1', '‹', 20, 732, 100, 52);
			button('page:1', '›', W - 120, 732, 100, 52);
			g.fillStyle = C.dim;
			g.textAlign = 'center';
			g.font = '400 24px system-ui, sans-serif';
			g.fillText(`${view.page + 1} / ${view.pages}`, W / 2, 758);
			g.font = '500 28px system-ui, sans-serif';
		}
		const bw = (W - 40 - 24) / 3;
		button('rename', 'Rename', 20, 796, bw, 64, { disabled: view.readOnly });
		button('disconnect', 'Unwire', 20 + bw + 12, 796, bw, 64, { disabled: view.readOnly || !view.canDisconnect });
		button('delete', 'Delete', 20 + (bw + 12) * 2, 796, bw, 64, { disabled: view.readOnly, danger: true });
	}
	if (view.status) {
		g.textAlign = 'center';
		g.font = '500 24px system-ui, sans-serif';
		g.fillStyle = view.statusTone === 'bad' ? C.bad : view.statusTone === 'warn' ? C.warn : C.body;
		g.fillText(fitText(g, view.status, W - 48), W / 2, view.hasNode ? 708 : 600);
	}
	return hits;
}

/** the rect under a canvas point (last painted wins) @param {PanelHit[]} hits @param {number} px @param {number} py */
export function hitAt(hits, px, py) {
	for (let i = hits.length - 1; i >= 0; i--) {
		const r = hits[i];
		if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r;
	}
	return null;
}
