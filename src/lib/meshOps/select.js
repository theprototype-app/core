// @ts-check
// Roadmap 99 K8 (lane 99-newops): SHORTEST-PATH SELECT on the op mesh — the kernel's search
// (meshKernel/shortestPath.js) in the editor's own selection currency: vertices are welded position keys,
// edges are welded key pairs ("ka|kb", sorted), faces are output triangles (a path face brings every
// triangle of its stored face, so a quad is picked whole). Read-only: it never edits the op mesh.
// Pure (no three.js, no stores).

import { shortestPath } from '../meshKernel/shortestPath.js';
import { NONE } from '../meshKernel/kernel.js';
import { pos, keyOfPos } from './rebuild.js';
import { verticesOfKeys } from './dissolve.js';
import { edgesOfKeys } from './bridgeFill.js';

/** @typedef {import('./opMesh.js').OpMesh} OpMesh */

/** the welded key pair of an edge, sorted (triFrame's edgeKey) @param {string} a @param {string} b */
const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

/**
 * @param {OpMesh} om @param {'vertex' | 'edge' | 'face'} kind
 * @param {string | number} from the active element: a vertex key, an edge key, or an output triangle
 * @param {string | number} to the clicked one, same currency
 * @param {{ topological?: boolean }} [options] count steps instead of length
 * @returns {{ keys?: string[], tris?: number[] } | null} the path from .. to (vertex / edge keys, or the triangles of
 *   every face on it, ascending); null when either end is not on the mesh or nothing connects them
 */
export function pathSelect(om, kind, from, to, options = {}) {
	const m = om.mesh;
	const opts = { topological: !!options.topological };
	if (kind === 'vertex') {
		const [a, b] = verticesOfKeys(om, [String(from), String(to)]);
		if (a === undefined || b === undefined || a < 0 || b < 0) return null;
		const path = a === b ? [a] : shortestPath(m, 'vertex', a, b, opts);
		return path ? { keys: path.map((v) => keyOfPos(pos(om, v))) } : null;
	}
	if (kind === 'edge') {
		const pairs = edgesOfKeys(om, [String(from), String(to)]);
		if (pairs.length < 2) return null;
		const ea = m.findEdge(pairs[0][0], pairs[0][1]);
		const eb = m.findEdge(pairs[1][0], pairs[1][1]);
		if (ea === NONE || eb === NONE) return null;
		const path = ea === eb ? [ea] : shortestPath(m, 'edge', ea, eb, opts);
		if (!path) return null;
		return {
			keys: path.map((e) => pairKey(keyOfPos(pos(om, m.eVert[e * 2])), keyOfPos(pos(om, m.eVert[e * 2 + 1]))))
		};
	}
	const ta = Number(from);
	const tb = Number(to);
	const { view } = om;
	if (!(ta >= 0 && ta < view.count && tb >= 0 && tb < view.count)) return null;
	const path = shortestPath(m, 'face', view.tFace[ta], view.tFace[tb], opts);
	if (!path) return null;
	// every triangle of every stored face the path crosses
	const groups = new Set(path.map((f) => om.logical[f]));
	/** @type {number[]} */
	const tris = [];
	for (let t = 0; t < view.count; t++) if (groups.has(om.logical[view.tFace[t]])) tris.push(t);
	return { tris };
}
