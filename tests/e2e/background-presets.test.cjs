// 65 M2 — EVERY BACKGROUND PRESET LOADS AND COMPILES, with no browser. Reads the packs repo's
// `backgrounds/` set (BACKGROUNDS_DIR, else a sibling packs checkout) plus core's built-in,
// runs each through the app's own loader rules (backgroundPresetsCore) and compiler, and — when
// glslangValidator is installed — compiles the GLSL for real at BOTH budget tiers, wrapped the
// way three wraps a ShaderMaterial on WebGL2 (GLSL ES 3.00, gl_FragColor -> pc_fragColor).
//   node tests/e2e/background-presets.test.cjs
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

let failures = 0;
function check(ok, label) {
	console.log((ok ? 'PASS ' : 'FAIL ') + label);
	if (!ok) failures++;
}
const src = (f) => pathToFileURL(path.join(__dirname, '..', '..', 'src', 'lib', f)).href;

function packsDir() {
	const candidates = [
		process.env.BACKGROUNDS_DIR,
		path.join(__dirname, '..', '..', '..', 'packs-lane-65-visuals', 'backgrounds'),
		path.join(__dirname, '..', '..', '..', 'packs', 'backgrounds')
	].filter(Boolean);
	return candidates.find((d) => fs.existsSync(path.join(d, 'index.json'))) ?? null;
}

function glslang() {
	try {
		execFileSync('glslangValidator', ['--version'], { stdio: 'pipe' });
		return true;
	} catch {
		return false;
	}
}

(async () => {
	const { normalizePresetIndex, normalizePresetDoc, builtinPresetDoc, BUILTIN_PRESET_KEY } = await import(src('backgroundPresetsCore.js'));
	const { compileBackgroundGraphToIR } = await import(src('shaderCompile.js'));

	/** @type {{key: string, raw: any}[]} */
	const docs = [{ key: BUILTIN_PRESET_KEY, raw: builtinPresetDoc() }];
	const dir = packsDir();
	if (dir) {
		const index = normalizePresetIndex(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')));
		check(index.ok && index.presets.length >= 5, 'the packs index lists the five M2 presets: ' + index.presets.map((p) => p.key).join(', '));
		for (const want of ['mesh-gradient', 'silk-gradient', 'noise-flow', 'metaballs', 'grain-dither'])
			check(index.presets.some((p) => p.key === want), '  ...including ' + want);
		for (const p of index.presets) docs.push({ key: p.key, raw: JSON.parse(fs.readFileSync(path.join(dir, p.file), 'utf8')) });
	} else console.log('SKIP the packs presets: no backgrounds/ checkout (set BACKGROUNDS_DIR)');

	const real = glslang();
	if (!real) console.log('SKIP the real GLSL compile: glslangValidator not installed');
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-bg-'));
	for (const { key, raw } of docs) {
		const n = normalizePresetDoc(raw, key);
		check(n.ok, key + ' passes the loader');
		if (!n.ok) continue;
		const r = compileBackgroundGraphToIR(n.doc);
		check(r.ok, key + ' compiles to IR' + (r.ok ? '' : ': ' + r.errors));
		if (!r.ok) continue;
		check(r.ir.usesPointer, key + ' reads the pointer (every shipped preset reacts to it)');
		if (!real) continue;
		for (const low of [false, true]) {
			const glsl =
				'#version 300 es\nprecision highp float;\nprecision highp int;\n' +
				(low ? '#define TP_OCTAVE_CAP 2\n' : '') +
				'#define varying in\nout highp vec4 pc_fragColor;\n#define gl_FragColor pc_fragColor\n#define texture2D texture\n' +
				r.ir.fragment.replace('#include <colorspace_fragment>', '');
			const file = path.join(tmp, key + (low ? '-low' : '') + '.frag');
			fs.writeFileSync(file, glsl);
			let out = '';
			let ok = true;
			try {
				execFileSync('glslangValidator', [file], { stdio: 'pipe' });
			} catch (err) {
				ok = false;
				out = String(err.stdout || err.message);
			}
			check(ok, '  ' + key + ' is valid GLSL ES 3.00 at the ' + (low ? 'low' : 'high') + ' tier' + (ok ? '' : ': ' + out));
		}
	}
	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
	process.exit(failures ? 1 : 0);
})();
