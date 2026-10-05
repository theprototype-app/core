// VR controls — STABLE TOUR TARGETS in the headset (36-vr, contract T1 with 36-onboard). A desktop tour
// step points at a `data-tour` element; a VR step points at one of these ids and asks for the live
// Object3D to put its arrow on:
//   radial:<entry id>   a radial sector (radial:undo, radial:nav:settings, radial:set:turning …), radial:hub
//   vr-panel:<name>     a VR panel's root group (settings, objects, props, prefabs, chat, palette, edit,
//                       snap, stats, keyboard, approve, radial, game, wrist)
// A sector carries its id on `userData.tour` (VRMenu stamps it); a panel is found by its fixed group name.
// Null = not on screen right now (its ring or panel is closed) — `openRadialAt(ring)` opens a ring first.
import { get } from 'svelte/store';
import { globalScene, vrMenuOpen } from '../../stores/sceneStore';
import { resetRings, pushRing } from '../vrRadialMenu';

/** panel id -> the group's scene name */
export const VR_PANEL_NAMES = /** @type {Record<string, string>} */ ({
	radial: 'vr-quick-menu',
	settings: 'vr-settings-panel',
	objects: 'vr-objects-panel',
	props: 'vr-props-panel',
	prefabs: 'vr-prefabs-panel',
	chat: 'vr-chat-panel',
	palette: 'vr-color-palette',
	edit: 'vr-edit-menu',
	snap: 'vr-snap-menu',
	stats: 'vr-stats-card',
	keyboard: 'vr-keyboard',
	approve: 'vr-approve-panel',
	game: 'vr-game-panel',
	wrist: 'vr-game-wrist'
});

/**
 * The live object a tour id names, or null while it is not on screen.
 * @param {string} id @returns {any}
 */
export function vrTourTarget(id) {
	const scene = /** @type {any} */ (get(globalScene));
	if (!scene || typeof id !== 'string') return null;
	if (id.startsWith('vr-panel:')) {
		const name = VR_PANEL_NAMES[id.slice('vr-panel:'.length)];
		const group = name ? scene.getObjectByName(name) : null;
		return group?.visible === false ? null : (group ?? null);
	}
	if (id.startsWith('radial:')) {
		const menu = scene.getObjectByName('vr-quick-menu');
		if (!menu) return null;
		/** @type {any} */
		let hit = null;
		menu.traverse((/** @type {any} */ o) => {
			if (!hit && o.userData?.tour === id) hit = o;
		});
		return hit;
	}
	return null;
}

/** every tour id on screen right now (sectors of the open ring + open panels) */
export function vrTourIds() {
	const scene = /** @type {any} */ (get(globalScene));
	if (!scene) return [];
	/** @type {string[]} */
	const out = [];
	for (const [key, name] of Object.entries(VR_PANEL_NAMES)) {
		const g = scene.getObjectByName(name);
		if (g && g.visible !== false) out.push('vr-panel:' + key);
	}
	const menu = scene.getObjectByName('vr-quick-menu');
	menu?.traverse((/** @type {any} */ o) => {
		if (typeof o.userData?.tour === 'string' && o.userData.tour.startsWith('radial:')) out.push(o.userData.tour);
	});
	return out;
}

/**
 * Open the radial menu on a ring ('root', 'settings', 'settings:comfort', 'tools' …) so a tour step can
 * point into it. @param {string} ring
 */
export function openRadialAt(ring) {
	vrMenuOpen.set(true);
	resetRings();
	if (ring && ring !== 'root') {
		// a nested ring is reached through its parent, so Back walks the way a hand would
		if (ring.startsWith('settings:')) pushRing('settings');
		pushRing(ring);
	}
}
