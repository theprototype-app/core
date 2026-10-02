// 33 (G3): the headset's Levels page — EVERY level (it drew the first 20: Untangle's levels
// 21-30 were unreachable in VR), the game's level tabs above the grid, pages when even a
// 6-column grid cannot hold them. Drawn onto a stub 2D context; the hits are what the laser can press.
import { describe, it, expect } from 'vitest';
import { drawShellPage, levelGridLayout, SHELL_STAGE } from '../../src/lib/shellPanelDraw.js';

/** a 2D context that records nothing but answers measureText */
function stubContext() {
	const noop = () => {};
	return { beginPath: noop, moveTo: noop, arcTo: noop, closePath: noop, fill: noop, stroke: noop, fillText: noop, measureText: (/** @type {string} */ t) => ({ width: t.length * 10 }) };
}
const levels = (/** @type {number} */ n, current = '1') => ({ list: Array.from({ length: n }, (_, i) => ({ id: String(i + 1), label: 'Level ' + (i + 1), locked: i > 4 })), current });
const BOARD = { id: 'board', label: 'Board', options: [{ value: 'globe', label: 'Globe' }, { value: '2d', label: '2D board' }], value: '2d' };
/** @param {any} extra */
const page = (extra) => drawShellPage(/** @type {any} */ (stubContext()), /** @type {any} */ ({ page: 'levels', title: 'Levels', subtitle: '', items: [], settings: [], help: [], levels: levels(30), ...extra }), { k: 1 });
const ids = (/** @type {any[]} */ hits) => hits.map((h) => h.id);

describe('the grid layout', () => {
	it('up to 20 levels and no tabs: the 5 x 4 of big tiles it always had', () => {
		expect(levelGridLayout(20, 0, null, 0)).toMatchObject({ cols: 5, rows: 4, tw: 190, th: 96, perPage: 20, pages: 1, page: 0 });
	});
	it('30 levels with a tab row: one page of 6 x 5, tiles at least 64 px tall', () => {
		const g = levelGridLayout(30, 1, null, 0);
		expect(g).toMatchObject({ cols: 6, rows: 5, perPage: 30, pages: 1 });
		expect(g.th).toBeGreaterThanOrEqual(64);
		expect(g.top + g.rows * g.th + (g.rows - 1) * g.gap).toBeLessThanOrEqual(SHELL_STAGE.h - 72);
	});
	it('60 levels: pages; null opens the page holding the current level; a page is clamped', () => {
		const g = levelGridLayout(60, 1, null, 44);
		expect(g.pages).toBe(2);
		expect(g.page).toBe(1);
		expect(levelGridLayout(60, 1, 9, 0).page).toBe(1);
		expect(levelGridLayout(60, 1, 0, 44).page).toBe(0);
	});
});

describe('the drawn page', () => {
	it('every one of 30 levels is a pressable tile (unlocked ones), no page arrows', () => {
		const hits = ids(page({}));
		const tiles = hits.filter((id) => id.startsWith('shell:level:'));
		// levels 1-5 open, 6-30 locked (drawn, not pressable)
		expect(tiles).toEqual(['1', '2', '3', '4', '5'].map((n) => 'shell:level:' + n));
		const all = ids(page({ levels: { list: levels(30).list.map((l) => ({ ...l, locked: false })), current: '30' } }));
		expect(all.filter((id) => id.startsWith('shell:level:')).length).toBe(30);
		expect(all).toContain('shell:level:30');
		expect(all.some((id) => id.startsWith('shell:lvpage:'))).toBe(false);
	});
	it('the tab row: one tab per option, above the grid', () => {
		const hits = page({ tabs: [BOARD] });
		expect(ids(hits).filter((id) => id.startsWith('shell:tab:'))).toEqual(['shell:tab:0:0', 'shell:tab:0:1']);
		const tab = hits.find((h) => h.id === 'shell:tab:0:0');
		const tile = hits.find((h) => h.id === 'shell:level:1');
		expect(tab && tile && tab.y + tab.h).toBeLessThan(/** @type {any} */ (tile).y);
		// nothing overlaps (a press means one thing)
		const overlap = hits.some((a, i) => hits.some((b, j) => j > i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
		expect(overlap).toBe(false);
	});
	it('60 open levels with a tab: page 1 shows 31-60 and an arrow back to page 1', () => {
		const list = Array.from({ length: 60 }, (_, i) => ({ id: String(i + 1), label: 'L' + (i + 1) }));
		const hits = ids(page({ tabs: [BOARD], levels: { list, current: '1' }, levelPage: 1 }));
		expect(hits).toContain('shell:level:31');
		expect(hits).toContain('shell:level:60');
		expect(hits).not.toContain('shell:level:30');
		expect(hits).toContain('shell:lvpage:0');
		expect(hits).not.toContain('shell:lvpage:2');
	});
});
