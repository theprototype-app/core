// 41 G10: the customise panel's ISOLATED STUDIO — a neutral backdrop, a floor disc and a soft
// key light around YOUR character, with the scene hidden from the render. LOCAL to this screen:
// nothing here replicates, saves or undoes, and peers keep seeing your scene and your body.
//
// HIDING THE SCENE IS A RENDER-LAYER SWITCH, NOT AN EDIT. The camera is set to see only
// STUDIO_LAYER, which only the studio and the preview avatar enable — so no object's `visible`
// is written (that would replicate as a fact about the object and race every peer), nothing is
// removed, and leaving puts the camera's own mask back. three filters LIGHTS by the same layer
// test, so the scene's lights (and their shadow maps) stand down too, and the studio key light
// is the only one the character sees. The layer number: 1 and 2 are the WebXR eyes, 29-31 are
// taken (water selection, helpers, overload), postprocessing's selections count up from 2 —
// 28 is clear of all of them, and the studio never runs in a headset anyway.
//
// The colours are the THEME's (backdrop = --bg-app, floor = --surface-2), so the studio is a
// dark room in a dark theme and a light one in a light theme.

import * as THREE from 'three';

export const STUDIO_LAYER = 28;
export const STUDIO_NAME = 'character-studio';

/** @param {string} token @param {string} fallback css colour @returns {THREE.Color} */
function tokenColour(token, fallback) {
	const c = new THREE.Color(fallback);
	try {
		const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
		if (v) c.setStyle(v);
	} catch {
		/* not a colour three can parse (a color-mix): keep the fallback */
	}
	return c;
}

/** a soft round fade, for the floor disc's edge @returns {THREE.CanvasTexture} */
function discFade() {
	const size = 128;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
	const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	grad.addColorStop(0, 'white'); // an alpha MAP: only the grey level is read
	grad.addColorStop(0.62, 'white');
	grad.addColorStop(1, 'black');
	g.fillStyle = grad;
	g.fillRect(0, 0, size, size);
	return new THREE.CanvasTexture(canvas);
}

/** put a whole subtree on the studio layer (keeping its own bits) @param {THREE.Object3D} root */
export function joinStudioLayer(root) {
	root.traverse((node) => node.layers.enable(STUDIO_LAYER));
}

/**
 * Build the studio. Place it with `place(feet, yaw)`; recolour it with `retheme()` after a theme
 * change; `dispose()` frees everything it made.
 */
export function buildStudio() {
	const group = new THREE.Group();
	group.name = STUDIO_NAME;

	// the backdrop: a big inside-out sphere, a vertical gradient from the floor colour at the
	// horizon to the app background overhead and underfoot
	const skyGeo = new THREE.SphereGeometry(40, 48, 24);
	const skyMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
	const sky = new THREE.Mesh(skyGeo, skyMat);
	sky.name = `${STUDIO_NAME}-backdrop`;
	sky.renderOrder = -1000;
	sky.frustumCulled = false;
	group.add(sky);

	const floorMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, transparent: true, alphaMap: discFade(), fog: false });
	const floor = new THREE.Mesh(new THREE.CircleGeometry(1.7, 64), floorMat);
	floor.name = `${STUDIO_NAME}-floor`;
	floor.rotation.x = -Math.PI / 2;
	floor.receiveShadow = true;
	group.add(floor);

	// a soft key from the front-left above, a hemisphere fill, and a faint rim from behind
	const key = new THREE.DirectionalLight(0xffffff, 2.4);
	key.name = `${STUDIO_NAME}-key`;
	key.castShadow = true;
	key.shadow.mapSize.set(1024, 1024);
	key.shadow.radius = 4;
	key.shadow.bias = -0.0005;
	const sc = key.shadow.camera;
	sc.left = sc.bottom = -2.2;
	sc.right = sc.top = 2.2;
	sc.near = 0.5;
	sc.far = 14;
	group.add(key, key.target);
	const fill = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.1);
	fill.name = `${STUDIO_NAME}-fill`;
	group.add(fill);
	const rim = new THREE.DirectionalLight(0xffffff, 0.9);
	rim.name = `${STUDIO_NAME}-rim`;
	group.add(rim, rim.target);

	group.traverse((node) => node.layers.set(STUDIO_LAYER));

	function retheme() {
		const back = tokenColour('--bg-app', '#0b0e14');
		const floorColour = tokenColour('--surface-2', '#1b212d');
		const horizon = back.clone().lerp(floorColour, 0.55);
		const pos = skyGeo.getAttribute('position');
		const colours = new Float32Array(pos.count * 3);
		const tmp = new THREE.Color();
		for (let i = 0; i < pos.count; i++) {
			const y = pos.getY(i) / 40; // -1 underfoot .. 1 overhead
			tmp.copy(horizon).lerp(back, Math.min(1, Math.abs(y) * 1.6));
			colours[i * 3] = tmp.r;
			colours[i * 3 + 1] = tmp.g;
			colours[i * 3 + 2] = tmp.b;
		}
		skyGeo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
		floorMat.color.copy(floorColour);
	}
	retheme();

	/** stand the studio at the character's feet, lit relative to where it faces
	 * @param {number[]} feet [x, y, z] @param {number} yaw */
	function place(feet, yaw) {
		group.position.set(feet[0], feet[1], feet[2]);
		const fx = -Math.sin(yaw);
		const fz = -Math.cos(yaw);
		// local frame: forward (fx, fz), its right (-fz, fx)
		key.position.set(fx * 3 - -fz * 2.2, 4.2, fz * 3 - fx * 2.2);
		key.target.position.set(0, 1, 0);
		rim.position.set(-fx * 3, 3, -fz * 3);
		rim.target.position.set(0, 1.2, 0);
		floor.position.set(0, 0.004, 0);
	}

	function dispose() {
		group.removeFromParent();
		skyGeo.dispose();
		skyMat.dispose();
		floor.geometry.dispose();
		floorMat.alphaMap?.dispose();
		floorMat.dispose();
		key.shadow.map?.dispose();
		key.dispose();
		rim.dispose();
		fill.dispose();
	}

	return { group, place, retheme, dispose };
}
