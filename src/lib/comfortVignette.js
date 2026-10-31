// 31 (K3) — THE COMFORT VIGNETTE. A dark ring closing in around the view while the player
// is moved ARTIFICIALLY (the stick walking/flying them, smooth turning) — the standard VR
// comfort aid, because vection with a still body is what makes people sick. Physical head
// motion and teleports never trigger it (the first is real, the second is instant).
//
// Per game, off by default (`vignette` in gameSettings). 53 (A7): a LEVEL — Off / Low / High on the
// device (Settings ▸ VR ▸ Comfort), Default / Off / Low / High per game (Default = the device's);
// Low closes to about half of High's ring. vrControls notes the two motion
// sources every XR frame (`noteArtificialMotion`); the VR game panel's per-frame call poses
// the ring head-locked (`vignetteFrame`). LOCAL, scene-root, default layer (both eyes),
// never in objectsGroup. One mesh and one canvas texture, built once: nothing allocates per
// frame.
//
// A LEAF: three + svelte/store + gameSettings + gameFeel + sceneStore + vr/prefs (36).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene } from '../stores/sceneStore';
import { gameSettingValues } from './gameSettings';
import { gameFeelActive } from './gameFeel';
import { vrComfortVignette, vignetteLevel } from './vr/prefs.js';

let stick = 0;
let turn = 0;
/** 52 (V5): the two-grip world gesture's rate (log-scale + yaw, per second) and when it was heard */
let gesture = 0;
let gestureAt = -Infinity;
let strength = 0;
/** @type {THREE.Mesh | null} */
let mesh = null;

/**
 * vrControls, every XR frame: the locomotion stick's deflection (0..1) and the smooth turn
 * applied this frame (radians). @param {number} stickMag @param {number} turnRad
 */
export function noteArtificialMotion(stickMag, turnRad) {
	stick = Math.min(1, Math.max(0, Number(stickMag) || 0));
	turn = Math.max(0, Number(turnRad) || 0);
}

/**
 * 52 (V5): the two-grip world grab, every frame it runs — how fast the world scales and turns around you
 * (|d ln scale| + |d yaw|, per second). Scaling the world is vection like walking: the ring closes in.
 * @param {number} rate
 */
export function noteWorldGesture(rate) {
	gesture = Math.max(0, Number(rate) || 0);
	gestureAt = performance.now();
}

/**
 * The strength the ring should head toward, 0..1. Pure; exported for the suites. A stick
 * inside its deadzone and no turn = 0.
 * @param {number} stickMag @param {number} turnRad radians applied this frame @param {number} dt seconds
 * @param {number} [worldRate] 52 (V5): the world gesture's rate (noteWorldGesture); ~1/s = full ring
 */
export function vignetteTarget(stickMag, turnRad, dt, worldRate = 0) {
	const move = stickMag > 0.2 ? Math.min(1, (stickMag - 0.2) / 0.6) : 0;
	const rate = dt > 0 ? turnRad / dt : 0; // radians per second
	const spin = Math.min(1, rate / 1.2);
	const world = worldRate > 0.08 ? Math.min(1, (worldRate - 0.08) / 0.9) : 0; // a trembling hand rings nothing
	return Math.max(move, spin, world);
}

/** Ease `current` toward `target`: fast in, slower out. Pure. @param {number} current @param {number} target @param {number} dt */
export function easeVignette(current, target, dt) {
	const k = target > current ? 8 : 3;
	return current + (target - current) * Math.min(1, dt * k);
}

function build() {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 256;
	const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
	const grad = g.createRadialGradient(128, 128, 60, 128, 128, 128);
	grad.addColorStop(0, 'rgba(0,0,0,0)');
	grad.addColorStop(0.55, 'rgba(0,0,0,0.55)');
	grad.addColorStop(1, 'rgba(0,0,0,1)');
	g.fillStyle = grad;
	g.fillRect(0, 0, 256, 256);
	const texture = new THREE.CanvasTexture(canvas);
	const m = new THREE.Mesh(
		new THREE.PlaneGeometry(1.1, 1.1),
		new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, opacity: 0 })
	);
	m.name = 'vr-comfort-vignette';
	m.renderOrder = 1100; // over the scene AND the game panels: it frames what you see
	m.frustumCulled = false;
	m.visible = false;
	m.userData.localOnly = true;
	return m;
}

const _fwd = new THREE.Vector3();

/**
 * One frame: pose the ring 0.3 m in front of the eyes and set its strength. Returns the
 * strength shown. @param {{position: any, quaternion: any} | null} head @param {number} [dt]
 */
export function vignetteFrame(head, dt = 1 / 72) {
	// 36: the DEVICE setting (Settings ▸ VR ▸ Comfort) rings it everywhere — Edit, Interact, any scene;
	// a game can still turn it on (53: or off, or Low) for itself through its own setting
	level = vignetteLevelNow();
	const cap = LEVEL_CAP[level] ?? 0;
	const on = !!head && cap > 0;
	// the gesture rate counts only while it is fresh (the world grab stopped = no more notes)
	const worldRate = performance.now() - gestureAt < 120 ? gesture : 0;
	const target = on ? vignetteTarget(stick, turn, dt, worldRate) * cap : 0;
	strength = on ? easeVignette(strength, target, dt) : 0;
	if (!on && !mesh) return 0;
	if (!mesh) mesh = build();
	const scene = /** @type {any} */ (get(globalScene));
	if (scene && mesh.parent !== scene) scene.add(mesh);
	mesh.visible = on && strength > 0.02;
	if (mesh.visible && head) {
		_fwd.set(0, 0, -1).applyQuaternion(head.quaternion);
		mesh.position.copy(head.position).addScaledVector(_fwd, 0.3);
		mesh.quaternion.copy(head.quaternion);
		// a stronger vignette is a SMALLER clear window: scale the plane down as it closes in
		mesh.scale.setScalar(1.25 - 0.45 * strength);
		/** @type {any} */ (mesh.material).opacity = strength;
		mesh.updateMatrixWorld(true);
	}
	return strength;
}

/** 53 (A7): how far each level closes the ring (High = the ring as it always was) */
export const LEVEL_CAP = /** @type {Record<string, number>} */ ({ off: 0, low: 0.55, high: 1 });
/** @type {string} */
let level = 'off';

/**
 * The level in force: this game's own row (while playing it) unless it says Default, else the
 * device's. Pure over its arguments; exported for the suites.
 * @param {any} device @param {any} gameRow @param {boolean} inGame
 */
export function resolveVignetteLevel(device, gameRow, inGame) {
	const own = String(gameRow ?? 'default');
	if (inGame && (own === 'off' || own === 'low' || own === 'high')) return own;
	return vignetteLevel(device);
}
function vignetteLevelNow() {
	return resolveVignetteLevel(get(vrComfortVignette), get(gameSettingValues).vignette, gameFeelActive());
}

/** the suites' view */
export function vignetteDebug() {
	return { strength, visible: !!mesh?.visible, stick, turn, level, world: performance.now() - gestureAt < 120 ? gesture : 0 };
}
