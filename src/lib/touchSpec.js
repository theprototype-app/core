import { derived } from 'svelte/store';
import { flowGraphs } from '../stores/flowStore';
import { charControl } from './charController';
import { leftBehindModules } from './sceneScope';
import { resolveTouchControls, touchDeclarations } from './touchActions';

// 36 U8: WHAT THE SCENE ON SCREEN ASKS A TOUCH SCREEN FOR — the one derived store the
// overlay and the layout editor both draw from, so the editor always edits exactly the
// buttons the game will show.
//
// Not in touchActions.js on purpose: that file is a leaf the module SDK imports, and this
// one reaches the character controller and the flow documents. Only components import it.
//
// Inputs, all reactive: the modules' declarations (a module LEFT BEHIND by a scene switch
// stops counting, the sceneScope rule every other per-game registration follows), the
// Character Controller's mode, and every Key Press node's key across every graph document.

export const touchSpec = derived(
	[touchDeclarations, leftBehindModules, charControl, flowGraphs],
	([$declared, $left, $control, $graphs]) => {
		/** @type {string[]} */
		const keyCodes = [];
		for (const graph of Object.values($graphs ?? {}))
			for (const node of graph?.nodes ?? [])
				if (node?.type === 'keypress' && typeof node.data?.code === 'string' && !keyCodes.includes(node.data.code))
					keyCodes.push(node.data.code);
		const control = /** @type {any} */ ($control);
		return resolveTouchControls({
			declared: $declared.filter((d) => !$left.has(d.owner)),
			walk: control?.mode === 'walk',
			fly: !control || control.mode === 'fly',
			keyCodes
		});
	}
);
