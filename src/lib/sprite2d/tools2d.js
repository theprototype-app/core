import { get, writable } from 'svelte/store';
import { objectsGroup, selectedObject, transformMode, orbitControls } from '../../stores/sceneStore';
import { view2d } from './view2d.js';

// 64-2d D6: THE 2D TOOLBAR'S TOOLS. Loaded with the toolbar (a lazy chunk), never at boot.
//
// A tool is DATA — {id, label, icon, order, title, run(ctx), active?} — the same shape for the
// built-ins below and for a FEATURE that adds its own: a lane drops a `tools2d.js` beside its
// code (`src/lib/<feature>/tools2d.js`, default export = an array of tools) and the toolbar finds
// it through `import.meta.glob`. A feature that is not in the build has no file, so its button
// does not exist: the toolbar has no dead buttons (64-vector adds pen + shapes, 64-extrude adds
// extrude). The glob is lazy too: a feature's tools load when the toolbar opens.
//
//   id      unique ('select', 'pen', 'shapes', 'text', 'extrude', 'layers' — the D6 list)
//   order   where it sits: select 10, pen 20, shapes 30, text 40, extrude 50, layers 60
//   icon    a Lucide name the Icon component knows (no emoji, owner rule)
//   run     (ctx) => void | Promise — the press. A tool that ARMS a mode lights itself through
//           `active` (a svelte Readable<boolean>), and must stand down when ctx.disarm() asks
//   disarm  () => void, optional — called when another tool is pressed (or the view closes)
//
// ctx (what a tool may use): { plane: {z}, center(): {x, y}, halfH(): number, exit(), disarm(),
// openLayers() }. `plane.z` is the z the active layer draws at (a new shape lands there).

/** @typedef {{id: string, label: string, icon: string, order: number, title?: string, run: (ctx: any) => any, active?: import('svelte/store').Readable<boolean>, disarm?: () => void}} Tool2d */

/** the Layers panel is open (the toolbar renders it) */
export const layersOpen = writable(false);

/** @type {Tool2d[]} */
export const BUILTIN_TOOLS = [
	{
		id: 'select',
		label: 'Select',
		icon: 'mouse-pointer-2',
		order: 10,
		title: 'Select and move — click a sprite or a layer, drag the arrows to move it in the plane',
		run: (ctx) => {
			ctx.disarm();
			transformMode.set('translate');
		}
	},
	{
		id: 'text',
		label: 'Text',
		icon: 'type',
		order: 40,
		title: 'Text — a text object in the middle of the view, on the active layer',
		run: async (ctx) => {
			ctx.disarm();
			const { spawnAtPoint } = await import('../addObjects.js');
			const c = ctx.center();
			spawnAtPoint('/create Text', [c.x, c.y, ctx.plane.z + 0.01]);
		}
	},
	{
		id: 'layers',
		label: 'Layers',
		icon: 'layers',
		order: 60,
		title: 'Layers — the 2D layers front to back: pick one, reorder, set its parallax',
		active: layersOpen,
		run: () => layersOpen.update((v) => !v)
	}
];

// FEATURE tools: every `src/lib/<feature>/tools2d.js` in the build (none is an empty object)
const FEATURE_TOOLS = import.meta.glob(['../*/tools2d.js', '!../sprite2d/tools2d.js']);

/** load every tool in the build, sorted @returns {Promise<Tool2d[]>} */
export async function loadTools() {
	/** @type {Tool2d[]} */
	const list = [...BUILTIN_TOOLS];
	const loaded = await Promise.allSettled(Object.values(FEATURE_TOOLS).map((load) => load()));
	for (const r of loaded) {
		if (r.status !== 'fulfilled') {
			console.warn('a 2D tool failed to load', r.reason);
			continue;
		}
		const tools = /** @type {any} */ (r.value)?.default;
		for (const t of Array.isArray(tools) ? tools : []) {
			if (t && typeof t.id === 'string' && typeof t.run === 'function' && !list.some((x) => x.id === t.id)) list.push(t);
		}
	}
	return list.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

/** @param {any} o */
const layerOf = (o) => (o?.userData?.layer2d && typeof o.userData.layer2d === 'object' ? o : null);

/** the 2D layers of the scene, FRONT first (higher z draws in front) @returns {any[]} */
export function layersFrontToBack() {
	/** @type {any[]} */
	const out = [];
	get(objectsGroup)?.traverse?.((/** @type {any} */ o) => {
		if (layerOf(o)) out.push(o);
	});
	return out.sort((a, b) => b.position.z - a.position.z || String(a.name).localeCompare(String(b.name)));
}

/** the layer new things land on: the selected object's layer, else the gameplay layer (parallax
 * 1), else z 0 @returns {any | null} */
export function activeLayer() {
	/** @type {any} */
	let o = get(selectedObject);
	while (o && !layerOf(o)) o = o.parent;
	if (o) return o;
	return layersFrontToBack().find((l) => Number(l.userData.layer2d.parallax ?? 1) === 1) ?? null;
}

/** the toolbar's ctx for a press (see the header) @param {{disarm: () => void, exit: () => void}} hooks */
export function toolContext(hooks) {
	const layer = activeLayer();
	return {
		plane: { z: layer ? (layer.updateWorldMatrix(true, false), layer.matrixWorld.elements[14]) : 0 },
		// where the flat view looks NOW (its controls' target; view2d holds it only between mounts)
		center: () => {
			/** @type {any} */
			const c = get(orbitControls);
			if (c?.__view2d && c.target) return { x: c.target.x, y: c.target.y };
			const v = get(view2d);
			return { x: v.x, y: v.y };
		},
		halfH: () => {
			/** @type {any} */
			const c = get(orbitControls);
			const zoom = c?.__view2d ? c.object?.zoom || 1 : 1;
			return get(view2d).halfH / zoom;
		},
		layer,
		disarm: hooks.disarm,
		exit: hooks.exit,
		openLayers: () => layersOpen.set(true)
	};
}
