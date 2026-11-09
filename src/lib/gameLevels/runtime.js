// 93 LP0 — THE LEVELS TABLE IN THE RUNNING APP: the scene's table (scenePhysics.levels) defines
// kit.levels on every peer (the same replicated table → the same definition everywhere, the way
// the same module code defines a module's table), so the Kit: Levels nodes — Go to level / Next
// level / Finish level — work with no module code (78 F19). A chosen level is then ACTED ON
// (gameLevels/travel.js: its scene or its spawn point).
//
// Light on purpose: the kit runtime and the scene-settings store only; everything that reaches the
// sessions / history family is a dynamic import elsewhere.
import { get } from 'svelte/store';
import { scenePhysicsState_ } from '../scenePhysics';
import { kit, onKitTick } from '../kit/runtime.js';
import { kitLevelsDef } from './table.js';

/** the scene's Levels table right now (null = the scene has none) @returns {any} */
export function sceneLevelsTable() {
	return get(scenePhysicsState_)?.levels ?? null;
}

/** @type {(() => void) | null} */
let undefine = null;
let definedKey = '';

/**
 * Bring kit.levels up to the scene's table: define it (or re-define it when it changed), or drop
 * the definition when the scene has no table. Idempotent; every peer runs it on every change.
 */
export function syncKitLevels() {
	const levels = kit.impls.levels;
	if (!levels?.extra?.define) return;
	const def = kitLevelsDef(sceneLevelsTable());
	const key = def ? JSON.stringify(def) : '';
	if (key === definedKey) return;
	definedKey = key;
	undefine?.();
	undefine = null;
	if (def) undefine = levels.extra.define(def, 'scene-table');
}

/** a scene clear resets the kit (its local definitions too): the next sync defines again */
export function forgetKitLevels() {
	undefine = null;
	definedKey = '';
}

let installed = false;
/** wire the table to the kit for the app's life (flowRuntime's start, through kit/runtime.js) */
export function installLevelsRuntime() {
	if (installed) return;
	installed = true;
	scenePhysicsState_.subscribe(() => syncKitLevels());
	// acting on a chosen level (travel / spawn) + the travel carry: sessions-family, so dynamic
	import('./travel.js')
		.then((m) => m.installLevelsTravel())
		.catch((error) => console.warn('levels: travel did not install', error));
	// LP1 / LP3: portals + checkpoints at play time, and the kit's checkpoint calls
	Promise.all([import('./play.js'), import('./checkpoints.js')])
		.then(([play, cps]) => {
			onKitTick(play.tickLevelObjects);
			cps.installCheckpoints();
		})
		.catch((error) => console.warn('levels: portals did not install', error));
}
