// 77 C1 — BURN-IN: caption lines painted into a video frame, the way the overlay shows them
// (bottom-centre, one solid backing per row, white text). The recorder calls `burnLiveCaptions`
// after it copies each frame (what was on screen); a frame-exact offline render calls
// `burnCaptionsAt(ctx, w, h, seq, t)`, which reads the sequence's cues AT the frame's time, so
// the captions in the file are in sync to the frame whatever the render speed.
// A LEAF: svelte/store + the caption stores + the pure sequence core.
import { get } from 'svelte/store';
import { activeCaptions, captionsShown, subtitleLines, subtitleTexts } from './captions';
import { captionsAt } from './sequenceCore';

/**
 * Wrap `text` into rows no wider than `maxW` (measured with the context's current font).
 * @param {CanvasRenderingContext2D} ctx @param {string} text @param {number} maxW @returns {string[]}
 */
export function wrapRows(ctx, text, maxW) {
	/** @type {string[]} */
	const rows = [];
	for (const line of String(text ?? '').split('\n')) {
		let row = '';
		for (const word of line.split(' ').filter(Boolean)) {
			const next = row ? row + ' ' + word : word;
			if (row && ctx.measureText(next).width > maxW) {
				rows.push(row);
				row = word;
			} else row = next;
		}
		if (row) rows.push(row);
	}
	return rows;
}

/** the suites' view: frames painted with captions, and the last rows painted */
const burned = { frames: 0, rows: /** @type {string[]} */ ([]) };
export function captionBurnDebug() {
	return { frames: burned.frames, rows: [...burned.rows] };
}

/**
 * Paint caption lines onto a frame. Size follows the frame (≈ 4.6 % of its height, the broadcast
 * subtitle size), so a 4K file and a GIF read the same. Returns the rows drawn.
 * @param {CanvasRenderingContext2D} ctx @param {number} w @param {number} h @param {string[]} lines
 */
export function drawCaptionsOnto(ctx, w, h, lines) {
	if (!lines.length) return 0;
	const px = Math.max(12, Math.round(h * 0.046));
	const pad = Math.round(px * 0.45);
	const lineH = Math.round(px * 1.32);
	ctx.save();
	ctx.font = `600 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	const rows = lines.flatMap((l) => wrapRows(ctx, l, w * 0.84)).slice(-4);
	let y = h - Math.round(h * 0.08) - rows.length * (lineH + 4);
	for (const row of rows) {
		const tw = ctx.measureText(row).width + pad * 2;
		ctx.fillStyle = 'rgba(10, 12, 18, 0.86)';
		ctx.beginPath();
		if (ctx.roundRect) ctx.roundRect((w - tw) / 2, y, tw, lineH, Math.round(px * 0.25));
		else ctx.rect((w - tw) / 2, y, tw, lineH);
		ctx.fill();
		ctx.fillStyle = '#f9fafb';
		ctx.fillText(row, w / 2, y + lineH / 2 + 1);
		y += lineH + 4;
	}
	ctx.restore();
	burned.frames++;
	burned.rows = rows;
	return rows.length;
}

/** What is on screen now: subtitles, then the caption bus when this person has Captions on. */
export function liveCaptionLines() {
	return [...subtitleTexts(get(subtitleLines)), ...(get(captionsShown) ? get(activeCaptions).map((c) => c.text) : [])];
}

/** The recorder's per-frame call. @param {CanvasRenderingContext2D} ctx @param {number} w @param {number} h */
export function burnLiveCaptions(ctx, w, h) {
	return drawCaptionsOnto(ctx, w, h, liveCaptionLines());
}

/**
 * A frame-exact render's call: the cues of `seq` at sequence time `t`.
 * @param {CanvasRenderingContext2D} ctx @param {number} w @param {number} h @param {any} seq @param {number} t
 */
export function burnCaptionsAt(ctx, w, h, seq, t) {
	return drawCaptionsOnto(ctx, w, h, subtitleTexts(/** @type {any} */ (captionsAt(seq, t))));
}
