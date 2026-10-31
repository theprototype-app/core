// 57 M4 — is a file a VRM? A LEAF (no three-vrm): the import path asks before deciding which parser
// (and so which lazy chunk) a model needs. A .vrm is a GLB; a VRM renamed to .glb still names the
// VRM extension in its JSON chunk (VRMC_vrm = VRM 1.0, VRM = 0.x).

/** @param {ArrayBuffer} buffer */
export function glbIsVrm(buffer) {
	try {
		const dv = new DataView(buffer);
		if (dv.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) return false;
		const len = dv.getUint32(12, true);
		if (20 + len > dv.byteLength) return false;
		const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, len)));
		const used = Array.isArray(json.extensionsUsed) ? json.extensionsUsed : [];
		return used.includes('VRMC_vrm') || used.includes('VRM');
	} catch {
		return false;
	}
}
