// 31 (K3) — THE PAUSE MENU ON THE VR GAME PANEL. DOM is invisible in a headset, so the
// game shell's pages (gameShell.js — the same model the desktop GameShellMenu renders)
// are drawn onto the game panel's canvas. vrGamePanel owns the surface, its placement,
// the laser and the hit test; this file only PAINTS a page and returns its pressable
// rects, exactly the shape drawPanel returns, so pressing goes through the panel's one
// press path (`pressShellHit` for kind 'shell').
//
// Pure over its arguments (the model is read by the caller); exported for the suites.

/** The board's stage size while the menu is up, in stage pixels (the panel scales it). */
export const SHELL_STAGE = { x: 0, y: 0, w: 1100, h: 640 };

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

/**
 * @typedef {{page: string, title: string, subtitle: string,
 *   items: {id: string, label: string}[],
 *   levels: {list: {id: string, label: string, locked?: boolean, stars?: number}[], current: string | null} | null,
 *   settings: {id: string, label: string, type: string, value: any, display: string, min?: number, max?: number, game?: boolean}[],
 *   help: string[], fps?: string | null,
 *   tabs?: {id: string, label: string, options: {value: string, label: string}[], value: string}[],
 *   levelPage?: number | null}} ShellModel
 */

/** the sub-pages' content starts here, in stage px */
const PAGE_TOP = 110;
/** one tab row above the level grid (50 px tabs + the gap under them) */
const TAB_ROW = 64;

/**
 * 33 (G3) — the headset's level grid. It drew `list.slice(0, 20)`: Untangle's levels 21-30 were
 * unreachable in VR. Up to 20 levels and no tabs: the 5 x 4 of big tiles it always had. More, or
 * tabs above the grid: 6 columns, as many rows of at least 64 px as fit; when even that is not
 * enough, pages (the ‹ › arrows beside Back). `page` null = the page holding the current level.
 * Pure; exported for the suites.
 * @param {number} count @param {number} tabRows @param {number | null | undefined} page @param {number} currentIndex
 */
export function levelGridLayout(count, tabRows, page, currentIndex) {
	const top = PAGE_TOP + tabRows * TAB_ROW;
	if (!tabRows && count <= 20) return { cols: 5, rows: 4, tw: 190, th: 96, gap: 14, top, perPage: 20, pages: 1, page: 0 };
	const cols = 6;
	const gap = 12;
	const bottom = SHELL_STAGE.h - 72 - 14; // above Back
	const areaH = bottom - top;
	const rows = Math.max(1, Math.floor((areaH + gap) / (64 + gap)));
	const th = Math.min(96, (areaH - (rows - 1) * gap) / rows);
	const perPage = cols * rows;
	const pages = Math.max(1, Math.ceil(count / perPage));
	const want = page ?? (currentIndex >= 0 ? Math.floor(currentIndex / perPage) : 0);
	return { cols, rows, tw: 160, th, gap, top, perPage, pages, page: Math.min(Math.max(0, want), pages - 1) };
}

/**
 * Paint one shell page over the (already cleared + plated) board. `k` = canvas px per
 * stage px. Returns the hits in CANVAS pixels, `kind: 'shell'`.
 * @param {CanvasRenderingContext2D} g @param {ShellModel} model
 * @param {{k: number, hover?: string | null}} opts
 * @returns {{id: string, key: string, kind: string, x: number, y: number, w: number, h: number}[]}
 */
export function drawShellPage(g, model, opts) {
	const k = opts.k;
	const W = SHELL_STAGE.w * k;
	/** @type {{id: string, key: string, kind: string, x: number, y: number, w: number, h: number}[]} */
	const hits = [];
	const hover = opts.hover ?? null;

	/** @param {string} id @param {string} label @param {number} x @param {number} y @param {number} w @param {number} h @param {{accent?: boolean, disabled?: boolean, sub?: string}} [o] */
	const button = (id, label, x, y, w, h, o = {}) => {
		roundRect(g, x * k, y * k, w * k, h * k, 10 * k);
		g.fillStyle = o.disabled ? 'rgba(55,65,81,0.5)' : o.accent ? '#ef562f' : '#1f2937';
		g.fill();
		const hot = hover === id;
		g.lineWidth = (hot ? 5 : 2) * k;
		g.strokeStyle = hot ? '#5fd0ff' : 'rgba(148,163,184,0.55)';
		g.stroke();
		g.fillStyle = o.disabled ? 'rgba(243,244,246,0.5)' : '#f3f4f6';
		g.textAlign = 'center';
		g.textBaseline = 'middle';
		g.font = `600 ${Math.round(26 * k)}px system-ui, sans-serif`;
		g.fillText(label, (x + w / 2) * k, (y + (o.sub ? h * 0.4 : h / 2)) * k);
		if (o.sub) {
			g.font = `500 ${Math.round(18 * k)}px system-ui, sans-serif`;
			g.fillStyle = '#fbbf24';
			g.fillText(o.sub, (x + w / 2) * k, (y + h * 0.74) * k);
		}
		if (!o.disabled) hits.push({ id, key: 'shell', kind: 'shell', x: x * k, y: y * k, w: w * k, h: h * k });
	};

	// the heading
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	g.fillStyle = '#f9fafb';
	g.font = `800 ${Math.round(40 * k)}px system-ui, sans-serif`;
	g.fillText(model.title, W / 2, 46 * k);
	g.fillStyle = '#93c5fd';
	g.font = `500 ${Math.round(20 * k)}px system-ui, sans-serif`;
	g.fillText(model.subtitle + (model.fps ? '  ·  ' + model.fps : ''), W / 2, 84 * k);

	const top = PAGE_TOP;
	if (model.page === 'main') {
		const bw = 520;
		const bh = 56;
		const gap = 12;
		model.items.forEach((item, i) => {
			button('shell:item:' + item.id, item.label, (SHELL_STAGE.w - bw) / 2, top + i * (bh + gap), bw, bh, { accent: item.id === 'resume' });
		});
		return hits;
	}

	// every sub-page: a Back button at the bottom
	const backY = SHELL_STAGE.h - 72;
	button('shell:back', 'Back', (SHELL_STAGE.w - 300) / 2, backY, 300, 54);

	if (model.page === 'levels') {
		const list = model.levels?.list ?? [];
		// 33 (G3): the game's level-picking choices as tabs (Untangle: Board  [Globe] [2D board])
		const tabs = (model.tabs ?? []).slice(0, 2);
		tabs.forEach((tab, t) => {
			const y = top + t * TAB_ROW;
			g.textAlign = 'right';
			g.textBaseline = 'middle';
			g.fillStyle = '#cbd5e1';
			g.font = `600 ${Math.round(24 * k)}px system-ui, sans-serif`;
			const tw = Math.min(260, (SHELL_STAGE.w - 400) / Math.max(1, tab.options.length));
			const x0 = (SHELL_STAGE.w - tab.options.length * (tw + 12) + 12) / 2 + 70;
			g.fillText(tab.label, (x0 - 20) * k, (y + 25) * k);
			tab.options.forEach((option, o) => {
				button('shell:tab:' + t + ':' + o, option.label, x0 + o * (tw + 12), y, tw, 50, { accent: option.value === tab.value });
			});
		});
		const current = list.findIndex((level) => level.id === model.levels?.current);
		const grid = levelGridLayout(list.length, tabs.length, model.levelPage, current);
		const x0 = (SHELL_STAGE.w - (grid.cols * grid.tw + (grid.cols - 1) * grid.gap)) / 2;
		list.slice(grid.page * grid.perPage, (grid.page + 1) * grid.perPage).forEach((level, i) => {
			const x = x0 + (i % grid.cols) * (grid.tw + grid.gap);
			const y = grid.top + Math.floor(i / grid.cols) * (grid.th + grid.gap);
			const stars = level.stars ? '★'.repeat(level.stars) : '';
			button('shell:level:' + level.id, level.label, x, y, grid.tw, grid.th, {
				disabled: !!level.locked,
				accent: model.levels?.current === level.id,
				sub: level.locked ? 'Locked' : stars
			});
		});
		// more pages: the arrows beside Back name the page they go to
		const backX = (SHELL_STAGE.w - 300) / 2;
		if (grid.page > 0) button('shell:lvpage:' + (grid.page - 1), '‹ Page ' + grid.page, backX - 12 - 200, backY, 200, 54);
		if (grid.page < grid.pages - 1) button('shell:lvpage:' + (grid.page + 1), 'Page ' + (grid.page + 2) + ' ›', backX + 300 + 12, backY, 200, 54);
		return hits;
	}

	if (model.page === 'settings') {
		const colW = 510;
		const rowH = 44;
		const gap = 6;
		const perCol = Math.floor((backY - top - 10) / (rowH + gap));
		const x0 = (SHELL_STAGE.w - colW * 2 - 30) / 2;
		model.settings.slice(0, perCol * 2).forEach((row, i) => {
			const col = Math.floor(i / perCol);
			const x = x0 + col * (colW + 30);
			const y = top + (i % perCol) * (rowH + gap);
			g.textAlign = 'left';
			g.textBaseline = 'middle';
			g.fillStyle = row.game ? '#fde68a' : '#e5e7eb';
			g.font = `500 ${Math.round(21 * k)}px system-ui, sans-serif`;
			g.fillText(row.label, x * k, (y + rowH / 2) * k);
			const cx = x + colW - 220;
			if (row.type === 'toggle') {
				button('shell:set:' + row.id + ':next', row.display, cx + 60, y + 2, 160, rowH - 4, { accent: !!row.value });
			} else {
				button('shell:set:' + row.id + ':prev', '‹', cx, y + 2, 50, rowH - 4);
				g.textAlign = 'center';
				g.fillStyle = '#f3f4f6';
				// the value fits BETWEEN the arrows (a game row's option label can be long)
				let size = 21;
				g.font = `600 ${Math.round(size * k)}px system-ui, sans-serif`;
				while (size > 12 && g.measureText(row.display).width > 108 * k) {
					size -= 1;
					g.font = `600 ${Math.round(size * k)}px system-ui, sans-serif`;
				}
				g.fillText(row.display, (cx + 110) * k, (y + rowH / 2) * k);
				button('shell:set:' + row.id + ':next', '›', cx + 170, y + 2, 50, rowH - 4);
			}
		});
		return hits;
	}

	// help
	g.textAlign = 'left';
	g.textBaseline = 'middle';
	g.font = `500 ${Math.round(22 * k)}px system-ui, sans-serif`;
	let y = top + 10;
	for (const line of model.help) {
		for (const piece of wrap(g, line, (SHELL_STAGE.w - 160) * k)) {
			if (y > backY - 30) break;
			g.fillStyle = '#e5e7eb';
			g.fillText(piece, 80 * k, y * k);
			y += 32;
		}
		if (!line) y += 6;
	}
	return hits;
}

/** @param {CanvasRenderingContext2D} g @param {string} text @param {number} max */
function wrap(g, text, max) {
	if (!text) return [''];
	/** @type {string[]} */
	const out = [];
	let line = '';
	for (const word of text.split(/\s+/)) {
		const next = line ? line + ' ' + word : word;
		if (line && g.measureText(next).width > max) {
			out.push(line);
			line = word;
		} else line = next;
	}
	if (line) out.push(line);
	return out;
}
