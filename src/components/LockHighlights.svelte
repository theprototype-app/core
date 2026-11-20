<script>
	import * as THREE from 'three';
	import { T, useTask } from '@threlte/core';
	import { lockedObjects, objectsGroup } from '../stores/sceneStore';
	import { peers, userdata } from '../stores/appStore';
	import { peerColor, nameOf } from '$lib/lockControl';
	// 30b P1: who-holds-what boxes are editor information - none in Interact/Play
	import { editorHelpersShown } from '$lib/helperLayer';

	// Wireframe box around every object locked by ANOTHER peer, tinted with
	// that peer's color (same hash as pings/cursors). Boxes track the object
	// every frame; nothing here touches replicated materials.
	//
	// 80a K1: plus a small AVATAR of the holder above the object (their colour, their initial, the
	// same drawing as PeerAvatar's disc), so people see who has it before they click. A fixed size on
	// screen (sizeAttenuation off), drawn over the scene. The group is a helper: it lives under the
	// scene root, never in objectsGroup, so no save or export carries it, and it hides in Play.
	// Only the HOLDER of an object gets a box and an avatar: a losing claim (two peers selecting at
	// once, 80a K3) is a row in the table for a moment and draws nothing.

	const group = new THREE.Group();
	group.name = 'lock-highlights';

	/** @type {Map<string, any>} lock key -> Box3Helper */
	const helpers = new Map();
	/** @type {Map<string, THREE.Sprite>} lock key -> avatar sprite */
	const avatars = new Map();
	/** @type {Map<string, THREE.SpriteMaterial>} holder + initial -> material (textures are per person) */
	const avatarMats = new Map();
	const AVATAR_SIZE = 0.045; // of the viewport height
	const avatarAt = new THREE.Vector3();

	/** @param {string} holder */
	function initialOf(holder) {
		const label = String(nameOf(holder) || '').trim();
		const g = /^Guest (\d+)$/.exec(label);
		if (g) return g[1].slice(0, 2);
		return label.charAt(0).toUpperCase() || '?';
	}

	/** @param {string} holder */
	function avatarMaterial(holder) {
		const initial = initialOf(holder);
		const key = holder + '\n' + initial;
		let mat = avatarMats.get(key);
		if (mat) return mat;
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 64;
		const ctx = canvas.getContext('2d');
		if (ctx) {
			ctx.fillStyle = peerColor(holder);
			ctx.beginPath();
			ctx.arc(32, 32, 28, 0, Math.PI * 2);
			ctx.fill();
			ctx.lineWidth = 4;
			ctx.strokeStyle = 'rgba(0,0,0,0.55)'; // tokens-ok: drawn into a canvas texture (the avatar's rim)
			ctx.stroke();
			ctx.fillStyle = '#10131a'; // tokens-ok: drawn into a canvas texture, not UI chrome
			ctx.font = '600 30px system-ui, sans-serif';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(initial, 32, 34);
		}
		const tex = new THREE.CanvasTexture(canvas);
		tex.colorSpace = THREE.SRGBColorSpace;
		mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true });
		avatarMats.set(key, mat);
		return mat;
	}

	useTask(() => {
		group.visible = $editorHelpersShown;
		$userdata; // a renamed holder redraws its initial
		/** @type {any} */
		const peer = $peers;
		const scene = $objectsGroup;
		const wanted = new Map();
		if (scene && peer) {
			const seen = new Set();
			for (const [holder, uuid] of $lockedObjects) {
				// the table is in holder order (sortLockTable): the first row of an object is its holder
				if (seen.has(uuid)) continue;
				seen.add(uuid);
				if (holder === peer.peer?.id) continue;
				const target = scene.getObjectByProperty('uuid', uuid);
				if (target) wanted.set(holder + ':' + uuid, { holder, target });
			}
		}
		// drop stale helpers
		for (const [key, helper] of helpers) {
			if (!wanted.has(key)) {
				group.remove(helper);
				helper.dispose?.();
				helpers.delete(key);
			}
		}
		for (const [key, sprite] of avatars) {
			if (!wanted.has(key)) {
				group.remove(sprite);
				avatars.delete(key);
			}
		}
		// add/update
		for (const [key, { holder, target }] of wanted) {
			let helper = helpers.get(key);
			if (!helper) {
				helper = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(peerColor(holder)));
				helpers.set(key, helper);
				group.add(helper);
			}
			helper.box.setFromObject(target);
			let sprite = avatars.get(key);
			const mat = avatarMaterial(holder);
			if (!sprite) {
				sprite = new THREE.Sprite(mat);
				sprite.name = 'lock-avatar';
				sprite.userData.lockAvatar = holder;
				sprite.renderOrder = 999;
				sprite.center.set(0.5, 0);
				sprite.scale.set(AVATAR_SIZE, AVATAR_SIZE, 1);
				sprite.raycast = () => {}; // never picked: a click goes to the object under it
				avatars.set(key, sprite);
				group.add(sprite);
			} else if (sprite.material !== mat) sprite.material = mat;
			const box = helper.box;
			if (!box.isEmpty()) {
				box.getCenter(avatarAt);
				avatarAt.y = box.max.y;
				sprite.position.copy(avatarAt);
			}
		}
	});
</script>

<T is={group} />
