import { get, writable } from 'svelte/store';
import { scenePlay } from './scenePhysics';
import { showToast } from '../stores/appStore';
import { normalizeLocomotion, normalizeSpawn } from './locomotionPolicy';
import { moduleWorldChildren } from './moduleWorld';

/**
 * 30b P4: a spawn point set at RUNTIME by a module (`api.setSpawn(position, yaw)`) — a
 * dungeon's floor, a level's start. LOCAL (every peer's module runs the same code off the
 * same replicated state, so each sets its own), never saved, and it wins over the scene's
 * authored `play.spawn` (contract C1: a module overrides the scene's).
 * @type {import('svelte/store').Writable<{position: [number, number, number], yaw: number, owner?: string} | null>}
 */
export const runtimeSpawn = writable(null);

/** @param {any} position @param {any} [yaw] @param {string} [owner] @returns {boolean} */
export function setRuntimeSpawn(position, yaw, owner) {
	if (position == null) {
		runtimeSpawn.set(null);
		return true;
	}
	const spawn = normalizeSpawn(position, yaw);
	if (!spawn) return false;
	runtimeSpawn.set(owner ? { ...spawn, owner } : spawn);
	return true;
}

// 21-B B3: what play mode BEHAVES like in this scene.
//
// The shared defaults live in scenePhysics (`play.*`, so they replicate, save
// and undo with everything else). A MODULE may override them by publishing
// `userData.play` on its scene-root group — which is the generalisation DEVX #13
// asked for: `dungeonPlay.dungeonData()` reaches for the object named
// 'dungeon-module' by name, and nothing else can publish the same contract.
//
// The SORT is load-bearing. `scene.children` order follows ADD order, which is
// per-peer (module load order, when a peer joined, what it re-created), so an
// unsorted scan resolves DIFFERENTLY on two peers — a class of desync that only
// shows up when two modules both publish.

/** the eye height play mode has always used for a grounded walker */
export const DEFAULT_EYE_HEIGHT = 0.8;

let warnedMultiple = false;

/**
 * Every scene-root child publishing the play contract, in a DETERMINISTIC
 * order: 'dungeon-module' first (the original publisher, so its behaviour is
 * unchanged), then the rest by name.
 * @param {any} scene @returns {any[]} the userData.play objects
 */
export function playPublishers(scene) {
	if (!scene?.children) return [];
	// 30b P5: registered module groups live under the world rig's module root now
	const found = [...scene.children, ...moduleWorldChildren()].filter(
		(/** @type {any} */ child) => child?.userData?.play
	);
	found.sort((/** @type {any} */ a, /** @type {any} */ b) => {
		if (a.name === 'dungeon-module') return -1;
		if (b.name === 'dungeon-module') return 1;
		return String(a.name).localeCompare(String(b.name));
	});
	return found;
}

/**
 * The effective play settings: the scene's shared `play` block, overridden
 * FIELD BY FIELD by each publisher (a module only overrides what it declares).
 * @param {any} scene
 * 30 P3: `cursor` too — 'free' (the real cursor aims, no pointer lock) or 'locked' (the
 * crosshair, today). A module publishing `userData.play.cursor` overrides the scene's, the
 * way `grounded` does, which is how a board-game module asks for it without an authored
 * scene field.
 * 30b P3/P4: `locomotion` ({teleport, fly}, both false unless the scene or a publisher
 * allows them — field by field, like `grounded`) and `spawn` (the runtime api.setSpawn,
 * else a publisher's `userData.play.spawn`, else the scene's `play.spawn`, else null).
 * @returns {{interaction: 'grab'|'click'|'off', grounded: boolean, eyeHeight: number, cursor: 'free'|'locked',
 *   locomotion: {teleport: boolean, fly: boolean}, spawn: {position: [number, number, number], yaw: number} | null}}
 */
export function resolvePlaySettings(scene) {
	const base = get(scenePlay);
	/** @type {any} */
	const out = {
		interaction: base.interaction,
		grounded: base.grounded,
		eyeHeight: DEFAULT_EYE_HEIGHT,
		cursor: base.cursor === 'free' ? 'free' : 'locked',
		locomotion: { teleport: false, fly: false },
		spawn: normalizeSpawn(base.spawn)
	};
	const baseLoco = normalizeLocomotion(base.locomotion);
	if (baseLoco) Object.assign(out.locomotion, baseLoco);
	const publishers = playPublishers(scene);
	if (publishers.length > 1 && !warnedMultiple) {
		warnedMultiple = true;
		showToast(
			publishers.length +
				' modules define play behaviour (' +
				publishers.map((/** @type {any} */ p) => p.name).join(', ') +
				') — the last one listed wins'
		);
	}
	for (const publisher of publishers) {
		const play = publisher.userData.play;
		if (play.interaction === 'grab' || play.interaction === 'click' || play.interaction === 'off')
			out.interaction = play.interaction;
		if (typeof play.grounded === 'boolean') out.grounded = play.grounded;
		if (typeof play.eyeHeight === 'number') out.eyeHeight = play.eyeHeight;
		if (play.cursor === 'free' || play.cursor === 'locked') out.cursor = play.cursor;
		const loco = normalizeLocomotion(play.locomotion);
		if (loco) Object.assign(out.locomotion, loco);
		const spawn = normalizeSpawn(play.spawn);
		if (spawn) out.spawn = spawn;
	}
	const runtime = get(runtimeSpawn);
	if (runtime) out.spawn = { position: runtime.position, yaw: runtime.yaw };
	return out;
}

/**
 * DEVX #13, the minimap half: markers any publisher can put on the play HUD,
 * as `userData.play.markers = [{x, z, kind}]`. Absent means none, so a module
 * that does not want markers is byte-unchanged.
 * @param {any} scene @returns {{x: number, z: number, kind: string}[]}
 */
export function playMarkers(scene) {
	/** @type {any[]} */
	const markers = [];
	for (const publisher of playPublishers(scene)) {
		const list = publisher.userData.play.markers;
		if (!Array.isArray(list)) continue;
		for (const marker of list) {
			if (typeof marker?.x === 'number' && typeof marker?.z === 'number')
				markers.push({ x: marker.x, z: marker.z, kind: String(marker.kind ?? 'marker') });
		}
	}
	return markers;
}

/** test hook: forget that we warned about multiple publishers */
export function resetPlaySettingsWarning() {
	warnedMultiple = false;
}
