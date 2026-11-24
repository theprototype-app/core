// 102b-papercuts: the BOOT half of the rounded box (roundedBox.js is a lazy chunk). Everything that must be
// synchronous lives here and is small: the Box builder the Geometry rows call, the ObjectLoader hook that
// reads a radius back, and the cheap "could this be one?" tests. When a radius is asked for before the chunk
// has arrived, the box is built SQUARE for that moment and the chunk then rounds every such box in the scene
// (`restoreRoundedBoxes`, keyed on the object's userData.geometryParams, which every rounded box carries).

import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';

/** the most corner segments a radius may ask for (each one is 4x the vertices of the last) */
export const MAX_RADIUS_SEGMENTS = 6;
/** the default corner segments (three's RoundedBoxGeometry default) */
export const DEFAULT_RADIUS_SEGMENTS = 2;

/** @type {any} */ let mod = null;
/** @type {Promise<any> | null} */ let loading = null;

/** the loaded chunk, or null */
export function roundedBoxModule() {
	return mod;
}

/** load the chunk once; when it lands, round every box that was built square while waiting */
export function loadRoundedBox() {
	loading ??= import('./roundedBox.js').then((m) => {
		mod = m;
		const group = get(objectsGroup);
		if (group && m.restoreRoundedBoxes(group)) pokeScene();
		return m;
	});
	return loading;
}

/** @param {any} v */
const hasRadius = (v) => Number(v) > 0 && Number.isFinite(Number(v));

/**
 * A Box's geometry from its params: rounded when `radius` > 0, else exactly the BoxGeometry it always was.
 * @param {any} p
 */
export function boxGeometryFor(p) {
	if (hasRadius(p?.radius)) {
		if (mod) return mod.roundedBoxGeometry(p);
		void loadRoundedBox();
	}
	return new THREE.BoxGeometry(p?.width, p?.height, p?.depth, p?.widthSegments, p?.heightSegments, p?.depthSegments);
}

// teach ObjectLoader (every parse path: files, peers, undo, prefabs) to read a radius back
{
	const Box = /** @type {any} */ (THREE.BoxGeometry);
	const stock = Box.fromJSON;
	Box.fromJSON = function (/** @type {any} */ data) {
		if (hasRadius(data?.radius)) {
			if (mod) return mod.roundedBoxGeometry({ ...data, radiusSegments: data.radiusSegments ?? DEFAULT_RADIUS_SEGMENTS });
			void loadRoundedBox();
		}
		return stock.call(this, data);
	};
}

/** a parsed tree: round any box that should be (the chunk's job; loads it only when a box asks) @param {any} root */
export function healRoundedBoxes(root) {
	let wants = false;
	root?.traverse?.((/** @type {any} */ o) => {
		if (o.userData?.geometryParams?.gtype === 'Box' && hasRadius(o.userData.geometryParams.params?.radius)) wants = true;
	});
	if (!wants) return;
	if (mod) mod.restoreRoundedBoxes(root);
	else void loadRoundedBox();
}

/** vertex counts a rounded box can have (non-indexed: 36 (2s+1)^2), for the cheap pre-test */
const COUNTS = new Set(Array.from({ length: MAX_RADIUS_SEGMENTS }, (_, i) => 36 * (2 * i + 3) * (2 * i + 3)));

/**
 * Could this geometry be a baked rounded box? The exact test lives in the chunk: null while it loads (the
 * scene is poked when it lands, so an Inspector reading this asks again).
 * @param {any} geometry @returns {any}
 */
export function matchRoundedBoxLazy(geometry) {
	const count = geometry?.attributes?.position?.count;
	if (!geometry?.isBufferGeometry || geometry.index || geometry.parameters || !COUNTS.has(count)) return null;
	if (mod) return mod.matchRoundedBox(geometry);
	void loadRoundedBox().then(() => pokeScene());
	return undefined;
}

/**
 * 102b-papercuts: is this baked mesh a rounded box the Inspector can OFFER to convert? The params, or null.
 * Cached per geometry (the check rebuilds one box to compare). Never converts anything.
 * @type {WeakMap<object, any>} */
const matchCache = new WeakMap();
/** @param {any} object */
export function roundedBoxOffer(object) {
	const g = object?.geometry;
	if (!object?.isMesh || !g || object.userData?.geometryParams || object.userData?.terrain || Array.isArray(object.material)) return null;
	if (g.type !== 'BufferGeometry') return null;
	if (!matchCache.has(g)) {
		const found = matchRoundedBoxLazy(g);
		if (found === undefined) return null; // the exact test is still loading (the scene is poked when it lands)
		matchCache.set(g, found);
	}
	return matchCache.get(g);
}
