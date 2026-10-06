// 38 R8 (NOTES-38 #4): the play banner is scene data in the play block, absent at its default
import { describe, it, expect } from 'vitest';
import { normalizePlayBanner, normalizeScenePhysics } from '../../src/lib/scenePhysics.js';

describe('play banner', () => {
	it('the default (show the hint) is never written', () => {
		expect(normalizePlayBanner(undefined)).toBe(null);
		expect(normalizePlayBanner({ mode: 'hint' })).toBe(null);
		expect('banner' in normalizeScenePhysics({}).play).toBe(false);
	});
	it('hide and custom text survive a normalize, text capped at 80', () => {
		expect(normalizeScenePhysics({ play: { banner: { mode: 'hide', text: 'x' } } }).play.banner).toEqual({ mode: 'hide' });
		const long = 'a'.repeat(120);
		expect(normalizePlayBanner({ mode: 'custom', text: long })).toEqual({ mode: 'custom', text: 'a'.repeat(80) });
		expect(normalizePlayBanner({ mode: 'custom', text: 5 })).toEqual({ mode: 'custom', text: '' });
	});
});
