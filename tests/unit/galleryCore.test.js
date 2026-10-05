import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
	gallerySlug,
	normalizeTags,
	buildEntry,
	galleryRow,
	validateEntry,
	uploadUrl,
	editGalleryJsonUrl,
	submissionReadme,
	GALLERY_LICENSES,
	SCENE_CAP,
	THUMB_CAP
} from '../../src/lib/export/galleryCore.js';

// 36-share (B13): the community-gallery submission — the repo's README shape as code, and the
// repo's OWN CI run against what this produces (when the sibling checkout is there).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GALLERY = [process.env.COMMUNITY_GALLERY_DIR, path.resolve(HERE, '../../../community-gallery')].filter(Boolean).find((p) => fs.existsSync(path.join(/** @type {string} */ (p), 'scripts/validate.cjs')));

describe('slugs and tags', () => {
	it('slugs a title into the folder name the CI accepts', () => {
		expect(gallerySlug('Sky Castle!')).toBe('sky-castle');
		expect(gallerySlug('  Ça va? Été  ')).toBe('ca-va-ete');
		expect(gallerySlug('!!!')).toBe('scene');
		expect(gallerySlug('x'.repeat(80))).toHaveLength(48);
		expect(gallerySlug('a-'.repeat(30))).not.toMatch(/-$/);
	});
	it('normalizes tags: dashed, unique, at most 6', () => {
		expect(normalizeTags('Nature, showcase, nature, Sci Fi')).toEqual(['nature', 'showcase', 'sci-fi']);
		expect(normalizeTags(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toHaveLength(6);
		expect(normalizeTags(', ,!!,')).toEqual([]);
	});
});

describe('entry + row', () => {
	const entry = buildEntry({ title: ' Sky castle ', author: '@AlexZ005', license: 'CC0-1.0', description: 'Floating towers.', tags: 'building, showcase', appVersion: '1.24.0', created: new Date('2026-10-05T12:00:00Z') });
	it('writes entry.json in README order with the @ dropped', () => {
		expect(Object.keys(entry)).toEqual(['title', 'author', 'license', 'description', 'tags', 'appVersion', 'created']);
		expect(entry).toMatchObject({ title: 'Sky castle', author: 'AlexZ005', created: '2026-10-05', tags: ['building', 'showcase'] });
	});
	it('the row puts slug first, then the entry, then the repo paths + bytes', () => {
		const row = galleryRow('sky-castle', entry, { thumbName: 'thumb.webp', bytes: 4705 });
		expect(Object.keys(row)[0]).toBe('slug');
		expect(row).toMatchObject({ scene: 'sky-castle/scene.tpscene', thumb: 'sky-castle/thumb.webp', bytes: 4705, license: 'CC0-1.0' });
	});
	it('refuses what the gallery CI refuses', () => {
		expect(validateEntry('sky-castle', entry)).toEqual([]);
		expect(validateEntry('Sky Castle', entry)).toHaveLength(1);
		expect(validateEntry('ok', { ...entry, title: '' })).toEqual(['Give it a title.']);
		expect(validateEntry('ok', { ...entry, title: 'x'.repeat(81) })[0]).toMatch(/80/);
		expect(validateEntry('ok', { ...entry, author: '' })[0]).toMatch(/GitHub handle/);
		expect(validateEntry('ok', { ...entry, author: 'two words' })[0]).toMatch(/GitHub handle/);
		expect(validateEntry('ok', { ...entry, license: 'GPL-3.0' })[0]).toMatch(/license/);
		expect(validateEntry('ok', { ...entry, description: 'x'.repeat(301) })[0]).toMatch(/300/);
		expect(validateEntry('ok', entry, { sceneBytes: SCENE_CAP + 1 })[0]).toMatch(/25 MB/);
		expect(validateEntry('ok', entry, { thumbBytes: THUMB_CAP + 1 })[0]).toMatch(/512 KB/);
	});
	it('every license the UI offers is in the CI allowlist', () => {
		expect(GALLERY_LICENSES.map((l) => l.id)).toEqual(['CC0-1.0', 'CC-BY-4.0', 'MIT']);
	});
	it('links point at GitHub pages the person opens (upload into the slug folder, edit gallery.json)', () => {
		expect(uploadUrl('sky-castle')).toBe('https://github.com/theprototype-app/community-gallery/upload/main/sky-castle');
		expect(editGalleryJsonUrl()).toBe('https://github.com/theprototype-app/community-gallery/edit/main/gallery.json');
		expect(submissionReadme('sky-castle', 'thumb.webp')).toContain('upload/main/sky-castle');
	});
});

describe.skipIf(!GALLERY)('the gallery repo CI accepts a generated submission', () => {
	it('validate.cjs: ALL PASS after adding the folder + row; FAIL with a bad license', () => {
		const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-gallery-'));
		const dir = /** @type {string} */ (GALLERY);
		fs.cpSync(dir, work, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
		const scene = Buffer.from('PK\u0005\u0006' + '\u0000'.repeat(18), 'binary'); // an empty zip
		const thumb = fs.readFileSync(path.join(dir, 'campfire-camp/thumb.webp'));
		const write = (/** @type {any} */ entry) => {
			const slug = 'sky-castle';
			fs.mkdirSync(path.join(work, slug), { recursive: true });
			fs.writeFileSync(path.join(work, slug, 'scene.tpscene'), scene);
			fs.writeFileSync(path.join(work, slug, 'thumb.webp'), thumb);
			fs.writeFileSync(path.join(work, slug, 'entry.json'), JSON.stringify(entry, null, '\t') + '\n');
			const gallery = JSON.parse(fs.readFileSync(path.join(dir, 'gallery.json'), 'utf8'));
			gallery.entries.push(galleryRow(slug, entry, { thumbName: 'thumb.webp', bytes: scene.length }));
			fs.writeFileSync(path.join(work, 'gallery.json'), JSON.stringify(gallery, null, '\t') + '\n');
		};
		const run = () => {
			try {
				return { code: 0, out: execFileSync('node', [path.join(work, 'scripts/validate.cjs')], { encoding: 'utf8' }) };
			} catch (e) {
				return { code: /** @type {any} */ (e).status, out: String(/** @type {any} */ (e).stdout) };
			}
		};
		const good = buildEntry({ title: 'Sky castle', author: 'AlexZ005', license: 'CC-BY-4.0', description: 'Floating towers.', tags: ['building'], appVersion: '1.24.0' });
		write(good);
		const ok = run();
		expect(ok.out).toContain('ALL PASS');
		expect(ok.code).toBe(0);
		// the counterfactual: a license the app never offers is refused by the same CI
		write({ ...good, license: 'GPL-3.0' });
		const bad = run();
		expect(bad.code).toBe(1);
		expect(bad.out).toMatch(/FAIL entry "sky-castle": license/);
		fs.rmSync(work, { recursive: true, force: true });
	});
});
