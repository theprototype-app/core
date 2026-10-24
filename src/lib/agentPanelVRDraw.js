// Roadmap 67 P1 — PAINT an agent panel for the headset. DOM is invisible in VR, so the panel the
// person sees in a window on the desktop is drawn onto a canvas a plane in front of them shows
// (agentPanelsVR.js places it and reads the laser). Pure over its arguments (imports only the pure
// core): `layoutPanel` decides what goes where, `pressResult` decides what a trigger pull on a
// control means, `drawAgentPanel` paints and returns the pressable rects — the vrPanelDraw /
// shellPanelDraw convention, one domain over.
//
// THE SAME RULES AS THE WINDOW: labels are text (fillText, never markup); a viewer sees no panel
// at all (they never get one); a text field shows its value and says to edit it on the desktop
// (typing in a headset is the VR keyboard's job and a panel is not worth summoning it for).

import { ownershipLabel, valueFor } from './agentPanelCore.js';

/** canvas size in px: 1024 over 0.64 m is ~1.1 texels per headset pixel at 0.9 m on a Quest 3 */
export const VR_PANEL_PX = { w: 1024, h: 768 };
/** panel size in metres */
export const VR_PANEL_M = { w: 0.64, h: 0.48 };

const PAD = 28;
const HEAD_H = 92;
const TABS_H = 56;
const FOOT_H = 76;
const ROW_H = 68;
const LABEL_W = 0.4;

const C = {
	bg: 'rgba(17, 21, 28, 0.95)',
	border: '#2f3846',
	dim: '#8b95a5',
	title: '#f1f4f8',
	body: '#cfd6e0',
	accent: '#4f9bff',
	track: '#2a2f38',
	button: '#2a2f38',
	hover: '#3a4250',
	primary: '#2563eb',
	primaryHover: '#3b82f6',
	ok: '#3fb950',
	warn: '#d29922',
	error: '#f85149'
};

/** @typedef {{id: string, control?: string, part?: string, x: number, y: number, w: number, h: number}} VRHit */

/** how tall a control's row is on the board @param {any} c */
export function rowHeight(c) {
	if (c.type === 'image') return 300;
	if (c.type === 'table') return 40 + Math.min(4, c.rows?.length ?? 0) * 34;
	if (c.type === 'textarea') return 104;
	if (c.type === 'files') return 40 + Math.min(3, c.items?.length ?? 0) * 32;
	if (c.type === 'status' || c.type === 'progress') return 60;
	return ROW_H;
}

/**
 * Which controls the board shows: the tab's controls, cut into PAGES that fit between the header
 * and the footer. Pure.
 * @param {any} spec normalized @param {number} [tab] @param {number} [height]
 * @returns {{tabs: string[], tab: number, pages: {control: any, y: number, h: number}[][]}}
 */
export function layoutPanel(spec, tab = 0, height = VR_PANEL_PX.h) {
	const tabs = (spec?.tabs ?? []).map((/** @type {any} */ t) => t.title || 'Tab');
	const ti = Math.max(0, Math.min(tabs.length - 1, Math.floor(tab) || 0));
	const top = HEAD_H + (tabs.length > 1 ? TABS_H : 0);
	const room = height - top - FOOT_H;
	/** @type {{control: any, y: number, h: number}[][]} */
	const pages = [[]];
	let y = top;
	for (const s of spec?.tabs?.[ti]?.sections ?? []) {
		for (const c of s.controls) {
			const h = Math.min(room, rowHeight(c));
			if (y + h > top + room && pages.at(-1)?.length) {
				pages.push([]);
				y = top;
			}
			/** @type {any[]} */ (pages.at(-1)).push({ control: c, y, h });
			y += h;
		}
	}
	return { tabs, tab: ti, pages };
}

/**
 * What a trigger pull on a control means — the window's own change/press, never anything else.
 * `u` is where along the hit the laser landed (0..1). Pure.
 * @param {any} c @param {any} value the current value @param {string} [part] @param {number} [u]
 * @returns {{kind: 'change', value: any} | {kind: 'press'} | null}
 */
export function pressResult(c, value, part = '', u = 0.5) {
	if (!c || c.disabled) return null;
	switch (c.type) {
		case 'button':
			return { kind: 'press' };
		case 'toggle':
			return { kind: 'change', value: !value };
		case 'select': {
			const opts = c.options ?? [];
			if (!opts.length) return null;
			const i = opts.findIndex((/** @type {any} */ o) => o.value === value);
			const step = part === 'prev' ? -1 : 1;
			return { kind: 'change', value: opts[(i + step + opts.length) % opts.length].value };
		}
		case 'slider': {
			const raw = c.min + Math.max(0, Math.min(1, u)) * (c.max - c.min);
			return { kind: 'change', value: valueFor(c, raw) };
		}
		case 'number': {
			const step = c.step ?? 1;
			const now = Number(value) || 0;
			if (part !== '-' && part !== '+') return null;
			return { kind: 'change', value: valueFor(c, now + (part === '+' ? step : -step)) };
		}
	}
	return null;
}

/** the hit a uv point lands on, and where along it @param {VRHit[]} hits @param {{x: number, y: number}} uv */
export function hitAt(hits, uv) {
	const px = uv.x * VR_PANEL_PX.w;
	const py = (1 - uv.y) * VR_PANEL_PX.h;
	const hit = hits.find((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) ?? null;
	return hit ? { hit, u: hit.w > 0 ? (px - hit.x) / hit.w : 0.5 } : null;
}

/** @param {CanvasRenderingContext2D} g @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r */
function roundRect(g, x, y, w, h, r) {
	g.beginPath();
	g.moveTo(x + r, y);
	g.arcTo(x + w, y, x + w, y + h, r);
	g.arcTo(x + w, y + h, x, y + h, r);
	g.arcTo(x, y + h, x, y, r);
	g.arcTo(x, y, x + w, y, r);
	g.closePath();
}

/** one line, cut with an ellipsis to fit @param {CanvasRenderingContext2D} g @param {string} text @param {number} maxW */
function fit(g, text, maxW) {
	let t = String(text ?? '');
	if (g.measureText(t).width <= maxW) return t;
	while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
	return t + '…';
}

/** @param {number} n */
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

/**
 * Paint one panel. Returns the pressable rects in canvas px.
 * @param {CanvasRenderingContext2D} g
 * @param {{spec: any, values: Record<string, any>, agentName?: string, machine?: string, live?: boolean, waiting?: string}} panel
 * @param {{tab?: number, page?: number, hover?: string | null, images?: Record<string, HTMLImageElement | null>, count?: number, index?: number}} [opts]
 * @returns {VRHit[]}
 */
export function drawAgentPanel(g, panel, opts = {}) {
	const W = g.canvas.width;
	const H = g.canvas.height;
	/** @type {VRHit[]} */
	const hits = [];
	const hov = opts.hover ?? null;
	g.clearRect(0, 0, W, H);
	roundRect(g, 0, 0, W, H, 28);
	g.fillStyle = C.bg;
	g.fill();
	g.lineWidth = 3;
	g.strokeStyle = C.border;
	g.stroke();
	g.textBaseline = 'middle';

	/** a button-shaped hit @param {string} id @param {string} label @param {number} x @param {number} y @param {number} w @param {number} h @param {{primary?: boolean, control?: string, part?: string, on?: boolean}} [o] */
	const button = (id, label, x, y, w, h, o = {}) => {
		const over = hov === id;
		roundRect(g, x, y, w, h, 12);
		g.fillStyle = o.primary ? (over ? C.primaryHover : C.primary) : o.on ? C.accent : over ? C.hover : C.button;
		g.fill();
		if (over) {
			g.lineWidth = 3;
			g.strokeStyle = C.accent;
			g.stroke();
		}
		g.fillStyle = C.title;
		g.font = '600 26px system-ui, sans-serif';
		g.textAlign = 'center';
		g.fillText(fit(g, label, w - 16), x + w / 2, y + h / 2);
		g.textAlign = 'left';
		hits.push({ id, control: o.control, part: o.part, x, y, w, h });
	};

	// header: title, the agent, Close
	g.fillStyle = C.title;
	g.font = '700 34px system-ui, sans-serif';
	const count = opts.count ?? 1;
	const title = panel.spec?.title || 'Agent panel';
	g.fillText(fit(g, count > 1 ? title + '  (' + ((opts.index ?? 0) + 1) + '/' + count + ')' : title, W - PAD * 2 - 240), PAD, 40);
	g.fillStyle = C.dim;
	g.font = '22px system-ui, sans-serif';
	g.fillText(fit(g, ownershipLabel(panel), W - PAD * 2 - 240), PAD, 74);
	if (count > 1) button('next-panel', 'Next', W - PAD - 220, 20, 100, 52);
	button('close', 'Close', W - PAD - 110, 20, 110, 52);

	const layout = layoutPanel(panel.spec, opts.tab ?? 0, H);
	let top = HEAD_H;
	if (layout.tabs.length > 1) {
		const tw = Math.min(200, (W - PAD * 2) / layout.tabs.length);
		layout.tabs.forEach((t, i) => button('tab:' + i, t, PAD + i * tw, top + 4, tw - 8, TABS_H - 12, { on: i === layout.tab }));
		top += TABS_H;
	}
	const page = Math.max(0, Math.min(layout.pages.length - 1, opts.page ?? 0));
	const values = panel.values ?? {};
	const labelW = (W - PAD * 2) * LABEL_W;
	const cx = PAD + labelW;
	const cw = W - PAD - cx;
	for (const { control: c, y, h } of layout.pages[page] ?? []) {
		const v = values[c.id] ?? c.value;
		const mid = y + Math.min(h, ROW_H) / 2;
		const id = 'c:' + c.id;
		const label = c.type === 'button' ? '' : c.label || '';
		if (label && !['image', 'table', 'files', 'status', 'progress', 'textarea'].includes(c.type)) {
			g.fillStyle = c.disabled ? C.dim : C.body;
			g.font = '24px system-ui, sans-serif';
			g.fillText(fit(g, label, labelW - 12), PAD, mid);
		}
		if (c.type === 'button') {
			button(id, c.label, PAD, y + 8, W - PAD * 2, ROW_H - 16, { primary: c.variant !== 'secondary', control: c.id });
		} else if (c.type === 'slider') {
			const tx = cx;
			const tw = cw - 120;
			const t = (Number(v) - c.min) / (c.max - c.min || 1);
			roundRect(g, tx, mid - 8, tw, 16, 8);
			g.fillStyle = C.track;
			g.fill();
			roundRect(g, tx, mid - 8, Math.max(16, tw * t), 16, 8);
			g.fillStyle = hov === id ? C.primaryHover : C.accent;
			g.fill();
			g.beginPath();
			g.arc(tx + tw * t, mid, 16, 0, Math.PI * 2);
			g.fillStyle = C.title;
			g.fill();
			g.fillStyle = C.body;
			g.font = '24px system-ui, sans-serif';
			g.fillText(fit(g, fmt(Number(v)) + (c.unit ? ' ' + c.unit : ''), 110), tx + tw + 12, mid);
			hits.push({ id, control: c.id, x: tx, y: y + 6, w: tw, h: ROW_H - 12 });
		} else if (c.type === 'number') {
			button(id + ':-', '−', cx, y + 10, 72, ROW_H - 20, { control: c.id, part: '-' });
			g.fillStyle = C.title;
			g.font = '600 26px system-ui, sans-serif';
			g.textAlign = 'center';
			g.fillText(fmt(Number(v)) + (c.unit ? ' ' + c.unit : ''), cx + 72 + (cw - 144) / 2, mid);
			g.textAlign = 'left';
			button(id + ':+', '+', cx + cw - 72, y + 10, 72, ROW_H - 20, { control: c.id, part: '+' });
		} else if (c.type === 'toggle') {
			const on = !!v;
			const over = hov === id;
			roundRect(g, cx, mid - 20, 84, 40, 20);
			g.fillStyle = on ? C.accent : over ? C.hover : C.track;
			g.fill();
			g.beginPath();
			g.arc(cx + (on ? 62 : 22), mid, 15, 0, Math.PI * 2);
			g.fillStyle = C.title;
			g.fill();
			g.fillStyle = C.dim;
			g.font = '22px system-ui, sans-serif';
			g.fillText(on ? 'On' : 'Off', cx + 100, mid);
			hits.push({ id, control: c.id, x: cx, y: y + 6, w: cw, h: ROW_H - 12 });
		} else if (c.type === 'select') {
			const opt = (c.options ?? []).find((/** @type {any} */ o) => o.value === v);
			button(id + ':prev', '‹', cx, y + 10, 64, ROW_H - 20, { control: c.id, part: 'prev' });
			button(id, opt?.label ?? String(v ?? ''), cx + 72, y + 10, cw - 144, ROW_H - 20, { control: c.id, part: 'next' });
			button(id + ':next', '›', cx + cw - 64, y + 10, 64, ROW_H - 20, { control: c.id, part: 'next' });
		} else if (c.type === 'colour') {
			roundRect(g, cx, mid - 20, 84, 40, 8);
			g.fillStyle = /^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : '#808080';
			g.fill();
			g.fillStyle = C.dim;
			g.font = '22px system-ui, sans-serif';
			g.fillText(String(v) + '  (change it on the desktop)', cx + 100, mid);
		} else if (c.type === 'text' || c.type === 'textarea') {
			if (c.type === 'textarea') {
				g.fillStyle = C.body;
				g.font = '24px system-ui, sans-serif';
				g.fillText(fit(g, c.label || '', W - PAD * 2), PAD, y + 22);
			}
			const ty = c.type === 'textarea' ? y + 44 : mid - 22;
			const tx = c.type === 'textarea' ? PAD : cx;
			roundRect(g, tx, ty, W - PAD - tx, 44, 8);
			g.fillStyle = C.track;
			g.fill();
			g.fillStyle = v ? C.title : C.dim;
			g.font = '22px system-ui, sans-serif';
			g.fillText(fit(g, String(v || c.placeholder || '').replace(/\s+/g, ' '), W - PAD - tx - 24), tx + 12, ty + 22);
		} else if (c.type === 'image') {
			const img = opts.images?.[c.id] ?? null;
			const box = { x: PAD, y: y + 8, w: W - PAD * 2, h: h - 16 };
			roundRect(g, box.x, box.y, box.w, box.h, 12);
			g.fillStyle = '#0b0e13';
			g.fill();
			if (img && img.naturalWidth > 0) {
				// one frame of a sprite sheet (the first), scaled to fit
				const cols = c.frames?.cols ?? 1;
				const rows = c.frames?.rows ?? 1;
				const fw = img.naturalWidth / cols;
				const fh = img.naturalHeight / rows;
				const k = Math.min((box.w - 16) / fw, (box.h - 16) / fh);
				g.imageSmoothingEnabled = !c.pixelated;
				g.drawImage(img, 0, 0, fw, fh, box.x + (box.w - fw * k) / 2, box.y + (box.h - fh * k) / 2, fw * k, fh * k);
				g.imageSmoothingEnabled = true;
			} else {
				g.fillStyle = C.dim;
				g.font = '22px system-ui, sans-serif';
				g.textAlign = 'center';
				g.fillText(fit(g, c.src ? 'Loading…' : c.alt || 'No image yet', box.w - 32), box.x + box.w / 2, box.y + box.h / 2);
				g.textAlign = 'left';
			}
		} else if (c.type === 'progress') {
			const t = c.value === null || c.value === undefined ? null : Number(c.value);
			g.fillStyle = C.body;
			g.font = '22px system-ui, sans-serif';
			g.fillText(fit(g, (c.label ? c.label + ' ' : '') + (c.text ?? (t === null ? '' : Math.round(t * 100) + '%')), W - PAD * 2), PAD, y + 18);
			roundRect(g, PAD, y + 36, W - PAD * 2, 12, 6);
			g.fillStyle = C.track;
			g.fill();
			roundRect(g, PAD, y + 36, Math.max(12, (W - PAD * 2) * (t ?? 0.3)), 12, 6);
			g.fillStyle = C.accent;
			g.fill();
		} else if (c.type === 'status') {
			g.fillStyle = c.tone === 'ok' ? C.ok : c.tone === 'warn' ? C.warn : c.tone === 'error' ? C.error : C.accent;
			g.beginPath();
			g.arc(PAD + 10, mid - 4, 8, 0, Math.PI * 2);
			g.fill();
			g.fillStyle = C.body;
			g.font = '24px system-ui, sans-serif';
			g.fillText(fit(g, c.text || c.label || '', W - PAD * 2 - 32), PAD + 30, mid - 4);
		} else if (c.type === 'table' || c.type === 'files') {
			g.fillStyle = C.body;
			g.font = '600 22px system-ui, sans-serif';
			const lines = c.type === 'table' ? [c.columns.join('   ·   '), ...c.rows.slice(0, 4).map((/** @type {any[]} */ r) => r.join('   ·   '))] : [c.label || 'Files', ...c.items.slice(0, 3).map((/** @type {any} */ f) => f.name)];
			lines.forEach((line, i) => {
				g.font = (i === 0 ? '600 ' : '') + '22px system-ui, sans-serif';
				g.fillStyle = i === 0 ? C.body : C.dim;
				g.fillText(fit(g, line, W - PAD * 2), PAD, y + 20 + i * 34);
			});
		}
	}

	// footer: the waiting / offline state and the page buttons
	const fy = H - FOOT_H;
	g.fillStyle = C.border;
	g.fillRect(PAD, fy, W - PAD * 2, 2);
	g.fillStyle = panel.live === false ? C.warn : C.dim;
	g.font = '22px system-ui, sans-serif';
	const note = panel.live === false ? panel.waiting || 'The agent is not here — changes wait for it' : 'Changes go to the agent; it answers with its tools';
	g.fillText(fit(g, note, W - PAD * 2 - 260), PAD, fy + FOOT_H / 2);
	if (layout.pages.length > 1) {
		if (page > 0) button('page:prev', '▲', W - PAD - 250, fy + 12, 80, FOOT_H - 24);
		g.fillStyle = C.dim;
		g.textAlign = 'center';
		g.fillText(page + 1 + '/' + layout.pages.length, W - PAD - 125, fy + FOOT_H / 2);
		g.textAlign = 'left';
		if (page < layout.pages.length - 1) button('page:next', '▼', W - PAD - 80, fy + 12, 80, FOOT_H - 24);
	}
	return hits;
}
