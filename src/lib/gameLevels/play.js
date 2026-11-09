// 93 LP1 / LP3 — PORTALS AND CHECKPOINTS AT PLAY TIME. ~10x a second, only while this peer plays (Play or
// Interact — an editor camera flying through a doorway goes nowhere), every peer checks ITS OWN player
// against the portal and checkpoint trigger boxes (objects.js triggerBox): entering a portal takes this
// player through it; stepping on a checkpoint saves this player's progress there. Nothing here is sent: a
// portal hop is a LOCAL scene replace (peers in other scenes is the rooms layer's normal state), and a
// checkpoint is per player by definition.
//
// PRELOAD: a portal whose target is another scene starts fetching that scene's bytes while the player stands
// within PRELOAD_RADIUS of it, so the hop (and its loading screen) is short or skipped (LP2).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalCamera } from '../../stores/sceneStore';
import { gameFeelActive } from '../gameFeel';
import { insideTrigger, BACK_TARGET } from './objects.js';
import { levelRow } from './table.js';
import { sceneLevelsTable } from './runtime.js';

/** how often the trigger check runs (ms) */
const CHECK_MS = 100;
/** a fresh hop arms no portal for this long (the arrival spot is outside the trigger anyway) */
const HOP_COOLDOWN_MS = 1500;
/** metres: a portal this close to the player preloads its target scene */
export const PRELOAD_RADIUS = 8;
/** the feet sit about this far below the eye (a walker's 1.7 m person, with slack for crouching) */
const FEET_BELOW_EYE = 1.5;

/** @type {{portals: any[], checkpoints: any[], at: number}} */
let cache = { portals: [], checkpoints: [], at: 0 };
/** uuids this player is inside now (rising edges act) @type {Set<string>} */
let inside = new Set();
let lastCheck = 0;
let busyUntil = 0;
/** @type {Promise<any> | null} */
let hopping = null;
/** where this player last came in through a portal (the Back target) @type {{scene: string, portal: string} | null} */
let lastPortal = null;

const _eye = new THREE.Vector3();
const _feet = new THREE.Vector3();
const _at = new THREE.Vector3();

/** re-scan the scene for portals / checkpoints (twice a second: objects come and go while editing) */
function scan() {
	const group = /** @type {any} */ (get(objectsGroup));
	/** @type {any[]} */
	const portals = [];
	/** @type {any[]} */
	const checkpoints = [];
	group?.traverse?.((/** @type {any} */ o) => {
		if (o.userData?.portal) portals.push(o);
		else if (o.userData?.checkpoint) checkpoints.push(o);
	});
	cache = { portals, checkpoints, at: performance.now() };
}

/** per frame (kit/runtime tickKit, every peer) */
export function tickLevelObjects() {
	const now = performance.now();
	if (now - lastCheck < CHECK_MS) return;
	lastCheck = now;
	if (!gameFeelActive()) {
		if (inside.size) inside = new Set();
		return;
	}
	if (now - cache.at > 500) scan();
	if (!cache.portals.length && !cache.checkpoints.length) return;
	const cam = /** @type {any} */ (get(globalCamera));
	if (!cam?.getWorldPosition) return;
	cam.getWorldPosition(_eye);
	_feet.copy(_eye).y -= FEET_BELOW_EYE;
	/** @type {Set<string>} */
	const now_ = new Set();
	for (const cp of cache.checkpoints) {
		if (!cp.parent) continue;
		if (insideTrigger(cp, 'checkpoint', _feet) || insideTrigger(cp, 'checkpoint', _eye)) {
			now_.add(cp.uuid);
			if (!inside.has(cp.uuid)) void reached(cp);
		}
	}
	for (const portal of cache.portals) {
		if (!portal.parent) continue;
		const rec = portal.userData.portal;
		if (insideTrigger(portal, 'portal', _feet) || insideTrigger(portal, 'portal', _eye)) {
			now_.add(portal.uuid);
			if (!inside.has(portal.uuid) && !hopping && now >= busyUntil) void enterPortal(portal);
		} else if (rec?.scene || rec?.level) {
			portal.getWorldPosition(_at);
			if (_at.distanceTo(_feet) < PRELOAD_RADIUS) void preloadFor(rec);
		}
	}
	inside = now_;
}

/** the target a portal record names: {scene?, spawn?, level?, title} (null = goes nowhere) @param {any} rec */
export function portalTarget(rec) {
	if (!rec) return null;
	if (rec.level === BACK_TARGET) return lastPortal ? { scene: lastPortal.scene, spawn: lastPortal.portal, title: lastPortal.scene || 'Back' } : null;
	if (rec.level) {
		const row = levelRow(sceneLevelsTable(), rec.level);
		if (!row) return null;
		return { level: row.id, scene: row.scene ?? '', spawn: rec.spawn || row.spawn || '', title: row.name, goal: row.goal ?? '' };
	}
	if (rec.scene || rec.spawn) return { scene: rec.scene ?? '', spawn: rec.spawn ?? '', title: rec.scene || rec.spawn };
	return null;
}

/** take this player through a portal @param {any} portal */
export async function enterPortal(portal) {
	const rec = portal.userData?.portal;
	const target = portalTarget(rec);
	if (!target) return false;
	const run = (async () => {
		const tr = await import('./transition.js');
		const travel = await import('./travel.js');
		const here = await travel.currentSceneName();
		const from = { scene: here, portal: portal.name || portal.uuid };
		await tr.transitionOut(rec.transition ?? 'fade', { title: target.title, goal: target.goal });
		let ok = false;
		try {
			ok = (await travel.hopTo(target, { solo: true, loading: rec.loading ?? null })).ok;
		} finally {
			busyUntil = performance.now() + HOP_COOLDOWN_MS;
			await tr.transitionIn();
		}
		if (ok) {
			// a later Back portal returns here, in front of the portal just used
			if (target.scene && target.scene !== here) lastPortal = from;
			// LP3: a portal passed counts as a checkpoint (where a fall or a reload brings you back)
			(await import('./checkpoints.js')).notePortalPassed(target);
		}
		return ok;
	})();
	hopping = run;
	try {
		return await run;
	} finally {
		hopping = null;
	}
}

/** @param {any} cp */
async function reached(cp) {
	(await import('./checkpoints.js')).reachCheckpoint(cp);
}

/** @type {Set<string>} scenes already asked for */
const preloaded = new Set();
/** @param {any} rec */
async function preloadFor(rec) {
	const target = portalTarget(rec);
	const scene = target?.scene;
	if (!scene || preloaded.has(scene)) return;
	preloaded.add(scene);
	try {
		(await import('./preload.js')).preloadScene(scene);
	} catch {}
}

/** a scene clear / load: forget what we were standing in */
export function resetLevelObjects() {
	inside = new Set();
	cache = { portals: [], checkpoints: [], at: 0 };
	preloaded.clear();
}

/** test / debug view */
export function levelObjectsDebug() {
	return { portals: cache.portals.length, checkpoints: cache.checkpoints.length, inside: [...inside], hopping: !!hopping, lastPortal };
}
