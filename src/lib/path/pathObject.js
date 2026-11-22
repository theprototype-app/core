// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { isPathObject, newPathRecord, PATH_COLOR } from './pathCore.js';
import { buildSplineGeometry } from '../splineTube.js';
import { pathOfObject } from './pathRuntime.js';
import { editingPathUuid, pathScrub, pathSelectedPoints } from './pathState.js';

// 78 F4 — THE PATH OBJECT IN THE SCENE, the THREE half (a LEAF over three + the path leaves;
// geometries.svelte.js stamps through it, Scene.svelte ticks it once a frame).
//
//   - `stampPathObject`: what `/create Path` makes — a thin spline tube carrying the Path record,
//     deterministic on every peer (the FlowPath / Text precedent), a SENSOR (a guide line is
//     never a floor or a wall), no shadow.
//   - `tickPathObjects`: per frame, LOCAL only —
//       · PLAY hides every Path whose record says `showInPlay: false` (the default): the
//         material stops drawing and the object stops answering rays, and both come back in
//         the editor. Never `object.visible` (it serializes, and flow effects own it).
//       · NUMBERED POINTS on the selected / edited Path(s) (scene-root sprites, never children:
//         children would ride every save), with a mark on points that wait or fire an event.
//       · the SCRUB GHOST: an arrow at the pose `pathScrub` asks for (the Inspector's slider).

const LABEL_LAYER_NAME = 'path-labels';
const GHOST_NAME = 'path-scrub-ghost';

/**
 * Stamp a fresh Path (from the replicated /create, deterministic on every peer).
 * @param {any} object a Mesh
 */
export function stampPathObject(object) {
	object.name = 'Path';
	const rec = newPathRecord();
	object.userData.spline = rec;
	const geometry = buildSplineGeometry(rec);
	if (geometry) {
		object.geometry?.dispose?.();
		object.geometry = geometry;
	}
	const m = object.material;
	if (m && !Array.isArray(m)) {
		m.color?.set?.(PATH_COLOR);
		if ('roughness' in m) m.roughness = 0.6;
		if ('emissive' in m) m.emissive?.set?.('#3a2a00');
	}
	object.castShadow = false;
	object.receiveShadow = false;
	object.userData.shadow = false;
	// a guide line: pass-through for bodies (On Enter still works on it)
	object.userData.physics = { mode: 'static', sensor: true };
}

/** the Path line builder for an empty create (customGeometries) */
export function pathGeometry() {
	return buildSplineGeometry(newPathRecord());
}

// ---- per frame -------------------------------------------------------------------------------

/** objects hidden for Play by us: uuid -> object @type {Map<string, any>} */
const hidden = new Map();
/** @type {any} */ let labelGroup = null;
/** @type {any} */ let ghost = null;
/** what the labels were last built for (skip rebuilding an unchanged frame) */
let labelSig = '';
const NOOP_RAYCAST = () => {};

/** @param {any} object @param {boolean} hide */
function setHiddenForPlay(object, hide) {
	const m = object.material;
	if (hide) {
		if (hidden.has(object.uuid)) return;
		hidden.set(object.uuid, object);
		if (m && !Array.isArray(m)) m.visible = false;
		object.raycast = NOOP_RAYCAST;
	} else {
		// a save taken mid-Play (autosave) wrote the hidden material: the editor shows it again
		if (!hidden.has(object.uuid)) {
			if (m && !Array.isArray(m) && m.visible === false) m.visible = true;
			return;
		}
		hidden.delete(object.uuid);
		if (m && !Array.isArray(m)) m.visible = true;
		// back to the prototype's raycast
		if (Object.prototype.hasOwnProperty.call(object, 'raycast')) delete object.raycast;
	}
}

/** a numbered sprite @param {string} text @param {boolean} marked @param {number} size */
function labelSprite(text, marked, size) {
	const canvas = document.createElement('canvas');
	canvas.width = 128;
	canvas.height = 64;
	const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
	ctx.fillStyle = marked ? 'rgba(122, 58, 0, 0.92)' : 'rgba(20, 20, 24, 0.85)';
	const r = 14;
	ctx.beginPath();
	ctx.moveTo(r, 0);
	ctx.arcTo(128, 0, 128, 64, r);
	ctx.arcTo(128, 64, 0, 64, r);
	ctx.arcTo(0, 64, 0, 0, r);
	ctx.arcTo(0, 0, 128, 0, r);
	ctx.fill();
	ctx.fillStyle = '#ffffff';
	ctx.font = 'bold 34px system-ui, sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(text, 64, 34);
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
	sprite.scale.set(size * 2, size, 1);
	sprite.renderOrder = 1000;
	return sprite;
}

function disposeLabels() {
	if (!labelGroup) return;
	labelGroup.parent?.remove(labelGroup);
	labelGroup.traverse((/** @type {any} */ o) => {
		o.material?.map?.dispose?.();
		o.material?.dispose?.();
	});
	labelGroup = null;
	labelSig = '';
}

/** @param {any} scene @param {any[]} paths @param {number[]} picked */
function updateLabels(scene, paths, picked) {
	if (!paths.length) {
		disposeLabels();
		return;
	}
	const views = paths.map((o) => pathOfObject(o)).filter(Boolean);
	const sig = JSON.stringify(views.map((v) => [v?.uuid, v?.points.map((p) => [p.pos.map((x) => +x.toFixed(3)), p.wait ?? 0, p.event ?? '', p.gap ? 1 : 0])])) + '|' + picked.join(',');
	if (sig === labelSig && labelGroup?.parent === scene) return;
	disposeLabels();
	labelSig = sig;
	labelGroup = new THREE.Group();
	labelGroup.name = LABEL_LAYER_NAME;
	labelGroup.userData.vrOverlay = false;
	for (const v of views) {
		if (!v) continue;
		const box = new THREE.Box3();
		for (const p of v.points) box.expandByPoint(new THREE.Vector3(...p.pos));
		const size = THREE.MathUtils.clamp(box.getSize(new THREE.Vector3()).length() * 0.03, 0.12, 0.6);
		v.points.forEach((p, i) => {
			const bits = [String(i + 1)];
			if (p.wait) bits.push(p.wait + 's');
			if (p.gap) bits.push('jump');
			const sprite = labelSprite(bits.join(' · '), !!p.event || picked.includes(i), size);
			sprite.position.set(p.pos[0], p.pos[1] + size * 1.2, p.pos[2]);
			sprite.userData.pathLabel = { uuid: v.uuid, index: i };
			labelGroup.add(sprite);
		});
	}
	scene.add(labelGroup);
}

/** @param {any} scene @param {any} root */
function updateGhost(scene, root) {
	const scrub = get(pathScrub);
	const object = scrub ? root?.getObjectByProperty?.('uuid', scrub.uuid) : null;
	const view = object ? pathOfObject(object) : null;
	const pose = view?.poseAt(scrub?.t ?? 0, { start: 0 });
	if (!pose) {
		if (ghost) {
			ghost.parent?.remove(ghost);
			ghost.traverse((/** @type {any} */ o) => {
				o.geometry?.dispose?.();
				o.material?.dispose?.();
			});
			ghost = null;
		}
		return;
	}
	if (!ghost) {
		ghost = new THREE.Group();
		ghost.name = GHOST_NAME;
		const mat = new THREE.MeshBasicMaterial({ color: 0x7cc4ff, transparent: true, opacity: 0.55, depthTest: false });
		const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.9, 4, 10), mat);
		body.position.y = 0.67;
		const nose = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.4, 12), mat.clone());
		nose.rotation.x = Math.PI / 2;
		nose.position.set(0, 1.0, 0.35);
		ghost.add(body, nose);
		ghost.renderOrder = 998;
		ghost.userData.vrOverlay = false;
	}
	if (ghost.parent !== scene) scene.add(ghost);
	ghost.position.set(pose.p[0], pose.p[1], pose.p[2]);
	ghost.rotation.set(0, pose.yaw, 0);
}

/**
 * Once a frame from Scene.svelte. Cheap when there are no Paths: one traverse of the objects.
 * @param {any} scene the THREE scene (labels and the ghost live at its root)
 * @param {any} root objectsGroup
 * @param {{playing: boolean, selected: string[]}} state
 */
export function tickPathObjects(scene, root, state) {
	if (!scene || !root) return;
	/** @type {any[]} */
	const paths = [];
	root.traverse((/** @type {any} */ o) => {
		if (isPathObject(o)) paths.push(o);
	});
	const seen = new Set();
	for (const o of paths) {
		seen.add(o.uuid);
		setHiddenForPlay(o, state.playing && !o.userData.spline.path.showInPlay);
	}
	// a Path deleted (or un-pathed) while hidden: forget it
	for (const [uuid, o] of hidden) if (!seen.has(uuid)) {
		hidden.delete(uuid);
		const m = o.material;
		if (m && !Array.isArray(m)) m.visible = true;
		if (Object.prototype.hasOwnProperty.call(o, 'raycast')) delete o.raycast;
	}
	if (state.playing) {
		disposeLabels();
		if (ghost) {
			ghost.parent?.remove(ghost);
			ghost = null;
		}
		return;
	}
	const editing = get(editingPathUuid);
	const shown = paths.filter((o) => o.uuid === editing || state.selected.includes(o.uuid));
	updateLabels(scene, shown, editing ? get(pathSelectedPoints) : []);
	updateGhost(scene, root);
}

/** test/debug view @param {any} root */
export function pathObjectsDebug(root) {
	/** @type {any[]} */
	const out = [];
	root?.traverse?.((/** @type {any} */ o) => {
		if (!isPathObject(o)) return;
		out.push({ uuid: o.uuid, name: o.name, hidden: hidden.has(o.uuid), materialVisible: o.material?.visible !== false });
	});
	return { paths: out, labels: labelGroup?.children.length ?? 0, ghost: !!ghost };
}
