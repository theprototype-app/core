// 43 J9 — TIPS THAT RETIRE THEMSELVES. A tip is a one-line how-to the app shows until the person has
// DONE what it explains (orchestrator, roadmap 43: no ×) — the More sheet's drag tip retires on the
// first bar edit. The retirement is remembered on this device, and Settings ▸ Interface ▸ "Reset tips"
// brings every tip back (the "Reset tours" row's sibling). LOCAL: a tip is guidance for whoever is
// holding this screen, so it never replicates, never saves into a scene and never undoes.
//
// A leaf (svelte/store + safeStorage). The first tip is the phone More sheet's "Hold and drag items
// to or from the bar"; a new tip is a new id, nothing else.
import { writable, derived } from 'svelte/store';
import { safeStorage } from './safeStorage';

const KEY = 'tipsDismissed';

/** @returns {string[]} */
function read() {
	try {
		const v = JSON.parse(safeStorage.getItem(KEY) ?? '[]');
		return Array.isArray(v) ? v.filter((id) => typeof id === 'string') : [];
	} catch {
		return [];
	}
}

/** the ids of every tip closed on this device */
export const dismissedTips = writable(/** @type {string[]} */ (read()));
dismissedTips.subscribe((ids) => {
	if (ids.length) safeStorage.setItem(KEY, JSON.stringify(ids));
	else safeStorage.removeItem(KEY);
});

/** retire a tip for good (until Reset tips) @param {string} id */
export function dismissTip(id) {
	dismissedTips.update((ids) => (ids.includes(id) ? ids : [...ids, id]));
}

/** a store that reads true while the tip should show @param {string} id */
export function tipShown(id) {
	return derived(dismissedTips, (ids) => !ids.includes(id));
}

/** Settings ▸ Reset tips: every closed tip shows again */
export function resetTips() {
	dismissedTips.set([]);
}

/** the phone More sheet's drag how-to */
export const TIP_PHONE_MORE = 'phone-more-drag';

/** 73 AI6: Generate 3D model can start from a picture (retires on the first picture picked) */
export const TIP_MESH_PICTURE = 'mesh-from-picture';

/** 64-text: the Text section's first-use how-to (Solid / Bake / fonts; retires on a mode switch, or its ✕) */
export const TIP_TEXT_3D = 'text-3d-first-use';

/** 68: Film mode's first-use how-to (retires on the first take, or its ✕) */
export const TIP_FILM = 'film-first-use';

/** 85a: Claude can shape, dress and undo now (the Connect Claude row; retires on the first call of one of those tools) */
export const TIP_AGENT_SHAPES = 'agent-shapes-looks';
/** the tools that retire it: geometryTools + lookTools + assistTools NAMES minus the look tools that only read (a unit
 * test keeps them in step; those modules pull three.js, so the row cannot import them) */
export const AGENT_TIP_TOOLS = new Set([
	...['set_geometry', 'create_lathe', 'create_tube', 'extrude_shape', 'edit_mesh', 'create_mesh', 'create_shapes', 'update_mesh', 'duplicate'],
	...['set_material', 'create_shader', 'edit_shader', 'assign_shader', 'set_post', 'create_post_graph', 'uv_unwrap', 'set_uv', 'set_quality'],
	...['undo_last', 'set_pivot', 'create_pivot', 'add_image']
]);

/** 85b (1.60): Claude builds worlds and games now (the Connect Claude row, shown before the 85a hint; retires on the
 * first successful call of an 85b tool that changes something) */
export const TIP_AGENT_GAMES = 'agent-worlds-games';
/** hudTools + sceneSetupTools + worldTools NAMES minus the reads (a unit test keeps them in step) */
export const AGENT_GAMES_TIP_TOOLS = new Set([
	...['create_hud', 'edit_hud', 'hud_panel'],
	...['set_sky', 'set_light', 'place_spawn', 'set_play_camera'],
	...['place_asset', 'prefab', 'create_particles', 'scatter', 'terrain', 'water', 'place_sound', 'set_music']
]);
