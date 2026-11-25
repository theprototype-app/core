// 105-slots: tapping a slot row FLASHES its faces in the viewport — a short accent glow over the triangles of that
// slot, so "which faces are these" has an answer without opening Edit Mesh. LOCAL and transient: the overlay is a
// SCENE-ROOT mesh (the colliderHelpers / onionSkin pattern), never a child of the object, so no serializer, peer or
// undo step can see it. It shares the object's geometry (never disposed here) and follows the object's world matrix
// for its ~0.7 s life. Lazy: the slot list imports it on the first tap.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';

const LIFE_MS = 700;
/** @type {{mesh: any, raf: number} | null} */
let live = null;

function stop() {
	if (!live) return;
	cancelAnimationFrame(live.raf);
	live.mesh.removeFromParent();
	for (const m of live.mesh.material) m.dispose?.();
	live = null;
	pokeScene();
}

/** @returns {string} the accent colour as a literal (a THREE.Color cannot read a CSS variable) */
function accent() {
	try {
		const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
		return v || '#4f8cff';
	} catch {
		return '#4f8cff';
	}
}

/**
 * Flash the faces of slot `index` on `object`.
 * @param {any} object @param {number} index @returns {boolean} whether anything was drawn
 */
export function flashSlotFaces(object, index) {
	stop();
	const root = /** @type {any} */ (get(objectsGroup))?.parent;
	const geometry = object?.geometry;
	if (
		!root ||
		!geometry ||
		!Array.isArray(object.material) ||
		!(geometry.groups ?? []).some((/** @type {any} */ g) => (g.materialIndex || 0) === index)
	)
		return false;
	const glow = new THREE.MeshBasicMaterial({
		color: accent(),
		transparent: true,
		opacity: 0.55,
		depthTest: true,
		depthWrite: false,
		polygonOffset: true,
		polygonOffsetFactor: -2,
		polygonOffsetUnits: -2,
		side: THREE.DoubleSide
	});
	const hidden = new THREE.MeshBasicMaterial({ visible: false });
	const materials = object.material.map((/** @type {any} */ _m, /** @type {number} */ i) =>
		i === index ? glow : hidden
	);
	const mesh = new THREE.Mesh(geometry, materials);
	mesh.name = 'slot-flash';
	mesh.matrixAutoUpdate = false;
	mesh.renderOrder = 999;
	mesh.userData.helper = true;
	root.add(mesh);
	const start = performance.now();
	const tick = () => {
		if (!live) return;
		const t = (performance.now() - start) / LIFE_MS;
		if (t >= 1 || !object.parent) return stop();
		object.updateWorldMatrix(true, false);
		mesh.matrix.copy(object.matrixWorld);
		mesh.matrixWorld.copy(object.matrixWorld);
		glow.opacity = 0.55 * (1 - t);
		pokeScene();
		live.raf = requestAnimationFrame(tick);
	};
	live = { mesh, raf: requestAnimationFrame(tick) };
	return true;
}

/** test seam: is a flash showing, and for how many triangles */
export function slotFlashDebug() {
	if (!live) return { on: false };
	const idx = live.mesh.material.findIndex((/** @type {any} */ m) => m.visible !== false);
	const tris = (live.mesh.geometry.groups ?? [])
		.filter((/** @type {any} */ g) => (g.materialIndex || 0) === idx)
		.reduce((/** @type {number} */ n, /** @type {any} */ g) => n + g.count / 3, 0);
	return { on: true, slot: idx, tris };
}
