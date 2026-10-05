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
		// 36 (U10): `data.type` too — every node card reads its spec through it
		nodes.push({ id, type, position: { x, y }, data: { label, type, ...data }, class: 'w-[150px]' });
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
	/**
	 * 36 (U10): a game's RULES — a behaviour node holding the rules file (`data.main: 1` marks the
	 * Main graph as authored, so the old-scene migration leaves it alone).
	 * @param {string} id @param {string} name @param {string} code @param {number} x @param {number} y @param {any} [extra]
	 */
	const B = (id, name, code, x, y, extra = {}) => {
		nodes.push({ id, type: 'behaviour', position: { x, y }, data: { label: 'Behaviour', type: 'behaviour', name, code, main: 1, ...extra }, class: 'w-[250px]' });
		return id;
	};
	/**
	 * 36 (U10): a node GROUP (N1) — a collapsed card standing for `children`; its routed sockets
	 * are derived from the wires crossing it when the template is authored (groupReconcile).
	 * @param {string} id @param {string} label @param {string[]} children @param {number} x @param {number} y
	 */
	const G = (id, label, children, x, y) => {
		nodes.push({ id, type: 'group', position: { x, y }, data: { label, type: 'group', children, inputs: [], outputs: [] }, class: 'w-[190px]' });
		return id;
	};
	/**
	 * 36 (U10): a NOTE (N1) — markdown explaining a part of the graph.
	 * @param {string} id @param {string} title @param {string} text @param {number} x @param {number} y
	 * @param {{w?: number, h?: number, color?: string}} [opts]
	 */
	const T = (id, title, text, x, y, opts = {}) => {
		nodes.push({ id, type: 'note', position: { x, y }, data: { title, text, color: opts.color ?? 'yellow', w: opts.w ?? 260, h: opts.h ?? 150, type: 'note' } });
		return id;
	};
	/**
	 * 36 (U10): a Script node v2 (custom code in the graph): declared inputs/outputs + its code.
	 * @param {string} id @param {string} name @param {string} code @param {any[]} inputs @param {any[]} outputs @param {number} x @param {number} y
	 */
	const S = (id, name, code, inputs, outputs, x, y) => {
		nodes.push({ id, type: 'script', position: { x, y }, data: { label: 'Script', type: 'script', name, code, inputs, outputs }, class: 'w-[200px]' });
		return id;
	};
	/** move already-made nodes (a block laid out relative to its own origin) @param {string[]} ids @param {number} dx @param {number} dy */
	const shift = (ids, dx, dy) => {
		for (const n of nodes) if (ids.includes(n.id)) n.position = { x: n.position.x + dx, y: n.position.y + dy };
	};
	return { N, E, B, G, T, S, shift, nodes, edges, done: () => ({ nodes, edges }) };
}

/** 36 (U10): a rules file beside the template (scripts/templates/rules/<name>) @param {string} name */
function rulesSource(name) {
	return require('fs').readFileSync(require('path').join(__dirname, 'rules', name), 'utf8');
}

module.exports = { gray, graphBuilder, rulesSource };
