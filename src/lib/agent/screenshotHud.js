// mcp-diorama2 (26) — THE GAME HUD ON AN AGENT'S SCREENSHOT (`screenshot {hud: true}`). The desktop HUD is DOM
// (HudLayer), which a WebGL readback never sees, so the screens this tab shows are drawn onto the finished picture
// with the headset's canvas renderer (hudCanvasDraw.drawHudElement — the same twin the VR band and board use).
//
// The layout is the HUD's own: each element's 9-grid anchor + pixel offsets laid out in a frame as wide as the
// person's window would be at this aspect, then scaled to the picture, so a score card sits in the corner it sits
// in on screen. Kinds with no canvas form (a minimap plot, the debug pill, a module's own DOM, a full-screen flash,
// the crosshair) are left out and counted.
import { get } from 'svelte/store';
import { hudRuntime, visibleScreen, activeHudKeys, rectInFrame } from '$lib/hudDocs';
import { drawHudElement, elementShows } from '$lib/hudCanvasDraw';
import { isRenderableKind } from '$lib/hudKinds';
import { NO_VR_FORM } from '$lib/vrHudLayout';

/** the reference width the elements are laid out in (a laptop window) when the person's own is unknown */
const REFERENCE_W = 1280;

/**
 * Draw the visible HUD screens over `ctx` (w × h px).
 * @param {CanvasRenderingContext2D} ctx @param {number} w @param {number} h
 * @param {{through?: string | null, windowW?: number}} [opts] the camera looked through (its own HUD doc), the CSS width of the person's window
 * @returns {{drawn: number, skipped: number, screens: string[]}}
 */
export function drawHudOver(ctx, w, h, opts = {}) {
	const frameW = Math.max(320, Math.round(Number(opts.windowW) || REFERENCE_W));
	const k = w / frameW;
	const frameH = h / k;
	const runtime = /** @type {Record<string, any>} */ (get(hudRuntime) ?? {});
	let drawn = 0;
	let skipped = 0;
	/** @type {string[]} */
	const screens = [];
	for (const key of activeHudKeys(opts.through ?? null)) {
		const screen = visibleScreen(key);
		if (!screen) continue;
		screens.push(String(screen.name ?? screen.id ?? key));
		const elements = [...(screen.elements ?? [])].sort((a, b) => (Number(a?.z) || 0) - (Number(b?.z) || 0));
		for (const el of elements) {
			if (!el || typeof el.kind !== 'string') continue;
			const rt = runtime[el.id];
			// a backdrop (a panel, anything with its own fill) draws with no text of its own
			if (!elementShows(el, rt) && el.kind !== 'panel' && !(el.style?.bg && el.style.bg !== 'transparent')) continue;
			if (NO_VR_FORM.has(el.kind) || !isRenderableKind(el.kind)) {
				skipped++;
				continue;
			}
			const r = rectInFrame(el, frameW, frameH);
			if (!(r.w > 0 && r.h > 0)) continue;
			ctx.save();
			try {
				drawHudElement(ctx, el, r.left * k, r.top * k, r.w * k, r.h * k, k, rt);
				drawn++;
			} catch {
				skipped++;
			} finally {
				ctx.restore();
			}
		}
	}
	return { drawn, skipped, screens };
}
