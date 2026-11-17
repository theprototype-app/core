// 101 F2: scripts/check-loaders.cjs — three's generic loaders only through src/lib/loadGuard.js
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { hitsIn, gltfHitsIn } = require('../../scripts/check-loaders.cjs');
const ROOT = path.resolve(__dirname, '../..');

describe('check-loaders', () => {
	it('finds a call, and skips comments', () => {
		expect(hitsIn('const o = new THREE.ObjectLoader().parse(x);')).toEqual([1]);
		expect(hitsIn('a\nloader.parseMaterials(m, t);')).toEqual([2]);
		expect(hitsIn('new MaterialLoader();')).toEqual([1]);
		expect(hitsIn('// new THREE.ObjectLoader()\n * ObjectLoader().parse\n/* new MaterialLoader() */')).toEqual([]);
		expect(hitsIn('/*\n new ObjectLoader()\n*/ ok()')).toEqual([]);
	});
	it('a glTF parse needs a checkGltf( before it', () => {
		expect(gltfHitsIn("const loader = new GLTFLoader(m);\nloader.parse(b, '', r, j);")).toEqual([2]);
		expect(gltfHitsIn("if (!checkGltf(b)) throw x;\nconst loader = new GLTFLoader(m);\nloader.parse(b, '', r, j);")).toEqual([]);
		expect(gltfHitsIn("createGltfLoader(m).parse(b, '', r, j);")).toEqual([1]);
		expect(gltfHitsIn('const f = (() => {\n let l;\n return () => (l ??= createGltfLoader(m));\n})();\nf().parse(b);')).toEqual([5]);
		// another loader under a name a glTF loader used elsewhere in the file
		expect(gltfHitsIn("if (!checkGltf(b)) throw x;\nconst loader = new GLTFLoader(m);\nloader.parse(b);\n" + 'x;\n'.repeat(50) + 'const loader = new OBJLoader();\nloader.parse(t);')).toEqual([]);
		expect(gltfHitsIn('exporter.parse(x); JSON.parse(y); new OBJLoader().parse(t);')).toEqual([]);
		expect(gltfHitsIn("// new GLTFLoader(m).parse(b)")).toEqual([]);
	});
	it('src/ is clean', () => {
		const out = execFileSync('node', [path.join(ROOT, 'scripts/check-loaders.cjs')], { encoding: 'utf8' });
		expect(out).toMatch(/clean/);
	});
});
