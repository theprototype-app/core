import { objectsGroup } from '../stores/sceneStore';

// 102 M3: the per-frame entry for decals — ONE line in Scene's useTask (the textPathTick shape).
// The runtime chunk loads only once a scene holds a decal (or a stamp arrives). A scene with none
// pays a scan per scene poke (and one a second as a backstop), never a per-frame traversal.

const FALLBACK_MS = 1000;

let wanted = true;
let lastScan = 0;
let has = false;
/** @type {null | ((root: any, now: number) => void)} */
let tick = null;
let loading = false;
let ever = false;
/** a stamp asked for the runtime (it may arrive before any carrier exists) */
let forced = false;

objectsGroup.subscribe(() => {
	wanted = true;
});

/** @param {any} root */
function holdsDecal(root) {
	let found = false;
	root?.traverse?.((/** @type {any} */ o) => {
		// (decalCore's isDecalObject, inlined: the boot never loads a decal module)
		if (!found && o.isMesh && o.userData?.decal && typeof o.userData.decal === 'object') found = true;
	});
	return found;
}

/** has anything loaded the decal runtime in this tab (the zero-change proof: a scene without decals never does) */
export const decalRuntimeLoaded = () => forced || !!tick;

/** load the runtime now (a stamp message, a placement) @returns {Promise<any>} */
export function loadDecalRuntime() {
	forced = true;
	return import('./decalRuntime.js').then((m) => {
		tick = m.tickDecals;
		return m;
	});
}

/** @param {any} root objectsGroup @param {number} now ms */
export function tickDecalsLazy(root, now) {
	if (!root) return;
	if (wanted || now - lastScan > FALLBACK_MS) {
		wanted = false;
		lastScan = now;
		has = holdsDecal(root);
	}
	if (tick) {
		// the last decal went: one more pass lets the runtime drop its visuals, then it rests
		if (has || ever || forced) tick(root, now);
		ever = has;
		return;
	}
	if (loading || !has) return;
	loading = true;
	loadDecalRuntime()
		.catch((err) => console.log('decal runtime failed to load', err))
		.finally(() => (loading = false));
}
