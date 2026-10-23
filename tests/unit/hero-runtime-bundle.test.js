import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { bundleHeroRuntime } = createRequire(import.meta.url)('../../scripts/hero-runtime.cjs');

// 65 M7: the website section runtime is bundled into ONE self-contained IIFE string — no imports left,
// anime.js inside it, small enough to ship beside the frames.
describe('virtual:tp-hero-runtime', () => {
	it('is a self-contained IIFE exposing TPHero.mount, small', async () => {
		const { code, files } = await bundleHeroRuntime();
		expect(code).toMatch(/^var TPHero\s*=/);
		expect(code).not.toMatch(/\bimport\s*[({'"]|\brequire\(/);
		expect(files.some((f) => f.endsWith('heroMath.js'))).toBe(true);
		const g = /** @type {any} */ ({});
		new Function(code + ';this.TPHero=TPHero').call(g);
		expect(typeof g.TPHero.mount).toBe('function');
		// no document (node): mounts nothing rather than throwing
		expect(g.TPHero.mount({ frames: ['x'] }, null)).toBe(null);
		expect(code.length).toBeLessThan(60_000);
	});
});
