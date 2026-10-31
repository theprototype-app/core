// 57 M4 — VRM CHARACTERS (three-vrm, MIT; VRM 0.x and 1.0). A LAZY CHUNK: imported only when a
// .vrm (or a .glb carrying the VRM extension) is parsed, so a scene without one never loads it.
//
// A VRM is an ANIMATED IMPORT like any rig (animatedImports.js, kind 'vrm'): its original bytes
// replicate, save and undo; every peer parses them with this plugin. On top of the plain glTF it
// brings three things the app uses:
//   - its own HUMANOID MAP (VRM names its bones), handed to humanoidRig as the file's map, so
//     Apply clip… needs no detection at all;
//   - SPRING BONES (hair, cloth) and EXPRESSIONS, advanced every frame by `vrm.update(dt)` AFTER
//     the mixer has posed the bones (local to each peer: a visual, like particles);
//   - its LICENCE META (who made it, may it be redistributed / used commercially / modified,
//     must it be credited), which becomes the model's provenance licence (provenance.js) and so
//     the warnings in Export / Download / Publish.
// The mixer drives the RAW bones by node name like any other rig, so the humanoid's own
// normalized-bone copy is switched off (`autoUpdateHumanBones = false`) — otherwise every
// `vrm.update` would put the raw bones back to the rest pose the normalized ones hold.
// VRM 0.x faces -Z; `rotateVRM0` turns the ROOT, so the model faces +Z in the world like every
// other import (the retarget reads the bones' own facing and conjugates — retarget.js).

import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { createGltfLoader } from '../gltfLoader';
import { licenceFromVrmMeta } from '../provenance.js';

/** root uuid -> its VRM @type {Map<string, any>} */
const vrms = new Map();
/** a parsed scene -> its VRM, until the root is registered under its uuid @type {WeakMap<any, any>} */
const byScene = new WeakMap();
let last = 0;

/**
 * Parse VRM bytes. Resolves the same shape animatedImports' parser does, plus the VRM.
 * @param {ArrayBuffer} bytes @returns {Promise<{root: any, animations: any[], vrm: any, gltf: any}>}
 */
export async function parseVrmBytes(bytes) {
	const loader = createGltfLoader();
	loader.register((/** @type {any} */ parser) => new VRMLoaderPlugin(parser));
	const gltf = await loader.parseAsync(bytes, '');
	const vrm = gltf.userData?.vrm ?? null;
	const root = gltf.scene;
	if (vrm) {
		if (vrm.meta?.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
		if (vrm.humanoid) vrm.humanoid.autoUpdateHumanBones = false;
		byScene.set(root, vrm);
		root.userData.vrmLicence = licenceFromVrmMeta(vrm.meta);
		root.userData.vrmMeta = metaSummary(vrm.meta);
	}
	return { root, animations: gltf.animations ?? [], vrm, gltf };
}

/**
 * The few meta fields the Inspector shows (plain data; the licence itself is provenance's).
 * @param {any} meta
 */
export function metaSummary(meta) {
	if (!meta) return null;
	const v1 = meta.metaVersion === '1';
	return {
		version: v1 ? '1.0' : '0.x',
		name: String((v1 ? meta.name : meta.title) ?? '').slice(0, 200),
		authors: v1
			? (meta.authors ?? []).slice(0, 8).map(String)
			: meta.author
				? [String(meta.author)]
				: [],
		licenseUrl: String(
			(v1 ? meta.licenseUrl : meta.otherLicenseUrl || meta.otherPermissionUrl) ?? ''
		).slice(0, 400),
		licenseName: v1 ? '' : String(meta.licenseName ?? ''),
		avatarPermission: String((v1 ? meta.avatarPermission : meta.allowedUserName) ?? ''),
		commercialUsage: String((v1 ? meta.commercialUsage : meta.commercialUssageName) ?? ''),
		creditNotation: String(meta.creditNotation ?? ''),
		allowRedistribution: v1
			? meta.allowRedistribution
			: meta.licenseName === 'Redistribution_Prohibited'
				? false
				: undefined,
		modification: String(meta.modification ?? '')
	};
}

/**
 * Take over the VRM of a root animatedImports just registered (kind 'vrm'). Returns its humanoid
 * map (VRM bone -> raw node name), or null when the file had no VRM after all.
 * @param {any} root @returns {Record<string, string> | null}
 */
export function adoptVrm(root) {
	const vrm = byScene.get(root);
	if (!vrm) return null;
	vrms.set(root.uuid, vrm);
	/** @type {Record<string, string>} */
	const map = {};
	const bones = vrm.humanoid?.rawHumanBones ?? {};
	for (const [bone, entry] of Object.entries(bones)) {
		const node = /** @type {any} */ (entry)?.node;
		if (node?.name) map[bone] = node.name;
	}
	// a stored expression state (riding the bytes) comes back with the root
	const saved = root.userData?.vrmExpressions;
	if (saved && typeof saved === 'object')
		for (const [name, w] of Object.entries(saved)) setExpression(root.uuid, name, Number(w));
	return map;
}

/** forget a removed root @param {string} uuid */
export function dropVrm(uuid) {
	const vrm = vrms.get(uuid);
	if (!vrm) return;
	vrms.delete(uuid);
	try {
		VRMUtils.deepDispose(vrm.scene);
	} catch {
		/* already disposed with the tree */
	}
}

export function dropAllVrms() {
	vrms.clear();
}

/** is this root a VRM? @param {string} uuid */
export function isVrm(uuid) {
	return vrms.has(uuid);
}

/**
 * Per frame, AFTER the mixers: spring bones, expressions, look-at, constraints.
 * @param {number} [now] ms
 */
export function tickVrms(now = performance.now()) {
	const dt = last ? Math.min(0.1, Math.max(0, (now - last) / 1000)) : 1 / 60;
	last = now;
	for (const [uuid, vrm] of vrms) {
		if (!vrm.scene?.parent) continue; // removed without a drop (the drop follows)
		try {
			vrm.update(dt);
		} catch (error) {
			console.log('vrm update failed', uuid, error);
			vrms.delete(uuid);
		}
	}
}

/** the expression names a VRM offers (presets first) @param {string} uuid @returns {string[]} */
export function expressionNames(uuid) {
	const em = vrms.get(uuid)?.expressionManager;
	if (!em) return [];
	return em.expressions.map((/** @type {any} */ e) => e.expressionName).filter(Boolean);
}

/**
 * Set one expression's weight (0..1) on this peer. The replicated state is the root's
 * `userData.vrmExpressions` (the caller writes it); this only drives the face.
 * @param {string} uuid @param {string} name @param {number} weight @returns {boolean}
 */
export function setExpression(uuid, name, weight) {
	const em = vrms.get(uuid)?.expressionManager;
	if (!em || !em.getExpression(name)) return false;
	em.setValue(name, Math.max(0, Math.min(1, Number.isFinite(weight) ? weight : 0)));
	return true;
}

/** the expression's current weight (null = no such expression) @param {string} uuid @param {string} name */
export function expressionValue(uuid, name) {
	return vrms.get(uuid)?.expressionManager?.getValue(name) ?? null;
}

/** spring-bone joints, for a debug read @param {string} uuid */
export function springJointCount(uuid) {
	return vrms.get(uuid)?.springBoneManager?.joints?.size ?? 0;
}
