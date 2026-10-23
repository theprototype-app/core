// 56 C9 — import_model's gate: only a complete, SELF-CONTAINED binary glTF 2.0 gets in.
// Counterfactuals: the same fixture with a buffer / image pointing outside the file, a .gltf (JSON),
// a truncated file and a glTF 1 header are each refused with a reason.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspectGlb, MAX_IMPORT_BYTES } from '../../src/lib/ai/importModelCore.js';

const glb = new Uint8Array(readFileSync(fileURLToPath(new URL('../e2e/fixtures/campfire-named.glb', import.meta.url))));

/** rebuild a GLB with an edited JSON chunk @param {(json: any) => void} edit */
function withJson(edit) {
	const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
	const jsonLen = dv.getUint32(12, true);
	const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
	edit(json);
	let text = JSON.stringify(json);
	while (text.length % 4) text += ' ';
	const jsonBytes = new TextEncoder().encode(text);
	const rest = glb.subarray(20 + jsonLen);
	const out = new Uint8Array(20 + jsonBytes.length + rest.length);
	out.set(glb.subarray(0, 12));
	const odv = new DataView(out.buffer);
	odv.setUint32(8, out.length, true);
	odv.setUint32(12, jsonBytes.length, true);
	odv.setUint32(16, 0x4e4f534a, true);
	out.set(jsonBytes, 20);
	out.set(rest, 20 + jsonBytes.length);
	return out;
}

describe('inspectGlb', () => {
	it('accepts the named campfire fixture and counts its nodes', () => {
		const r = inspectGlb(glb);
		expect(r.ok).toBe(true);
		expect(r.nodes).toBe(8); // Campfire, Logs, Log_1..3, Flame_Pivot, Flame, Socket_Pot
		expect(r.json.nodes.map((/** @type {any} */ n) => n.name)).toContain('Socket_Pot');
	});
	it('refuses an external buffer URI (counterfactual)', () => {
		const bad = withJson((j) => (j.buffers[0].uri = 'campfire.bin'));
		const r = inspectGlb(bad);
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/not self-contained/);
	});
	it('refuses an external image URI, allows a data: one', () => {
		expect(inspectGlb(withJson((j) => (j.images = [{ uri: 'https://example.com/tex.png' }]))).ok).toBe(false);
		expect(inspectGlb(withJson((j) => (j.images = [{ uri: 'data:image/png;base64,AAAA' }]))).ok).toBe(true);
	});
	it('refuses a .gltf (JSON), a truncated file and glTF 1', () => {
		expect(inspectGlb(new TextEncoder().encode('{"asset":{"version":"2.0"}}' + ' '.repeat(20))).error).toMatch(/not a GLB/);
		expect(inspectGlb(glb.subarray(0, glb.length - 10)).error).toMatch(/truncated/);
		const v1 = glb.slice();
		new DataView(v1.buffer).setUint32(4, 1, true);
		expect(inspectGlb(v1).error).toMatch(/2\.0/);
		expect(inspectGlb(new Uint8Array(4)).ok).toBe(false);
	});
	it('the cap is the Explorer import cap', () => {
		expect(MAX_IMPORT_BYTES).toBe(25 * 1024 * 1024);
	});
});
