import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import notices from '../../scripts/third-party-notices.cjs';

// 48 F3 — the licence notices page is generated from what the app is built from. The proof the user asked for:
// libheif-js (LGPL-3.0, the HEIC decoder) + three + EVERY runtime dependency are listed, each with its licence.

const list = notices.collectNotices();
const byName = new Map(list.map((n) => [n.name, n]));
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));

describe('48 F3: third-party notices', () => {
	it('lists libheif-js as LGPL-3.0 with its full licence text', () => {
		const heif = byName.get('libheif-js');
		expect(heif?.license).toMatch(/LGPL-3\.0/);
		expect(heif?.text).toMatch(/GNU LESSER GENERAL PUBLIC LICENSE/);
		expect(heif?.version).toBe(JSON.parse(fs.readFileSync('node_modules/libheif-js/package.json', 'utf8')).version);
	});

	it('lists three (MIT) with its licence text', () => {
		const three = byName.get('three');
		expect(three?.license).toBe('MIT');
		expect(three?.text).toMatch(/Permission is hereby granted/);
	});

	it('lists every runtime dependency in package.json', () => {
		const missing = Object.keys(pkg.dependencies).filter((name) => !byName.has(name));
		expect(missing).toEqual([]);
	});

	it('lists every production package of the lockfile (bar Node-only platform binaries)', () => {
		const want = Object.entries(lock.packages)
			.filter(([k, v]) => k && !v.dev && !v.devOptional && !v.link && !v.os && !v.cpu && fs.existsSync(k + '/package.json'))
			.map(([k]) => JSON.parse(fs.readFileSync(k + '/package.json', 'utf8')).name);
		const missing = [...new Set(want)].filter((name) => !byName.has(name));
		expect(missing).toEqual([]);
	});

	it('lists every package src/ imports (svelte and the kit ship in the bundle from devDependencies)', () => {
		const imported = [...notices.importedPackages('.')].filter((name) => fs.existsSync('node_modules/' + name + '/package.json'));
		expect(imported.length).toBeGreaterThan(20);
		expect(imported.filter((name) => !byName.has(name))).toEqual([]);
		for (const name of ['svelte', '@sveltejs/kit', '@xyflow/svelte', 'tailwindcss']) expect(byName.has(name), name).toBe(true);
	});

	it('every entry names a licence; the vendored static files are there too', () => {
		expect(list.filter((n) => !n.license || n.license === 'UNKNOWN' && !n.text).map((n) => n.name)).toEqual([]);
		for (const v of notices.VENDORED) expect(byName.has(v.name), v.name).toBe(true);
		expect(byName.get('IBM Plex Sans / Mono')?.text).toMatch(/SIL OPEN FONT LICENSE/i);
	});

	it('renders a page naming every component, with the LGPL note', () => {
		const html = notices.renderHtml(list, { version: '9.9.9' });
		for (const n of list) expect(html).toContain(`data-name="${n.name.replace(/&/g, '&amp;')}"`);
		expect(html).toContain('id="lgpl-note"');
		expect(html).toMatch(/<title>Third-party licences — theprototype\.app 9\.9\.9<\/title>/);
		expect(notices.packageOf('@scope/pkg/deep/file.js')).toBe('@scope/pkg');
		expect(notices.packageOf('three/examples/jsm/x.js')).toBe('three');
		expect(notices.packageOf('$lib/x')).toBe(null);
		expect(notices.packageOf('./x')).toBe(null);
	});
});
