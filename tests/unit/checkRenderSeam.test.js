// 101 F3: the CI gate — no renderer / render target is made outside src/lib/render/.
import { describe, test, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { scan, PATTERN } = require('../../scripts/check-render-seam.cjs');

describe('renderer seam gate (101 F3)', () => {
	test('the pattern catches every spelling the brief names', () => {
		for (const s of ['new THREE.WebGLRenderer({', 'new WebGLRenderer(', 'new THREE.WebGLRenderTarget(1, 1)', 'new WebGLRenderTarget(w, h)']) expect(PATTERN.test(s), s).toBe(true);
		for (const s of ['createRenderTarget(1, 1)', 'WebGLRenderTarget,', 'new THREE.WebGLCubeRenderTarget(8)']) expect(PATTERN.test(s), s).toBe(false);
	});
	test('src/ makes none outside the seam', () => expect(scan()).toEqual([]));
});
