import {
	flowGraphClose,
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

/**
 * W2: the dock key -> the store that CLOSES that panel (every one of these is inverted
 * app-wide: true = closed). It lives here beside the add list, and not in bottomDock.js,
 * for the reason stated at the top of that module — dock bookkeeping imports no app
 * stores. The tab strip's ✕ is its only caller today; putting the mapping in one place
 * is what stops a future closer disagreeing with the "+" entry that opened it.
 * @type {Record<string, import('svelte/store').Writable<boolean>>}
 */
export const DOCK_CLOSERS = {
	flow: flowGraphClose,
	flowcode: flowCodeClose,
	animation: animationClose,
	uv: uvEditorClose,
	shader: shaderEditorClose,
	hud: hudEditorClose,
	explorer: explorerClose
};

/** @param {string} key @returns {import('svelte/store').Writable<boolean>|null} */
export function closeStoreFor(key) {
	return DOCK_CLOSERS[key] ?? null;
}
