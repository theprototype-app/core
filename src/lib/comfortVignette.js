// 31 (K3) — THE COMFORT VIGNETTE. A dark ring closing in around the view while the player
// is moved ARTIFICIALLY (the stick walking/flying them, smooth turning) — the standard VR
// comfort aid, because vection with a still body is what makes people sick. Physical head
// motion and teleports never trigger it (the first is real, the second is instant).
//
// Per game, off by default (`vignette` in gameSettings). vrControls notes the two motion
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
import { vrComfortVignette } from './vr/prefs.js';

let stick = 0;
let turn = 0;
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
 * The strength the ring should head toward, 0..1. Pure; exported for the suites. A stick
 * inside its deadzone and no turn = 0.
 * @param {number} stickMag @param {number} turnRad radians applied this frame @param {number} dt seconds
 */
export function vignetteTarget(stickMag, turnRad, dt) {
	const move = stickMag > 0.2 ? Math.min(1, (stickMag - 0.2) / 0.6) : 0;
	const rate = dt > 0 ? turnRad / dt : 0; // radians per second
	const spin = Math.min(1, rate / 1.2);
	return Math.max(move, spin);
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
	// a game can still turn it on for itself through its own setting
	const on = !!head && (get(vrComfortVignette) || (gameFeelActive() && get(gameSettingValues).vignette === true));
	const target = on ? vignetteTarget(stick, turn, dt) : 0;
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

/** the suites' view */
export function vignetteDebug() {
	return { strength, visible: !!mesh?.visible, stick, turn };
}
