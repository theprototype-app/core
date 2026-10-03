import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fetchIndex, onContentStale, markContentStale } from '../../src/lib/contentBase.js';

// 1.19.1: "1.19.0 is out, why are the two new example levels not seen?" The CDN was
// right; the BROWSER was not. jsDelivr answers a branch ref (`scenes@format-2`,
// `packs@format-1`, `modules@main`) with `cache-control: max-age=604800`, and every
// index fetch used the default cache mode, so a device that had opened the tab in the
// last week kept the old list for up to seven days. Every CDN LIST now goes through
// `fetchIndex` (cache: 'no-cache' = revalidate; a 304 on the ETag when unchanged), and
// an app update drops the per-session index memos.
//
// The consumers import svelte/store and the app's stores, so (the unit layer's entry
// rule, see contentBase.test.js) they are read as SOURCE here; the helper itself is a
// leaf and runs for real against a stubbed fetch.

const SRC = resolve(__dirname, '../../src');
/** @param {string} file */
const source = (file) => readFileSync(resolve(SRC, file), 'utf8');

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe('fetchIndex', () => {
	it('fetches with cache: no-cache (revalidate), passing the url through', async () => {
		/** @type {any[]} */
		const calls = [];
		globalThis.fetch = /** @type {any} */ (
			async (/** @type {any} */ url, /** @type {any} */ init) => {
				calls.push([url, init]);
				return new Response('[]');
			}
		);
		const res = await fetchIndex('https://cdn.jsdelivr.net/gh/theprototype-app/scenes@format-2/index.json');
		expect(await res.json()).toEqual([]);
		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toBe('https://cdn.jsdelivr.net/gh/theprototype-app/scenes@format-2/index.json');
		expect(calls[0][1]?.cache).toBe('no-cache');
	});
});

describe('the CDN lists use fetchIndex', () => {
	// [file, the exact call that must be there] — one row per list the app reads off a
	// branch ref. Reverting any one of them to a bare fetch turns its row red.
	const SITES = [
		['lib/sceneTemplates.js', 'fetchIndex(`${SCENES_BASE}/index.json`)'],
		['lib/sceneTemplates.js', 'fetchIndex(GALLERY_JSON_URL)'],
		['lib/packs.js', 'fetchIndex(`${PACKS_BASE}/index.json`)'],
		['lib/packs.js', 'fetchIndex(pack.listUrl)'],
		['lib/moduleGallery.js', 'fetchIndex(`${MODULES_BASE}/index.json`)'],
		['lib/lodGroup.js', 'job = fetchIndex(url)'],
		['lib/userModules.js', "fetchIndex(base + '/manifest.json')"]
	];
	for (const [file, call] of SITES) {
		it(file + ' ' + call, () => {
			expect(source(file)).toContain(call);
		});
	}

	it('installUrl revalidates the files a manifest lists (they change in place on modules@main)', () => {
		expect(source('lib/userModules.js')).toContain("fetch(base + '/' + path, { cache: 'no-cache' })");
	});

	it('no bare fetch of a JSON under a content base anywhere in src', () => {
		/** @type {string[]} */
		const offenders = [];
		/** @param {string} dir */
		const walk = (dir) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (statSync(path).isDirectory()) walk(path);
				else if (/\.(js|ts|svelte)$/.test(name)) {
					const text = readFileSync(path, 'utf8');
					// fetch(`${SCENES_BASE}/index.json`) and friends: a list read with the
					// default cache mode is exactly the 1.19.0 bug
					const hits = text.match(/(?<![A-Za-z])fetch\(\s*`\$\{[A-Z_]+_BASE\}\/[^`]*\.json`/g);
					if (hits) offenders.push(path.slice(SRC.length + 1) + ': ' + hits.join(', '));
				}
			}
		};
		walk(SRC);
		expect(offenders).toEqual([]);
	});
});

describe('an app update drops the index memos', () => {
	it('markContentStale runs every handler, survives a throwing one, and unsubscribe works', () => {
		const seen = /** @type {string[]} */ ([]);
		const offA = onContentStale(() => seen.push('a'));
		const offBad = onContentStale(() => {
			throw new Error('boom');
		});
		const offB = onContentStale(() => seen.push('b'));
		markContentStale();
		expect(seen).toEqual(['a', 'b']);
		offA();
		markContentStale();
		expect(seen).toEqual(['a', 'b', 'b']);
		offBad();
		offB();
	});

	it('updateCheck marks content stale when it sees a new version', () => {
		const text = source('lib/updateCheck.js');
		const versionGuard = text.indexOf('remote.version === APP_VERSION) return;');
		const mark = text.indexOf('markContentStale()');
		expect(versionGuard).toBeGreaterThan(-1);
		// AFTER the "same version" early return, so only a real update drops the memos
		expect(mark).toBeGreaterThan(versionGuard);
	});

	it('the memoizing loaders register a stale handler that re-opens their memo', () => {
		const templates = source('lib/sceneTemplates.js');
		expect(templates).toMatch(/onContentStale\(\(\) => \{\s*templatesStale = true;\s*communityStale = true;/);
		expect(templates).toContain("if (!force && !templatesStale && (state === 'ready'");
		expect(templates).toContain("if (!force && !communityStale && (state === 'ready'");
		expect(source('lib/moduleGallery.js')).toMatch(/onContentStale\(\(\) => \{\s*loaded = false;/);
		expect(source('lib/packs.js')).toMatch(/onContentStale\(\(\) => \{\s*for \(const name of Object\.keys\(itemCache\)\) delete itemCache\[name\];/);
	});
});
