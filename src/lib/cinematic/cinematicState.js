// 100 C1 — THE CINEMATIC VIEW'S FRONT DOOR (a boot-path leaf: the offer probe and the switch's calls).
// The switch itself, three/webgpu and the lighting are a LAZY chunk (./cinematicView.js) that only a
// desktop that pressed the switch ever downloads. That chunk imports no app store: what it needs from
// the app (the renderer, scene, camera, the toast) is handed over here as `ctx`, which keeps its
// preload list (its static import closure) a handful of files instead of the whole app.
import { get } from 'svelte/store';
import { deviceClass, browserSaysMobile } from '../deviceClass.js';
import { isVRMode, globalRenderer, globalScene, globalCamera } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import { offerVerdict, asQuality } from './cinematicOffer.js';
import { cinematicPrefs, cinematicState, cinematicDisabled } from './cinematicStore.js';

export { cinematicPrefs, cinematicState, disableCinematic } from './cinematicStore.js';

/** @type {Promise<boolean> | null} */
let probing = null;
let probedFor = '';

/** a Chromium browser (the WebGPU path the lighting was proven on) */
function chromium() {
	/** @type {any} */
	const nav = typeof navigator !== 'undefined' ? navigator : {};
	const brands = nav.userAgentData?.brands;
	if (Array.isArray(brands)) return brands.some((/** @type {any} */ b) => /Chromium|Google Chrome|Microsoft Edge/.test(String(b?.brand)));
	return /Chrome\/|Edg\//.test(String(nav.userAgent || ''));
}

/** Ask whether this device gets the switch (no download; an adapter request, once). */
export function probeCinematic() {
	if (probing && probedFor === cinematicDisabled.reason) return probing;
	probedFor = cinematicDisabled.reason;
	probing = (async () => {
		/** @type {any} */
		const nav = typeof navigator !== 'undefined' ? navigator : {};
		const facts = {
			desktop: get(deviceClass) === 'desktop' && !browserSaysMobile(),
			quest: /OculusBrowser|Quest|Pico/i.test(String(nav.userAgent || '')),
			xr: !!get(isVRMode),
			gpu: !!nav.gpu,
			chromium: chromium(),
			adapter: false,
			fallbackAdapter: false,
			disabled: cinematicDisabled.reason
		};
		if (facts.desktop && !facts.quest && facts.gpu && facts.chromium && !facts.disabled) {
			try {
				const adapter = await nav.gpu.requestAdapter();
				facts.adapter = !!adapter;
				facts.fallbackAdapter = !!(adapter?.info?.isFallbackAdapter ?? adapter?.isFallbackAdapter);
			} catch {
				facts.adapter = false;
			}
		}
		const v = offerVerdict(facts);
		cinematicState.update((s) => ({ ...s, offered: v.offered, why: v.why }));
		return v.offered;
	})();
	return probing;
}

/** what the lazy switch needs from the app */
function ctx() {
	return {
		gl: /** @type {any} */ (get(globalRenderer)),
		scene: /** @type {any} */ (get(globalScene)),
		camera: () => /** @type {any} */ (get(globalCamera)),
		toast: (/** @type {string} */ msg) => showToast(msg)
	};
}

/** the lazy half @returns {Promise<typeof import('./cinematicView.js')>} */
export function cinematicView() {
	return import('./cinematicView.js');
}

/** turn the view on or off on this device @param {boolean} on */
export async function setCinematic(on) {
	if (on && !(await probeCinematic())) return false;
	cinematicPrefs.update((p) => ({ ...p, on }));
	const v = await cinematicView();
	return on ? v.enterCinematic(ctx()) : v.leaveCinematic();
}

/** the switch's press and the keyboard shortcut */
export function toggleCinematic() {
	const s = get(cinematicState);
	if (s.mode === 'entering' || s.mode === 'leaving') return Promise.resolve(false);
	return setCinematic(s.mode !== 'on');
}

/** pick the quality step (applies live when the view is on) @param {any} q */
export async function setCinematicQuality(q) {
	cinematicPrefs.update((p) => ({ ...p, quality: asQuality(q) }));
	if (get(cinematicState).mode === 'on') (await cinematicView()).requalify();
}

/** a headset session starting: the view gives the frame back first (XR draws through WebGL) */
isVRMode.subscribe((vr) => {
	if (vr && get(cinematicState).mode !== 'off') void cinematicView().then((v) => v.leaveCinematic());
});
