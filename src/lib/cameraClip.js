import { writable, get } from 'svelte/store';
import { editorCam, playerCam, orbitControls } from '../stores/sceneStore';
import { sceneRadius } from './sceneBounds';

// Camera clip planes (123): a LOCAL per-device view preference (never
// replicated) exposed in Configure Scene. The far plane still grows to fit the
// scene (60), but now it's PAIRED with the orbit maxDistance so dollying out
// can't fly past the far plane and blank the scene — the classic
// "zoom out and everything vanishes" bug. Near is tunable so very close
// objects stop clipping.

const FAR_CAP = 200000;

/** @param {string} key @param {number} fallback */
function stored(key, fallback) {
	try {
		const v = parseFloat(localStorage.getItem(key) ?? '');
		return isFinite(v) ? v : fallback;
	} catch {
		return fallback;
	}
}

export const cameraNear = writable(stored('cameraNear', 0.05));
/** user's MINIMUM far — the dynamic scene-fit bound grows ABOVE this */
export const cameraFar = writable(stored('cameraFar', 5000));

/** The far plane needed for a scene of `radius`, honoring the user floor. Pure.
 * @param {number} userFar @param {number} radius */
export function effectiveFar(userFar, radius) {
	return Math.min(Math.max(userFar, radius * 6), FAR_CAP);
}

/** Keep the camera fully inside the far plane — never dolly past ~90% of it.
 * @param {number} far */
export function maxOrbitDistance(far) {
	return far * 0.9;
}

/** Apply near/far to both cameras + clamp orbit zoom to the far plane. */
export function applyCameraClip() {
	const near = get(cameraNear);
	const far = effectiveFar(get(cameraFar), sceneRadius());
	for (const store of [editorCam, playerCam]) {
		const cam = /** @type {any} */ (get(store));
		if (!cam) continue;
		if (cam.near !== near || cam.far !== far) {
			cam.near = near;
			cam.far = far;
			cam.updateProjectionMatrix();
		}
	}
	const orbit = /** @type {any} */ (get(orbitControls));
	if (orbit) orbit.maxDistance = maxOrbitDistance(far);
}

/** @param {number} v */
export function setCameraNear(v) {
	const n = Math.min(Math.max(v, 0.001), 10);
	cameraNear.set(n);
	try {
		localStorage.setItem('cameraNear', String(n));
	} catch {}
	applyCameraClip();
}

/** @param {number} v */
export function setCameraFar(v) {
	const f = Math.min(Math.max(v, 10), FAR_CAP);
	cameraFar.set(f);
	try {
		localStorage.setItem('cameraFar', String(f));
	} catch {}
	applyCameraClip();
}

// ---------------------------------------------------------------------------
// 16-P4: the rest of the viewport-camera prefs. The clip planes were the only
// tunable here; orbit feel (speeds, damping, invert) was hardcoded in
// Scene.svelte's <OrbitControls>. All LOCAL, same as near/far.

export const DEFAULT_ORBIT = { rotateSpeed: 1, zoomSpeed: 1, panSpeed: 1, damping: true, invertY: false };

function storedOrbit() {
	try {
		const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('orbitPrefs') : null;
		return raw ? { ...DEFAULT_ORBIT, ...JSON.parse(raw) } : { ...DEFAULT_ORBIT };
	} catch {
		return { ...DEFAULT_ORBIT };
	}
}

/** @type {import('svelte/store').Writable<typeof DEFAULT_ORBIT>} */
export const orbitPrefs = writable(storedOrbit());

/** Push the prefs onto the live OrbitControls (call after any change). */
export function applyOrbitPrefs() {
	const prefs = get(orbitPrefs);
	const orbit = /** @type {any} */ (get(orbitControls));
	if (!orbit) return;
	// invertY flips the vertical orbit direction; three has no flag for it, so the
	// sign rides rotateSpeed — the only place that reads it
	orbit.rotateSpeed = prefs.rotateSpeed * (prefs.invertY ? -1 : 1);
	orbit.zoomSpeed = prefs.zoomSpeed;
	orbit.panSpeed = prefs.panSpeed;
	orbit.enableDamping = prefs.damping;
}

/** @param {Partial<typeof DEFAULT_ORBIT>} patch */
export function setOrbitPrefs(patch) {
	orbitPrefs.update((value) => ({ ...value, ...patch }));
	try {
		localStorage.setItem('orbitPrefs', JSON.stringify(get(orbitPrefs)));
	} catch {}
	applyOrbitPrefs();
}

export function resetOrbitPrefs() {
	orbitPrefs.set({ ...DEFAULT_ORBIT });
	try {
		localStorage.setItem('orbitPrefs', JSON.stringify(DEFAULT_ORBIT));
	} catch {}
	applyOrbitPrefs();
}

// re-apply whenever the controls (re)mount — VR exit and spectator mode both
// unmount them
orbitControls.subscribe(() => applyOrbitPrefs());
