// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
// @ts-ignore - three addons ship no declarations here (project-wide)
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// @ts-ignore
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
// @ts-ignore
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { writable, get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { PACKS_BASE } from './packs';
import { hashBytes } from './explorer';

// 30c — KIT REFERENCES: a pack piece in a scene is a REFERENCE, not a copy.
//
// THE MEASUREMENT this module exists for: one placed `WallStone` (a 0.84 MB GLB from the
// architecture kit) serialized through `buildSessionPayload` as a 7.9 MB toJSON element —
// its three 1024² JPEGs come back as PNG data URLs (3.3 + 2.3 + 1.9 MB) — and 5.9 MB
// zipped. `objects` is one toJSON() PER top-level child, so two copies of one wall share
// nothing, and a castle of ~100 kit pieces would be a ~600 MB file. The wire has the same
// shape (a session load sends each element; a placement sends each mesh as a GLTF).
//
// So a piece placed from a pack carries WHERE IT CAME FROM:
//   userData.packRef = {pack, item, path, hash, kids}
// `path` is relative to PACKS_BASE (an absolute URL passes through — the Khronos rows),
// `hash` is the content hash of the bytes it was built from, `kids` the uuids of its
// descendants in traverse order (so every peer rebuilds the same child uuids). A save, a
// session-load broadcast and a late joiner's sync write a PRISTINE piece as a STUB: an
// empty Group with the root's uuid, transform and userData plus `packStub: true`. Every
// peer (and the loader of a file) REFILLS a stub from the pack URL — fetched and parsed
// once per piece, and every copy shares its textures, so twelve walls upload three
// textures instead of thirty-six.
//
// PRISTINE is measured, never assumed: a piece whose descendants differ from the file it
// came from (a mesh edit, a new colour, a dropped texture, a moved child) is written in
// full exactly as before — `fingerprintOf` over the descendants' structure, geometry
// checksums, material parameters and an 8×8 sample of every texture, compared against the
// same fingerprint of the parsed file. Only the ROOT's own transform, name and userData
// are free, and those ride the stub.
//
// AN OLDER BUILD reading a stub gets an empty group where the piece was (nothing throws);
// a peer that cannot reach the pack keeps the stub, says so once, and SAVES it back as a
// stub — a reference is never silently turned into nothing.
//
// A LEAF: three + its loaders, svelte/store, two stores, packs (for PACKS_BASE) and
// explorer (for the one content hash) — both leaves themselves. sessions and
// commandsHandler import this; nothing here reaches back.

/**
 * @typedef {{pack: string, item: string, path: string, hash?: string, kids?: string[]}} PackRef
 */

/** How many refills are in flight — the author script and the suite wait on it.
 * @type {import('svelte/store').Writable<number>} */
export const packRefsPending = writable(0);

/** url -> the parsed file ({hash, scene}); a failure is forgotten so a retry can win
 * @type {Map<string, Promise<{hash: string, scene: any}>>} */
const templates = new Map();
/** content hash -> the fingerprint of a pristine copy
 * @type {Map<string, {key: string, samples: (number[] | null)[]}>} */
const fingerprints = new Map();
/** image-bytes key -> the ONE texture every piece painted with those bytes uses
 * @type {Map<string, any>} */
const sharedTextures = new Map();
/** root uuid -> its refill, so two scans never fill one root twice
 * @type {Map<string, Promise<boolean>>} */
const filling = new Map();
/** urls already reported as unreachable (one toast per piece, not per copy) */
const reported = new Set();

/** @param {any} object @returns {PackRef | null} */
export function packRefOf(object) {
	const ref = object?.userData?.packRef;
	return ref && typeof ref.path === 'string' && ref.path ? ref : null;
}

/** Where a reference's bytes live. @param {PackRef} ref */
export function packRefUrl(ref) {
	if (/^https?:\/\//.test(ref.path)) return ref.path;
	return String(PACKS_BASE).replace(/\/+$/, '') + '/' + ref.path.replace(/^\/+/, '');
}

/**
 * The reference for a pack item fetched from `url`: relative to PACKS_BASE when it lives
 * there (so a scene follows the pack to whatever ref the build serves), absolute otherwise.
 * @param {string} url @param {{pack?: string, item?: string}} [names]
 * @returns {PackRef | null}
 */
export function packRefFromUrl(url, names = {}) {
	if (!url || typeof url !== 'string') return null;
	const base = String(PACKS_BASE).replace(/\/+$/, '') + '/';
	let path = url;
	if (url.startsWith(base)) path = url.slice(base.length);
	else if (!/^https?:\/\//.test(url)) return null;
	const pack = names.pack || (path === url ? '' : path.split('/')[0]) || 'pack';
	const item = names.item || (path.split('/').pop() ?? '').replace(/\.\w+$/, '') || 'item';
	return { pack, item, path };
}

function createLoader() {
	const loader = new GLTFLoader();
	const draco = new DRACOLoader();
	draco.setDecoderPath('/draco/');
	loader.setDRACOLoader(draco);
	loader.setMeshoptDecoder(MeshoptDecoder);
	return loader;
}

/**
 * The bytes of every IMAGE in a GLB, by glTF image index — read from the file's own JSON
 * chunk, because the parsed texture no longer knows them. Empty for a .gltf or anything
 * unexpected (sharing is an optimisation; nothing depends on it).
 * @param {ArrayBuffer} buffer @returns {Uint8Array[]}
 */
function glbImages(buffer) {
	try {
		const view = new DataView(buffer);
		if (view.getUint32(0, true) !== 0x46546c67) return [];
		const jsonLength = view.getUint32(12, true);
		const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)));
		const binStart = 20 + jsonLength + 8;
		return (json.images ?? []).map((/** @type {any} */ image) => {
			const bv = json.bufferViews?.[image.bufferView];
			return bv ? new Uint8Array(buffer, binStart + (bv.byteOffset ?? 0), bv.byteLength) : new Uint8Array();
		});
	} catch {
		return [];
	}
}

const MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap', 'displacementMap', 'lightMap'];

/**
 * One texture per distinct IMAGE across every kit piece: the architecture kit's six
 * sandstone walls carry byte-identical JPEGs, so without this each wall variant uploaded
 * its own three. Keyed by the image bytes' hash plus everything that makes two textures
 * of one image differ (colour space, sampler, channel, flip).
 * @param {any} gltf @param {ArrayBuffer} buffer
 */
async function shareTextures(gltf, buffer) {
	const images = glbImages(buffer);
	if (!images.length) return;
	const json = gltf.parser?.json;
	/** @type {string[]} */
	const imageKeys = await Promise.all(
		images.map(async (bytes) => (bytes.byteLength ? hashBytes(bytes.slice().buffer) : ''))
	);
	gltf.scene.traverse((/** @type {any} */ node) => {
		if (!node.isMesh) return;
		for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
			for (const slot of MAP_SLOTS) {
				const texture = material?.[slot];
				if (!texture) continue;
				const index = gltf.parser?.associations?.get(texture)?.textures;
				const source = index == null ? undefined : json?.textures?.[index]?.source;
				const imageKey = source == null ? '' : imageKeys[source];
				if (!imageKey) continue;
				const key = [imageKey, texture.colorSpace, texture.wrapS, texture.wrapT, texture.magFilter, texture.minFilter, texture.channel, texture.flipY].join('|');
				const shared = sharedTextures.get(key);
				if (shared && shared !== texture) {
					material[slot] = shared;
					texture.dispose();
				} else if (!shared) sharedTextures.set(key, texture);
			}
		}
	});
}

/**
 * Fetch + parse a pack file ONCE per url, and register the fingerprint of a pristine copy
 * under the hash of the bytes actually fetched.
 * @param {string} url @returns {Promise<{hash: string, scene: any}>}
 */
export function loadPackTemplate(url) {
	let job = templates.get(url);
	if (!job) {
		job = (async () => {
			const res = await fetch(url);
			if (!res.ok) throw new Error('HTTP ' + res.status);
			const buffer = await res.arrayBuffer();
			const hash = await hashBytes(buffer);
			/** @type {any} */
			const gltf = await new Promise((resolve, reject) => createLoader().parse(buffer, '', resolve, reject));
			// an animated rig replicates as its BYTES (animatedImports) — never a reference
			if (gltf.animations?.length) throw new Error('animated models are not referenced');
			await shareTextures(gltf, buffer);
			const scene = gltf.scene;
			scene.updateMatrixWorld(true);
			fingerprints.set(hash, fingerprintOf(scene));
			return { hash, scene };
		})();
		templates.set(url, job);
		job.catch(() => templates.delete(url));
	}
	return job;
}

// ---- the fingerprint ---------------------------------------------------------

/** Seven significant digits, and anything under 1e-6 is zero — a GLTF round trip turns a
 * rotation matrix's -1.14e-9 into -1.42e-9, which is the same matrix.
 * @param {number} v */
const num = (v) =>
	typeof v === 'number' && Number.isFinite(v) ? (Math.abs(v) < 1e-6 ? 0 : Number(v.toPrecision(7))) : String(v);

/** Two weighted sums over a typed array — equal arrays give equal sums, and a moved
 * vertex moves the second one even when it keeps the first.
 * @param {ArrayLike<number>} array */
function checksum(array) {
	let a = 0;
	let b = 0;
	for (let i = 0; i < array.length; i++) {
		a += array[i];
		b += array[i] * ((i % 251) + 1);
	}
	return num(a) + '/' + num(b);
}

/** @param {any} geometry */
function geometryKey(geometry) {
	if (!geometry?.attributes) return '-';
	const names = Object.keys(geometry.attributes).sort();
	const parts = names.map((name) => {
		const attr = geometry.attributes[name];
		return name + ':' + attr.itemSize + ':' + attr.count + ':' + (attr.normalized ? 1 : 0) + ':' + checksum(attr.array);
	});
	const index = geometry.index ? 'i' + geometry.index.count + ':' + checksum(geometry.index.array) : 'noindex';
	const groups = (geometry.groups ?? []).map((/** @type {any} */ g) => g.start + '+' + g.count + '@' + (g.materialIndex ?? 0)).join(';');
	return parts.join(',') + '|' + index + '|' + groups;
}

/** 8×8 RGBA of a texture's image, cached per image. Null when it cannot be read (no
 * canvas, a tainted or odd image) — then the texture is compared by its shape alone.
 * @type {WeakMap<any, number[] | null>} */
const samples = new WeakMap();
/** @param {any} texture @returns {number[] | null} */
function textureSample(texture) {
	const image = texture?.image;
	if (!image || typeof image !== 'object') return null;
	if (samples.has(image)) return samples.get(image) ?? null;
	/** @type {number[] | null} */
	let out = null;
	try {
		if (typeof document !== 'undefined' && (image.width ?? 0) > 0) {
			const canvas = document.createElement('canvas');
			canvas.width = 8;
			canvas.height = 8;
			const ctx = canvas.getContext('2d', { willReadFrequently: true });
			if (ctx) {
				ctx.drawImage(image, 0, 0, 8, 8);
				out = Array.from(ctx.getImageData(0, 0, 8, 8).data);
			}
		}
	} catch {
		out = null;
	}
	samples.set(image, out);
	return out;
}

/** @param {any} texture */
function textureKey(texture) {
	if (!texture) return '-';
	const image = texture.image ?? {};
	return [
		(image.width ?? '?') + 'x' + (image.height ?? '?'),
		texture.flipY ? 1 : 0,
		texture.wrapS,
		texture.wrapT,
		num(texture.repeat?.x) + ',' + num(texture.repeat?.y),
		num(texture.offset?.x) + ',' + num(texture.offset?.y),
		num(texture.rotation),
		texture.channel ?? 0
	].join(':');
}

/** @param {any} color */
const colorKey = (color) => (color?.getHexString ? color.getHexString() : '-');

/** @param {any} material @param {(number[] | null)[]} sink */
function materialKey(material, sink) {
	if (!material) return '-';
	const head = [
		material.type,
		colorKey(material.color),
		num(material.roughness),
		num(material.metalness),
		colorKey(material.emissive),
		num(material.emissiveIntensity),
		num(material.opacity),
		material.transparent ? 1 : 0,
		material.side,
		num(material.alphaTest),
		material.vertexColors ? 1 : 0,
		material.flatShading ? 1 : 0,
		material.wireframe ? 1 : 0,
		num(material.normalScale?.x) + ',' + num(material.normalScale?.y),
		num(material.envMapIntensity)
	].join(',');
	const maps = MAP_SLOTS.map((slot) => {
		const texture = material[slot];
		if (texture) sink.push(textureSample(texture));
		return slot + '=' + textureKey(texture);
	}).join(',');
	return head + '|' + maps;
}

/**
 * What must match for a copy to be the file it came from: every DESCENDANT's type, name,
 * visibility and local matrix, each mesh's geometry and material(s), plus texture samples
 * (compared with a tolerance, because an autosave round trip re-encodes the JPEGs). The
 * root itself is excluded — its transform, name and userData are the placement and ride
 * the stub.
 * @param {any} root @returns {{key: string, samples: (number[] | null)[]}}
 */
export function fingerprintOf(root) {
	/** @type {(number[] | null)[]} */
	const sink = [];
	/** @type {string[]} */
	const lines = [];
	root.traverse((/** @type {any} */ node) => {
		if (node === root) return;
		let line = node.type + ':' + node.name + ':' + (node.visible ? 1 : 0) + ':' + node.matrix.elements.map(num).join(',');
		if (node.isMesh || node.isLine || node.isPoints) {
			line += '|' + geometryKey(node.geometry);
			const materials = Array.isArray(node.material) ? node.material : [node.material];
			line += '|' + materials.map((/** @type {any} */ m) => materialKey(m, sink)).join('||');
		}
		lines.push(line);
	});
	return { key: lines.join('\n'), samples: sink };
}

/** Mean absolute difference per channel under which two samples are one image. */
const SAMPLE_TOLERANCE = 10;

/** @param {{key: string, samples: (number[] | null)[]}} a @param {{key: string, samples: (number[] | null)[]}} b */
export function sameFingerprint(a, b) {
	if (!a || !b || a.key !== b.key || a.samples.length !== b.samples.length) return false;
	for (let i = 0; i < a.samples.length; i++) {
		const x = a.samples[i];
		const y = b.samples[i];
		if (!x || !y) continue; // unreadable on one side: the shape key already matched
		if (x.length !== y.length) return false;
		let diff = 0;
		for (let k = 0; k < x.length; k++) diff += Math.abs(x[k] - y[k]);
		if (diff / x.length > SAMPLE_TOLERANCE) return false;
	}
	return true;
}

/** The uuids of a root's descendants in traverse order. @param {any} root */
function descendantUuids(root) {
	/** @type {string[]} */
	const out = [];
	root.traverse((/** @type {any} */ node) => {
		if (node !== root) out.push(node.uuid);
	});
	return out;
}

/**
 * Stamp a freshly imported pack piece BEFORE it replicates: its reference, its children's
 * uuids, and — since it IS the file right now — the pristine fingerprint for its hash.
 * @param {any} root @param {PackRef} ref @param {string} hash the bytes it was parsed from
 */
export function stampPackRef(root, ref, hash) {
	if (!root || !ref) return;
	root.updateMatrixWorld(true);
	root.userData = { ...(root.userData ?? {}), packRef: { pack: ref.pack, item: ref.item, path: ref.path, hash, kids: descendantUuids(root) } };
	if (hash && !fingerprints.has(hash)) fingerprints.set(hash, fingerprintOf(root));
}

/**
 * Is this object a reference that can travel as a stub? A hollow stub (not refilled yet,
 * or its pack was unreachable) always is; a filled one only when it still IS the file.
 * @param {any} object @returns {boolean}
 */
export function isPristinePackRef(object) {
	const ref = packRefOf(object);
	if (!ref) return false;
	if (object.userData.packStub) return object.children.length === 0;
	const fingerprint = ref.hash ? fingerprints.get(ref.hash) : null;
	if (!fingerprint) return false;
	object.updateMatrixWorld(true);
	return sameFingerprint(fingerprint, fingerprintOf(object));
}

/**
 * The stub: an empty Group carrying the root's identity, transform and userData, as a
 * toJSON element — the shape `objects` and the `object` message already carry, so an
 * older reader parses it into an empty group rather than failing.
 * @param {any} root @returns {any}
 */
export function stubElementOf(root) {
	const ref = /** @type {PackRef} */ (packRefOf(root));
	const hollow = new THREE.Group();
	hollow.uuid = root.uuid;
	hollow.name = root.name;
	hollow.position.copy(root.position);
	hollow.quaternion.copy(root.quaternion);
	hollow.scale.copy(root.scale);
	hollow.visible = root.visible;
	hollow.renderOrder = root.renderOrder;
	hollow.layers.mask = root.layers.mask;
	const kids = root.userData.packStub ? ref.kids ?? [] : descendantUuids(root);
	hollow.userData = JSON.parse(JSON.stringify({ ...root.userData, packRef: { ...ref, kids }, packStub: true }));
	hollow.updateMatrix();
	return hollow.toJSON();
}

/** How many nodes a stub stands for (the root + what it refills to), for object budgets.
 * @param {any} node a serialized node (element.object) */
export function stubNodeCount(node) {
	const kids = node?.userData?.packStub ? node?.userData?.packRef?.kids : null;
	return Array.isArray(kids) ? kids.length : 0;
}

/** A child uuid every peer computes alike: the root's uuid with its last 12 hex digits
 * replaced by the child's index. @param {string} rootUuid @param {number} index */
function derivedUuid(rootUuid, index) {
	return String(rootUuid).slice(0, 24) + (index + 1).toString(16).padStart(12, '0');
}

/** A private copy of a parsed piece: geometry and material cloned (the edit tools mutate
 * both IN PLACE, and a copy must never move its siblings), textures shared.
 * @param {any} scene */
function instanceOf(scene) {
	const copy = scene.clone(true);
	copy.traverse((/** @type {any} */ node) => {
		if (!node.isMesh) return;
		node.geometry = node.geometry.clone();
		node.material = Array.isArray(node.material) ? node.material.map((/** @type {any} */ m) => m.clone()) : node.material.clone();
	});
	return copy;
}

/**
 * Refill a stub from its pack. Resolves true when it filled, false when it could not (or
 * is no longer in the scene, or was filled meanwhile). The children take the recorded
 * uuids, so every peer converges on the same ones.
 * @param {any} root @returns {Promise<boolean>}
 */
export function fillPackRef(root) {
	if (!root?.userData?.packStub) return Promise.resolve(false);
	const ref = packRefOf(root);
	if (!ref) return Promise.resolve(false);
	const inflight = filling.get(root.uuid);
	if (inflight) return inflight;
	const url = packRefUrl(ref);
	packRefsPending.update((n) => n + 1);
	const job = (async () => {
		try {
			const { hash, scene } = await loadPackTemplate(url);
			// replaced (a clear, a reload of the same file) or filled while we fetched
			if (!root.userData.packStub || root.children.length) return false;
			if (get(objectsGroup)?.getObjectByProperty('uuid', root.uuid) !== root) return false;
			const copy = instanceOf(scene);
			/** @type {any[]} */
			const nodes = [];
			copy.traverse((/** @type {any} */ node) => {
				if (node !== copy) nodes.push(node);
			});
			const kids = Array.isArray(ref.kids) ? ref.kids : [];
			// a stub that lost its kids (a merge import re-uuids the tree) still has to give
			// every peer the SAME child uuids: derive them from the root's
			nodes.forEach((node, i) => {
				node.uuid = typeof kids[i] === 'string' && kids[i] ? kids[i] : derivedUuid(root.uuid, i);
			});
			const hideShadow = root.userData.shadow === false;
			for (const child of [...copy.children]) root.add(child);
			if (hideShadow)
				root.traverse((/** @type {any} */ node) => {
					if (!node.isMesh) return;
					node.castShadow = false;
					node.receiveShadow = false;
					node.userData.shadow = false;
				});
			delete root.userData.packStub;
			root.userData.packRef = { ...ref, hash, kids: nodes.map((node) => node.uuid) };
			pokeScene();
			return true;
		} catch (error) {
			if (!reported.has(url)) {
				reported.add(url);
				console.log('kit piece could not be loaded: ' + url, error);
				showToast('Could not load the kit piece "' + (ref.item || ref.path) + '" — its pack is unreachable. It stays in the scene as a placeholder.');
			}
			return false;
		} finally {
			filling.delete(root.uuid);
			packRefsPending.update((n) => n - 1);
		}
	})();
	filling.set(root.uuid, job);
	return job;
}

/** Resolves once no refill is in flight (the author script and the suites wait on it). */
export function packRefsSettled() {
	return new Promise((resolve) => {
		/** @type {any} */
		let off = null;
		off = packRefsPending.subscribe((n) => {
			if (n > 0) return;
			queueMicrotask(() => off?.());
			resolve(true);
		});
	});
}

/** Refill every stub in the scene, and learn the pristine fingerprint of every piece whose
 * file we have not parsed yet (a scene restored from the autosave), so a later save can
 * write it as a stub again. */
function scan() {
	const group = get(objectsGroup);
	if (!group) return;
	group.traverse((/** @type {any} */ node) => {
		const ref = packRefOf(node);
		if (!ref) return;
		if (node.userData.packStub) {
			if (!node.children.length) fillPackRef(node);
		} else if (ref.hash && !fingerprints.has(ref.hash)) {
			loadPackTemplate(packRefUrl(ref)).catch(() => {});
		}
	});
}

let started = false;
/** @type {any} */
let scanTimer = null;

/** Watch the scene for stubs (a loaded file, a peer's broadcast, a late joiner's sync). */
export function startPackRefs() {
	if (started || typeof window === 'undefined') return;
	started = true;
	// 30b integrate: undo keeps a pristine piece as its stub (history.registerReferenceSnapshot).
	// Dynamic: history's import subtree must not gain an edge to the Explorer through here.
	import('./history').then((history) =>
		history.registerReferenceSnapshot((/** @type {any} */ object) => (isPristinePackRef(object) ? stubElementOf(object) : null))
	);
	objectsGroup.subscribe(() => {
		if (scanTimer) return;
		scanTimer = setTimeout(() => {
			scanTimer = null;
			scan();
		}, 30);
	});
}
