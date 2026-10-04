// 36 U3b — PAINT the VR welcome's world-space panel. DOM is invisible in a headset, so the
// tour step is drawn onto a canvas that a plane in front of the user shows. Pure over its
// arguments (imports nothing): it paints one step and returns the pressable rects, the shape
// the panel's laser hit test reads (the vrGamePanel / shellPanelDraw convention).

/** canvas size in px: 1024 over 0.6 m is ~1.07 texels per headset pixel at 0.9 m on a Quest 3 */
export const PANEL_PX = { w: 1024, h: 640 };

/** @typedef {{id: 'skip' | 'never' | 'back' | 'next', x: number, y: number, w: number, h: number, label: string}} PanelHit */

const C = {
	bg: 'rgba(17, 21, 28, 0.95)',
	border: '#2f3846',
	dim: '#8b95a5',
	title: '#f1f4f8',
	body: '#cfd6e0',
	accent: '#4f9bff',
	button: '#2a2f38',
	buttonHover: '#3a4250',
	primary: '#2563eb',
	primaryHover: '#3b82f6',
	done: '#3fb950'
};

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

/**
 * Greedy word wrap. @param {CanvasRenderingContext2D} g @param {string} text @param {number} maxW
 * @returns {string[]}
 */
export function wrapLines(g, text, maxW) {
	/** @type {string[]} */
	const lines = [];
	for (const para of String(text).split('\n')) {
		let line = '';
		for (const word of para.split(/\s+/).filter(Boolean)) {
			const next = line ? line + ' ' + word : word;
			if (line && g.measureText(next).width > maxW) {
				lines.push(line);
				line = word;
			} else line = next;
		}
		lines.push(line);
	}
	return lines;
}

/**
 * Paint one step. `art` is the controller diagram already rasterised (an image, or null while
 * it loads — the column stays empty for a frame). Returns the buttons' rects in canvas px.
 * @param {CanvasRenderingContext2D} g
 * @param {{title: string, index: number, total: number, last: boolean, first: boolean,
 *   step: {title: string, body: string, hint?: string}, waiting: string[]}} tour
 * @param {{art?: CanvasImageSource | null, artW?: number, artH?: number, hover?: string | null,
 *   family?: string}} [opts]
 * @returns {PanelHit[]}
 */
export function drawTourPanel(g, tour, opts = {}) {
	const { w: W, h: H } = PANEL_PX;
	g.clearRect(0, 0, W, H);
	roundRect(g, 4, 4, W - 8, H - 8, 28);
	g.fillStyle = C.bg;
	g.fill();
	g.lineWidth = 3;
	g.strokeStyle = C.border;
	g.stroke();

	g.textBaseline = 'alphabetic';
	g.font = '600 22px system-ui, sans-serif';
	g.fillStyle = C.dim;
	g.textAlign = 'left';
	g.fillText(tour.title.toUpperCase(), 40, 50);
	g.textAlign = 'right';
	g.fillText(`${tour.index + 1} / ${tour.total}`, W - 40, 50);
	// progress pips under the header
	const pipW = (W - 80 - (tour.total - 1) * 6) / tour.total;
	for (let i = 0; i < tour.total; i++) {
		g.fillStyle = i <= tour.index ? C.accent : C.border;
		g.fillRect(40 + i * (pipW + 6), 62, pipW, 5);
	}

	const hasArt = !!opts.art;
	const textW = hasArt ? 470 : W - 80;
	g.textAlign = 'left';
	g.fillStyle = C.title;
	g.font = '700 40px system-ui, sans-serif';
	let y = 118;
	for (const line of wrapLines(g, tour.step.title, W - 80).slice(0, 2)) {
		g.fillText(line, 40, y);
		y += 46;
	}
	g.fillStyle = C.body;
	g.font = '400 27px system-ui, sans-serif';
	y += 6;
	const bodyLines = wrapLines(g, tour.step.body, textW);
	const maxLines = Math.floor((470 - y) / 36);
	for (const line of bodyLines.slice(0, maxLines)) {
		g.fillText(line, 40, y);
		y += 36;
	}

	if (hasArt && opts.art) {
		// the diagram column: fit (artW × artH) into 440 × 330 at the right
		const boxX = W - 40 - 440;
		const boxY = 96;
		const aw = opts.artW || 432;
		const ah = opts.artH || 308;
		const k = Math.min(440 / aw, 330 / ah);
		g.drawImage(opts.art, boxX + (440 - aw * k) / 2, boxY, aw * k, ah * k);
	}

	if (tour.step.hint) {
		g.font = '700 30px system-ui, sans-serif';
		g.fillStyle = C.accent;
		g.fillText('→ ' + tour.step.hint, 40, 508);
		g.font = '400 22px system-ui, sans-serif';
		g.fillStyle = C.dim;
		g.textAlign = 'right';
		g.fillText(tour.last ? 'or press Done' : 'or press Next', W - 40, 508);
		g.textAlign = 'left';
	}

	/** @type {PanelHit[]} */
	const hits = [
		{ id: 'skip', x: 40, y: 548, w: 130, h: 60, label: 'Skip' },
		{ id: 'never', x: 184, y: 548, w: 268, h: 60, label: "Don't show again" }
	];
	if (!tour.first) hits.push({ id: 'back', x: W - 40 - 190 - 14 - 160, y: 548, w: 160, h: 60, label: 'Back' });
	hits.push({ id: 'next', x: W - 40 - 190, y: 548, w: 190, h: 60, label: tour.last ? 'Done' : 'Next' });
	for (const hit of hits) {
		const hovered = opts.hover === hit.id;
		const primary = hit.id === 'next';
		roundRect(g, hit.x, hit.y, hit.w, hit.h, 14);
		g.fillStyle = primary ? (hovered ? C.primaryHover : C.primary) : hovered ? C.buttonHover : C.button;
		g.fill();
		if (hovered) {
			g.lineWidth = 3;
			g.strokeStyle = C.accent;
			g.stroke();
		}
		g.font = `${primary ? 700 : 500} 26px system-ui, sans-serif`;
		g.fillStyle = primary ? '#ffffff' : C.body;
		g.textAlign = 'center';
		g.fillText(hit.label, hit.x + hit.w / 2, hit.y + 39);
	}
	g.textAlign = 'left';
	return hits;
}

/**
 * Which button a uv point on the panel plane hits. @param {PanelHit[]} hits
 * @param {{x: number, y: number}} uv three's uv (origin bottom-left) @returns {PanelHit | null}
 */
export function hitAtUv(hits, uv) {
	const px = uv.x * PANEL_PX.w;
	const py = (1 - uv.y) * PANEL_PX.h;
	return hits.find((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) ?? null;
}
