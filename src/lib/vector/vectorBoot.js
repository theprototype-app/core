// 64-vector: the boot-time ROWS for vector shapes — the VR radial menu's Add ▸ Shapes and
// Selected ▸ Extrude, the Ctrl+K / Settings ▸ Shortcuts row for the draw tool, and the pen and
// Edit points keys (rebindable, `external`: vectorTool.js / vectorEdit.js read them through
// `bindingOf`). Every action is a dynamic import, so the tools themselves stay lazy chunks.
import { get } from 'svelte/store';
import { selectedObject, selectedObjects, objectsGroup } from '../../stores/sceneStore';
import { registerVRMenuEntry } from '../vrRadialMenu';
import { isVectorObject, toggleVectorTool } from './vectorGate.js';

const vr = () => import('./vectorVR.js');

registerVRMenuEntry({
	id: 'nav:vecshapes',
	group: 'add',
	label: 'Shapes',
	icon: 'pen-tool',
	order: 5.6,
	ring: 'vecshapes'
});
[
	['rect', 'Rectangle', 'square'],
	['ellipse', 'Ellipse', 'circle'],
	['star', 'Star', 'star'],
	['polygon', 'Polygon', 'hexagon']
].forEach(([kind, label, icon], order) =>
	registerVRMenuEntry({
		id: 'vec:add:' + kind,
		group: 'vecshapes',
		label,
		icon,
		order,
		closes: true,
		action: () => void vr().then((m) => m.spawnVectorAhead(kind))
	})
);
registerVRMenuEntry({
	id: 'vec:extrude',
	group: 'object',
	label: 'Extrude',
	icon: 'layers',
	order: 1.5,
	visible: () => isVectorObject(get(selectedObject)),
	value: () => {
		const d =
			/** @type {any} */ (get(selectedObject))?.userData?.geometryParams?.params?.depth ?? 0;
		return d > 0 ? `${Math.round(d * 100)} cm` : 'flat';
	},
	action: () => void vr().then((m) => m.stepExtrude())
});

/** the rows, exported for the unit test (the keys are the registry's defaults) */
export const VECTOR_SHORTCUTS = [
	{
		id: 'tools.draw-shapes',
		keys: 'Alt+V',
		group: 'Tools',
		scope: 'viewport',
		label: 'Draw shapes (rectangle, ellipse, star, polygon, pen)',
		action: () => void toggleVectorTool()
	},
	{
		id: 'vector.pen-finish',
		keys: 'Enter',
		group: 'Shapes',
		scope: 'vector',
		label: 'Pen: finish the open path',
		external: true
	},
	{
		id: 'vector.pen-undo',
		keys: 'Backspace',
		group: 'Shapes',
		scope: 'vector',
		label: 'Pen: remove the last point',
		external: true
	},
	{
		id: 'vector.point-delete',
		keys: 'Delete',
		group: 'Shapes',
		scope: 'vector',
		label: 'Edit points: delete the picked point',
		external: true
	}
];

// 64-extrude: one selected shape or text gets the extrude arrow (the chunk watches from then on and
// stops by itself when the selection moves on)
selectedObjects.subscribe((list) => {
	const id = Array.isArray(list) && list.length === 1 ? list[0] : null;
	const o = /** @type {any} */ (
		id ? get(objectsGroup)?.getObjectByProperty('uuid', /** @type {any} */ (id)?.uuid ?? id) : null
	);
	if (o?.isMesh && (isVectorObject(o) || o.userData?.textPath))
		void import('./vectorExtrude.js').then((m) => m.watchExtrude());
});

// a dynamic import, the checkpoints precedent: shortcuts sits in history's import family
void import('../shortcuts').then(({ registerShortcut }) =>
	VECTOR_SHORTCUTS.forEach((row) => registerShortcut(row))
);
