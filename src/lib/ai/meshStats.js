// mcp-shapes — list_scene's per-mesh size facts (imports nothing: it reads the object's own geometry and matrix).

/** @param {number} n */
const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * mcp-shapes: a mesh's size facts for list_scene — vertexCount, faceCount (triangles) and its bounding box in its own
 * space (`local`, the vertices as given) and in the scene (`world`), each [[minX, minY, minZ], [maxX, maxY, maxZ]].
 * Meshes only; nothing for groups, lights or cameras. Call `updateMatrixWorld` on the scene first.
 * @param {any} object @returns {any}
 */
export function meshStats(object) {
	const geometry = object?.isMesh ? object.geometry : null;
	const position = geometry?.attributes?.position;
	if (!position) return null;
	if (!geometry.boundingBox) geometry.computeBoundingBox();
	const box = geometry.boundingBox;
	if (!box || box.isEmpty()) return { vertexCount: position.count, faceCount: 0 };
	const world = box.clone().applyMatrix4(object.matrixWorld);
	const pair = (/** @type {any} */ b) => [b.min.toArray().map(r3), b.max.toArray().map(r3)];
	return {
		vertexCount: position.count,
		faceCount: Math.floor((geometry.index ? geometry.index.count : position.count) / 3),
		bounds: { local: pair(box), world: pair(world) }
	};
}
