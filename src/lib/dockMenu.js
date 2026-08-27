import {
	flowCodeClose,
	animationClose,
	uvEditorClose,
	shaderEditorClose,
	hudEditorClose,
	explorerClose
} from '../stores/appStore';
import { activateDock } from './bottomDock';

// The dock's "+" add-a-view menu, in ONE place. The docked tab strip
// (DockTabs.svelte) and the FLOATING Node editor's header "+" (Flow.svelte) each
// kept their own copy of the same list, so a view added to one silently went
// missing from the other. Every entry opens its panel — they all start docked —
// and makes it the visible tab; the Explorer is one of them now that it is an
// ordinary dock tab rather than the dock's separate occupant.

/** @returns {{label: string, tooltip: string, action: () => void}[]} */
export function dockAddItems() {
	return [
		{ label: '＋ Flow Code', tooltip: 'Edit the graph as JSON', action: () => { flowCodeClose.set(false); activateDock('flowcode'); } },
		{ label: '＋ Animation', tooltip: 'Animate the selected object', action: () => { animationClose.set(false); activateDock('animation'); } },
		{ label: '＋ UV editor', tooltip: 'Edit the selected mesh’s UV map and textures', action: () => { uvEditorClose.set(false); activateDock('uv'); } },
		{ label: '＋ Shader editor', tooltip: 'Drive this material from a node graph', action: () => { shaderEditorClose.set(false); activateDock('shader'); } },
		{ label: '＋ HUD editor', tooltip: 'Lay out the on-screen HUD its nodes drive', action: () => { hudEditorClose.set(false); activateDock('hud'); } },
		{ label: '＋ Explorer', tooltip: 'Browse the asset library', action: () => { explorerClose.set(false); activateDock('explorer'); } }
	];
}
