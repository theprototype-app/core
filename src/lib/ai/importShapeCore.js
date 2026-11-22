// mcp-diorama2 (item 9) — create_shape {action: "import"}'s pure half (imports only the pure GLB check): what a
// model file IS, read from its bytes, never from its name or a server's Content-Type. glTF 2.0 binary (GLB),
// glTF 2.0 JSON with every buffer and image embedded as a data: URI, or Wavefront OBJ text. A model is DATA:
// nothing in one runs, and the only way a file could reach outside itself is a uri, so every uri must be an
// embedded buffer or a raster image (no SVG, no HTML, no external address).

import { inspectGlb, MAX_IMPORT_BYTES } from './importModelCore.js';

export { MAX_IMPORT_BYTES };

/** the data: types an embedded glTF buffer / image may have */
const BUFFER_TYPES = ['application/octet-stream', 'application/gltf-buffer'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/ktx2'];

/** @param {any} json @returns {string | null} why its uris are refused */
export function uriRefusal(json) {
	const bad = /** @type {string[]} */ ([]);
	for (const b of json?.buffers ?? []) {
		if (typeof b?.uri !== 'string') continue;
		const t = /^data:([^;,]*)[;,]/i.exec(b.uri)?.[1]?.toLowerCase();
		if (!t || !BUFFER_TYPES.includes(t)) bad.push(b.uri.slice(0, 60));
	}
	for (const i of json?.images ?? []) {
		if (typeof i?.uri !== 'string') continue;
		const t = /^data:([^;,]*)[;,]/i.exec(i.uri)?.[1]?.toLowerCase();
		if (!t || !IMAGE_TYPES.includes(t)) bad.push(i.uri.slice(0, 60));
	}
	if (!bad.length) return null;
	return (
		'the model is not self-contained: ' +
		bad.length +
		' buffer / image uri(s) point outside the file or are not an embedded buffer or PNG / JPEG / WebP image (' +
		bad.slice(0, 3).join(', ') +
		'). Export a single .glb, or a .gltf with everything embedded'
	);
}

/** the named parts a glTF would make (node names, capped) @param {any} json */
function gltfParts(json) {
	return (json?.nodes ?? []).map((/** @type {any} */ n) => String(n?.name ?? '')).filter(Boolean).slice(0, 200);
}

/**
 * What the bytes are. PURE.
 * @param {Uint8Array} b
 * @returns {{format: 'glb' | 'gltf' | 'obj', ext: string, mime: string, parts: string[], warnings: string[], generator?: string} | {error: string}}
 */
export function sniffModel(b) {
	if (!b || !b.length) return { error: 'the file is empty' };
	if (b.length > MAX_IMPORT_BYTES) return { error: 'the file is ' + (b.length / 1048576).toFixed(1) + ' MB — the limit is ' + MAX_IMPORT_BYTES / 1048576 + ' MB' };
	if (b.length >= 4 && b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46) {
		const glb = inspectGlb(b);
		if (!glb.ok) return { error: String(glb.error) };
		const refused = uriRefusal(glb.json);
		if (refused) return { error: refused };
		return { format: 'glb', ext: 'glb', mime: 'model/gltf-binary', parts: gltfParts(glb.json), warnings: [], generator: glb.generator };
	}
	// text from here on: a NUL in the first 4 KB is a binary file nobody here reads
	const head = b.subarray(0, 4096);
	if (head.includes(0)) return { error: 'not a model this takes: a .glb (binary glTF), a .gltf (glTF JSON, everything embedded) or an .obj (text)' };
	const text = new TextDecoder('utf-8', { fatal: false }).decode(b);
	const lead = text.replace(/^﻿/, '').trimStart();
	if (lead.startsWith('{')) {
		/** @type {any} */
		let json;
		try {
			json = JSON.parse(lead);
		} catch {
			return { error: 'the file starts like glTF JSON but is not valid JSON' };
		}
		if (!/^2\./.test(String(json?.asset?.version ?? ''))) return { error: 'only glTF 2.0 is supported (asset.version "2.0")' };
		const refused = uriRefusal(json);
		if (refused) return { error: refused };
		return { format: 'gltf', ext: 'gltf', mime: 'model/gltf+json', parts: gltfParts(json), warnings: [], generator: String(json.asset?.generator ?? '') };
	}
	const vertex = /^\s*v\s+[-+.\d]/m.test(text);
	const face = /^\s*f\s+\S/m.test(text);
	if (!vertex || !face) return { error: 'not a model this takes: a .glb, a .gltf (glTF 2.0 JSON) or an .obj with v and f lines' };
	/** @type {string[]} */
	const parts = [];
	for (const m of text.matchAll(/^\s*[og]\s+(.+?)\s*$/gm)) if (parts.length < 200 && !parts.includes(m[1])) parts.push(m[1]);
	/** @type {string[]} */
	const warnings = [];
	if (/^\s*mtllib\s/m.test(text)) warnings.push('the .obj names a material library (.mtl) that is not inside it: its parts get plain materials — set colours with set_material');
	return { format: 'obj', ext: 'obj', mime: 'model/obj', parts, warnings };
}
