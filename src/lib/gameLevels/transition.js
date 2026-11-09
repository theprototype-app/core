// 93 LP1 / LP2 — THE LEVEL-CHANGE TRANSITION and THE LOADING SCREEN's state. LOCAL to this player (a portal
// hop is one player's; a group hop runs it on every peer for itself), never replicated or saved.
//
//   out    cover the view (fade to black / iris closing / a level card) — resolves when covered
//   (the hop happens under the cover; a scene load shows the loading screen on top: loading.js)
//   in     uncover
//
// The DOM half is LevelTransition.svelte (App + PlayApp root). In a headset DOM is invisible, so the VR half
// is a dark sphere around the eyes that fades (the comfort rule: no head-locked UI, a fade is not UI) —
// "VR = fade-teleport": a VR hop always fades, whatever the portal's transition.
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { isVRMode, globalCamera } from '../../stores/sceneStore';

/** @typedef {{kind: string, phase: 'idle' | 'out' | 'covered' | 'in', title: string, goal: string}} TransitionState */
/** @type {import('svelte/store').Writable<TransitionState>} */
export const levelTransition = writable({ kind: 'fade', phase: 'idle', title: '', goal: '' });

/** how long a cover / uncover takes (ms); a card holds a little longer so it can be read */
export const TRANSITION_MS = { fade: 320, iris: 420, card: 320, none: 0 };
const CARD_HOLD_MS = 900;

/** does this viewer ask for less motion? (53 A5: the app's one setting, set before first paint) */
export function reducedMotion() {
	try {
		return typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduce';
	} catch {
		return false;
	}
}

/** @param {number} ms */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the VR fade ------------------------------------------------------------------------------------------
/** @type {THREE.Mesh | null} */
let vrShell = null;
/** @param {number} opacity */
function vrFadeTo(opacity) {
	const cam = /** @type {any} */ (get(globalCamera));
	if (!cam?.isObject3D) return;
	if (!vrShell) {
		vrShell = new THREE.Mesh(
			new THREE.SphereGeometry(0.3, 16, 12),
			new THREE.MeshBasicMaterial({ color: 0x05070a, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false })
		);
		vrShell.name = 'levels-vr-fade';
		vrShell.renderOrder = 10000;
		vrShell.frustumCulled = false;
		vrShell.userData.helper = true;
	}
	if (vrShell.parent !== cam) cam.add(vrShell);
	/** @type {any} */ (vrShell.material).opacity = opacity;
	vrShell.visible = opacity > 0.001;
}
/** animate the VR shell @param {number} from @param {number} to @param {number} ms */
async function vrFade(from, to, ms) {
	const start = performance.now();
	for (;;) {
		const t = ms > 0 ? Math.min(1, (performance.now() - start) / ms) : 1;
		vrFadeTo(from + (to - from) * t);
		if (t >= 1) break;
		await wait(16);
	}
	if (to <= 0 && vrShell?.parent) vrShell.parent.remove(vrShell);
}

// ---- out / in ---------------------------------------------------------------------------------------------
/**
 * Cover the view. @param {string} kind fade | iris | card | none
 * @param {{title?: string, goal?: string}} [info] what a card says
 */
export async function transitionOut(kind = 'fade', info = {}) {
	const vr = get(isVRMode);
	let k = ['fade', 'iris', 'card', 'none'].includes(kind) ? kind : 'fade';
	if (vr) k = 'fade';
	if (k === 'iris' && reducedMotion()) k = 'fade';
	levelTransition.set({ kind: k, phase: 'out', title: String(info.title ?? ''), goal: String(info.goal ?? '') });
	const ms = /** @type {any} */ (TRANSITION_MS)[k] ?? 300;
	if (vr) await vrFade(0, 1, ms);
	else await wait(ms);
	levelTransition.update((s) => ({ ...s, phase: 'covered' }));
	if (k === 'card') await wait(CARD_HOLD_MS);
}

/** Uncover the view. */
export async function transitionIn() {
	const s = get(levelTransition);
	if (s.phase === 'idle') return;
	levelTransition.set({ ...s, phase: 'in' });
	const ms = /** @type {any} */ (TRANSITION_MS)[s.kind] ?? 300;
	if (get(isVRMode) || vrShell?.parent) await vrFade(1, 0, ms);
	else await wait(ms);
	levelTransition.set({ ...get(levelTransition), phase: 'idle' });
}
