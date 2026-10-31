// Roadmap 56 C9 — import_model's pure half (imports nothing): is this a GLB the app may import?
// Binary glTF 2.0, complete, and SELF-CONTAINED — no buffer or image pointing outside the file.

export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

/** a GLB's header + JSON chunk, or why it is refused. PURE. @param {Uint8Array} b */
export function inspectGlb(b) {
	if (!b || b.length < 20) return { ok: false, error: 'not a GLB: the file is too short' };
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	if (dv.getUint32(0, true) !== 0x46546c67) return { ok: false, error: 'not a GLB (binary glTF): the file does not start with "glTF". Export as .glb, not .gltf + separate files' };
	if (dv.getUint32(4, true) !== 2) return { ok: false, error: 'only glTF 2.0 GLBs are supported' };
	const length = dv.getUint32(8, true);
	if (length > b.length) return { ok: false, error: 'the GLB is truncated (header says ' + length + ' bytes, got ' + b.length + ')' };
	const jsonLen = dv.getUint32(12, true);
	if (dv.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLen > b.length) return { ok: false, error: 'the GLB has no JSON chunk' };
	/** @type {any} */
	let json;
	try {
		json = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + jsonLen)));
	} catch {
		return { ok: false, error: 'the GLB JSON chunk is not valid JSON' };
	}
	const external = [...(json.buffers ?? []), ...(json.images ?? [])].filter((x) => typeof x?.uri === 'string' && !x.uri.startsWith('data:'));
	if (external.length)
		return { ok: false, error: 'the GLB is not self-contained: it points at ' + external.length + ' external file(s) (' + external.map((x) => x.uri).slice(0, 3).join(', ') + '). Embed every buffer and texture (Blender: glTF Binary)' };
	const nodes = Array.isArray(json.nodes) ? json.nodes.length : 0;
	return { ok: true, json, nodes, meshes: Array.isArray(json.meshes) ? json.meshes.length : 0, animations: Array.isArray(json.animations) ? json.animations.length : 0, generator: String(json.asset?.generator ?? '') };
}

