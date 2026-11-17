// 101 F5: battery.json `gpu` tags — a suite is renderer-neutral only when it never screenshots or
// reads pixels; the stored tags match what the classifier says today.
import { describe, test, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { classify, PIXELS } = require('../../scripts/ci/gpu-neutral-suites.cjs');

describe('renderer-neutral suites (101 F5)', () => {
	test('the pixel patterns catch the ways a suite takes or reads a picture', () => {
		for (const s of ['page.screenshot(', 'h.grabFrame(A)', 'h.frameDelta(', 'ctx.getImageData(', 'canvas.toDataURL()', 'captureThroughCamera(']) expect(PIXELS.test(s), s).toBe(true);
		expect(PIXELS.test("await page.click('#x')")).toBe(false);
	});
	// the SAFE direction only: a suite tagged neutral that now takes a picture fails; an untagged
	// neutral suite (a lane added one and did not rerun the script) is merely run twice later
	test('every suite tagged "gpu": false is still renderer-neutral', () => {
		const battery = JSON.parse(fs.readFileSync('tests/e2e/battery.json', 'utf8'));
		const neutral = new Set(classify().neutral);
		const stale = Object.keys(battery.gpu ?? {}).filter((n) => !neutral.has(n));
		expect(stale, 'rerun node scripts/ci/gpu-neutral-suites.cjs --write').toEqual([]);
		expect(Object.keys(battery.gpu ?? {}).length).toBeGreaterThan(300);
		expect(Object.values(battery.gpu).every((v) => v === false)).toBe(true);
		for (const name of Object.keys(battery.gpu)) expect(battery.suites[name], name).toBeTypeOf('number');
	});
	test('a suite that screenshots is never tagged', () => {
		const battery = JSON.parse(fs.readFileSync('tests/e2e/battery.json', 'utf8'));
		expect(battery.gpu['render-seam']).toBeUndefined();
	});
});
