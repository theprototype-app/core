import { objectsGroup } from '../../stores/sceneStore';

// 64-2d: the per-frame entry for sprites and 2D layers — ONE line in Scene's useTask (the
// decalTick / textPathTick shape). The runtime chunk (spriteRuntime.js + spriteCore.js) loads only
// once a scene holds a sprite or a 2D layer, or a Camera Follow 2D node runs. A scene with none
// pays a scan per scene poke (and one a second as a backstop), never a per-frame traversal, and
// never fetches the chunk: the "feature unused = zero change" proof reads sprite2dRuntimeLoaded().

const FALLBACK_MS = 1000;

let wanted = true;
let lastScan = 0;
let has = false;
/** @type {any} */
let runtime = null;
/** @type {Promise<any> | null} */
let loading = null;
let ever = false;
/** @type {((m: any) => void)[]} */
const waiting = [];

objectsGroup.subscribe(() => {
	wanted = true;
});

/** @param {any} root */
function holds2d(root) {
	let found = false;
	root?.traverse?.((/** @type {any} */ o) => {
		// (spriteRuntime's isSprite / isLayer2d, inlined: the boot never loads a sprite module)
		if (found) return;
		const d = o.userData;
		if ((o.isMesh && d?.sprite && typeof d.sprite === 'object') || (d?.layer2d && typeof d.layer2d === 'object')) found = true;
	});
	return found;
}

/** is this object a 2D layer or does it hold a sprite (the Inspector offers the 2D layer section
 * then — and only then fetches it) @param {any} object */
export const offers2dLayer = (object) => !!object?.isGroup && holds2d(object);

/** the loaded runtime module, or null (flowRuntime's Play Animation / Camera Follow 2D read it) */
export const sprite2dRuntime = () => runtime;

/** has this tab fetched the sprite runtime (a scene without sprites never does) */
export const sprite2dRuntimeLoaded = () => !!runtime;

/** run `fn(runtime)` once the runtime is loaded (at once when it already is) @param {(m: any) => void} fn */
export function onSprite2dRuntime(fn) {
	if (runtime) fn(runtime);
	else waiting.push(fn);
}

/** load the runtime now (a Camera Follow 2D node, the template, the Inspector) @returns {Promise<any>} */
export function loadSprite2dRuntime() {
	if (!loading) {
		loading = import('./spriteRuntime.js').then((m) => {
			runtime = m;
			for (const fn of waiting.splice(0)) fn(m);
			return m;
		});
		loading.catch((err) => {
			console.log('sprite runtime failed to load', err);
			loading = null;
		});
	}
	return loading;
}

/** @param {any} root objectsGroup @param {any} camera the view camera @param {any} renderer @param {number} now ms */
export function tickSprites2dLazy(root, camera, renderer, now) {
	if (!root) return;
	if (wanted || now - lastScan > FALLBACK_MS) {
		wanted = false;
		lastScan = now;
		has = holds2d(root);
	}
	if (runtime) {
		// the last sprite went: one more pass lets the runtime drop what it derived, then it rests
		if (has || ever) runtime.tickSprites2d(root, camera, renderer);
		ever = has;
		return;
	}
	if (has) void loadSprite2dRuntime();
}
