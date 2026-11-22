// 72 LK4: a GLTFExporter plugin that writes look animation (material, visibility, light, camera field of
// view) as KHR_animation_pointer, and camera markers as real glTF cameras so a field of view has something
// to point at. Viewers that do not read the extension ignore these channels: an export with look animation
// still opens everywhere, it just holds still. TRS channels keep going through the exporter's own path.
import { lookClipsOf } from './animationPreview';
import { pointerTracksFor } from './gltfLookPointers.js';
import * as THREE from 'three';

const POINTER = 'KHR_animation_pointer';
const VISIBILITY = 'KHR_node_visibility';
const EMISSIVE_STRENGTH = 'KHR_materials_emissive_strength';

/** @param {any} object */
function materialList(object) {
	if (!object?.material) return [];
	return Array.isArray(object.material) ? object.material : [object.material];
}

/** Where the exporter wrote a material. Its cache is keyed by uuid, plus whether the geometry has tangents
 * when there is a normal map, so one material can be two entries in the file: a clip must drive both.
 * @param {any} writer @param {any} material @returns {number[]} */
function materialIndices(writer, material) {
	return [material.uuid, material.uuid + ':true', material.uuid + ':false'].flatMap((key) => {
		const index = writer.cache.materials.get(key);
		return index === undefined ? [] : [index];
	});
}

/** a marker's settings as a glTF camera @param {any} spec */
function cameraDef(spec) {
	const near = Math.max(1e-4, Number(spec.near) || 0.1);
	const far = Math.max(near * 1.001, Number(spec.far) || 1000);
	const ratio = spec.aspect === '16:9' ? 16 / 9 : spec.aspect === '2.39:1' ? 2.39 : spec.aspect === '4:3' ? 4 / 3 : spec.aspect === '1:1' ? 1 : 0;
	if (spec.kind === 'orthographic') {
		const size = Math.max(0.01, Number(spec.orthoSize) || 1);
		return { type: 'orthographic', orthographic: { xmag: size * (ratio || 16 / 9), ymag: size, znear: near, zfar: far } };
	}
	const fov = Math.min(170, Math.max(1, Number(spec.fov) || 50));
	return { type: 'perspective', perspective: { yfov: (fov * Math.PI) / 180, znear: near, zfar: far, ...(ratio ? { aspectRatio: ratio } : {}) } };
}

/** @param {any} live @param {any} exported @param {Map<any, any>} map */
function pairNodes(live, exported, map) {
	map.set(live, exported);
	(live.children ?? []).forEach((/** @type {any} */ child, /** @type {number} */ i) => {
		if (exported.children?.[i]) pairNodes(child, exported.children[i], map);
	});
}

class LookPointerPlugin {
	/** @param {any} writer @param {any[]} liveRoots @param {any[]} exportRoots */
	constructor(writer, liveRoots, exportRoots) {
		this.name = POINTER;
		this.writer = writer;
		this.liveRoots = liveRoots;
		/** the live object → the object the exporter sees (a clone when an origin had to be baked) */
		this.exportedOf = new Map();
		liveRoots.forEach((root, i) => exportRoots[i] && pairNodes(root, exportRoots[i], this.exportedOf));
	}

	/** @param {any} object @param {any} nodeDef */
	writeNode(object, nodeDef) {
		const spec = object.userData?.camera;
		if (!spec || nodeDef.camera !== undefined) return;
		const json = this.writer.json;
		json.cameras = json.cameras ?? [];
		nodeDef.camera = json.cameras.push(cameraDef(spec)) - 1;
	}

	afterParse() {
		const { writer } = this;
		const json = writer.json;
		let wrote = false;
		for (const root of this.liveRoots) {
			for (const { object, clip, samples } of lookClipsOf(root)) {
				const exported = this.exportedOf.get(object) ?? object;
				const node = writer.nodeMap.get(exported);
				if (node === undefined) continue;
				const nodeDef = json.nodes[node];
				const materials = materialList(object).flatMap((/** @type {any} */ material) => {
					return materialIndices(writer, material).map((index) => ({
						index,
						color: material.color ? [material.color.r, material.color.g, material.color.b] : null,
						opacity: material.opacity,
						hasColor: !!material.color,
						hasMetalness: material.metalness !== undefined,
						hasRoughness: material.roughness !== undefined,
						hasEmissive: material.emissiveIntensity !== undefined
					}));
				});
				const { tracks, needs } = pointerTracksFor(samples, {
					node,
					materials,
					light: nodeDef.extensions?.KHR_lights_punctual?.light ?? null,
					camera: nodeDef.camera ?? null
				});
				if (!tracks.length) continue;
				this.declare(nodeDef, needs, object);
				this.writeTracks(tracks, clip.name, node);
				wrote = true;
			}
		}
		// a clip whose only channel the exporter could not write (`visible`) leaves an empty animation,
		// which the glTF schema refuses
		if (json.animations) {
			json.animations = json.animations.filter((/** @type {any} */ animation) => animation.channels?.length);
			if (!json.animations.length) delete json.animations;
		}
		if (wrote) writer.extensionsUsed[POINTER] = true;
	}

	/** Make the document hold what the pointers aim at. @param {any} nodeDef @param {any} needs @param {any} object */
	declare(nodeDef, needs, object) {
		const { writer } = this;
		const json = writer.json;
		if (needs.nodeVisibility) {
			nodeDef.extensions = nodeDef.extensions ?? {};
			nodeDef.extensions[VISIBILITY] = { visible: object.visible !== false };
			writer.extensionsUsed[VISIBILITY] = true;
		}
		for (const index of needs.blend) json.materials[index].alphaMode = 'BLEND';
		for (const index of needs.emissive) {
			const def = json.materials[index];
			const live = materialList(object).find((/** @type {any} */ m) => materialIndices(writer, m).includes(index));
			def.extensions = def.extensions ?? {};
			if (!def.extensions[EMISSIVE_STRENGTH]) def.extensions[EMISSIVE_STRENGTH] = { emissiveStrength: live?.emissiveIntensity ?? 1 };
			writer.extensionsUsed[EMISSIVE_STRENGTH] = true;
			// strength scales the colour, so a black one shows nothing: the same own-colour rule playback uses
			const black = !def.emissiveFactor || def.emissiveFactor.every((/** @type {number} */ n) => n === 0);
			if (black) def.emissiveFactor = live?.color ? [live.color.r, live.color.g, live.color.b].map((n) => Math.min(1, Math.max(0, n))) : [1, 1, 1];
		}
	}

	/** A clip with TRS tracks already has an animation in the file: these join it, so it plays as one.
	 * @param {import('./gltfLookPointers.js').PointerTrack[]} tracks @param {string} name @param {number} node */
	writeTracks(tracks, name, node) {
		const { writer } = this;
		const json = writer.json;
		json.animations = json.animations ?? [];
		let animation = json.animations.find(
			(/** @type {any} */ a) => a.name === name && a.channels.every((/** @type {any} */ c) => c.target.node === node)
		);
		if (!animation) {
			animation = { name, samplers: [], channels: [] };
			json.animations.push(animation);
		}
		for (const track of tracks) {
			const input = writer.processAccessor(new THREE.BufferAttribute(new Float32Array(track.times), 1));
			const values = track.bool ? new Uint8Array(track.values) : new Float32Array(track.values);
			const output = writer.processAccessor(new THREE.BufferAttribute(values, track.itemSize));
			const sampler = animation.samplers.push({ input, output, interpolation: track.step ? 'STEP' : 'LINEAR' }) - 1;
			animation.channels.push({ sampler, target: { path: 'pointer', extensions: { [POINTER]: { pointer: track.pointer } } } });
		}
	}
}

/**
 * Make an exporter write look animation and cameras. `liveRoots` hold the clips; `exportRoots` are what the
 * exporter parses (the same objects, or clones when an origin had to be baked).
 * @template T @param {T} exporter @param {any[]} liveRoots @param {any[]} [exportRoots] @returns {T}
 */
export function withLookAnimation(exporter, liveRoots, exportRoots = liveRoots) {
	/** @type {any} */ (exporter).register((/** @type {any} */ writer) => new LookPointerPlugin(writer, liveRoots, exportRoots));
	return exporter;
}

/** does anything under these roots have look animation? (the Quest preset's optimizer cannot carry it)
 * @param {any[]} roots */
export function hasLookAnimation(roots) {
	return roots.some((root) => lookClipsOf(root).length > 0);
}
