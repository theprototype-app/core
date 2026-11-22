// 103 H5 — KEYMAP PRESETS, the lazy half. A preset is a set of default bindings; the user's own
// rebinds (`overrides` in shortcuts.js) win over any of them. 'theprototype' is today's keys and the
// default, so a person who never opens Settings never loads this file: shortcuts.js keeps only the
// active table (empty for the default) and imports this when a stored preset is not the default, or
// when Settings ▸ Shortcuts shows the Keymap card. 1 / 2 / 3 stay the tool keys in every preset
// (owner, 22 Nov); Mesh edit and the UV editor keep their own keys unless a preset adds missing ones.
import { get } from 'svelte/store';
import { flyWithWasd } from './flyPrefs';
import { usePresetTable } from './shortcuts';

export const KEYMAP_PRESETS = [
	{ id: 'theprototype', label: 'ThePrototype (default)', hint: "Today's keys: 1 / 2 / 3 pick the tool, W A S D fly, G picks Move." },
	{
		id: 'blender',
		label: 'Blender style',
		hint: 'G / R start moving / rotating at once, Alt+S resizes (bare S when the fly keys wait for the right mouse button), X / Y / Z lock an axis.'
	},
	{
		id: 'unity',
		label: 'Unity / Maya style',
		hint: 'W / E / R pick Move / Rotate / Scale — with "Fly with WASD" set to the right mouse button, where those letters are free.'
	}
];

/**
 * The preset's bindings, `{ id: combo }` ('' = unbound). Every key a preset TAKES from another row
 * says where that row went (listed in the shortcut sheet and the changelog too).
 * @param {string} preset @returns {Record<string, string>}
 */
export function presetKeys(preset) {
	const freeS = get(flyWithWasd) === 'rmb';
	if (preset === 'blender')
		return {
			'transform.now-move': 'G',
			'transform.grab': '', // G starts the move now; 1 still picks the Move tool
			'transform.now-rotate': 'R',
			'transform.now-scale': freeS ? 'S' : 'Alt+S',
			// Alt+S was the Shader editor's; it moves to Alt+Shift+S (only while Alt+S resizes)
			...(freeS ? {} : { 'panels.shader-editor': 'Alt+Shift+S' }),
			// X / Y / Z lock an axis in every preset (the registry's own default)
			// the UV editor (WASD never flies there, so bare S is free): G takes uv.grab's G, which
			// stays on 1 (arm Move); the tool keys follow Blender's W (select), B (box), C (circle)
			'uv.now-move': 'G',
			'uv.grab': '',
			'uv.now-rotate': 'R',
			'uv.now-scale': 'S',
			'uv.lock-u': 'X',
			'uv.lock-v': 'Y',
			'uv.tool-select': 'W',
			'uv.tool-box': 'B',
			'uv.tool-lasso': 'C',
			'uv.tool-paint': 'P',
			// Edit Mesh: G starts the move (mesh.move's "arm Move" goes unbound; the toolbox button
			// stays), R / S rotate / resize, and Subdivide leaves S for Shift+S
			'mesh.now-move': 'G',
			'mesh.move': '',
			'mesh.now-rotate': 'R',
			'mesh.now-scale': 'S',
			'mesh.subdivide': 'Shift+S'
		};
	// W / E fly while the fly keys are always on, so the tool letters only arrive with 'rmb'
	if (preset === 'unity') return freeS ? { 'transform.move': 'W', 'transform.rotate': 'E', 'transform.scale': 'R' } : {};
	return {};
}

/** Put a preset in force. `switching` = the user picked it (drops overrides that now equal it).
 * @param {string} id @param {boolean} switching */
export function applyPreset(id, switching) {
	if (!KEYMAP_PRESETS.some((p) => p.id === id)) return;
	usePresetTable(id, presetKeys(id), switching);
}
