// Roadmap 67 P1 — the headset board's pure half: layout pages, what a press means, the uv hit test.
import { describe, it, expect } from 'vitest';
import { normalizeSpec } from '../../src/lib/agentPanelCore.js';
import { layoutPanel, pressResult, hitAt, rowHeight, VR_PANEL_PX } from '../../src/lib/agentPanelVRDraw.js';

const res = normalizeSpec({
	v: 1,
	title: 'Pixling',
	tabs: [
		{
			title: 'Make',
			sections: [
				{
					controls: [
						{ type: 'slider', id: 'size', label: 'Size', min: 8, max: 64, step: 8, value: 32 },
						{ type: 'number', id: 'frames', label: 'Frames', min: 1, max: 8, value: 4 },
						{ type: 'select', id: 'pal', label: 'Palette', options: ['pico8', 'gameboy', 'nes'], value: 'gameboy' },
						{ type: 'toggle', id: 'outline', label: 'Outline', value: false },
						{ type: 'image', id: 'preview', label: 'Preview', src: '' },
						{ type: 'button', id: 'render', label: 'Render' }
					]
				}
			]
		},
		{ title: 'About', sections: [{ controls: [{ type: 'status', id: 's', text: 'Ready' }] }] }
	]
});
if (!res.ok) throw new Error(res.error);
const spec = res.spec;
/** @param {string} id */
const ctl = (id) => spec.tabs[0].sections[0].controls.find((/** @type {any} */ c) => c.id === id);

describe('agent panel VR board', () => {
	it('lays the tab out in pages that fit between header and footer', () => {
		const l = layoutPanel(spec, 0);
		expect(l.tabs).toEqual(['Make', 'About']);
		const all = l.pages.flat().map((r) => r.control.id);
		expect(all).toEqual(['size', 'frames', 'pal', 'outline', 'preview', 'render']);
		for (const page of l.pages) for (const r of page) expect(r.y + r.h).toBeLessThanOrEqual(VR_PANEL_PX.h - 76);
		expect(layoutPanel(spec, 1).pages.flat().map((r) => r.control.id)).toEqual(['s']);
		expect(layoutPanel(spec, 9).tab).toBe(1);
	});
	it('a short board pages more', () => {
		expect(layoutPanel(spec, 0, 400).pages.length).toBeGreaterThan(layoutPanel(spec, 0).pages.length);
		expect(rowHeight(ctl('preview'))).toBeGreaterThan(rowHeight(ctl('size')));
	});
	it('a press means what the window control means', () => {
		expect(pressResult(ctl('render'), undefined)).toEqual({ kind: 'press' });
		expect(pressResult(ctl('outline'), false)).toEqual({ kind: 'change', value: true });
		expect(pressResult(ctl('pal'), 'gameboy', 'next')).toEqual({ kind: 'change', value: 'nes' });
		expect(pressResult(ctl('pal'), 'pico8', 'prev')).toEqual({ kind: 'change', value: 'nes' });
		expect(pressResult(ctl('size'), 32, '', 0)).toEqual({ kind: 'change', value: 8 });
		expect(pressResult(ctl('size'), 32, '', 1)).toEqual({ kind: 'change', value: 64 });
		expect(/** @type {any} */ (pressResult(ctl('size'), 32, '', 0.49)).value % 8).toBe(0);
		expect(pressResult(ctl('frames'), 4, '+')).toEqual({ kind: 'change', value: 5 });
		expect(pressResult(ctl('frames'), 8, '+')).toEqual({ kind: 'change', value: 8 });
		expect(pressResult(ctl('frames'), 4, '')).toBeNull();
		expect(pressResult(ctl('preview'), null)).toBeNull();
		expect(pressResult({ ...ctl('render'), disabled: true }, null)).toBeNull();
	});
	it('the uv hit test returns the rect and where along it', () => {
		const hits = [{ id: 'c:size', control: 'size', x: 100, y: 100, w: 200, h: 50 }];
		const r = hitAt(hits, { x: 200 / VR_PANEL_PX.w, y: 1 - 125 / VR_PANEL_PX.h });
		expect(r?.hit.id).toBe('c:size');
		expect(r?.u).toBeCloseTo(0.5, 5);
		expect(hitAt(hits, { x: 0.9, y: 0.1 })).toBeNull();
	});
});
