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
 *   help: string[], fps?: string | null}} ShellModel
 */

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

	const top = 110;
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
		const cols = 5;
		const tw = 190;
		const th = 96;
		const gap = 14;
		const x0 = (SHELL_STAGE.w - (cols * tw + (cols - 1) * gap)) / 2;
		list.slice(0, 20).forEach((level, i) => {
			const x = x0 + (i % cols) * (tw + gap);
			const y = top + Math.floor(i / cols) * (th + gap);
			const stars = level.stars ? '★'.repeat(level.stars) : '';
			const current = model.levels?.current === level.id;
			button('shell:level:' + level.id, level.label, x, y, tw, th, {
				disabled: !!level.locked,
				accent: current,
				sub: level.locked ? 'Locked' : stars
			});
		});
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
				g.font = `600 ${Math.round(21 * k)}px system-ui, sans-serif`;
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
