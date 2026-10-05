// 36 B12: ONE CANVAS RENDERER FOR A HUD ELEMENT in the headset — extracted verbatim from
// vrGamePanel's board (30b C2) so the board (menus) and the curved HUD band (vrHud.js, the
// playing screen) draw an element the same way. DOM is invisible in a headset; the desktop
// HUD is HudElement.svelte, and this is its canvas twin.
import { hudValueOf } from './hudDocs';
import { hudOptionsOf } from './flowRuntime';
import { hudImageFor, resolveHudImage } from './hudImages';
import { fitLabel } from './shellPanelDraw';
import { moduleHudKindDef } from './moduleHudKinds';

/** a style value, token names resolved to literals (a canvas cannot take var())
 * @param {any} value @param {string} fallback */
export function paint(value, fallback) {
	if (value === undefined || value === null || value === '') return fallback;
	const text = String(value);
	if (/^[a-z][a-z0-9-]*$/i.test(text) && !/^(transparent|white|black|red|green|blue|gray|grey|yellow|orange|none)$/i.test(text)) {
		try {
			const v = getComputedStyle(document.documentElement).getPropertyValue('--' + text).trim();
			return v || fallback;
		} catch {
			return fallback;
		}
	}
	return text;
}

/** @param {CanvasRenderingContext2D} g @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r */
export function roundRect(g, x, y, w, h, r) {
	const rr = Math.max(0, Math.min(r, w / 2, h / 2));
	g.beginPath();
	g.moveTo(x + rr, y);
	g.arcTo(x + w, y, x + w, y + h, rr);
	g.arcTo(x + w, y + h, x, y + h, rr);
	g.arcTo(x, y + h, x, y, rr);
	g.arcTo(x, y, x + w, y, rr);
	g.closePath();
}

/** @param {CanvasRenderingContext2D} g @param {string} text @param {number} max */
export function wrapText(g, text, max) {
	/** @type {string[]} */
	const out = [];
	for (const para of text.split('\n')) {
		let line = '';
		for (const word of para.split(/\s+/)) {
			const next = line ? line + ' ' + word : word;
			if (line && g.measureText(next).width > max) {
				out.push(line);
				line = word;
			} else line = next;
		}
		if (line) out.push(line);
	}
	return out.slice(0, 12);
}

/** @type {Map<string, HTMLImageElement>} */
const images = new Map();
let imageCount = 0;
/** bumps when an image finishes decoding (a surface's redraw signature reads it) */
export function imageTick() {
	return imageCount;
}

/**
 * 36 B12: what a MODULE's own element kind (its DOM, `api.registerHudElement`) reads in the
 * headset — its def's optional `vrText(element, runtime)`, else nothing (DOM is invisible
 * there). A throw reads as nothing. @param {any} el @param {any} rt @returns {string | null}
 */
export function moduleVrText(el, rt) {
	const fn = moduleHudKindDef(String(el?.kind ?? ''))?.vrText;
	if (typeof fn !== 'function') return null;
	try {
		const v = fn(el, rt);
		return v === undefined || v === null ? '' : String(v);
	} catch {
		return '';
	}
}

/** what an element SAYS right now: a module kind's headset text, else its runtime text,
 * else its authored label @param {any} el @param {any} rt @returns {string} */
export function elementText(el, rt) {
	const vr = moduleVrText(el, rt);
	return vr !== null ? vr : rt?.text !== undefined && rt?.text !== null ? String(rt.text) : String(el.label ?? '');
}

/** does an element put anything on screen (text, a bar, an image, a list row)? A HUD group
 * whose members all show nothing draws no plate — an empty dark box reads as broken.
 * @param {any} el @param {any} rt */
export function elementShows(el, rt) {
	if (['bar', 'progressradial', 'slider', 'toggle', 'image'].includes(el?.kind)) return true;
	if (el?.kind === 'list' && ((Array.isArray(rt?.rows) && rt.rows.length) || String(el.rowsText ?? '').trim())) return true;
	return elementText(el, rt).replace(/\[[^\]]*\]/g, '').trim().length > 0;
}

/**
 * Draw ONE HUD element into the box (x, y, w, h) in canvas px, at `k` canvas px per stage
 * px. Returns the corner radius it used (the board rings a hovered button with it).
 * @param {CanvasRenderingContext2D} g @param {any} el @param {number} x @param {number} y
 * @param {number} w @param {number} h @param {number} k @param {any} rt the element's runtime entry
 * @returns {number}
 */
export function drawHudElement(g, el, x, y, w, h, k, rt) {
	const style = el.style ?? {};
	const text = elementText(el, rt);
	const size = Math.max(10, Number(style.size ?? 14)) * k;
	const weight = String(style.weight ?? (el.kind === 'button' ? 600 : 400));
	const colour = paint(style.color, '#f3f4f6');
	const disabled = el.enabled === false;
	g.globalAlpha = Number(style.opacity ?? 1) * (disabled ? 0.45 : 1);
	const bg = paint(style.bg, el.kind === 'button' || el.kind === 'toggle' || el.kind === 'dropdown' || el.kind === 'tabs' ? '#374151' : 'transparent');
	const radius = Number(style.radius ?? (el.kind === 'button' ? 8 : 0)) * k;
	if (bg !== 'transparent') {
		roundRect(g, x, y, w, h, radius);
		g.fillStyle = bg;
		g.fill();
	}
	if (style.border) {
		roundRect(g, x, y, w, h, radius);
		g.lineWidth = 2 * k;
		g.strokeStyle = paint(style.border, 'rgba(75,85,99,0.7)');
		g.stroke();
	}
	g.fillStyle = colour;
	g.font = `${weight} ${size}px system-ui, sans-serif`;
	g.textBaseline = 'middle';
	const align = el.kind === 'button' ? 'center' : String(style.align ?? 'left');
	g.textAlign = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
	const pad = Number(style.pad ?? 0) * k;
	const tx = align === 'center' ? x + w / 2 : align === 'right' ? x + w - pad - 4 * k : x + pad + 4 * k;
	if (el.kind === 'bar' || el.kind === 'progressradial' || el.kind === 'slider') {
		const value = Number(el.kind === 'slider' ? hudValueOf(el.id, el.value ?? el.min ?? 0) : rt?.value ?? el.value ?? 0);
		const min = Number(rt?.min ?? el.min ?? 0);
		const max = Number(rt?.max ?? el.max ?? (el.kind === 'slider' ? 100 : 1));
		const pct = max - min > 1e-9 ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
		roundRect(g, x, y + h * 0.3, w, h * 0.4, h * 0.2);
		g.fillStyle = 'rgba(255,255,255,0.15)';
		g.fill();
		roundRect(g, x, y + h * 0.3, w * pct, h * 0.4, h * 0.2);
		g.fillStyle = paint(style.color, '#ef562f');
		g.fill();
		if (text && el.kind !== 'slider') {
			g.fillStyle = '#f3f4f6';
			g.textAlign = 'center';
			g.fillText(text, x + w / 2, y + h / 2);
		}
	} else if (el.kind === 'toggle') {
		const on = !!hudValueOf(el.id, el.value);
		roundRect(g, x + 6 * k, y + h * 0.2, h * 1.1, h * 0.6, h * 0.3);
		g.fillStyle = on ? '#22c55e' : 'rgba(255,255,255,0.2)';
		g.fill();
		g.beginPath();
		g.arc(x + 6 * k + (on ? h * 0.8 : h * 0.3), y + h / 2, h * 0.24, 0, Math.PI * 2);
		g.fillStyle = '#fff';
		g.fill();
		g.fillStyle = colour;
		g.textAlign = 'left';
		g.fillText(text, x + h * 1.3 + 10 * k, y + h / 2);
	} else if (el.kind === 'dropdown' || el.kind === 'tabs') {
		const options = hudOptionsOf(el.id, el);
		const held = hudValueOf(el.id, el.value ?? (el.kind === 'tabs' ? 0 : options[0]));
		const shown = el.kind === 'tabs' ? options[Math.round(Number(held)) || 0] ?? '' : String(held ?? '');
		g.textAlign = 'center';
		g.fillText((text ? text + ': ' : '') + '‹ ' + shown + ' ›', x + w / 2, y + h / 2);
	} else if (el.kind === 'list') {
		const rows = Array.isArray(rt?.rows) && rt.rows.length ? rt.rows : String(el.rowsText ?? '').split('\n').filter(Boolean);
		const rowH = Number(el.rowHeight ?? 18) * k;
		let yy = y + rowH / 2;
		if (text) {
			g.fillText(text, tx, yy);
			yy += rowH;
		}
		for (const row of rows) {
			if (yy > y + h) break;
			g.fillText(String(row), tx, yy);
			yy += rowH;
		}
	} else if (el.kind === 'image') {
		const url = hudImageFor(String(el.src ?? ''));
		if (!url && el.src) void resolveHudImage(String(el.src));
		if (url) {
			let img = images.get(url);
			if (!img) {
				img = new Image();
				img.onload = () => (imageCount += 1);
				img.src = url;
				images.set(url, img);
			}
			if (img.complete && img.naturalWidth) g.drawImage(img, x, y, w, h);
		}
	} else if (el.kind === 'crosshair' || el.kind === 'minimap' || el.kind === 'debug' || el.kind === 'custom' || el.kind === 'damageflash') {
		// a crosshair, a plot, a debug pill and a module's own DOM have no VR form here
	} else if (text && el.kind === 'button' && !el.wrap) {
		// 33 G5: a button's label fits the button (the desktop's CSS box never overflows)
		g.fillText(fitLabel(g, text, w - 10 * k, weight, size), tx, y + h / 2);
	} else if (text) {
		// text, timer, panel, richtext and anything else that says something
		const lines = el.wrap || el.kind === 'richtext' ? wrapText(g, text.replace(/\[[^\]]*\]/g, ''), w - 8 * k) : [text];
		const lh = size * 1.25;
		let yy = y + h / 2 - ((lines.length - 1) * lh) / 2;
		for (const line of lines) {
			g.fillText(line, tx, yy);
			yy += lh;
		}
	}
	g.globalAlpha = 1;
	return radius;
}
