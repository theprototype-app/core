// 70 W2-W5 — the pop-out layout model: move / merge / collapse / strip rules (pure).
import { describe, it, expect } from 'vitest';
import {
	emptyLayout,
	popOut,
	popOutDock,
	addTab,
	removeTab,
	closeWindow,
	activate,
	mergeWindows,
	setRect,
	windowOf,
	poppedKeys,
	showsStrip,
	windowTitle,
	sanitize,
	serialize,
	setupKey
} from '../../src/lib/windows/panelLayout.js';

const TITLES = /** @type {Record<string, string>} */ ({ explorer: 'Explorer', inspector: 'Properties', code: 'Code', flow: 'Node editor' });
const titleOf = (/** @type {string} */ k) => TITLES[k] ?? k;

describe('pop out (W2)', () => {
	it('a panel pops into a window of its own, front tab, no strip', () => {
		const { layout, id } = popOut(emptyLayout(), 'explorer');
		expect(layout.windows).toHaveLength(1);
		const w = layout.windows[0];
		expect(w).toMatchObject({ id, kind: 'panel', panels: ['explorer'], active: 'explorer' });
		expect(showsStrip(w)).toBe(false);
		expect(windowTitle(w, titleOf)).toBe('Explorer');
	});
	it('popping a panel already alone in its window changes nothing', () => {
		const a = popOut(emptyLayout(), 'explorer');
		const b = popOut(a.layout, 'explorer');
		expect(b.layout).toBe(a.layout);
		expect(b.id).toBe(a.id);
	});
	it('ids are fresh per window', () => {
		const a = popOut(emptyLayout(), 'explorer');
		const b = popOut(a.layout, 'code');
		expect(b.id).not.toBe(a.id);
		expect(poppedKeys(b.layout)).toEqual(['explorer', 'code']);
	});
	it('does not mutate its input', () => {
		const a = popOut(emptyLayout(), 'explorer');
		const frozen = JSON.stringify(a.layout);
		addTab(a.layout, a.id, 'inspector');
		removeTab(a.layout, 'explorer');
		expect(JSON.stringify(a.layout)).toBe(frozen);
	});
});

describe('tabs (W3) and one place (W4)', () => {
	it('a second tab makes the strip appear and comes to the front', () => {
		const a = popOut(emptyLayout(), 'explorer');
		const l = addTab(a.layout, a.id, 'inspector');
		const w = windowOf(l, 'inspector');
		expect(w?.panels).toEqual(['explorer', 'inspector']);
		expect(w?.active).toBe('inspector');
		expect(showsStrip(w)).toBe(true);
	});
	it('back to one tab collapses the strip', () => {
		const a = popOut(emptyLayout(), 'explorer');
		const l = removeTab(addTab(a.layout, a.id, 'inspector'), 'inspector');
		const w = windowOf(l, 'explorer');
		expect(w?.panels).toEqual(['explorer']);
		expect(showsStrip(w)).toBe(false);
		expect(w?.active).toBe('explorer');
	});
	it('the setting shows the strip for one tab too', () => {
		const a = popOut(emptyLayout(), 'explorer');
		expect(showsStrip(a.layout.windows[0], true)).toBe(true);
	});
	it('adding a panel that lives in another window MOVES it (no duplicate) and the emptied window is gone', () => {
		const a = popOut(emptyLayout(), 'explorer');
		const b = popOut(a.layout, 'code');
		const l = addTab(b.layout, a.id, 'code');
		expect(l.windows).toHaveLength(1);
		expect(poppedKeys(l)).toEqual(['explorer', 'code']);
		expect(windowOf(l, 'code')?.id).toBe(a.id);
	});
	it('moving out of a two-tab window leaves the other tab in front', () => {
		const a = popOut(emptyLayout(), 'explorer');
		let l = addTab(a.layout, a.id, 'inspector');
		const b = popOut(l, 'code');
		l = addTab(b.layout, b.id, 'inspector');
		expect(windowOf(l, 'explorer')).toMatchObject({ panels: ['explorer'], active: 'explorer' });
		expect(windowOf(l, 'inspector')?.id).toBe(b.id);
	});
	it('the front tab leaving hands the front to its right neighbour, else its left', () => {
		const a = popOutDock(emptyLayout(), ['explorer', 'inspector', 'code'], { active: 'inspector' });
		let l = removeTab(a.layout, 'inspector');
		expect(windowOf(l, 'explorer')?.active).toBe('code');
		l = removeTab(activate(l, 'code'), 'code');
		expect(windowOf(l, 'explorer')?.active).toBe('explorer');
	});
	it('addTab inside its own window reorders', () => {
		const a = popOutDock(emptyLayout(), ['explorer', 'inspector', 'code']);
		const l = addTab(a.layout, /** @type {string} */ (a.id), 'code', 0);
		expect(windowOf(l, 'code')?.panels).toEqual(['code', 'explorer', 'inspector']);
	});
	it('moving a window\'s only tab into itself keeps the window', () => {
		const a = popOut(emptyLayout(), 'explorer');
		const l = addTab(a.layout, a.id, 'explorer', 0);
		expect(l.windows).toHaveLength(1);
		expect(windowOf(l, 'explorer')?.panels).toEqual(['explorer']);
	});
	it('a panel never sits in two windows whatever the sequence', () => {
		let { layout: l, id: w1 } = popOut(emptyLayout(), 'explorer');
		const r = popOut(l, 'inspector');
		l = r.layout;
		l = addTab(l, w1, 'inspector');
		l = popOut(l, 'inspector').layout;
		l = addTab(l, w1, 'code');
		l = mergeWindows(l, /** @type {string} */ (windowOf(l, 'inspector')?.id), w1);
		const keys = poppedKeys(l);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys.sort()).toEqual(['code', 'explorer', 'inspector']);
	});
	it('addTab to an unknown window changes nothing', () => {
		const a = popOut(emptyLayout(), 'explorer');
		expect(addTab(a.layout, 'nope', 'code')).toBe(a.layout);
	});
});

describe('dock windows (W3)', () => {
	it('a popped dock always shows its tabs, even one', () => {
		const { layout, id } = popOutDock(emptyLayout(), ['explorer'], { origin: 'right' });
		const w = windowOf(layout, 'explorer');
		expect(w).toMatchObject({ id, kind: 'dock', origin: 'right', panels: ['explorer'] });
		expect(showsStrip(w)).toBe(true);
	});
	it('keeps the dock order and the front tab it was given', () => {
		const { layout } = popOutDock(emptyLayout(), ['flow', 'explorer', 'code'], { active: 'explorer', origin: 'bottom' });
		expect(layout.windows[0]).toMatchObject({ panels: ['flow', 'explorer', 'code'], active: 'explorer' });
	});
	it('pulls a dock member out of another window it was in', () => {
		const a = popOut(emptyLayout(), 'code');
		const { layout } = popOutDock(a.layout, ['explorer', 'code']);
		expect(layout.windows).toHaveLength(1);
		expect(layout.windows[0].kind).toBe('dock');
	});
	it('an empty dock pops nothing', () => {
		const r = popOutDock(emptyLayout(), []);
		expect(r.id).toBeNull();
		expect(r.layout.windows).toHaveLength(0);
	});
	it('closing a window hands every panel back', () => {
		const { layout, id } = popOutDock(emptyLayout(), ['flow', 'explorer']);
		const r = closeWindow(layout, /** @type {string} */ (id));
		expect(r.keys).toEqual(['flow', 'explorer']);
		expect(r.layout.windows).toHaveLength(0);
	});
	it('a dock window emptied tab by tab is gone (collapse)', () => {
		const { layout } = popOutDock(emptyLayout(), ['flow', 'explorer']);
		const l = removeTab(removeTab(layout, 'flow'), 'explorer');
		expect(l.windows).toHaveLength(0);
	});
});

describe('merge', () => {
	it('merging windows appends and keeps one place', () => {
		const a = popOut(emptyLayout(), 'explorer');
		const b = popOut(a.layout, 'code');
		const l = mergeWindows(b.layout, b.id, a.id);
		expect(l.windows).toHaveLength(1);
		expect(windowOf(l, 'code')).toMatchObject({ id: a.id, panels: ['explorer', 'code'], active: 'code' });
	});
});

describe('persistence (W5)', () => {
	it('round-trips through serialize / sanitize', () => {
		let { layout, id } = popOutDock(emptyLayout(), ['flow', 'explorer'], { origin: 'bottom', active: 'explorer' });
		layout = setRect(layout, /** @type {string} */ (id), { left: 1920, top: 0, width: 900, height: 700 });
		layout = popOut(layout, 'code').layout;
		const back = sanitize(JSON.parse(JSON.stringify(serialize(layout))), () => true);
		expect(back.windows.map((w) => [w.kind, w.panels, w.active, w.origin])).toEqual([
			['dock', ['flow', 'explorer'], 'explorer', 'bottom'],
			['panel', ['code'], 'code', null]
		]);
		expect(back.windows[0].rect).toEqual({ left: 1920, top: 0, width: 900, height: 700 });
		expect(back.next).toBe(3);
	});
	it('drops unknown keys, duplicates, empty windows and bad rects', () => {
		const back = sanitize(
			{
				windows: [
					{ kind: 'panel', panels: ['gone', 'explorer'], active: 'gone', rect: { left: 0, top: 0, width: 10, height: 10 } },
					{ kind: 'weird', panels: ['explorer', 'code'] },
					{ panels: ['gone'] },
					null
				]
			},
			(k) => k !== 'gone'
		);
		expect(back.windows).toEqual([
			{ id: 'w1', kind: 'panel', panels: ['explorer'], active: 'explorer', origin: null, rect: null },
			{ id: 'w2', kind: 'panel', panels: ['code'], active: 'code', origin: null, rect: null }
		]);
	});
	it('reads garbage as an empty layout', () => {
		expect(sanitize(null, () => true).windows).toEqual([]);
		expect(sanitize('x', () => true).windows).toEqual([]);
	});
});

describe('screen setup key (W5)', () => {
	it('every screen counts, in position order, when the API answered', () => {
		const a = setupKey({ screens: [{ width: 1920, height: 1080, left: 1920, top: 0, devicePixelRatio: 1 }, { width: 2560, height: 1440, left: 0, top: 0, devicePixelRatio: 1.25 }] });
		const b = setupKey({ screens: [{ width: 2560, height: 1440, left: 0, top: 0, devicePixelRatio: 1.25 }, { width: 1920, height: 1080, left: 1920, top: 0, devicePixelRatio: 1 }] });
		expect(a).toBe(b);
		expect(a).toBe('screens:2560x1440@1.25+0+0|1920x1080@1+1920+0');
	});
	it('falls back to the one visible screen + extended flag', () => {
		expect(setupKey({ screen: { width: 1280, height: 800, isExtended: false }, dpr: 1 })).toBe('screen:1280x800@1');
		expect(setupKey({ screen: { width: 1280, height: 800, isExtended: true }, dpr: 2 })).toBe('screen:1280x800@2+ext');
	});
});
