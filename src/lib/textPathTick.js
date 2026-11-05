import { objectsGroup } from '../stores/sceneStore';
import { isTextPathObject } from './textPathCore.js';

// 64 D2: the per-frame entry for text on a path — ONE line in Scene's useTask. A leaf that
// keeps the boot graph flat: troika's text runtime is imported only once a scene holds a text
// object. A scene with none pays a scan per scene poke (and one a second as a backstop for a
// write that did not poke), never a per-frame traversal.

const FALLBACK_MS = 1000;

let wanted = true;
let lastScan = 0;
let has = false;
/** @type {null | ((root: any) => void)} */
let tick = null;
let loading = false;
let ever = false;

objectsGroup.subscribe(() => {
	wanted = true;
});

/** @param {any} root */
function holdsText(root) {
	let found = false;
	root?.traverse?.((/** @type {any} */ o) => {
		if (!found && o.isMesh && isTextPathObject(o)) found = true;
	});
	return found;
}

/**
 * @param {any} root objectsGroup @param {number} now ms
 */
export function tickTextPathsLazy(root, now) {
	if (!root) return;
	if (wanted || now - lastScan > FALLBACK_MS) {
		wanted = false;
		lastScan = now;
		has = holdsText(root);
	}
	if (tick) {
		// the last text went: one more pass lets the runtime drop its visuals, then it rests
		if (has || ever) tick(root);
		ever = has;
		return;
	}
	if (loading || !has) return;
	loading = true;
	import('./textPathRuntime.js')
		.then((m) => {
			tick = m.tickTextPaths;
		})
		.catch((err) => console.log('text on a path runtime failed to load', err))
		.finally(() => (loading = false));
}

/** set while texts exist, so the runtime keeps ticking (and cleans up after the last one) */
export function textPathsActive() {
	return has;
}
