<script>
	// 60 Q5: THE REFERENCE IMAGES IN THE VIEWPORT. Mounted inside the world rig (so a VR world grab
	// carries them with the content) but OUTSIDE `sceneObjects` — nothing under here is picked,
	// selected, synced, saved, exported or published (the underlays.js header). Each plane:
	//  · sits on the editor HELPER layer (helperLayer.js), so only the editor camera ever draws it —
	//    the play camera, camera previews, the PiP, gallery captures and clean recordings never do;
	//  · is ALSO switched off in Play and Interact, whatever the "helpers in Play" debug toggle says;
	//  · has a no-op raycast, so even a ray cast over the whole scene cannot land on it.
	import { T } from '@threlte/core';
	import * as THREE from 'three';
	import { onDestroy } from 'svelte';
	import { underlays, setUnderlayScene, loadUnderlays, underlayHeight } from '$lib/underlays';
	import { markHelper } from '$lib/helperLayer';
	import { currentLevel } from '$lib/levels';
	import { isLocked, editorMode, pokeScene } from '../stores/sceneStore';

	const root = new THREE.Group();
	root.name = 'reference-underlays';
	root.userData.underlay = true;

	/** @type {Map<string, {mesh: any, src: string, texture: any}>} */
	const live = new Map();
	const loader = new THREE.TextureLoader();
	const noRaycast = () => {};

	$effect(() => {
		setUnderlayScene($currentLevel?.name ?? '');
	});
	void loadUnderlays();

	const playing = $derived($isLocked === true || $editorMode === 'interact');

	function build(/** @type {any} */ u) {
		const texture = loader.load(u.src, () => pokeScene());
		texture.colorSpace = THREE.SRGBColorSpace;
		const material = new THREE.MeshBasicMaterial({
			map: texture,
			transparent: true,
			opacity: u.opacity,
			side: THREE.DoubleSide,
			toneMapped: false,
			// a ground underlay must not fight the grid or a floor at the same height
			polygonOffset: true,
			polygonOffsetFactor: -1,
			polygonOffsetUnits: -4
		});
		const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
		mesh.name = 'underlay:' + u.id;
		mesh.userData.underlay = u.id;
		mesh.raycast = noRaycast;
		mesh.renderOrder = -1;
		markHelper(mesh);
		return { mesh, src: u.src, texture };
	}

	function dispose(/** @type {{mesh: any, texture: any}} */ entry) {
		root.remove(entry.mesh);
		entry.mesh.geometry.dispose();
		entry.mesh.material.dispose();
		entry.texture.dispose();
	}

	$effect(() => {
		const list = $underlays;
		const hide = playing;
		const seen = new Set();
		for (const u of list) {
			seen.add(u.id);
			let entry = live.get(u.id);
			if (entry && entry.src !== u.src) {
				dispose(entry);
				entry = undefined;
			}
			if (!entry) {
				entry = build(u);
				live.set(u.id, entry);
				root.add(entry.mesh);
			}
			const m = entry.mesh;
			m.position.fromArray(u.position);
			m.quaternion.fromArray(u.quaternion);
			m.scale.set(u.width, underlayHeight(u), 1);
			m.material.opacity = u.opacity;
			m.visible = u.visible && !hide;
			m.userData.owner = u.owner ?? '';
		}
		for (const [id, entry] of live) {
			if (seen.has(id)) continue;
			dispose(entry);
			live.delete(id);
		}
		pokeScene();
	});

	onDestroy(() => {
		for (const entry of live.values()) dispose(entry);
		live.clear();
	});
</script>

<T is={root} />
