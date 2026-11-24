// 64-vector-edit: the vector tools on 64-2d's 2D TOOLBAR (its contract: the header of src/lib/sprite2d/tools2d.js —
// default export = an array of {id, label, icon, order, title, run(ctx), active?, disarm?}). The toolbar finds this
// file by `import.meta.glob('../*/tools2d.js')`; without 64-2d in the build nothing imports it, so it costs nothing.
//   pen     order 20 — the pen on the active 2D layer's plane (ctx.plane.z), never the floor behind it
//   shapes  order 30 — rectangle / ellipse / star / polygon (the vector toolbar picks which), same plane
// The tools themselves are the lazy vectorTool chunk; this file holds only the rows and their lit state.
import { derived } from 'svelte/store';
import { vectorTool } from './vectorGate.js';

const tool = () => import('./vectorTool.js');
const SHAPES = ['rect', 'ellipse', 'star', 'polygon'];

/** @param {string} kind @param {any} ctx */
async function arm(kind, ctx) {
	ctx?.disarm?.();
	const m = await tool();
	m.armVectorTool(kind, { planeZ: Number(ctx?.plane?.z) || 0 });
}

export default [
	{
		id: 'pen',
		label: 'Pen',
		icon: 'pen-tool',
		order: 20,
		title: 'Pen — click for corners, drag for curves, click the first point to close; on the active layer',
		active: derived(vectorTool, (t) => t === 'pen'),
		run: (/** @type {any} */ ctx) => arm('pen', ctx),
		disarm: () => void tool().then((m) => m.disarmVectorTool())
	},
	{
		id: 'shapes',
		label: 'Shapes',
		icon: 'square-dashed', // a name Icon.svelte already has (no new boot icon)
		order: 30,
		title: 'Shapes — drag out a rectangle, ellipse, star or polygon (pick it in the shape bar); on the active layer',
		active: derived(vectorTool, (t) => !!t && SHAPES.includes(t)),
		run: (/** @type {any} */ ctx) => arm('rect', ctx),
		disarm: () => void tool().then((m) => m.disarmVectorTool())
	}
];
