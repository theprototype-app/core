// 64-extrude: the 2D toolbar's EXTRUDE tool (the 64-2d contract: the header of src/lib/sprite2d/tools2d.js —
// a feature drops `src/lib/<feature>/tools2d.js`, default export = an array of tools, found by
// import.meta.glob; no file = no button). Loaded with the 2D toolbar, never at boot.
//
// The flat view looks straight down at the 2D plane, so a drag along the depth axis cannot be seen
// there: the press TOGGLES the selected shape or block text between flat and a 10 cm solid (one undo
// step, the arrow's own edit), and the arrow in the 3D view sets any other depth.
import { get } from 'svelte/store';
import { selectedObject } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';

export const EXTRUDE_2D_DEPTH = 0.1;

/** the contract's Tool2d (64-2d), spelled out so this file stands without that branch
 * @type {{id: string, label: string, icon: string, order: number, title?: string, run: (ctx: any) => any}[]} */
const tools = [
	{
		id: 'extrude',
		label: 'Extrude',
		icon: 'box',
		order: 50,
		title:
			'Extrude — make the selected shape or text a 10 cm solid, or flat again (Back to 3D and drag its arrow for any depth)',
		run: async (ctx) => {
			ctx?.disarm?.();
			const o = /** @type {any} */ (get(selectedObject));
			const m = await import('../vector/vectorExtrude.js');
			const kind = m.extrudeKindOf(o);
			if (!o || !kind) {
				showToast('Select a shape or a text first, then Extrude');
				return false;
			}
			return m.setDepth(o.uuid, kind, m.depthNow(o) > 0 ? 0 : EXTRUDE_2D_DEPTH);
		}
	}
];

export default tools;
