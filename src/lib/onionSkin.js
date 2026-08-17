// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, objectsGroup, selectedObject } from '../stores/sceneStore';
import { activeClip, keyTimes, poseAt, ghostBase, playheadOf } from './animationPreview';
import { wireframeActive } from './viewMode';

// 17-E F6: ONION SKIN — faint copies of the object at the neighbouring keys, so you
// can see where a movement came from and where it is going while you work on the
// frame in between.
//
// Built on the colliderHelpers / cameraHelpers pattern, and for the same reason
// (golden rule 5): the ghosts are SCENE-ROOT clones, never children of the object,
// or they would ride the GLTF sync and duplicate on every peer. They are also
// LOCAL-only in the wider sense — like `showColliders`, nothing here replicates and
// nothing reaches a save.
//
// OFF by default: it is a working aid, and a scene full of half-transparent copies
// is not what someone opening a file wants to see.

export const showOnionSkin = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('showOnionSkin') === 'true'
);

/** @param {boolean} on */
export function setOnionSkin(on) {
	showOnionSkin.set(on);
	try {
		localStorage.setItem('showOnionSkin', on ? 'true' : 'false');
	} catch {}
}

const PAST = 0x60a5fa; // cool blue behind you
const FUTURE = 0xfbbf24; // warm amber ahead
const OPACITY = 0.28;

/** @type {any} */ let ghostRoot = null;
/** @type {{object: any, uuid: string, ghosts: {mesh: any, material: any, when: number}[], key: string}|null} */
let live = null;

/**
 * A faint copy of `object`'s renderable subtree.
 *
 * `depthWrite` stays TRUE deliberately. The documented trap is that anything drawn
 * with depthWrite false loses the postprocessing passes — the outline and AO read
 * the depth buffer, so the AO of whatever sits behind a non-writing surface gets
 * painted across its face. A low-opacity depth-WRITING material is the honest
 * trade: it occludes a little, and it composites correctly.
 *
 * Each ghost gets its OWN material instance, so two ghosts cannot fight over a
 * shared one and an animated look channel tints only the ghost it belongs to.
 * @param {any} object @param {number} colour @param {number} [bias] depth-sort rank
 */
function buildGhost(object, colour, bias = 0) {
	const material = new THREE.MeshBasicMaterial({
		color: colour,
		transparent: true,
		opacity: OPACITY,
		depthWrite: true,
		side: THREE.FrontSide,
		// A ghost sits ON the object whenever the movement between two keys is small,
		// and two almost-coplanar surfaces at equal depth SHIMMER — the classic
		// z-fight, reported as "they glitch like two planes in the same place".
		// Pushing the ghost's fragments slightly FURTHER in depth settles it: where
		// the two coincide the real object simply wins, and where the ghost really is
		// in front it still draws. The standard fix for coplanar overlay geometry,
		// and it keeps `depthWrite: true` — turning that off would lose the
		// postprocessing passes (the documented AO/outline trap above).
		//
		// Each ghost takes its OWN bias, so two ghosts cannot fight each other
		// either: they layer in a fixed order instead of flickering between frames.
		polygonOffset: true,
		polygonOffsetFactor: 1 + bias,
		polygonOffsetUnits: 1 + bias
	});
	const clone = object.clone(true);
	clone.traverse((/** @type {any} */ node) => {
		// anything that HAS a material takes the ghost one. Listing types
		// (isMesh/isLine/isPoints) missed Sprites, which then kept a reference to the
		// REAL material — so that part of the ghost drew at full strength and no
		// amount of re-asserting the ghost material could dim it.
		if (node.material) node.material = material;
		// a ghost is a picture, not an object: strip everything that would make it
		// behave like one, but KEEP `origin` — poseAt turns a hinged door about it,
		// so a ghost without it swings from the wrong point
		const origin = node.userData?.origin;
		node.userData = origin ? { origin } : {};
		node.castShadow = false;
		node.receiveShadow = false;
	});
	clone.name = 'onion-ghost';
	return { mesh: clone, material };
}

/** stable identity of what is BUILT — the clones are rebuilt only when this changes */
function keyOf(/** @type {string} */ uuid, /** @type {any} */ clip, /** @type {number[]} */ times) {
	return [uuid, clip?.name ?? '', clip?.tracks?.length ?? 0, times.join(',')].join('|');
}

/** The key times either side of the playhead: the previous one and the next one.
 * @param {number[]} times @param {number} head */
function neighbours(times, head) {
	/** @type {number[]} */
	const out = [];
	let prev = null;
	let next = null;
	for (const t of times) {
		if (t < head - 1e-6) prev = t;
		else if (t > head + 1e-6) {
			next = t;
			break;
		}
	}
	if (prev !== null) out.push(prev);
	if (next !== null) out.push(next);
	return out;
}

function clearGhosts() {
	if (!live) return;
	for (const ghost of live.ghosts) {
		ghostRoot?.remove(ghost.mesh);
		ghost.material.dispose();
		// the clone shares its source GEOMETRY, so disposing it here would destroy
		// the real object's mesh — only the materials this module made are ours
	}
	live = null;
}

/**
 * Per-frame from Scene's useTask. Cheap when off (one store read) and cheap when on:
 * the clones are rebuilt only when the object, clip or bracketing keys change, and
 * otherwise just re-posed.
 */
export function updateOnionSkin() {
	const scene = get(globalScene);
	if (!scene) return;
	const on = get(showOnionSkin) && !wireframeActive();
	const object = /** @type {any} */ (get(selectedObject));
	const uuid = object?.uuid;
	if (!on || !uuid) {
		if (live) clearGhosts();
		if (ghostRoot) ghostRoot.visible = false;
		return;
	}
	const clip = activeClip(uuid);
	const times = clip ? keyTimes(uuid) : [];
	const head = clip ? playheadOf(uuid) : 0;
	const want = clip ? neighbours(times, head) : [];
	if (!want.length) {
		if (live) clearGhosts();
		if (ghostRoot) ghostRoot.visible = false;
		return;
	}
	if (!ghostRoot) {
		ghostRoot = new THREE.Group();
		ghostRoot.name = 'onion-skin';
		scene.add(ghostRoot);
	}
	ghostRoot.visible = true;

	const key = keyOf(uuid, clip, want);
	if (!live || live.key !== key || live.object !== object) {
		clearGhosts();
		/** @type {{mesh: any, material: any, when: number}[]} */
		const ghosts = [];
		want.forEach((when, index) => {
			// index = the depth-sort rank: every ghost sits behind the real object, and
			// behind the ghost built before it, so nothing shimmers against anything
			const built = buildGhost(object, when < head ? PAST : FUTURE, index);
			ghostRoot.add(built.mesh);
			ghosts.push({ ...built, when });
		});
		live = { object, uuid, ghosts, key };
	}

	// pose each ghost at its key, then lift the LOCAL pose poseAt wrote into the
	// object's parent frame: the ghosts live at the scene root, so a nested object's
	// ghost would otherwise ignore every transform above it
	const base = ghostBase(uuid, object);
	const parent = object.parent;
	if (parent) parent.updateMatrixWorld();
	object.updateMatrixWorld();
	object.matrixWorld.decompose(objectPos, objectQuat, objectScale);
	for (const ghost of live.ghosts) {
		if (!clip) break;
		poseAt(ghost.mesh, clip, ghost.when, base);
		if (parent) {
			ghost.mesh.updateMatrix();
			composed.multiplyMatrices(parent.matrixWorld, ghost.mesh.matrix);
			composed.decompose(ghost.mesh.position, ghost.mesh.quaternion, ghost.mesh.scale);
		}
		// poseAt may have driven look channels (opacity, colour) onto the ghost's own
		// material — a ghost is meant to read as a ghost, so its faintness wins
		ghost.material.opacity = OPACITY;
		if (!ghost.material.transparent) {
			ghost.material.transparent = true;
			ghost.material.needsUpdate = true; // transparency is a render-program change
		}
		ghost.material.color.setHex(ghost.when < head ? PAST : FUTURE);
		// A ghost standing exactly where the object stands is not a ghost, it is a
		// second copy of it — and two of those at 28% over the real thing read as one
		// slightly odd SOLID object (reported as "onion skin shows the full object").
		// That is what happens whenever the clip drives only LOOK channels, or the
		// neighbouring keys hold the same pose: there is no motion to show. Onion
		// skin is a motion aid, so a ghost with nothing to say hides itself.
		ghost.mesh.visible = !sameTransform(ghost.mesh);
	}
}

const objectPos = new THREE.Vector3();
const objectQuat = new THREE.Quaternion();
const objectScale = new THREE.Vector3();
const ghostPos = new THREE.Vector3();
const ghostQuat = new THREE.Quaternion();
const ghostScale = new THREE.Vector3();

/** Is this ghost sitting exactly on the object it copies? @param {any} mesh */
function sameTransform(mesh) {
	mesh.updateMatrixWorld();
	mesh.matrixWorld.decompose(ghostPos, ghostQuat, ghostScale);
	return (
		ghostPos.distanceToSquared(objectPos) < 1e-8 &&
		Math.abs(ghostQuat.dot(objectQuat)) > 1 - 1e-6 &&
		ghostScale.distanceToSquared(objectScale) < 1e-8
	);
}

const composed = new THREE.Matrix4();

/** What is on screen, for the settings row and for checks. */
export function onionSkinDebug() {
	return {
		on: get(showOnionSkin),
		ghosts: live ? live.ghosts.map((g) => ({ when: g.when, colour: g.material.color.getHex() })) : [],
		root: !!ghostRoot && ghostRoot.visible
	};
}
