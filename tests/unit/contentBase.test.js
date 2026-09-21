import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contentBase } from '../../src/lib/contentBase.js';

// 29f (core #230). Two things this module has to keep true, and neither is visible
// from a build that merely runs: the deploy-time override must WIN (it is how
// production was unblocked the day the feed went stale), and the default a build
// ships with NONE of the VITE_* vars set must be a ref jsDelivr will re-resolve.
//
// The second is the lesson of #230: jsDelivr parses a ref like `v2` as a SEMVER
// VERSION (`x-jsd-version-type: version`, `cache-control: immutable` for a year), so a
// retag of it is a no-op forever and a purge reports finished without re-resolving —
// the Games tab shipped three games while the feed had six. The refs are `format-N`
// now, and this test reads the two consumers' SOURCE so the literal they pass as the
// fallback can never drift back to a version-shaped name. The consumers themselves
// import svelte/store and the app's stores, which is why they are read as text here
// rather than imported (the unit layer's entry rule: modules that import nothing).

const SRC = resolve(__dirname, '../../src/lib');
/** what jsDelivr treats as a version: an optional v, then dotted digits and nothing else */
const SEMVER_LIKE = /^v?\d+(\.\d+)*$/;
const SCENES_DEFAULT = 'https://cdn.jsdelivr.net/gh/theprototype-app/scenes@format-2';
const PACKS_DEFAULT = 'https://cdn.jsdelivr.net/gh/theprototype-app/packs@format-1';

/** the string literal a consumer hands `contentBase()` as its fallback
 * @param {string} file @param {string} constName */
function fallbackOf(file, constName) {
	const src = readFileSync(resolve(SRC, file), 'utf8');
	const m = src.match(new RegExp('export const ' + constName + " = contentBase\\([^,]+, '([^']+)'\\)"));
	if (!m) throw new Error(constName + ' fallback literal not found in ' + file);
	return m[1];
}
/** the ref after the `@` of a jsDelivr gh url @param {string} url */
function refOf(url) {
	const m = url.match(/@([^/]+)$/);
	return m ? m[1] : '';
}

describe('contentBase', () => {
	it('an override wins, with a trailing slash trimmed so `${BASE}/index.json` never doubles it', () => {
		expect(contentBase('https://cdn.jsdelivr.net/gh/theprototype-app/scenes@main', SCENES_DEFAULT)).toBe(
			'https://cdn.jsdelivr.net/gh/theprototype-app/scenes@main'
		);
		expect(contentBase('https://example.test/scenes@dev/', SCENES_DEFAULT)).toBe('https://example.test/scenes@dev');
		expect(contentBase('https://example.test/scenes@dev///', SCENES_DEFAULT)).toBe('https://example.test/scenes@dev');
	});

	it('an absent override ships the pinned fallback byte-identically', () => {
		expect(contentBase(undefined, SCENES_DEFAULT)).toBe(SCENES_DEFAULT);
		expect(contentBase('', SCENES_DEFAULT)).toBe(SCENES_DEFAULT);
		expect(contentBase(null, PACKS_DEFAULT)).toBe(PACKS_DEFAULT);
		// vite substitutes an unset VITE_* with undefined, never with a non-string; a
		// non-string is still "absent" rather than a crash
		expect(contentBase(42, PACKS_DEFAULT)).toBe(PACKS_DEFAULT);
	});

	it('the scenes default is scenes@format-2 and the packs default is packs@format-1', () => {
		expect(fallbackOf('sceneTemplates.js', 'SCENES_BASE')).toBe(SCENES_DEFAULT);
		expect(fallbackOf('packs.js', 'PACKS_BASE')).toBe(PACKS_DEFAULT);
	});

	it('no shipped fallback names a ref jsDelivr would parse as a semver version (#230)', () => {
		for (const [file, name] of [
			['sceneTemplates.js', 'SCENES_BASE'],
			['packs.js', 'PACKS_BASE']
		]) {
			const ref = refOf(fallbackOf(file, name));
			expect(ref, name + ' has a ref').not.toBe('');
			expect(SEMVER_LIKE.test(ref), name + ' ref "' + ref + '" must not look like a version').toBe(false);
		}
		// the rule itself, pinned against the two names that bit: this is what the
		// assertion above would have refused before 29f
		expect(SEMVER_LIKE.test('v2')).toBe(true);
		expect(SEMVER_LIKE.test('v1')).toBe(true);
		expect(SEMVER_LIKE.test('2')).toBe(true);
		expect(SEMVER_LIKE.test('1.2.3')).toBe(true);
		expect(SEMVER_LIKE.test('format-2')).toBe(false);
		expect(SEMVER_LIKE.test('main')).toBe(false);
	});
});
