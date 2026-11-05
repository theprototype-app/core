// @ts-nocheck — a vm sandbox built ad hoc
// 64-text: the vendored WOFF2 decoder (src/lib/vendor/wawoff2/decompress.js) — no eval under the CSP, and it really
// decodes when it runs the way a BROWSER runs it: strict mode, no `process` / `require` / `module`, a `window`. The
// npm package's own wrapper hung for ever in that environment (it only exported its Module under Node).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import opentype from 'opentype.js';

const ROOT = path.resolve(__dirname, '..', '..');
const FILE = path.join(ROOT, 'src/lib/vendor/wawoff2/decompress.js');

/** load the vendored module in a browser-shaped sandbox and return its loader */
function browserLoad() {
	const code = fs.readFileSync(FILE, 'utf8').replace('export default function loadWoff2', 'globalThis.loadWoff2 = function loadWoff2');
	const sandbox = {
		window: {},
		console,
		setTimeout,
		clearTimeout,
		WebAssembly,
		atob: (s) => Buffer.from(s, 'base64').toString('binary'),
		TextDecoder,
		Uint8Array,
		ArrayBuffer
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext('"use strict";\n' + code, sandbox, { filename: 'decompress.js' });
	expect(typeof sandbox.process).toBe('undefined');
	return sandbox.loadWoff2;
}

describe('vendored WOFF2 decoder', () => {
	it('carries no eval / Function (the CSP has no unsafe-eval)', async () => {
		const { scanNoEval } = await import('../../scripts/no-eval-scan.cjs');
		expect(scanNoEval(fs.readFileSync(FILE, 'utf8'))).toEqual([]);
	});

	it('decodes a WOFF2 to a font opentype reads, in a browser-shaped sandbox; the loader is shared', async () => {
		const load = browserLoad();
		const M = await load();
		expect(await load()).toBe(M);
		const woff2 = new Uint8Array(fs.readFileSync(path.join(ROOT, 'static/fonts/ibm-plex-sans-latin.woff2')));
		const out = M.decompress(woff2);
		expect(out).not.toBe(false);
		const ttf = new Uint8Array(out);
		expect([ttf[0], ttf[1], ttf[2], ttf[3]]).toEqual([0, 1, 0, 0]);
		const font = opentype.parse(ttf.buffer.slice(ttf.byteOffset, ttf.byteOffset + ttf.byteLength));
		expect(font.charToGlyph('O').index).toBeGreaterThan(0);
	});

	it('refuses bytes that are not WOFF2 (false, never a throw or a hang)', async () => {
		const M = await browserLoad()();
		expect(M.decompress(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(false);
	});
});
