// P4 — the shipped POST-GRAPH presets, as pure DATA.
//
// They exist to PROVE THE SEAM rather than to be hardcoded effects: each one is an
// ordinary post graph a user could have built node by node in the editor, so anything a
// preset can do is something the domain can do, and "delete a node and see what changes"
// is how you learn the vocabulary. That is the plan's own reason for shipping posterise,
// ordered dithering, depth+normal edge detect and a custom AO variant specifically —
// between them they touch the scene colour, the pixel grid, the depth buffer and the
// normal buffer, which is every input the domain has.
//
// Imports NOTHING (the shaderCatalog / hudKinds precedent), so the shapes are testable
// with no browser and no GL context. Positions are AUTHORED rather than left to
// normalizeShaderGraph's fallback grid, because these are the first graphs most people
// will open and a readable left-to-right layout is part of the explanation.

/**
 * @typedef {{key: string, label: string, hint: string, doc: () => {nodes: any[], edges: any[], domain: 'post'}}} PostPreset
 */

/** @param {string} id @param {string} type @param {number} x @param {number} y @param {any} [data] */
const node = (id, type, x, y, data = {}) => ({ id, type, position: { x, y }, data });

/** @param {string} source @param {string} sourceHandle @param {string} target @param {string} targetHandle */
const edge = (source, sourceHandle, target, targetHandle) => ({
	// the editor's canonical id shape, handles included — the flow lane's lesson that an
	// id in any other shape does not survive a reconcile
	id: 'e-' + source + '.' + sourceHandle + '-' + target + '.' + targetHandle,
	source,
	sourceHandle,
	target,
	targetHandle
});

/** @type {PostPreset[]} */
export const POST_PRESETS = [
	{
		key: 'posterise',
		label: 'Posterise',
		hint: 'Snaps the frame into a few brightness steps — a flat, printed look.',
		doc: () => ({
			domain: 'post',
			nodes: [
				node('scene', 'sceneColor', 60, 120),
				node('steps', 'posterize', 280, 120, { steps: 5 }),
				node('out', 'postOutput', 520, 120)
			],
			edges: [edge('scene', 'rgb', 'steps', 'a'), edge('steps', 'out', 'out', 'color')]
		})
	},
	{
		key: 'dither',
		label: 'Ordered dither',
		hint: 'Posterise with a 4x4 Bayer pattern mixed in first, so the bands break into dots.',
		doc: () => ({
			domain: 'post',
			nodes: [
				node('scene', 'sceneColor', 60, 60),
				node('bayer', 'bayer', 60, 240, { scale: 1 }),
				// A CONSTANT IS A NODE. The arithmetic nodes take their operands from SOCKETS
				// and have no params at all, so authoring `{ b: 0.5 }` on one would be silently
				// ignored and the unwired socket's 0.0 used instead — a preset that looks
				// authored and does nothing. Every number here is a Float node on purpose.
				node('half', 'float', 60, 370, { value: 0.5 }),
				node('depth', 'float', 240, 440, { value: 0.18 }),
				// centre the threshold on zero, then scale it to about one posterise step —
				// that is what turns a hard band edge into a dot pattern rather than a shift
				node('centre', 'subtract', 300, 240),
				node('amount', 'multiply', 470, 240),
				node('mixed', 'add', 470, 60),
				node('steps', 'posterize', 650, 60, { steps: 4 }),
				node('out', 'postOutput', 830, 60)
			],
			edges: [
				edge('bayer', 'out', 'centre', 'a'),
				edge('half', 'out', 'centre', 'b'),
				edge('centre', 'out', 'amount', 'a'),
				edge('depth', 'out', 'amount', 'b'),
				edge('scene', 'rgb', 'mixed', 'a'),
				edge('amount', 'out', 'mixed', 'b'),
				edge('mixed', 'out', 'steps', 'a'),
				edge('steps', 'out', 'out', 'color')
			]
		})
	},
	{
		key: 'edges',
		label: 'Edge detect (ink)',
		hint: 'Draws a line wherever depth or surface direction breaks — silhouettes and creases.',
		doc: () => ({
			domain: 'post',
			nodes: [
				node('scene', 'sceneColor', 60, 60),
				node('ink', 'color', 60, 200, { value: '#101014' }),
				node('lines', 'edgeDetect', 60, 330, { depthWeight: 6, normalWeight: 1.4 }),
				node('mix', 'mix', 380, 160),
				node('out', 'postOutput', 620, 160)
			],
			edges: [
				edge('scene', 'rgb', 'mix', 'a'),
				edge('ink', 'out', 'mix', 'b'),
				edge('lines', 'out', 'mix', 't'),
				edge('mix', 'out', 'out', 'color')
			]
		})
	},
	{
		key: 'customao',
		label: 'Ambient occlusion (graph)',
		hint: 'A depth-only contact shading you can retune, as an alternative to the built-in AO pass.',
		doc: () => ({
			domain: 'post',
			nodes: [
				node('scene', 'sceneColor', 60, 60),
				node('ao', 'ambientOcclusion', 60, 220, { radius: 8, bias: 0.002 }),
				node('strength', 'float', 60, 360, { value: 0.85 }),
				node('scaled', 'multiply', 300, 260),
				node('light', 'oneMinus', 470, 260),
				node('shade', 'multiply', 640, 120),
				node('out', 'postOutput', 820, 120)
			],
			edges: [
				edge('ao', 'out', 'scaled', 'a'),
				edge('strength', 'out', 'scaled', 'b'),
				edge('scaled', 'out', 'light', 'a'),
				edge('scene', 'rgb', 'shade', 'a'),
				edge('light', 'out', 'shade', 'b'),
				edge('shade', 'out', 'out', 'color')
			]
		})
	}
];

/** The empty starting point the "New graph" entry creates: the frame, straight through. */
export function emptyPostGraph() {
	return {
		domain: /** @type {'post'} */ ('post'),
		nodes: [node('scene', 'sceneColor', 90, 130), node('out', 'postOutput', 400, 130)],
		edges: [edge('scene', 'rgb', 'out', 'color')]
	};
}

/** @param {string} key @returns {PostPreset|null} */
export function postPreset(key) {
	return POST_PRESETS.find((preset) => preset.key === key) ?? null;
}
