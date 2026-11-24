import { objectsGroup } from '../stores/sceneStore';

// 102b-arrange row 1: the per-frame entry for arrays — ONE line in Scene's useTask (editor, Play and
// exported games share Scene.svelte). The textPathTick shape: the runtime is a lazy chunk imported
// only once a scene holds an array; a scene with none pays a scan per scene poke (and one a second).

const FALLBACK_MS = 1000;

let wanted = true;
let lastScan = 0;
/** @type {any[]} */
let carriers = [];
/** @type {null | ((carriers: any[], root: any) => void)} */
let tick = null;
let loading = false;
let ever = false;

objectsGroup.subscribe(() => {
	wanted = true;
});

/** @param {any} root objectsGroup @param {number} now ms */
export function tickArraysLazy(root, now) {
	if (!root) return;
	if (wanted || now - lastScan > FALLBACK_MS) {
		wanted = false;
		lastScan = now;
		/** @type {any[]} */
		const found = [];
		root.traverse((/** @type {any} */ o) => {
			if (o !== root && o.userData?.array) found.push(o);
		});
		carriers = found;
	}
	if (tick) {
		// the last array went: one more pass lets the runtime drop its copies, then it rests
		if (carriers.length || ever) tick(carriers, root);
		ever = carriers.length > 0;
		return;
	}
	if (loading || !carriers.length) return;
	loading = true;
	import('./arrayRuntime.js')
		.then((m) => {
			tick = m.tickArrays;
		})
		.catch((err) => console.log('array runtime failed to load', err))
		.finally(() => (loading = false));
}

/** a scene poke the runtime's own writes do not make (the Inspector's live preview calls it) */
export function arraysChanged() {
	wanted = true;
}
