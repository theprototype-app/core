import { writable, get } from 'svelte/store';
import { orbitControls, globalCamera } from '../../stores/sceneStore';

// 64-2d (QUESTIONS Q4): THE 2D EDITOR VIEW — a LOCAL orthographic view straight down -Z: no
// rotate, a drag pans, the wheel zooms. Editor2dView.svelte mounts it (a `makeDefault` camera, the
// CameraPreview swap) while `view2d.on`; Scene's perspective controls stand down meanwhile. It
// never replicates or saves — a viewpoint is a fact about this screen. 2D layers draw their
// parallax through it (the view camera is orthographic), exactly as a 2D game camera shows them.
// A LEAF: svelte/store + two leaf stores.

/** @type {import('svelte/store').Writable<{on: boolean, x: number, y: number, halfH: number}>} */
export const view2d = writable({ on: false, x: 0, y: 0, halfH: 6 });

/** the perspective editor's look-at point, kept across the 2D view (the cameraPreview 16-Q6 rule) @type {any} */
let savedTarget = null;
/** the perspective controls being replaced — a fresh instance mounts on exit @type {any} */
let staleControls = null;

/** Open the 2D view centred at (x, y) showing 2·halfH metres of height. @param {{x?: number, y?: number, halfH?: number}} [at] */
export function enter2dView(at = {}) {
	if (get(view2d).on) {
		view2d.update((v) => ({ ...v, ...at }));
		return;
	}
	const seed = seedFromEditor();
	/** @type {any} */
	const editor = get(orbitControls);
	savedTarget = editor?.target?.clone?.() ?? null;
	staleControls = editor ?? null;
	// the perspective controls UNMOUNT now, and an OrbitControls that is merely dropped keeps its
	// DOM listeners and goes on orbiting the editor camera unseen (the cameraPreview 16-Q5 zombie)
	try {
		editor?.dispose?.();
	} catch {
		/* its listeners are what mattered */
	}
	view2d.set({ on: true, x: at.x ?? seed.x, y: at.y ?? seed.y, halfH: Math.max(0.5, at.halfH ?? seed.halfH) });
}

export function exit2dView() {
	if (!get(view2d).on) return;
	view2d.update((v) => ({ ...v, on: false }));
	// the fresh perspective controls start at their default target: put back where you were
	const target = savedTarget;
	savedTarget = null;
	if (!target || typeof requestAnimationFrame === 'undefined') return;
	let tries = 0;
	const tick = () => {
		/** @type {any} */
		const controls = get(orbitControls);
		if (controls?.target && controls !== staleControls && !controls.__view2d) {
			controls.target.copy(target);
			controls.update?.();
			staleControls = null;
			return;
		}
		if (tries++ < 60) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}

export function toggle2dView() {
	if (get(view2d).on) exit2dView();
	else enter2dView();
}

/** where the perspective editor is looking, as a 2D view: its target's x/y, and a height that
 * frames what it showed at the target's distance */
function seedFromEditor() {
	/** @type {any} */
	const controls = get(orbitControls);
	/** @type {any} */
	const camera = get(globalCamera);
	const target = controls?.target;
	if (!target || !camera?.position) return { x: 0, y: 0, halfH: 6 };
	const distance = camera.position.distanceTo(target);
	const fov = camera.isPerspectiveCamera ? camera.fov : 40;
	return { x: target.x, y: target.y, halfH: Math.max(1, Math.tan(((fov * Math.PI) / 180) / 2) * distance) };
}
