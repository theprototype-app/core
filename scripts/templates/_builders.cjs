// Shared builders every template def authors through (34 R4 A3: split out of author-templates.cjs).

// ---- declarative scene definitions ------------------------------------------
// objects: {type:'box'|'cylinder'|'sphere'|'cone', name, color, pos, rot?, ...dims,
//           physics?} — physics = the userData.physics schema
//           {mode:'static'|'dynamic', mass, restitution, friction}.
const gray = { floor: 0x8b939c, block: 0xaab2bd, wall: 0x99a3ae, accent: 0xd97706 };

// ---- 24-A A3: the ONE graph builder every def authors its nodes through -----------
// Hoisted from towersGraph()/beatGraph(), which each carried a local copy (PR #192's
// review asked for this the moment a second game arrived). Byte-identical output: the
// `class: 'w-[150px]'`, the label rule (a programmatic node with no label renders a blank
// card) and the editor's CANONICAL edge id — `e-<source>[.<sourceHandle>]-<target>
// [.<targetHandle>]` (Nodes.svelte / hudActions.makeEdge) — which peer dedupe depends on.
// The E signature is the beat graph's superset: a Sequence step is a SOURCE handle, and a
// three-argument call (every Towers edge) produces exactly the id it always did.
function graphBuilder() {
	/** @type {any[]} */ const nodes = [];
	/** @type {any[]} */ const edges = [];
	/** every node gets a LABEL — a programmatic node with none renders a blank card.
	 * @param {string} id @param {string} type @param {string} label @param {number} x @param {number} y @param {any} data */
	const N = (id, type, label, x, y, data) => {
		nodes.push({ id, type, position: { x, y }, data: { label, ...data }, class: 'w-[150px]' });
		return id;
	};
	/** @param {string} source @param {string} target @param {string} [targetHandle] @param {string} [sourceHandle] */
	const E = (source, target, targetHandle, sourceHandle) => {
		edges.push({
			id: 'e-' + source + (sourceHandle ? '.' + sourceHandle : '') + '-' + target + (targetHandle ? '.' + targetHandle : ''),
			source,
			target,
			...(sourceHandle ? { sourceHandle } : {}),
			...(targetHandle ? { targetHandle } : {})
		});
	};
	return { N, E, nodes, edges, done: () => ({ nodes, edges }) };
}

module.exports = { gray, graphBuilder };
