// 101 F2: scripts/check-loaders.cjs — three's generic loaders only through src/lib/loadGuard.js
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { hitsIn } = require('../../scripts/check-loaders.cjs');
const ROOT = path.resolve(__dirname, '../..');

describe('check-loaders', () => {
	it('finds a call, and skips comments', () => {
		expect(hitsIn('const o = new THREE.ObjectLoader().parse(x);')).toEqual([1]);
		expect(hitsIn('a\nloader.parseMaterials(m, t);')).toEqual([2]);
		expect(hitsIn('new MaterialLoader();')).toEqual([1]);
		expect(hitsIn('// new THREE.ObjectLoader()\n * ObjectLoader().parse\n/* new MaterialLoader() */')).toEqual([]);
		expect(hitsIn('/*\n new ObjectLoader()\n*/ ok()')).toEqual([]);
	});
	it('src/ is clean', () => {
		const out = execFileSync('node', [path.join(ROOT, 'scripts/check-loaders.cjs')], { encoding: 'utf8' });
		expect(out).toMatch(/clean/);
	});
});
