// VR controls — 52-browser: PAINT the wrist Asset Browser. DOM is invisible in a headset, so the panel is
// one canvas on one plane (ONE draw call — a grid of meshes + troika labels would be ~40 on a Quest whose
// budget is 150 for the whole scene). Pure over its arguments (imports nothing): it paints one view and
// returns the pressable rects, the shape the laser hit test reads (the vrPanelDraw / shellPanelDraw
// convention).
//
// Canvas colours are literals (a canvas cannot read a CSS var()), the headset-panel exception the other VR
// panels take; the high-contrast pairs keep body text >= 7:1 on the panel ground.

/** canvas size in px. On the wrist the plane is 0.2 m wide (~3.8 px/mm, ~1 texel per Quest 3 pixel at the
 * 0.35 m a wrist is read from); pinned it grows 1.6x and is read from ~0.7 m. */
export const PANEL_PX = { w: 768, h: 896 };
/** cards per page */
export const COLS = 3;
export const ROWS = 3;
export const PAGE_SIZE = COLS * ROWS;

/** @typedef {{id: string, x: number, y: number, w: number, h: number}} PanelHit */
/** @typedef {{key: string, label: string, sub?: string, thumb?: string | null, badge?: string, progress?: number | null,
 *   placing?: boolean, folder?: boolean}} Card */
/**
 * @typedef {{tab: 'packs' | 'free' | 'library', crumb: string | null, query: string, cards: Card[], page: number, pages: number,
 *   total: number, status: string, statusTone?: 'info' | 'warn' | 'bad', loading: boolean, pinned: boolean, empty: string}} PanelView
 */

const C = {
	bg: 'rgba(17, 21, 28, 0.96)',
	border: '#2f3846',
	title: '#f1f4f8',
	body: '#d5dbe4',
	dim: '#97a1b0',
	card: '#232934',
	cardHover: '#33405a',
	cardPlacing: '#1d4f91',
	tab: '#232934',
	tabOn: '#2563eb',
	button: '#2a313d',
	buttonHover: '#3b4658',
	accent: '#5aa2ff',
	warn: '#fbbf24',
	bad: '#f87171',
	progress: '#3fb950',
	thumbBg: '#11151c'
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

/** one line, shortened with an ellipsis to fit `maxW` @param {CanvasRenderingContext2D} g @param {string} text @param {number} maxW */
export function fitText(g, text, maxW) {
	const s = String(text ?? '');
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

const TABS = /** @type {const} */ ([
	['packs', 'Packs'],
	['free', 'Free CC0'],
	['library', 'My library']
]);

/** the grid's geometry (canvas px), shared by the painter and the suites */
export const GRID = (() => {
	const pad = 16;
	const top = 236;
	const bottom = 764;
	const w = (PANEL_PX.w - pad * (COLS + 1)) / COLS;
	const h = (bottom - top - pad * (ROWS - 1)) / ROWS;
	return { pad, top, bottom, w, h };
})();

/**
 * Paint one view. `images` resolves a thumbnail url to a LOADED image (or null while it loads — the card
 * shows its initial meanwhile). `hover` is the id under a laser. Returns the pressable rects.
 * @param {CanvasRenderingContext2D} g @param {PanelView} view
 * @param {{images: (url: string) => (CanvasImageSource | null), hover: string | null}} opts
 * @returns {PanelHit[]}
 */
export function drawAssetPanel(g, view, opts) {
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

	// ---- header: title · pin / return · close ----------------------------------------------------
	g.fillStyle = C.title;
	g.font = '600 40px system-ui, sans-serif';
	g.textAlign = 'left';
	g.fillText('Assets', 28, 46);
	/** @param {string} id @param {string} label @param {number} x @param {number} w @param {number} y @param {number} h */
	const button = (id, label, x, y, w, h, on = false) => {
		roundRect(g, x, y, w, h, 14);
		g.fillStyle = on ? C.tabOn : hot(id) ? C.buttonHover : C.button;
		g.fill();
		g.fillStyle = C.title;
		g.textAlign = 'center';
		g.fillText(label, x + w / 2, y + h / 2 + 1);
		hits.push({ id, x, y, w, h });
	};
	g.font = '500 28px system-ui, sans-serif';
	button('pin', view.pinned ? 'To wrist' : 'Pin', W - 232, 18, 128, 56);
	button('close', '✕', W - 92, 18, 64, 56);

	// ---- tabs --------------------------------------------------------------------------------------
	g.font = '500 30px system-ui, sans-serif';
	const tabW = (W - 16 * 4) / 3;
	TABS.forEach(([id, label], i) => button('tab:' + id, label, 16 + i * (tabW + 16), 92, tabW, 60, view.tab === id));

	// ---- search row (a press opens the VR keyboard); inside a pack, a back crumb first -----------------
	let sx = 16;
	if (view.crumb) {
		g.font = '500 28px system-ui, sans-serif';
		button('back', '‹ Packs', 16, 166, 150, 56);
		sx = 182;
	}
	const sw = W - 16 - sx;
	roundRect(g, sx, 166, sw, 56, 14);
	g.fillStyle = hot('search') ? C.buttonHover : C.thumbBg;
	g.fill();
	g.lineWidth = 2;
	g.strokeStyle = C.border;
	g.stroke();
	hits.push({ id: 'search', x: sx, y: 166, w: sw, h: 56 });
	g.textAlign = 'left';
	g.font = '400 28px system-ui, sans-serif';
	const q = view.query ? view.query : view.crumb ? `Search ${view.crumb}…` : 'Search…';
	g.fillStyle = view.query ? C.title : C.dim;
	g.fillText(fitText(g, '⌕  ' + q, sw - 120), sx + 18, 195);
	if (view.query) {
		g.font = '500 26px system-ui, sans-serif';
		button('clear', 'Clear', sx + sw - 104, 172, 96, 44);
	}

	// ---- the grid ------------------------------------------------------------------------------------
	const { pad, top, w: cw, h: ch } = GRID;
	if (!view.cards.length) {
		g.fillStyle = C.dim;
		g.font = '400 30px system-ui, sans-serif';
		g.textAlign = 'center';
		g.fillText(view.loading ? 'Loading…' : view.empty, W / 2, (top + GRID.bottom) / 2);
	}
	view.cards.forEach((card, i) => {
		const col = i % COLS;
		const row = Math.floor(i / COLS);
		const x = pad + col * (cw + pad);
		const y = top + row * (ch + pad);
		const id = 'card:' + card.key;
		roundRect(g, x, y, cw, ch, 16);
		g.fillStyle = card.placing ? C.cardPlacing : hot(id) ? C.cardHover : C.card;
		g.fill();
		if (hot(id)) {
			g.lineWidth = 4;
			g.strokeStyle = C.accent;
			g.stroke();
		}
		hits.push({ id, x, y, w: cw, h: ch });
		// the thumbnail box
		const tx = x + 10;
		const ty = y + 10;
		const tw = cw - 20;
		const th = ch - 62;
		roundRect(g, tx, ty, tw, th, 10);
		g.fillStyle = C.thumbBg;
		g.fill();
		const img = card.thumb ? opts.images(card.thumb) : null;
		if (img) {
			// contain, centred
			const iw = /** @type {any} */ (img).naturalWidth || /** @type {any} */ (img).width || 1;
			const ih = /** @type {any} */ (img).naturalHeight || /** @type {any} */ (img).height || 1;
			const s = Math.min(tw / iw, th / ih);
			g.save();
			roundRect(g, tx, ty, tw, th, 10);
			g.clip();
			g.drawImage(img, tx + (tw - iw * s) / 2, ty + (th - ih * s) / 2, iw * s, ih * s);
			g.restore();
		} else {
			g.fillStyle = C.dim;
			g.font = '600 52px system-ui, sans-serif';
			g.textAlign = 'center';
			g.fillText(card.folder ? '▤' : String(card.label || '?').slice(0, 1).toUpperCase(), tx + tw / 2, ty + th / 2);
		}
		if (card.badge) {
			g.font = '600 22px system-ui, sans-serif';
			const bw = g.measureText(card.badge).width + 18;
			roundRect(g, x + cw - bw - 14, y + 14, bw, 32, 10);
			g.fillStyle = 'rgba(17, 21, 28, 0.85)';
			g.fill();
			g.fillStyle = C.body;
			g.textAlign = 'center';
			g.fillText(card.badge, x + cw - bw / 2 - 14, y + 31);
		}
		if (card.progress != null) {
			const p = Math.max(0, Math.min(1, card.progress));
			roundRect(g, tx, ty + th - 12, tw, 12, 6);
			g.fillStyle = 'rgba(17, 21, 28, 0.85)';
			g.fill();
			if (p > 0) {
				roundRect(g, tx, ty + th - 12, Math.max(12, tw * p), 12, 6);
				g.fillStyle = C.progress;
				g.fill();
			}
		}
		g.fillStyle = C.title;
		g.font = '500 26px system-ui, sans-serif';
		g.textAlign = 'center';
		g.fillText(fitText(g, card.label, cw - 20), x + cw / 2, y + ch - 36);
		if (card.sub) {
			g.fillStyle = C.dim;
			g.font = '400 20px system-ui, sans-serif';
			g.fillText(fitText(g, card.sub, cw - 20), x + cw / 2, y + ch - 13);
		}
	});

	// ---- footer: paging + status ------------------------------------------------------------------------
	g.font = '500 30px system-ui, sans-serif';
	if (view.pages > 1) {
		button('page:-1', '‹', 16, 776, 88, 60);
		button('page:1', '›', W - 104, 776, 88, 60);
	}
	g.textAlign = 'center';
	g.fillStyle = C.dim;
	g.font = '400 24px system-ui, sans-serif';
	g.fillText(view.total ? `${view.page + 1} / ${Math.max(1, view.pages)} · ${view.total} ${view.total === 1 ? 'item' : 'items'}` : '', W / 2, 806);
	if (view.status) {
		g.fillStyle = view.statusTone === 'bad' ? C.bad : view.statusTone === 'warn' ? C.warn : C.body;
		g.font = '500 26px system-ui, sans-serif';
		g.fillText(fitText(g, view.status, W - 48), W / 2, 860);
	}
	return hits;
}

/** the rect under a hit's uv (three's plane uv: v up) @param {PanelHit[]} hits @param {{x: number, y: number}} uv */
export function hitAtUv(hits, uv) {
	const px = uv.x * PANEL_PX.w;
	const py = (1 - uv.y) * PANEL_PX.h;
	// last painted wins (the Clear button sits on the search box)
	for (let i = hits.length - 1; i >= 0; i--) {
		const r = hits[i];
		if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r;
	}
	return null;
}
