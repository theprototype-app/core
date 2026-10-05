// 36-avatars (plan 76.1): the rigged characters' GLBs — fetched once per character, cloned per peer.
//
// Every character is ONE skinned mesh on ONE material (built that way in the packs repo), so an avatar
// costs one draw call for its body and one for an optional stylised head + hat (the per-avatar budget:
// <= 10k tris, 1 material, <= 2 calls). The clips live in ONE shared file: every character shares the
// rig, so an AnimationClip binds to any of them by bone name.
//
// LOCAL ONLY: nothing here is replicated — each peer builds the bodies it sees from the replicated
// config (userdata slot 5) and the camera/vrhands streams.

import * as THREE from 'three';
// @ts-ignore - three addons ship no declarations here (project-wide)
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
// @ts-ignore
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadGltf } from '../gltfLoader.js';
import { pageUrl } from '../export/exportBoot.js';
import { AVATAR_DIR, CLIPS_FILE, characterById, outfitMask, CLIP_NAMES } from './catalog.js';
import { hatAnchorY } from '../avatarModel.js';

/** @type {Map<string, Promise<any>>} */
const characters = new Map();
/** @type {Promise<Record<string, THREE.AnimationClip>> | null} */
let clipsPromise = null;
/** what was fetched, for the suite + the perf note */
export const avatarAssetStats = { characters: 0, clips: 0, instances: 0 };

/** @param {string} file */
function urlOf(file) {
	return pageUrl(AVATAR_DIR + file);
}

/** The parsed GLB of one character (cached; a failed fetch is forgotten so a retry can work).
 * @param {string} id */
export function loadCharacter(id) {
	const c = characterById(id);
	if (!c) return Promise.reject(new Error('unknown avatar ' + id));
	let p = characters.get(id);
	if (!p) {
		p = loadGltf(urlOf(c.file)).then((g) => {
			avatarAssetStats.characters++;
			return g;
		});
		p.catch(() => characters.delete(id));
		characters.set(id, p);
	}
	return p;
}

/** The shared clips, by clip name. */
export function loadClips() {
	if (!clipsPromise) {
		clipsPromise = loadGltf(urlOf(CLIPS_FILE)).then((g) => {
			avatarAssetStats.clips++;
			/** @type {Record<string, THREE.AnimationClip>} */
			const out = {};
			for (const clip of g.animations ?? []) out[clip.name] = clip;
			return out;
		});
		clipsPromise.catch(() => (clipsPromise = null));
	}
	return clipsPromise;
}

/** three's GLTFLoader sanitizes node names ('upperarm.l' -> 'upperarml') */
export const boneName = (/** @type {string} */ n) => THREE.PropertyBinding.sanitizeNodeName(n);

/**
 * A fresh instance of a loaded character: its own skeleton + bones, the SHARED geometry, and its own
 * material (the outfit colour is a per-avatar uniform).
 * @param {any} gltf @param {{outfit?: string, selfLit?: number}} [opts]
 */
export function instantiate(gltf, opts = {}) {
	const root = cloneSkinned(gltf.scene);
	/** @type {THREE.SkinnedMesh | null} */
	let mesh = null;
	/** @type {Map<string, THREE.Bone>} */
	const bones = new Map();
	root.traverse((/** @type {any} */ o) => {
		if (o.isSkinnedMesh && !mesh) mesh = o;
		if (o.isBone) bones.set(o.name, o);
	});
	if (!mesh) throw new Error('avatar has no skinned mesh');
	const m = /** @type {THREE.SkinnedMesh} */ (mesh);
	const material = makeAvatarMaterial(/** @type {any} */ (m.material), opts);
	m.material = material;
	m.frustumCulled = false; // a skinned mesh's bounds are the bind pose; a walking body leaves them
	m.castShadow = true;
	avatarAssetStats.instances++;
	return { root, mesh: m, bones, material };
}

/**
 * The avatar material: the character's own (textured, one atlas) plus two small shader changes —
 * the OUTFIT recolour (texels in the chosen atlas cells take the user's colour, keeping the gradient's
 * shading; skin and faces live in other cells and never change) and a SELF-LIT floor (the body
 * stays readable in a dark or unlit scene, the classic avatar was unlit for the same reason).
 * @param {THREE.MeshStandardMaterial} base @param {{outfit?: string, selfLit?: number}} opts
 */
export function makeAvatarMaterial(base, opts = {}) {
	const mat = base.clone();
	mat.roughness = 0.85;
	mat.metalness = 0;
	const uniforms = {
		uOutfit: { value: new THREE.Color(opts.outfit || '#ffffff') },
		uOutfitOn: { value: opts.outfit ? 1 : 0 },
		uOutfitMask: { value: 0 },
		uSelfLit: { value: opts.selfLit ?? 0.35 }
	};
	mat.userData.avatarUniforms = uniforms;
	mat.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, uniforms);
		shader.fragmentShader = shader.fragmentShader
			.replace(
				'#include <common>',
				'#include <common>\nuniform vec3 uOutfit;\nuniform float uOutfitOn;\nuniform int uOutfitMask;\nuniform float uSelfLit;'
			)
			.replace(
				'#include <map_fragment>',
				`#include <map_fragment>
#ifdef USE_MAP
	if (uOutfitOn > 0.5) {
		int col = int(floor(clamp(vMapUv.x, 0.0, 0.9999) * 8.0));
		int row = int(floor(clamp(vMapUv.y, 0.0, 0.9999) * 4.0));
		if (((uOutfitMask >> (row * 8 + col)) & 1) == 1) {
			float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
			diffuseColor.rgb = uOutfit * clamp(0.35 + 1.6 * lum, 0.0, 1.4);
		}
	}
#endif`
			)
			.replace(
				'#include <emissivemap_fragment>',
				'#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * uSelfLit;'
			);
	};
	// one program for every avatar: the uniforms vary, the code does not
	mat.customProgramCacheKey = () => 'tp-avatar-v1';
	return mat;
}

/**
 * Point a material at a character's outfit cells and a colour ('' = the character's own colours).
 * @param {THREE.Material} mat @param {string} characterId @param {string | undefined} color
 */
export function setOutfit(mat, characterId, color) {
	const u = /** @type {any} */ (mat).userData?.avatarUniforms;
	if (!u) return;
	const c = characterById(characterId);
	u.uOutfitMask.value = c ? outfitMask(c.outfitCells) | 0 : 0;
	u.uOutfitOn.value = color ? 1 : 0;
	if (color) u.uOutfit.value.set(color);
}

/** The clip names the runtime asks for, as a list (for the loader's sanity check). */
export const RUNTIME_CLIPS = Object.values(CLIP_NAMES);

const HAT_COLORS = { cap: '#2d5c9e', tophat: '#1c1c1c', crown: '#d4af37' };

/**
 * ONE geometry for a stylised head and/or a hat, coloured per vertex (one draw call). Built around the
 * head CENTRE at the origin; `head` = '' builds the hat alone (worn on the character's own head, seated
 * at `hatLift` above the centre).
 * @param {{head: string, hat: string, color: string, scale?: number, hatLift?: number}} o
 * @returns {THREE.BufferGeometry | null}
 */
export function buildHeadGeometry({ head, hat, color, scale = 0.72, hatLift = 0 }) {
	/** @type {THREE.BufferGeometry[]} */
	const parts = [];
	const paint = (/** @type {THREE.BufferGeometry} */ g, /** @type {string} */ hex) => {
		const ng = g.index ? g.toNonIndexed() : g;
		ng.deleteAttribute('uv');
		const c = new THREE.Color(hex);
		const n = ng.attributes.position.count;
		const arr = new Float32Array(n * 3);
		for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
		ng.setAttribute('color', new THREE.BufferAttribute(arr, 3));
		return ng;
	};
	const at = (/** @type {THREE.BufferGeometry} */ g, /** @type {number[]} */ p, /** @type {number[]} */ r = [0, 0, 0]) => {
		g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...r)), new THREE.Vector3(1, 1, 1)));
		return g;
	};
	if (head && head !== 'character') {
		/** @type {THREE.BufferGeometry} */
		let g;
		if (head === 'box') g = new THREE.BoxGeometry(1.0, 1.0, 1.0);
		else if (head === 'capsule') g = new THREE.CapsuleGeometry(0.45, 0.7, 6, 12);
		else if (head === 'cone') g = new THREE.ConeGeometry(0.62, 1.2, 20);
		else g = new THREE.SphereGeometry(0.59, 16, 12);
		parts.push(paint(g, color));
	}
	if (hat && hat !== 'none') {
		const lift = head && head !== 'character' ? hatAnchorY(head) : hatLift;
		const col = /** @type {Record<string, string>} */ (HAT_COLORS)[hat] ?? '#444444';
		if (hat === 'cap') {
			parts.push(paint(at(new THREE.SphereGeometry(0.36, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), [0, 0.45 + lift, 0]), col));
			parts.push(paint(at(new THREE.BoxGeometry(0.42, 0.04, 0.35), [0, 0.47 + lift, 0.35], [0.15, 0, 0]), col));
		} else if (hat === 'tophat') {
			parts.push(paint(at(new THREE.CylinderGeometry(0.26, 0.26, 0.45), [0, 0.78 + lift, 0]), col));
			parts.push(paint(at(new THREE.CylinderGeometry(0.45, 0.45, 0.05), [0, 0.56 + lift, 0]), col));
		} else if (hat === 'crown') {
			parts.push(paint(at(new THREE.CylinderGeometry(0.3, 0.34, 0.22, 8, 1, false), [0, 0.6 + lift, 0]), col));
			for (let s = 0; s < 6; s++)
				parts.push(paint(at(new THREE.ConeGeometry(0.05, 0.14, 4), [Math.cos((s * Math.PI) / 3) * 0.29, 0.76 + lift, Math.sin((s * Math.PI) / 3) * 0.29]), col));
		}
	}
	if (!parts.length) return null;
	const merged = mergeGeometries(parts, false);
	for (const p of parts) p.dispose();
	if (!merged) return null;
	merged.scale(scale, scale, scale);
	merged.computeBoundingSphere();
	return merged;
}
