// @ts-nocheck — fixtures built ad hoc (the checkJs rule for test fixtures)
// mcp-diorama2 (26): screenshot {hud: true} draws the HUD screens this tab shows over the picture, laid out by their
// own anchors; view 'camera' looks through a scene camera (planShot's half).
import { describe, it, expect, vi } from 'vitest';

const drawn = vi.hoisted(() => []);
vi.mock('$lib/hudCanvasDraw', () => ({
	drawHudElement: (g, el, x, y, w, h, k) => drawn.push({ id: el.id, x, y, w, h, k }),
	elementShows: (el) => !!el.text
}));

const { hudDocs } = await import('../../src/lib/hudDocs.js');
const { drawHudOver } = await import('../../src/lib/agent/screenshotHud.js');
const { planShot } = await import('../../src/lib/agent/screenshotCore.js');

const ctx = { save() {}, restore() {} };

describe('26 screenshot: the HUD on top, and view camera', () => {
	it('draws the visible screen\'s elements at their anchors, scaled to the picture; a minimap is skipped and counted', () => {
		hudDocs.set({
			scene: {
				active: 's1',
				screens: [
					{
						id: 's1',
						name: 'Playing',
						elements: [
							{ id: 'score', kind: 'text', text: 'Score 3', anchor: 'top-left', x: 20, y: 10, w: 200, h: 40 },
							{ id: 'clock', kind: 'text', text: '1:00', anchor: 'bottom-right', x: 20, y: 20, w: 100, h: 40 },
							{ id: 'map', kind: 'minimap', anchor: 'top-right', x: 0, y: 0, w: 100, h: 100, text: 'x' }
						]
					}
				]
			}
		});
		const r = drawHudOver(ctx, 640, 360, { windowW: 1280 });
		expect(r).toMatchObject({ drawn: 2, skipped: 1, screens: ['Playing'] });
		const score = drawn.find((d) => d.id === 'score');
		expect(score).toMatchObject({ x: 10, y: 5, w: 100, h: 20, k: 0.5 });
		const clock = drawn.find((d) => d.id === 'clock');
		expect(clock.x + clock.w).toBeCloseTo(640 - 10);
		expect(clock.y + clock.h).toBeCloseTo(360 - 10);
	});
	it('nothing on show draws nothing', () => {
		hudDocs.set({});
		drawn.length = 0;
		expect(drawHudOver(ctx, 640, 360)).toMatchObject({ drawn: 0, screens: [] });
	});
	it('view camera needs exactly one camera uuid and takes no from / free camera', () => {
		expect(planShot({ view: 'camera' }, 16 / 9).problem).toMatch(/one camera/);
		expect(planShot({ view: 'camera', uuid: 'c', from: 'top' }, 16 / 9).problem).toMatch(/leave camera and from out/);
		const ok = planShot({ view: 'camera', uuid: 'c', aspect: '16:9', size: 640 }, 1);
		expect(ok).toMatchObject({ problem: null, view: 'camera', current: false, w: 640, h: 360 });
	});
});
