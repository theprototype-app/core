// 30b (vr-play) C2 — THE GAME UI IN VR. The user, on a Quest: "in VR I should be able to
// see the game menu and interact with it", "I also should see the score in the VR".
//
// DOM is invisible in a headset, so the HUD layer (HudLayer.svelte) draws nothing there.
// This module draws the SAME documents into CANVAS TEXTURES on four scene-root meshes:
//
//  · the GAME PANEL — a world-space board ~1.2 m in front at chest height that LAZILY
//    follows your head yaw (it re-centres only once you have turned past ~35 degrees, so
//    it holds still while you read it). It shows a game's MENU-like screens (menu, pause,
//    results: a screen with input 'menu', a control on it, or bound to menu/paused/over)
//    laid out exactly as the desktop HUD lays them out (the 9-grid over the 1280x720
//    reference stage), plus a footer with two buttons of ours: "Edit mode" (the Edit ⇄
//    Interact switch 30b-vr-modes adds; a plain `editorMode` write is enough to leave) and
//    "Top strip" on/off. Its buttons answer the controller LASER + trigger and a
//    fingertip/controller-tip POKE.
//  · the WRIST card — the game's small overlays (score, timer, level) as short lines on
//    the LEFT wrist, shown when you turn the wrist toward your face, with the same two
//    buttons, so there is always a way back to editing even mid-round.
//  · the TOP STRIP — the same lines in one head-locked row across the top of the view,
//    LOCAL on/off (persisted), default on.
//  · the ANNOUNCE banner — api.announce(), head-locked, big and centred.
//
// A button press is the desktop press verbatim: `fireHudButton(id)` pulses the element's
// Button nodes through the replicated trigger log, a toggle writes its value first — so a
// press in the headset and a click on the desktop cannot disagree about what happened.
//
// LOCAL and non-replicated throughout; everything sits at the SCENE ROOT under fixed names
// (golden rule 5) on the default layer (both eyes, never the helper layer), and only while
// a headset session is presenting AND the player is in Interact/Play. The frame work is
// driven by vrGameInput's frame hook; the suites drive `vrGamePanelFrame` with a synthetic
// head pose, since no XR session runs headless.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, globalRenderer } from '../stores/sceneStore';
import { setEditorMode } from './objectActions';
import { hudDocs, hudRuntime, hudValueOf, setHudValue, visibleScreen, activeHudKeys, rectInFrame, hudScreenOverride } from './hudDocs';
import { isInteractiveKind, isRenderableKind } from './hudKinds';
import { fireHudButton, hudOptionsOf } from './flowRuntime';
import { cameraPreview } from './cameraPreview';
import { gameState } from './gameState';
import { gameFeelActive } from './gameFeel';
import { gameAnnouncement } from './gameAnnounce';
import { playGameSound } from './gameSfx';
import { hudImageFor, resolveHudImage } from './hudImages';
import { safeStorage } from './safeStorage';

/** the HUD's authoring reference — the editor artboard's stage */
export const STAGE_W = 1280;
export const STAGE_H = 720;
/** the panel's footer (our own buttons), in stage pixels */
export const FOOTER_H = 96;
const PANEL_DIST = 1.2;
const PANEL_DROP = 0.22; // below the eyes: chest height
const FOLLOW_DEG = 35;
const SETTLE_DEG = 2;
const WRIST_W = 0.15;
const STRIP_KEY = 'vr:gameStrip';

/** the board canvas's pixels per stage pixel: ~1000 px across a metre-wide board, what a
 * headset's ~20 px per degree needs at 1.2 m */
const SCALE = 1.5;

/* ------------------------------------------------------------ the classification --- */

/** a screen the PANEL shows (a menu, a pause, a results card) rather than the wrist
 * @param {any} screen */
export function isPanelScreen(screen) {
	if (!screen) return false;
	if (screen.input === 'menu') return true;
	if (['menu', 'paused', 'over'].includes(String(screen.showWhile ?? ''))) return true;
	return (screen.elements ?? []).some((/** @type {any} */ el) => isInteractiveKind(el.kind) && el.enabled !== false);
}

/** kinds with no VR form on the board (a crosshair, a plot, the debug pill, module DOM) */
const NO_VR_FORM = new Set(['crosshair', 'minimap', 'debug', 'custom', 'damageflash']);
/** the board never gets narrower than its footer needs, in stage pixels */
const MIN_CROP_W = 720;
const CROP_PAD = 36;

/**
 * The part of the 1280x720 stage a screen actually USES — the union of its elements'
 * rects, padded, widened to fit the footer. A desktop menu is usually a card in the middle
 * of a transparent screen; drawn whole, the headset saw a wall of empty backdrop with the
 * menu small in its middle (measured on the Towers template). Pure; exported.
 * @param {any} screen @returns {{x: number, y: number, w: number, h: number}}
 */
export function panelCrop(screen) {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const el of screen?.elements ?? []) {
		if (!isRenderableKind(el.kind) || NO_VR_FORM.has(el.kind)) continue;
		const r = rectInFrame(el, STAGE_W, STAGE_H);
		x0 = Math.min(x0, r.left);
		y0 = Math.min(y0, r.top);
		x1 = Math.max(x1, r.left + r.w);
		y1 = Math.max(y1, r.top + r.h);
	}
	if (!Number.isFinite(x0)) return { x: 0, y: 0, w: STAGE_W, h: STAGE_H };
	x0 = Math.max(0, x0 - CROP_PAD);
	y0 = Math.max(0, y0 - CROP_PAD);
	x1 = Math.min(STAGE_W, x1 + CROP_PAD);
	y1 = Math.min(STAGE_H, y1 + CROP_PAD);
	let w = x1 - x0;
	if (w < MIN_CROP_W) {
		const cx = (x0 + x1) / 2;
		w = MIN_CROP_W;
		x0 = Math.min(Math.max(0, cx - w / 2), STAGE_W - w);
	}
	return { x: x0, y: y0, w, h: Math.max(120, y1 - y0) };
}

/** metres per stage pixel on the board: a 14 px label reads ~1 degree tall at 1.2 m */
const METRES_PER_PX = 0.0016;

/**
 * The screens on show right now, the HudLayer rule (scene doc + the one keyed by the camera
 * looked through), split into what the panel shows and what the wrist/strip show.
 * @returns {{panel: {key: string, screen: any}[], overlay: {key: string, screen: any}[]}}
 */
export function vrScreens() {
	const through = get(cameraPreview)?.uuid ?? null;
	/** @type {{key: string, screen: any}[]} */
	const panel = [];
	/** @type {{key: string, screen: any}[]} */
	const overlay = [];
	for (const key of activeHudKeys(through)) {
		const screen = visibleScreen(key);
		if (!screen) continue;
		(isPanelScreen(screen) ? panel : overlay).push({ key, screen });
	}
	return { panel, overlay };
}

/**
 * The overlay as SHORT LINES — what a score/timer/level card SAYS, readable on a wrist.
 * Pure over (elements, runtime, values); exported for the suites.
 * @param {any[]} elements @param {Record<string, any>} runtime @returns {string[]}
 */
export function overlayLines(elements, runtime) {
	/** @type {string[]} */
	const out = [];
	const sorted = [...elements].sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
	for (const el of sorted) {
		if (!isRenderableKind(el.kind)) continue;
		const rt = runtime?.[el.id] ?? null;
		const text = rt?.text !== undefined && rt?.text !== null ? String(rt.text) : String(el.label ?? '');
		if (el.kind === 'text' || el.kind === 'timer' || el.kind === 'richtext' || el.kind === 'panel') {
			const clean = text.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
			if (clean) out.push(clean);
		} else if (el.kind === 'bar' || el.kind === 'progressradial') {
			const value = Number(rt?.value ?? el.value ?? 0);
			const min = Number(rt?.min ?? el.min ?? 0);
			const max = Number(rt?.max ?? el.max ?? 1);
			const pct = max - min > 1e-9 ? Math.round(Math.min(1, Math.max(0, (value - min) / (max - min))) * 100) : 0;
			out.push((text ? text + ' ' : '') + pct + '%');
		} else if (el.kind === 'list') {
			const rows = Array.isArray(rt?.rows) && rt.rows.length ? rt.rows : String(el.rowsText ?? '').split('\n').filter(Boolean);
			if (text) out.push(text);
			for (const row of rows.slice(0, 3)) out.push(String(row));
		}
		if (out.length >= 6) break;
	}
	return out.slice(0, 6);
}

/* --------------------------------------------------------------------- drawing ----- */

/** a style value, token names resolved to literals (a canvas cannot take var()) */
function paint(/** @type {any} */ value, /** @type {string} */ fallback) {
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

/** @type {Map<string, HTMLImageElement>} */
const images = new Map();
let imageTick = 0;

/** @typedef {{id: string, key: string, kind: string, x: number, y: number, w: number, h: number, footer?: string}} HitRect */

/**
 * Draw one menu screen + our footer into a 2D context sized (STAGE_W x (STAGE_H+FOOTER_H))
 * * SCALE, and return the pressable rects in CANVAS pixels. `hover` rings the element the
 * laser is on. Pure over its arguments (the DOM is only touched for token colours and
 * image decode); exported for the suites.
 * @param {CanvasRenderingContext2D} g @param {{key: string, screen: any} | null} entry
 * @param {Record<string, any>} runtime @param {{hover?: string | null, strip?: boolean, mode?: string, crop?: {x: number, y: number, w: number, h: number}}} [opts]
 * @returns {HitRect[]}
 */
export function drawPanel(g, entry, runtime, opts = {}) {
	const crop = opts.crop ?? { x: 0, y: 0, w: STAGE_W, h: STAGE_H };
	const W = g.canvas.width;
	const H = g.canvas.height;
	const k = W / crop.w;
	g.clearRect(0, 0, W, H);
	// the board: a dark rounded plate, so a screen authored over the game view still reads
	roundRect(g, 0, 0, W, H, 28 * k);
	g.fillStyle = 'rgba(12, 16, 26, 0.9)';
	g.fill();
	g.lineWidth = 3 * k;
	g.strokeStyle = 'rgba(148, 163, 184, 0.55)';
	g.stroke();
	/** @type {HitRect[]} */
	const hits = [];
	const elements = (entry?.screen?.elements ?? []).filter((/** @type {any} */ el) => isRenderableKind(el.kind));
	const sorted = [...elements].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
	g.save();
	g.beginPath();
	g.rect(0, 0, W, crop.h * k);
	g.clip();
	for (const el of sorted) {
		const r = rectInFrame(el, STAGE_W, STAGE_H);
		const x = (r.left - crop.x) * k;
		const y = (r.top - crop.y) * k;
		const w = r.w * k;
		const h = r.h * k;
		const style = el.style ?? {};
		const rt = runtime?.[el.id] ?? null;
		const text = rt?.text !== undefined && rt?.text !== null ? String(rt.text) : String(el.label ?? '');
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
					img.onload = () => (imageTick += 1);
					img.src = url;
					images.set(url, img);
				}
				if (img.complete && img.naturalWidth) g.drawImage(img, x, y, w, h);
			}
		} else if (el.kind === 'crosshair' || el.kind === 'minimap' || el.kind === 'debug' || el.kind === 'custom' || el.kind === 'damageflash') {
			// a crosshair, a plot, a debug pill and a module's own DOM have no VR form here
		} else if (text) {
			// text, timer, button, panel, richtext and anything else that says something
			const lines = el.wrap || el.kind === 'richtext' ? wrapText(g, text.replace(/\[[^\]]*\]/g, ''), w - 8 * k) : [text];
			const lh = size * 1.25;
			let yy = y + h / 2 - ((lines.length - 1) * lh) / 2;
			for (const line of lines) {
				g.fillText(line, tx, yy);
				yy += lh;
			}
		}
		g.globalAlpha = 1;
		const pressable = isInteractiveKind(el.kind) && !disabled;
		if (pressable) {
			hits.push({ id: el.id, key: entry?.key ?? 'scene', kind: el.kind, x, y, w, h });
			if (opts.hover === el.id) {
				roundRect(g, x - 4 * k, y - 4 * k, w + 8 * k, h + 8 * k, radius + 4 * k);
				g.lineWidth = 4 * k;
				g.strokeStyle = '#5fd0ff';
				g.stroke();
			}
		}
	}
	g.restore();
	// the footer: OUR two buttons, always there
	const fy = crop.h * k;
	g.fillStyle = 'rgba(255,255,255,0.06)';
	g.fillRect(0, fy, W, 2 * k);
	const buttons = [
		{ id: 'edit', label: 'Edit mode' },
		{ id: 'strip', label: opts.strip === false ? 'Top strip: off' : 'Top strip: on' }
	];
	const bw = 300 * k;
	const bh = 60 * k;
	buttons.forEach((b, i) => {
		const bx = W / 2 + (i === 0 ? -bw - 20 * k : 20 * k);
		const by = fy + (FOOTER_H * k - bh) / 2;
		roundRect(g, bx, by, bw, bh, 12 * k);
		g.fillStyle = b.id === 'edit' ? '#1f2937' : '#111827';
		g.fill();
		g.lineWidth = (opts.hover === 'footer:' + b.id ? 5 : 2) * k;
		g.strokeStyle = opts.hover === 'footer:' + b.id ? '#5fd0ff' : 'rgba(148,163,184,0.6)';
		g.stroke();
		g.fillStyle = '#f3f4f6';
		g.font = `600 ${26 * k}px system-ui, sans-serif`;
		g.textAlign = 'center';
		g.textBaseline = 'middle';
		g.fillText(b.label, bx + bw / 2, by + bh / 2);
		hits.push({ id: 'footer:' + b.id, key: '', kind: 'footer', footer: b.id, x: bx, y: by, w: bw, h: bh });
	});
	return hits;
}

/** a line cut to fit `max` pixels with an ellipsis @param {CanvasRenderingContext2D} g
 * @param {string} text @param {number} max */
function fitText(g, text, max) {
	if (g.measureText(text).width <= max) return text;
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (g.measureText(text.slice(0, mid) + '…').width <= max) lo = mid;
		else hi = mid - 1;
	}
	return text.slice(0, lo).trimEnd() + '…';
}

/** the strip is one glanceable row: a sentence (a hint, an instruction) belongs on the
 * wrist, not across the top of the view @param {string} line */
export function stripWorthy(line) {
	return line.length <= 28;
}

/** @param {CanvasRenderingContext2D} g @param {string} text @param {number} max */
function wrapText(g, text, max) {
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

/**
 * A compact card of lines (+ optional footer buttons) — the wrist, the top strip and the
 * banner are all this. Returns the pressable rects.
 * @param {CanvasRenderingContext2D} g @param {string[]} lines
 * @param {{title?: string, row?: boolean, buttons?: boolean, strip?: boolean, hover?: string | null, big?: boolean, color?: string}} [opts]
 * @returns {HitRect[]}
 */
export function drawCard(g, lines, opts = {}) {
	const W = g.canvas.width;
	const H = g.canvas.height;
	g.clearRect(0, 0, W, H);
	roundRect(g, 0, 0, W, H, Math.min(24, H / 4));
	g.fillStyle = 'rgba(12, 16, 26, 0.86)';
	g.fill();
	g.lineWidth = 2;
	g.strokeStyle = 'rgba(148, 163, 184, 0.5)';
	g.stroke();
	g.fillStyle = opts.color ?? '#f3f4f6';
	g.textBaseline = 'middle';
	/** @type {HitRect[]} */
	const hits = [];
	if (opts.big) {
		g.textAlign = 'center';
		g.font = `800 ${Math.round(H * 0.42)}px system-ui, sans-serif`;
		g.fillText(fitText(g, lines[0] ?? '', W - 40), W / 2, lines[1] ? H * 0.4 : H / 2);
		if (lines[1]) {
			g.font = `500 ${Math.round(H * 0.16)}px system-ui, sans-serif`;
			g.fillStyle = '#e5e7eb';
			g.fillText(lines[1], W / 2, H * 0.78);
		}
		return hits;
	}
	if (opts.row) {
		g.textAlign = 'center';
		g.font = `600 ${Math.round(H * 0.46)}px system-ui, sans-serif`;
		g.fillText(fitText(g, lines.join('   ·   '), W - 24), W / 2, H / 2);
		return hits;
	}
	const pad = 18;
	const footer = opts.buttons ? 64 : 0;
	const rows = Math.max(1, lines.length + (opts.title ? 1 : 0));
	const rowH = Math.min(52, (H - footer - pad * 2) / rows);
	let y = pad + rowH / 2;
	g.textAlign = 'left';
	if (opts.title) {
		g.font = `700 ${Math.round(rowH * 0.62)}px system-ui, sans-serif`;
		g.fillStyle = '#93c5fd';
		g.fillText(opts.title, pad, y);
		y += rowH;
	}
	g.fillStyle = '#f3f4f6';
	g.font = `600 ${Math.round(rowH * 0.62)}px system-ui, sans-serif`;
	for (const line of lines) {
		g.fillText(fitText(g, line, W - pad * 2), pad, y);
		y += rowH;
	}
	if (opts.buttons) {
		const labels = [
			{ id: 'edit', label: 'Edit' },
			{ id: 'strip', label: opts.strip === false ? 'Strip off' : 'Strip on' }
		];
		const bw = (W - pad * 3) / 2;
		labels.forEach((b, i) => {
			const bx = pad + i * (bw + pad);
			const by = H - footer + 8;
			roundRect(g, bx, by, bw, footer - 22, 10);
			g.fillStyle = '#1f2937';
			g.fill();
			g.lineWidth = opts.hover === 'footer:' + b.id ? 4 : 2;
			g.strokeStyle = opts.hover === 'footer:' + b.id ? '#5fd0ff' : 'rgba(148,163,184,0.6)';
			g.stroke();
			g.fillStyle = '#f3f4f6';
			g.font = `600 22px system-ui, sans-serif`;
			g.textAlign = 'center';
			g.fillText(b.label, bx + bw / 2, by + (footer - 22) / 2);
			hits.push({ id: 'footer:' + b.id, key: '', kind: 'footer', footer: b.id, x: bx, y: by, w: bw, h: footer - 22 });
		});
	}
	return hits;
}

/* ------------------------------------------------------------------ the meshes ----- */

/**
 * @typedef {{name: string, mesh: THREE.Mesh, canvas: HTMLCanvasElement, g: CanvasRenderingContext2D,
 *   texture: THREE.CanvasTexture, w: number, h: number, hits: HitRect[], sig: string}} Surface
 */

/** @type {Record<string, Surface>} */
const surfaces = {};

/** @param {string} name @param {number} pxW @param {number} pxH @param {number} worldW */
function surface(name, pxW, pxH, worldW) {
	let s = surfaces[name];
	const scene = /** @type {any} */ (get(globalScene));
	if (!s) {
		const canvas = document.createElement('canvas');
		canvas.width = pxW;
		canvas.height = pxH;
		const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
		const texture = new THREE.CanvasTexture(canvas);
		texture.colorSpace = THREE.SRGBColorSpace;
		texture.anisotropy = 4;
		const worldH = (worldW * pxH) / pxW;
		const mesh = new THREE.Mesh(
			new THREE.PlaneGeometry(worldW, worldH),
			new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide })
		);
		mesh.name = name;
		mesh.renderOrder = 1000;
		mesh.visible = false;
		mesh.frustumCulled = false;
		mesh.userData.localOnly = true;
		s = { name, mesh, canvas, g, texture, w: worldW, h: worldH, hits: [], sig: '' };
		surfaces[name] = s;
	}
	if (scene && s.mesh.parent !== scene) scene.add(s.mesh);
	return s;
}

/** give a surface a new canvas size and world size (a new crop) @param {Surface} s
 * @param {number} pxW @param {number} pxH @param {number} worldW */
function resizeSurface(s, pxW, pxH, worldW) {
	if (s.canvas.width === pxW && s.canvas.height === pxH && Math.abs(s.w - worldW) < 1e-6) return;
	s.canvas.width = pxW;
	s.canvas.height = pxH;
	// a CanvasTexture keeps its GPU allocation at the OLD size unless it is disposed
	s.texture.dispose();
	s.texture.needsUpdate = true;
	s.w = worldW;
	s.h = (worldW * pxH) / pxW;
	s.mesh.geometry.dispose();
	s.mesh.geometry = new THREE.PlaneGeometry(s.w, s.h);
}

/* -------------------------------------------------------------------- the state ---- */

/** LOCAL: the head-locked strip, on by default */
function stripOn() {
	return safeStorage.getItem(STRIP_KEY) !== 'false';
}
/** @param {boolean} on */
export function setVrStrip(on) {
	safeStorage.setItem(STRIP_KEY, on ? 'true' : 'false');
}

const panelYaw = { value: NaN, following: false };
/** the laser's current panel target per controller slot, for the hover ring */
const hover = /** @type {(string | null)[]} */ ([null, null]);
const debug = { presses: 0, pokes: 0, lastPress: /** @type {string | null} */ (null), edits: 0 };

const _head = new THREE.Vector3();
const _headQ = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _v = new THREE.Vector3();
const _e = new THREE.Euler();

/** the headset's world pose @returns {{position: THREE.Vector3, quaternion: THREE.Quaternion} | null} */
function headPose() {
	const renderer = /** @type {any} */ (get(globalRenderer));
	if (!renderer?.xr?.isPresenting) return null;
	const cam = renderer.xr.getCamera();
	cam.updateMatrixWorld?.(true);
	cam.getWorldPosition(_head);
	cam.getWorldQuaternion(_headQ);
	return { position: _head, quaternion: _headQ };
}

/** @param {THREE.Quaternion} q yaw of a quaternion (radians) */
function yawOf(q) {
	_e.setFromQuaternion(q, 'YXZ');
	return _e.y;
}

/**
 * Where the panel should yaw: it FOLLOWS lazily, with HYSTERESIS — a glance inside
 * FOLLOW_DEG leaves it alone, and once the head has turned past that the panel eases ALL
 * the way back in front (stopping at SETTLE_DEG). Without the second half a big turn left
 * it parked FOLLOW_DEG off to the side, forever. Pure over (current, head, dt, state);
 * `state.following` carries the latch between frames. Exported.
 * @param {number} current @param {number} head @param {number} dt seconds
 * @param {{following: boolean}} state
 * @returns {number}
 */
export function followYaw(current, head, dt, state) {
	if (!Number.isFinite(current)) {
		state.following = false;
		return head;
	}
	let d = head - current;
	d = Math.atan2(Math.sin(d), Math.cos(d));
	const off = Math.abs(d);
	if (!state.following && off > (FOLLOW_DEG * Math.PI) / 180) state.following = true;
	if (state.following && off < (SETTLE_DEG * Math.PI) / 180) state.following = false;
	if (!state.following) return current;
	return current + d * Math.min(1, dt * 3);
}

/**
 * One frame of the VR game UI. `opts.head` injects a head pose and `opts.hands` the two
 * controller world poses — the suites drive both; the live frame reads the XR camera and
 * the controllers. Returns what is on show.
 * @param {{head?: {position: any, quaternion: any} | null, hands?: ({position: any, quaternion: any} | null)[], dt?: number, force?: boolean}} [opts]
 */
export function vrGamePanelFrame(opts = {}) {
	const head = opts.head === undefined ? headPose() : opts.head;
	const live = !!head && (opts.force || gameFeelActive());
	const { panel, overlay } = live ? vrScreens() : { panel: [], overlay: [] };
	const runtime = get(hudRuntime);
	const strip = stripOn();
	void get(hudDocs);
	void get(hudScreenOverride);
	void get(gameState);

	// ---- the panel
	const entry = panel[0] ?? null;
	const crop = panelCrop(entry?.screen);
	const board = surface('vr-game-panel', Math.round(crop.w * SCALE), Math.round((crop.h + FOOTER_H) * SCALE), crop.w * METRES_PER_PX);
	board.mesh.visible = !!entry;
	if (entry && head) {
		const sig = JSON.stringify([entry.key, entry.screen, runtime, hover, strip, imageTick, valuesSig(entry.screen)]);
		if (sig !== board.sig) {
			board.sig = sig;
			resizeSurface(board, Math.round(crop.w * SCALE), Math.round((crop.h + FOOTER_H) * SCALE), crop.w * METRES_PER_PX);
			board.hits = drawPanel(board.g, entry, runtime, { hover: hover[0] ?? hover[1], strip, crop });
			board.texture.needsUpdate = true;
		}
		const headYaw = yawOf(head.quaternion);
		panelYaw.value = followYaw(panelYaw.value, headYaw, opts.dt ?? 1 / 72, panelYaw);
		_fwd.set(-Math.sin(panelYaw.value), 0, -Math.cos(panelYaw.value));
		board.mesh.position.copy(head.position).addScaledVector(_fwd, PANEL_DIST);
		board.mesh.position.y = head.position.y - PANEL_DROP;
		board.mesh.rotation.set(-0.12, panelYaw.value, 0, 'YXZ');
		board.mesh.updateMatrixWorld(true);
	} else if (!entry) panelYaw.value = NaN; // a new menu appears straight ahead

	// ---- the wrist + the strip (the overlay lines; the wrist is there even with none)
	const lines = overlayLines(
		overlay.flatMap((o) => o.screen.elements ?? []),
		runtime
	);
	const wrist = surface('vr-game-wrist', 320, 300, WRIST_W);
	const leftHand = opts.hands?.[0] ?? null;
	if (live && leftHand) {
		const sig = JSON.stringify([lines, strip, hover]);
		if (sig !== wrist.sig) {
			// a line count change re-sizes the card
			wrist.sig = sig;
			wrist.hits = drawCard(wrist.g, lines.length ? lines : ['No score yet'], { title: 'Game', buttons: true, strip, hover: hover[0] ?? hover[1] });
			wrist.texture.needsUpdate = true;
		}
		// up the forearm, facing up off it — clear of 30b-vr-modes' mode label, which sits on
		// the same controller at (0, 0.03, 0.07)
		_v.set(-0.01, 0.035, 0.21).applyQuaternion(leftHand.quaternion).add(leftHand.position);
		wrist.mesh.position.copy(_v);
		wrist.mesh.quaternion.copy(leftHand.quaternion).multiply(WRIST_TILT);
		wrist.mesh.updateMatrixWorld(true);
		// shown when the card's face points at the head ("turn the wrist to read")
		_up.set(0, 0, 1).applyQuaternion(wrist.mesh.quaternion);
		_v.copy(head ? head.position : _v).sub(wrist.mesh.position).normalize();
		wrist.mesh.visible = _up.dot(_v) > 0.35;
	} else wrist.mesh.visible = false;

	const stripLines = lines.filter(stripWorthy);
	const bar = surface('vr-game-strip', 1024, 72, 0.9);
	bar.mesh.visible = live && strip && stripLines.length > 0;
	if (bar.mesh.visible && head) {
		const sig = JSON.stringify(stripLines);
		if (sig !== bar.sig) {
			bar.sig = sig;
			drawCard(bar.g, stripLines, { row: true });
			bar.texture.needsUpdate = true;
		}
		headLocked(bar.mesh, head, 1.3, 0.36);
	}

	// ---- the announce banner (head-locked; shown in any mode while presenting)
	const note = get(gameAnnouncement);
	const banner = surface('vr-game-announce', 1024, 256, 0.95);
	banner.mesh.visible = !!head && !!note;
	if (banner.mesh.visible && head && note) {
		const sig = JSON.stringify([note.id, note.text, note.sub, note.color]);
		if (sig !== banner.sig) {
			banner.sig = sig;
			drawCard(banner.g, [note.text, note.sub].filter(Boolean), { big: true, color: note.color });
			banner.texture.needsUpdate = true;
		}
		headLocked(banner.mesh, head, 1.5, 0.12);
		const left = note.at + note.ms - Date.now();
		/** @type {any} */ (banner.mesh.material).opacity = Math.max(0, Math.min(1, left / 300));
	}
	return {
		panel: board.mesh.visible ? entry?.screen?.id ?? null : null,
		lines,
		stripLines,
		wrist: wrist.mesh.visible,
		strip: bar.mesh.visible,
		banner: banner.mesh.visible
	};
}

const WRIST_TILT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

/** @param {any} screen the values a menu's inputs hold (a toggle flip must redraw) */
function valuesSig(screen) {
	return (screen?.elements ?? []).filter((/** @type {any} */ el) => isInteractiveKind(el.kind)).map((/** @type {any} */ el) => hudValueOf(el.id, el.value));
}

/** @param {THREE.Object3D} mesh @param {{position: any, quaternion: any}} head @param {number} dist @param {number} up */
function headLocked(mesh, head, dist, up) {
	_fwd.set(0, 0, -1).applyQuaternion(head.quaternion);
	_up.set(0, 1, 0).applyQuaternion(head.quaternion);
	mesh.position.copy(head.position).addScaledVector(_fwd, dist).addScaledVector(_up, up);
	mesh.quaternion.copy(head.quaternion);
	mesh.updateMatrixWorld(true);
}

/* ---------------------------------------------------------------- interaction ----- */

/** @typedef {{surface: string, hit: HitRect, point: THREE.Vector3, distance: number}} PanelTarget */

/** @param {Surface} s @param {THREE.Vector2} uv @returns {HitRect | null} */
function hitAtUv(s, uv) {
	const px = uv.x * s.canvas.width;
	const py = (1 - uv.y) * s.canvas.height;
	return s.hits.find((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) ?? null;
}

/**
 * What a ray points at on the panel or the wrist — a pressable rect or null. Exported for
 * the sweep (P4) and the suites.
 * @param {THREE.Raycaster} ray @returns {PanelTarget | null}
 */
export function panelTargetAlong(ray) {
	/** @type {PanelTarget | null} */
	let best = null;
	for (const name of ['vr-game-panel', 'vr-game-wrist']) {
		const s = surfaces[name];
		if (!s?.mesh.visible) continue;
		const hit = ray.intersectObject(s.mesh, false)[0];
		if (!hit?.uv) continue;
		const rect = hitAtUv(s, hit.uv);
		if (rect && (!best || hit.distance < best.distance)) best = { surface: name, hit: rect, point: hit.point.clone(), distance: hit.distance };
	}
	return best;
}

/**
 * The laser's hover ring for slot `index` (redraws the board when it changes).
 * @param {number} index @param {THREE.Raycaster | null} ray @returns {PanelTarget | null}
 */
export function panelHover(index, ray) {
	const target = ray ? panelTargetAlong(ray) : null;
	hover[index] = target?.hit.id ?? null;
	return target;
}

/**
 * PRESS a panel target — the desktop press verbatim. Returns true when something acted.
 * @param {PanelTarget} target @param {{source?: string, u?: number}} [opts]
 */
export function pressPanelTarget(target, opts = {}) {
	const hit = target?.hit;
	if (!hit) return false;
	debug.presses++;
	debug.lastPress = hit.id;
	playGameSound('click', target.point ? target.point.toArray() : null);
	if (hit.kind === 'footer') {
		if (hit.footer === 'edit') {
			debug.edits++;
			// the ONE Edit/Interact switch (30b-vr-modes' Y button calls it too); the store
			// write is the whole of leaving Interact, the rest re-seats a desktop gizmo
			setEditorMode('edit');
		} else if (hit.footer === 'strip') setVrStrip(!stripOn());
		return true;
	}
	const el = elementOf(hit);
	if (!el) return false;
	if (el.kind === 'button') fireHudButton(el.id);
	else if (el.kind === 'toggle') {
		setHudValue(el.id, !hudValueOf(el.id, el.value), { shared: !!el.shared });
		fireHudButton(el.id);
	} else if (el.kind === 'slider') {
		const min = Number(el.min ?? 0);
		const max = Number(el.max ?? 100);
		const step = Number(el.step || 1);
		const u = Number.isFinite(opts.u) ? Number(opts.u) : 0.5;
		const raw = min + (max - min) * Math.min(1, Math.max(0, u));
		setHudValue(el.id, Math.round(raw / step) * step, { shared: !!el.shared });
	} else if (el.kind === 'dropdown' || el.kind === 'tabs') {
		const options = hudOptionsOf(el.id, el);
		if (!options.length) return false;
		if (el.kind === 'tabs') {
			const at = Math.max(0, Math.round(Number(hudValueOf(el.id, el.value ?? 0))));
			setHudValue(el.id, (at + 1) % options.length, { shared: !!el.shared });
		} else {
			const held = String(hudValueOf(el.id, el.value ?? options[0]));
			setHudValue(el.id, options[(Math.max(0, options.indexOf(held)) + 1) % options.length], { shared: !!el.shared });
		}
	} else fireHudButton(el.id); // a module kind with sub-presses: its own id pulses
	return true;
}

/** @param {HitRect} hit */
function elementOf(hit) {
	for (const { screen } of vrScreens().panel) {
		const el = (screen.elements ?? []).find((/** @type {any} */ e) => e.id === hit.id);
		if (el) return el;
	}
	return null;
}

/** the u (0..1 across the rect) of a panel target — a slider's value @param {PanelTarget} target */
export function uAcross(target) {
	const s = surfaces[target.surface];
	if (!s) return 0.5;
	const local = s.mesh.worldToLocal(target.point.clone());
	const px = (local.x / s.w + 0.5) * s.canvas.width;
	return (px - target.hit.x) / Math.max(1, target.hit.w);
}

/* ------------------------------------------------------------------------ poke ---- */

/** a tip is TOUCHING within this of the plane; it must back off past RELEASE to re-arm */
const POKE_TOUCH = 0.018;
const POKE_RELEASE = 0.04;
const pokeArmed = [true, true];

/**
 * One frame of the fingertip / controller-tip POKE for slot `index`: pushing the tip
 * through a button presses it once; pulling back re-arms. Returns the pressed target.
 * @param {number} index @param {THREE.Vector3 | null} tip world position
 * @returns {PanelTarget | null}
 */
export function pokeFrame(index, tip) {
	if (!tip) return null;
	let pressed = null;
	let nearest = Infinity;
	for (const name of ['vr-game-panel', 'vr-game-wrist']) {
		const s = surfaces[name];
		if (!s?.mesh.visible) continue;
		const local = s.mesh.worldToLocal(tip.clone());
		if (Math.abs(local.x) > s.w / 2 || Math.abs(local.y) > s.h / 2) continue;
		const depth = Math.abs(local.z);
		nearest = Math.min(nearest, depth);
		if (depth > POKE_TOUCH || !pokeArmed[index]) continue;
		const uv = new THREE.Vector2(local.x / s.w + 0.5, local.y / s.h + 0.5);
		const rect = hitAtUv(s, uv);
		if (!rect) continue;
		const target = { surface: name, hit: rect, point: tip.clone(), distance: 0 };
		pokeArmed[index] = false;
		debug.pokes++;
		pressPanelTarget(target, { source: 'poke', u: uAcross(target) });
		pressed = target;
	}
	if (nearest > POKE_RELEASE) pokeArmed[index] = true;
	return pressed;
}

/** @returns {{presses: number, pokes: number, lastPress: string | null, edits: number, hover: (string | null)[], strip: boolean, hits: Record<string, HitRect[]>}} */
export function vrGamePanelDebug() {
	/** @type {Record<string, HitRect[]>} */
	const hits = {};
	for (const [name, s] of Object.entries(surfaces)) hits[name] = s.hits.map((h) => ({ ...h }));
	return { ...debug, hover: [...hover], strip: stripOn(), hits };
}

/** the surfaces' meshes (suites read visibility, poses and canvases) @param {string} name */
export function vrGameSurface(name) {
	const s = surfaces[name];
	return s ? { mesh: s.mesh, canvas: s.canvas } : null;
}

/** Hide everything (the session ended, the player left the game). */
export function hideVrGamePanel() {
	for (const s of Object.values(surfaces)) s.mesh.visible = false;
	hover[0] = hover[1] = null;
	panelYaw.value = NaN;
}
