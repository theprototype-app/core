// 41 G23 + G1: the bottom toolbar's layout model ($lib/toolbarLayout.js, imports nothing).
import { describe, it, expect } from 'vitest';
import {
	normalizeClusters,
	CLUSTERS,
	PLAY,
	SIDE_MAX,
	defaultLayout,
	normalizeLayout,
	visualRow,
	moveCell,
	hideButton,
	showButton,
	swapCell,
	placements,
	fromPlacements,
	placeAt,
	placeRemove,
	stepItem,
	unplacedIds,
	regionOf,
	fillHole,
	isHole,
	foldToFit,
	barWidth
} from '../../src/lib/toolbarLayout.js';

const ROSTER = ['move', 'rotate', 'scale', 'pivot', 'mode', 'objects', 'flow', 'explorer', 'animation', 'uv', 'shader', 'hud', 'ai', 'add', 'chat', 'mic'];
/** @type {import('../../src/lib/toolbarLayout.js').LayoutConfig} */
const CFG = {
	order: ['move', 'rotate', 'scale', 'pivot', 'mode', 'objects', 'flow', 'explorer', 'animation'],
	spacer: 5,
	left: ['ai', 'add'],
	right: ['chat', 'mic'],
	isKnown: (id) => ROSTER.includes(id),
	legacyRows: ['move,rotate,scale,mode,__spacer,objects,flow,explorer,animation'],
	promoted: ['animation']
};
/** @typedef {import('../../src/lib/toolbarLayout.js').ToolbarLayout} ToolbarLayout */
/** what a reload does: JSON round trip, then normalize @param {ToolbarLayout} l */
const reload = (l) => normalizeLayout(JSON.parse(JSON.stringify(l)), CFG);

/** every invariant a layout must hold @param {ToolbarLayout} l */
function valid(l) {
	const placed = [...l.order, ...l.left, ...l.right];
	expect(new Set(placed).size).toBe(placed.length); // no id twice anywhere
	expect(placed.every((id) => ROSTER.includes(id))).toBe(true);
	expect(l.hidden.every((id) => l.order.includes(id))).toBe(true);
	expect(l.left.length).toBeLessThanOrEqual(SIDE_MAX);
	expect(l.right.length).toBeLessThanOrEqual(SIDE_MAX);
	const shown = l.order.filter((id) => !l.hidden.includes(id)).length;
	expect(l.spacerIndex).toBeGreaterThanOrEqual(0);
	expect(l.spacerIndex).toBeLessThanOrEqual(shown);
	expect(visualRow(l).filter((c) => c === PLAY).length).toBe(1);
}

describe('normalizeLayout', () => {
	it('reads nothing as the default, and the default round-trips', () => {
		const d = normalizeLayout(null, CFG);
		expect(d).toEqual(defaultLayout(CFG));
		expect(reload(d)).toEqual(d);
		valid(d);
	});

	it('repairs a broken record: unknown ids, non-strings, duplicates, holes', () => {
		const l = normalizeLayout(
			{ order: ['move', 'move', 42, 'nope', 'rotate', 'chat'], hidden: ['rotate', 'ghost', 'uv'], spacerIndex: 99, left: ['chat', 'ai', 'ai', 'add', 'mic', 'uv'], right: 'x', seen: ['move', 'rotate', 'chat', 'ai', 'add', 'mic', 'uv', 'scale', 'pivot', 'mode', 'objects', 'flow', 'explorer', 'animation'] },
			CFG
		);
		valid(l);
		expect(l.order).toEqual(['move', 'rotate', 'chat']);
		expect(l.hidden).toEqual(['rotate']); // a hidden id not on the bar is dropped
		expect(l.left).toEqual(['ai', 'add', 'mic', 'uv']); // chat is on the bar, capped at four (42 I9)
		expect(l.spacerIndex).toBe(2); // clamped into the shown row
	});

	it('is idempotent on anything', () => {
		const samples = [undefined, 7, 'x', [], { order: 'x' }, { order: ['scale', 'scale'], spacerIndex: -4 }, { order: ['uv'], left: [], right: [], seen: ['uv'] }];
		for (const s of samples) {
			const once = normalizeLayout(s, CFG);
			valid(once);
			expect(normalizeLayout(once, CFG)).toEqual(once);
		}
	});

	it('migrates a shipped default bar to today\'s default (33 E1) and keeps position + collapse', () => {
		const l = normalizeLayout({ order: ['move', 'rotate', 'scale', 'mode', 'objects', 'flow', 'explorer', 'animation'], hidden: [], spacerIndex: 4, collapsed: true, posX: 0.3 }, CFG);
		expect(l.order).toEqual(CFG.order);
		expect(l.collapsed).toBe(true);
		expect(l.posX).toBe(0.3);
	});

	it('a pre-41 record keeps the old append rule; a 41 record keeps a removed default removed', () => {
		const old = normalizeLayout({ order: ['rotate', 'scale', 'pivot', 'mode', 'objects', 'flow', 'explorer'], hidden: [], spacerIndex: 4 }, CFG);
		expect(old.order).toContain('move'); // appended: it cannot tell "removed" from "new"
		expect(old.order).not.toContain('animation'); // promoted: left off on purpose (33 E1)
		const removed = fromPlacements(defaultLayout(CFG), placeRemove(placements(defaultLayout(CFG)), 'move'));
		expect(reload(removed).order).not.toContain('move');
		const chatGone = fromPlacements(defaultLayout(CFG), placeRemove(placements(defaultLayout(CFG)), 'chat'));
		expect(reload(chatGone).right).toEqual(['mic']);
	});

	it('a corner button new to the app joins its corner; the bar wins over a stack', () => {
		const l = normalizeLayout({ order: [...CFG.order, 'chat'], hidden: [], spacerIndex: 5, seen: [...CFG.order, 'chat'] }, CFG);
		expect(l.order.at(-1)).toBe('chat');
		expect(l.right).toEqual(['mic']);
		expect(l.left).toEqual(['ai', 'add']);
	});
});

describe('G23: Move left/right many times, then reload', () => {
	it('walking every far-right cell to the leftmost survives a reload byte for byte', () => {
		let l = defaultLayout(CFG);
		for (let round = 0; round < 6; round++) {
			const row = visualRow(l);
			const far = row[row.length - 1];
			for (let i = 0; i < 12 && visualRow(l)[0] !== far; i++) l = moveCell(l, far, -1);
			valid(l);
			expect(reload(l)).toEqual(l);
			expect(visualRow(reload(l))).toEqual(visualRow(l));
		}
		// …and back again with Move right, through hidden entries
		l = hideButton(l, 'scale');
		for (let i = 0; i < 20; i++) l = moveCell(l, visualRow(l)[0], 1);
		valid(l);
		expect(reload(l)).toEqual(l);
	});

	it('a move never changes the set of cells, only their order', () => {
		let l = hideButton(defaultLayout(CFG), 'rotate');
		const before = [...visualRow(l)].sort();
		for (let i = 0; i < 50; i++) l = moveCell(l, visualRow(l)[(i * 7) % visualRow(l).length], i % 3 ? -1 : 1);
		expect([...visualRow(l)].sort()).toEqual(before);
		expect(l.order).toContain('rotate'); // the hidden entry kept its record
	});

	it('Move refuses the ends', () => {
		const d = defaultLayout(CFG);
		expect(moveCell(d, 'move', -1)).toBe(d);
		expect(moveCell(d, 'animation', 1)).toBe(d);
		expect(moveCell(d, 'nope', 1)).toBe(d);
	});
});

describe('hide / show / swap', () => {
	it('hide keeps the slot, show restores it; a corner button returns to its corner', () => {
		const d = defaultLayout(CFG);
		const h = hideButton(d, 'rotate');
		expect(visualRow(h)).not.toContain('rotate');
		expect(visualRow(showButton(h, 'rotate', CFG))).toEqual(visualRow(d));
		const noAi = hideButton(d, 'ai');
		expect(noAi.left).toEqual(['add']);
		expect(showButton(noAi, 'ai', CFG).left).toEqual(['add', 'ai']);
		expect(showButton(d, 'uv', CFG).order.at(-1)).toBe('uv');
	});

	it('swap puts the new button in the exact slot, bar or corner', () => {
		const d = defaultLayout(CFG);
		const s = swapCell(d, 'rotate', 'uv');
		expect(visualRow(s)[1]).toBe('uv');
		expect(regionOf(s, 'rotate')).toBe(null);
		const c = swapCell(d, 'chat', 'explorer');
		expect(c).toBe(d); // explorer is on the bar: not a swap target
		const c2 = swapCell(d, 'chat', 'uv');
		expect(c2.right).toEqual(['uv', 'mic']);
		valid(c2);
	});
});

describe('G1 placements', () => {
	it('round-trips the default exactly', () => {
		const d = defaultLayout(CFG);
		expect(fromPlacements(d, placements(d))).toEqual(d);
	});

	it('Play never leaves the bar and is never removed; a full stack takes nothing new', () => {
		const p = placements(defaultLayout(CFG));
		expect(placeAt(p, PLAY, 'left', 0)).toBe(p);
		expect(placeRemove(p, PLAY)).toBe(p);
		const full = placeAt(placeAt(p, 'uv', 'left', 2), 'hud', 'left', 3);
		expect(full.left).toEqual(['ai', 'add', 'uv', 'hud']); // 42 I9: four a corner
		expect(placeAt(full, 'shader', 'left', 0)).toBe(full);
		expect(placeAt(full, 'uv', 'left', 0).left).toEqual(['uv', 'ai', 'add', 'hud']); // within: fine
		expect(placeAt(full, 'move', 'right', 0).right).toEqual(['move', 'chat', 'mic']);
	});

	it('drag across regions, apply, reload', () => {
		let p = placements(defaultLayout(CFG));
		p = placeAt(p, 'explorer', 'left', 0); // bar → left stack bottom
		p = placeAt(p, 'chat', 'bar', 0); // corner → bar start
		p = placeRemove(p, 'mic');
		p = placeAt(p, 'shader', 'right', 0); // the "+" popup
		const l = fromPlacements(defaultLayout(CFG), p);
		valid(l);
		expect(l.left).toEqual(['explorer', 'ai', 'add']);
		expect(l.right).toEqual(['shader']);
		expect(visualRow(l)[0]).toBe('chat');
		expect(reload(l)).toEqual(l);
		expect(placements(reload(l))).toEqual(p);
	});

	it('the "+" list is everything unplaced, never Play', () => {
		const p = placeRemove(placements(defaultLayout(CFG)), 'mic');
		expect(unplacedIds(p, [...ROSTER, PLAY])).toEqual(['uv', 'shader', 'hud', 'mic']);
	});

	it('arrow keys walk an item along the bar and into the corners', () => {
		let p = placements(defaultLayout(CFG));
		p = stepItem(p, 'move', 'ArrowLeft'); // leftmost → left stack top
		expect(p.left).toEqual(['ai', 'add', 'move']);
		p = stepItem(p, 'move', 'ArrowDown');
		expect(p.left).toEqual(['ai', 'move', 'add']);
		p = stepItem(p, 'move', 'ArrowRight'); // back onto the bar's start
		expect(p.bar[0]).toBe('move');
		p = stepItem(p, PLAY, 'ArrowLeft');
		expect(p.bar.indexOf(PLAY)).toBe(4);
		const full = placeAt(placeAt(p, 'uv', 'left', 0), 'hud', 'left', 0);
		expect(stepItem(full, 'move', 'ArrowLeft')).toBe(full); // the corner is full (four)
		let q = placements(defaultLayout(CFG));
		for (let i = 0; i < 30; i++) q = stepItem(q, PLAY, 'ArrowRight');
		expect(q.bar.at(-1)).toBe(PLAY);
		expect(q.right).toEqual(['chat', 'mic']); // Play never steps into a corner
	});
});

describe('legacy rows', () => {
	it('an ARRANGED bar that spells a shipped row is not migrated away', () => {
		let l = hideButton(defaultLayout(CFG), 'pivot');
		l = { ...l, order: l.order.filter((o) => o !== 'pivot'), hidden: [], spacerIndex: 4 };
		const r = reload(l);
		expect(visualRow(r)).toEqual(['move', 'rotate', 'scale', 'mode', PLAY, 'objects', 'flow', 'explorer', 'animation']);
	});
});

describe('G1 holes (a removed bar cell leaves a "+" until apply)', () => {
	it('remove-with-hole keeps the slot, fill puts the new item exactly there, apply drops holes', () => {
		const d = defaultLayout(CFG);
		let p = placeRemove(placements(d), 'rotate', { hole: true });
		expect(p.bar[1]).toMatch(/^__hole:/);
		expect(isHole(p.bar[1])).toBe(true);
		p = placeRemove(p, 'scale', { hole: true });
		expect(new Set(p.bar.filter(isHole)).size).toBe(2); // unique hole ids
		p = fillHole(p, p.bar[1], 'chat'); // from the right corner into the first hole
		expect(p.bar[1]).toBe('chat');
		expect(p.right).toEqual(['mic']);
		const l = fromPlacements(d, p);
		expect(l.order.some(isHole)).toBe(false);
		expect(visualRow(l).slice(0, 3)).toEqual(['move', 'chat', 'pivot']);
		expect(reload(l)).toEqual(l);
		expect(unplacedIds(p, ROSTER)).toContain('rotate');
		expect(fillHole(p, '__hole:99', 'uv')).toBe(p);
		expect(fillHole(p, p.bar.find(isHole) ?? '', PLAY)).toBe(p);
	});
});

// ── 42 I9: the top-right group and the touch tools join the record; home-only ids ──────────
describe('42 I9: five regions', () => {
	const R42 = [...ROSTER, 'notes', 'notifications', 'peers', 'undo', 'redo', 'multiselect'];
	/** @type {import('../../src/lib/toolbarLayout.js').LayoutConfig} */
	const C42 = {
		...CFG,
		top: ['notes', 'notifications', 'peers'],
		touch: ['undo', 'redo', 'multiselect'],
		homeOnly: { notifications: 'top', peers: 'top' },
		isKnown: (id) => R42.includes(id)
	};
	const reload42 = (/** @type {ToolbarLayout} */ l) => normalizeLayout(JSON.parse(JSON.stringify(l)), C42);
	const home = C42.homeOnly;

	it('a 41 record (no top / touch) reads the default stacks and keeps its own arrangement', () => {
		const rec41 = { ...defaultLayout(CFG), left: ['add'], right: ['mic', 'chat', 'ai'], seen: [...CFG.order, 'ai', 'add', 'chat', 'mic'] };
		const l = normalizeLayout(JSON.parse(JSON.stringify(rec41)), C42);
		expect(l.top).toEqual(['notes', 'notifications', 'peers']);
		expect(l.touch).toEqual(['undo', 'redo', 'multiselect']);
		expect(l.right).toEqual(['mic', 'chat', 'ai']);
		expect(reload42(l)).toEqual(l);
	});

	it('a home-only id never lands outside its home — a hand-edited record sends it home', () => {
		const l = normalizeLayout({ ...defaultLayout(C42), order: ['peers', ...CFG.order], left: ['notifications', 'ai'], top: ['notes'] }, C42);
		expect(l.order).not.toContain('peers');
		expect(l.left).toEqual(['ai']);
		expect(l.top).toEqual(['notes', 'peers', 'notifications']);
		const p = placements(defaultLayout(C42), home);
		expect(placeAt(p, 'peers', 'bar', 0)).toBe(p);
		expect(placeAt(p, 'notifications', 'right', 0)).toBe(p);
		expect(placeAt(p, 'peers', 'top', 0).top).toEqual(['peers', 'notes', 'notifications']); // within its home: fine
		const holed = placeRemove(p, 'move', { hole: true });
		expect(fillHole(holed, holed.bar[0], 'peers')).toBe(holed);
	});

	it('anything else may move between every region; four a stack; apply + reload round-trip', () => {
		let p = placements(defaultLayout(C42), home);
		p = placeAt(p, 'explorer', 'top', 3); // a bar button into the top-right group
		p = placeAt(p, 'notes', 'bar', 0); // notes onto the bar
		p = placeAt(p, 'undo', 'right', 0); // a touch tool into a corner
		p = placeAt(p, 'mic', 'touch', 0); // a corner button into the touch tools
		expect(p.top).toEqual(['notifications', 'peers', 'explorer']);
		expect(placeAt(placeAt(p, 'uv', 'top', 0), 'shader', 'top', 0).top.length).toBe(4);
		const l = fromPlacements(defaultLayout(C42), p);
		expect(l.top).toEqual(['notifications', 'peers', 'explorer']);
		expect(l.touch).toEqual(['mic', 'redo', 'multiselect']);
		expect(l.right).toEqual(['undo', 'chat']);
		expect(visualRow(l)[0]).toBe('notes');
		expect(reload42(l)).toEqual(l);
		expect(placements(reload42(l), home)).toEqual(p);
	});

	it('removed stays removed across a reload; show/hide/swap know the new stacks', () => {
		const d = defaultLayout(C42);
		const noBell = fromPlacements(d, placeRemove(placements(d, home), 'notifications'));
		expect(reload42(noBell).top).toEqual(['notes', 'peers']);
		expect(showButton(noBell, 'notifications', C42).top).toEqual(['notes', 'peers', 'notifications']);
		expect(hideButton(d, 'redo').touch).toEqual(['undo', 'multiselect']);
		expect(regionOf(d, 'peers')).toBe('top');
		expect(regionOf(d, 'multiselect')).toBe('touch');
		const sw = swapCell(d, 'notes', 'uv', home);
		expect(sw.top).toEqual(['uv', 'notifications', 'peers']);
		const gone = hideButton(d, 'peers');
		expect(swapCell(gone, 'move', 'peers', home)).toBe(gone); // the peers trigger cannot go on the bar
		expect(swapCell(gone, 'notes', 'peers', home).top).toEqual(['peers', 'notifications']);
	});

	it('arrows walk the top-right group and the touch tools along themselves, never out', () => {
		let p = placements(defaultLayout(C42), home);
		p = stepItem(p, 'notes', 'ArrowRight');
		expect(p.top).toEqual(['notifications', 'notes', 'peers']);
		expect(stepItem(p, 'peers', 'ArrowRight')).toBe(p);
		p = stepItem(p, 'undo', 'ArrowDown');
		expect(p.touch).toEqual(['redo', 'undo', 'multiselect']);
		expect(stepItem(p, 'redo', 'ArrowUp')).toBe(p);
	});

	it('is idempotent on hostile records that name the new stacks', () => {
		const samples = [{ top: 'x', touch: [1, 2] }, { top: ['peers', 'peers', 'move'], order: ['move'] }, { touch: ['notifications', 'undo'] }];
		for (const s of samples) {
			const once = normalizeLayout(s, C42);
			const all = [...once.order, ...once.left, ...once.right, ...once.top, ...once.touch];
			expect(new Set(all).size).toBe(all.length);
			expect(once.top.length).toBeLessThanOrEqual(SIDE_MAX);
			expect(normalizeLayout(once, C42)).toEqual(once);
		}
	});
});

describe('43 J10: foldToFit (the overflow "»")', () => {
	// a mouse bar: 38 px cells, a 56 px well, 2 px gaps, 14 px of padding + border, a 47 px tail
	const M = { chrome: 14, cell: 38, well: 56, gap: 2, tail: 47, more: true };
	const row = ['move', 'rotate', 'scale', PLAY, 'objects', 'flow', 'explorer', 'animation'];
	it('folds nothing while the bar fits, "…" included', () => {
		const w = barWidth(row, M, true);
		expect(foldToFit(row, { ...M, budget: w })).toEqual({ shown: row, folded: [] });
		expect(foldToFit(row, { ...M, budget: Infinity }).folded).toEqual([]);
		expect(foldToFit(row, { ...M, budget: NaN }).folded).toEqual([]);
	});
	it('folds right to left by the user order, and the "»" then ends the bar', () => {
		const w = barWidth(row, M, true);
		// one px short: the "»" takes the "…"'s place, so ONE cell has to go
		const one = foldToFit(row, { ...M, budget: w - 1 });
		expect(one.folded).toEqual(['animation']);
		expect(barWidth(one.shown, M, true)).toBeLessThanOrEqual(w - 1);
		const three = foldToFit(row, { ...M, budget: w - 3 * 40 });
		expect(three.folded).toEqual(['flow', 'explorer', 'animation']);
		expect(three.shown).toEqual(['move', 'rotate', 'scale', PLAY, 'objects']);
	});
	it('crosses Play to the cells on its left only when the right side is empty — Play never folds', () => {
		const tiny = foldToFit(row, { ...M, budget: barWidth([PLAY, 'move'], M, true) });
		expect(tiny.shown).toEqual(['move', PLAY]);
		expect(tiny.folded).toEqual(['rotate', 'scale', 'objects', 'flow', 'explorer', 'animation']);
		const none = foldToFit(row, { ...M, budget: 10 });
		expect(none.shown).toEqual([PLAY]);
		expect(none.folded.length).toBe(row.length - 1);
	});
	it('a bar with no "…" fits one cell more, and once it must fold the "»" costs a cell', () => {
		const noMore = { ...M, more: false };
		const fits = barWidth(row, noMore, false);
		expect(foldToFit(row, { ...noMore, budget: fits }).folded).toEqual([]);
		expect(foldToFit(row, { ...noMore, budget: fits - 1 }).folded).toEqual(['explorer', 'animation']);
	});
	it('is monotonic: more room never folds more', () => {
		let last = Infinity;
		for (let budget = 100; budget <= 700; budget += 7) {
			const n = foldToFit(row, { ...M, budget }).folded.length;
			expect(n).toBeLessThanOrEqual(last);
			last = n;
		}
	});
});

describe('43 J2: the "…" in the record', () => {
	const cfg = { order: ['move', 'objects'], spacer: 1, left: [], right: [], isKnown: (/** @type {string} */ id) => ['move', 'objects'].includes(id) };
	it('is shown unless the record says more: false, and survives placements', () => {
		expect(normalizeLayout({ order: ['move'] }, cfg).more).toBe(true);
		const off = normalizeLayout({ order: ['move', 'objects'], more: false }, cfg);
		expect(off.more).toBe(false);
		expect(normalizeLayout(off, cfg)).toEqual(off);
		expect(fromPlacements(off, placements(off)).more).toBe(false);
		expect(fromPlacements(off, { ...placements(off), more: true }).more).toBe(true);
	});
});

describe('43 K3: the Connect pill in the record', () => {
	const cfg = { order: ['move'], spacer: 1, left: [], right: [], isKnown: (/** @type {string} */ id) => id === 'move' };
	it('is shown unless the record says connect: false, and survives placements', () => {
		expect(normalizeLayout({ order: ['move'] }, cfg).connect).toBe(true);
		const off = normalizeLayout({ order: ['move'], connect: false }, cfg);
		expect(off.connect).toBe(false);
		expect(fromPlacements(off, placements(off)).connect).toBe(false);
		expect(fromPlacements(off, { ...placements(off), connect: true }).connect).toBe(true);
	});
});

describe('48 F1: the budget chip is a cluster', () => {
	it('places and hides like the others, never rotates, and survives a record round trip', () => {
		expect(CLUSTERS).toContain('budget');
		const c = normalizeClusters({ budget: { x: 0.25, y: 1.4, rotated: true, hidden: true }, nonsense: { x: 1, y: 1 } });
		expect(c.budget).toEqual({ x: 0.25, y: 1, a: 'bottom-left', hidden: true });
		expect(c.nonsense).toBeUndefined();
		expect(normalizeClusters({ budget: { rotated: true } }).budget).toBeUndefined();
		const rec = reload({ ...defaultLayout(CFG), clusters: { budget: { x: 0.5, y: 0.9 } } });
		expect(rec.clusters?.budget?.x).toBe(0.5);
		expect(fromPlacements(rec, placements(rec)).clusters?.budget?.y).toBe(0.9);
	});
});
