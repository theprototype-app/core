// @ts-nocheck — fixtures built ad hoc (the checkJs rule for test fixtures)
// mcp-diorama2 (item 9): create_shape {action: "import"} reads WHAT a model file is from its bytes — GLB, glTF JSON
// with everything embedded, or OBJ text — and refuses anything that points outside itself or is not a model.
import { describe, it, expect } from 'vitest';
import { sniffModel, uriRefusal, MAX_IMPORT_BYTES } from '../../src/lib/ai/importShapeCore.js';

const enc = (s) => new TextEncoder().encode(s);

/** a GLB holding `json` (JSON chunk only) */
function glb(json) {
	const body = enc(JSON.stringify(json));
	const pad = (4 - (body.length % 4)) % 4;
	const len = 12 + 8 + body.length + pad;
	const out = new Uint8Array(len);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, 0x46546c67, true);
	dv.setUint32(4, 2, true);
	dv.setUint32(8, len, true);
	dv.setUint32(12, body.length + pad, true);
	dv.setUint32(16, 0x4e4f534a, true);
	out.set(body, 20);
	out.fill(0x20, 20 + body.length);
	return out;
}

const gltf = { asset: { version: '2.0', generator: 'test' }, nodes: [{ name: 'Body' }, { name: 'Lid' }], buffers: [{ byteLength: 4, uri: 'data:application/octet-stream;base64,AAAAAA==' }] };

describe('diorama2 import: sniffModel', () => {
	it('a GLB with embedded data is a glb, and its node names are the parts', () => {
		const r = sniffModel(glb(gltf));
		expect(r.format).toBe('glb');
		expect(r.parts).toEqual(['Body', 'Lid']);
	});

	it('glTF JSON with everything embedded is a gltf; another version or bad JSON is refused', () => {
		expect(sniffModel(enc(JSON.stringify(gltf))).format).toBe('gltf');
		expect(sniffModel(enc(JSON.stringify({ asset: { version: '1.0' } }))).error).toMatch(/2\.0/);
		expect(sniffModel(enc('{ nope')).error).toMatch(/not valid JSON/);
	});

	it('an external buffer, an external image or an SVG data: image is refused (nothing outside the file, nothing that runs)', () => {
		expect(sniffModel(glb({ ...gltf, buffers: [{ byteLength: 4, uri: 'https://example.com/a.bin' }] })).error).toMatch(/self-contained/);
		expect(sniffModel(enc(JSON.stringify({ ...gltf, images: [{ uri: 'tex.png' }] }))).error).toMatch(/self-contained/);
		expect(uriRefusal({ images: [{ uri: 'data:image/svg+xml;base64,PHN2Zz4=' }] })).toMatch(/PNG/);
		expect(uriRefusal({ images: [{ uri: 'data:image/png;base64,iVBO' }], buffers: [{ uri: 'data:application/gltf-buffer;base64,AA==' }] })).toBe(null);
	});

	it('OBJ text with v and f lines is an obj; o / g names are the parts; an mtllib is warned about', () => {
		const r = sniffModel(enc('mtllib box.mtl\no Base\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\ng Lid\nv 0 0 1\nf 1 2 4\n'));
		expect(r.format).toBe('obj');
		expect(r.parts).toEqual(['Base', 'Lid']);
		expect(r.warnings[0]).toMatch(/material library/);
	});

	it('anything else is refused by its bytes, whatever its name: binary, an image, text that is not a model, too big', () => {
		expect(sniffModel(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])).error).toMatch(/not a model/);
		expect(sniffModel(enc('<html><script>alert(1)</script></html>')).error).toMatch(/not a model/);
		expect(sniffModel(new Uint8Array(0)).error).toMatch(/empty/);
		expect(sniffModel(new Uint8Array(MAX_IMPORT_BYTES + 1)).error).toMatch(/limit/);
	});
});
