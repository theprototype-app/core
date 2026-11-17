#!/usr/bin/env node
// 101 F5 — which e2e suites are RENDERER-NEUTRAL: they never screenshot and never read pixels, so a
// later two-view run (roadmap 100: the standard view and Cinematic view) can run them once instead
// of twice. Writes battery.json `gpu` = { "<suite>": false } for each neutral suite in `suites`.
//
// CONSERVATIVE: a suite is neutral only when neither its own file nor any LOCAL module it requires
// (other than helpers.cjs, whose pixel helpers are matched by NAME at the call site) contains one
// of the pixel patterns below. A false "gpu" claim would make a two-view run skip a real check,
// so anything unclear stays GPU.
//   node scripts/ci/gpu-neutral-suites.cjs [--write]   (default: print the counts)
'use strict';
const fs = require('fs');
const path = require('path');

const E2E = path.join(__dirname, '..', '..', 'tests', 'e2e');
const BATTERY = path.join(E2E, 'battery.json');

/** anything that takes a picture or reads one back */
const PIXELS = /screenshot|grabFrame|centeredClip|frameDelta|framePixelsOffColor|pixelsOff|readPixels|readRenderTargetPixels|getImageData|toDataURL|toBlob\(|drawImage|captureThumbnail|captureThrough|captureThumb|captureMoment|eyeScreenshot|renderOffline|photoRender|startExport|imageData|PNG|png|\.jpe?g\b|recording|MediaRecorder|captureStream|decodeFrame|pixel/i;

/** @param {string} file @param {Set<string>} seen @returns {boolean} true = touches pixels */
function touchesPixels(file, seen = new Set()) {
	if (seen.has(file)) return false;
	seen.add(file);
	let src;
	try {
		src = fs.readFileSync(file, 'utf8');
	} catch {
		return true; // unreadable = unclear = GPU
	}
	if (PIXELS.test(src)) return true;
	for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
		const dep = path.resolve(path.dirname(file), m[1]);
		if (path.basename(dep) === 'helpers.cjs') continue;
		const resolved = fs.existsSync(dep) ? dep : fs.existsSync(dep + '.cjs') ? dep + '.cjs' : fs.existsSync(dep + '.js') ? dep + '.js' : null;
		if (!resolved || /\.json$/.test(resolved)) continue;
		if (touchesPixels(resolved, seen)) return true;
	}
	return false;
}

/** @returns {{ neutral: string[], gpu: string[], missing: string[] }} */
function classify() {
	const battery = JSON.parse(fs.readFileSync(BATTERY, 'utf8'));
	/** @type {string[]} */ const neutral = [];
	/** @type {string[]} */ const gpu = [];
	/** @type {string[]} */ const missing = [];
	for (const name of Object.keys(battery.suites).sort()) {
		const file = path.join(E2E, name + '.test.cjs');
		if (!fs.existsSync(file)) {
			missing.push(name);
			continue;
		}
		(touchesPixels(file) ? gpu : neutral).push(name);
	}
	return { neutral, gpu, missing };
}

if (require.main === module) {
	const out = classify();
	console.log(`renderer-neutral: ${out.neutral.length} · draws/reads pixels: ${out.gpu.length} · not a local suite: ${out.missing.length}`);
	if (process.argv.includes('--write')) {
		// TEXT edit, not a re-serialise: the file keeps its hand-made compact lines (merge-friendly)
		let text = fs.readFileSync(BATTERY, 'utf8').replace(/,\n\t"gpu": \{[^}]*\}/, '');
		const rows = out.neutral.map((n) => `\t\t${JSON.stringify(n)}: false`).join(',\n');
		const end = text.lastIndexOf('}');
		text = text.slice(0, end).replace(/\s*$/, '') + `,\n\t"gpu": {\n${rows}\n\t}\n}\n`;
		JSON.parse(text);
		fs.writeFileSync(BATTERY, text);
		console.log(`wrote battery.json gpu (${out.neutral.length} suites "gpu": false)`);
	}
}
module.exports = { classify, touchesPixels, PIXELS };
