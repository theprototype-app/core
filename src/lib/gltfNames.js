// fix-late-joiners — NAMES COME BACK AS WRITTEN. three's GLTFLoader runs every node name through
// PropertyBinding.sanitizeNodeName (spaces -> '_', '.', ':', '/', '[', ']' dropped) so an animation track can
// address it; the exporter wrote the name verbatim into the glTF JSON. So a late joiner, or an autosave
// restore, got "Gate_zone" for "Gate zone": every name-keyed thing (the code view, a flow that finds an
// object by name, the Objects list, an agent's list_scene) disagreed with the host. The loader's own
// `associations` map is the exact node index of each object, so the JSON's name is put back. A LEAF.

/**
 * @param {any} gltf a GLTFLoader result (needs `parser.associations`)
 * @param {any} json the glTF the result was parsed from (object or JSON text)
 * @returns {number} how many names changed
 */
export function restoreGltfNames(gltf, json) {
	const assoc = gltf?.parser?.associations;
	let doc = json;
	if (typeof doc === 'string') {
		try {
			doc = JSON.parse(doc);
		} catch {
			return 0;
		}
	}
	const nodes = doc?.nodes;
	if (!assoc || !Array.isArray(nodes) || !gltf?.scene?.traverse) return 0;
	let changed = 0;
	gltf.scene.traverse((/** @type {any} */ o) => {
		const index = assoc.get(o)?.nodes;
		const name = index === undefined ? undefined : nodes[index]?.name;
		if (typeof name === 'string' && name !== o.name) {
			o.name = name;
			changed++;
		}
	});
	return changed;
}
