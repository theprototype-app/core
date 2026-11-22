// 72 LK4: look animation in a glTF file, as KHR_animation_pointer. The pure half: from sampled channels
// to pointer tracks, unit-tested with no THREE. glTF keeps a colour and its alpha in one vec4, so the
// app's four scalar channels become one track; everything else is one scalar to one pointer.
//
// The plugin that writes these into the file is gltfLookExport.js.

/** @typedef {{pointer: string, itemSize: number, times: number[], values: number[], step?: boolean, bool?: boolean}} PointerTrack */

/**
 * What the file needs to hold for a track's target to exist. A pointer aimed at a property the document
 * does not declare is invalid, so these are returned beside the tracks and the plugin writes them.
 * @typedef {{nodeVisibility: boolean, blend: number[], emissive: number[]}} PointerNeeds
 */

/** the numbers two neighbours make redundant: an interior sample equal to both sides adds nothing to a
 * linear (or held) curve. @param {number[]} times @param {number[]} values @param {number} size
 * @returns {{times: number[], values: number[]}} */
export function dropFlatSamples(times, values, size) {
	const keep = [];
	const same = (/** @type {number} */ a, /** @type {number} */ b) => {
		for (let k = 0; k < size; k++) if (values[a * size + k] !== values[b * size + k]) return false;
		return true;
	};
	for (let i = 0; i < times.length; i++) {
		const edge = i === 0 || i === times.length - 1;
		if (edge || !same(i, i - 1) || !same(i, i + 1)) keep.push(i);
	}
	return { times: keep.map((i) => times[i]), values: keep.flatMap((i) => values.slice(i * size, i * size + size)) };
}

/** @param {any} n @param {number} fallback */
const finite = (n, fallback) => (typeof n === 'number' && Number.isFinite(n) ? n : fallback);

/**
 * @param {{times: number[], channels: Record<string, number[]>}} samples one clip, per channel per time
 * @param {{
 *   node?: number | null,
 *   materials?: {index: number, color?: number[] | null, opacity?: number, hasMetalness?: boolean, hasRoughness?: boolean, hasEmissive?: boolean, hasColor?: boolean}[],
 *   light?: number | null,
 *   camera?: number | null
 * }} target where each channel lands in this document: indices, plus the base values of a vec4's unkeyed parts
 * @returns {{tracks: PointerTrack[], needs: PointerNeeds}}
 */
export function pointerTracksFor(samples, target) {
	const { times, channels } = samples;
	/** @type {PointerTrack[]} */
	const tracks = [];
	/** @type {PointerNeeds} */
	const needs = { nodeVisibility: false, blend: [], emissive: [] };
	/** @param {string} pointer @param {number[]} values @param {number} itemSize @param {Partial<PointerTrack>} [more] */
	const push = (pointer, values, itemSize, more = {}) => {
		const reduced = dropFlatSamples(times, values, itemSize);
		tracks.push({ pointer, itemSize, times: reduced.times, values: reduced.values, ...more });
	};
	const has = (/** @type {string} */ channel) => Array.isArray(channels[channel]);

	if (has('visible') && Number.isInteger(target.node)) {
		needs.nodeVisibility = true;
		// a glTF boolean travels as an unsigned byte, and a held value cannot interpolate
		push('/nodes/' + target.node + '/extensions/KHR_node_visibility/visible', channels.visible.map((v) => (v >= 0.5 ? 255 : 0)), 1, { step: true, bool: true });
	}
	if (has('light.intensity') && Number.isInteger(target.light)) {
		push('/extensions/KHR_lights_punctual/lights/' + target.light + '/intensity', channels['light.intensity'].map((v) => Math.max(0, v)), 1);
	}
	if (has('camera.fov') && Number.isInteger(target.camera)) {
		// three keeps a camera's angle in degrees, glTF in radians
		push('/cameras/' + target.camera + '/perspective/yfov', channels['camera.fov'].map((v) => (Math.min(170, Math.max(1, v)) * Math.PI) / 180), 1);
	}
	for (const material of target.materials ?? []) {
		const root = '/materials/' + material.index;
		const wantsColor = material.hasColor !== false && (has('color.r') || has('color.g') || has('color.b'));
		if (wantsColor || has('opacity')) {
			const base = material.color ?? [1, 1, 1];
			const baseAlpha = finite(material.opacity, 1);
			/** @type {number[]} */
			const values = [];
			times.forEach((_, i) => {
				const read = (/** @type {string} */ channel, /** @type {number} */ fallback) => Math.min(1, Math.max(0, finite(channels[channel]?.[i], fallback)));
				values.push(read('color.r', base[0]), read('color.g', base[1]), read('color.b', base[2]), read('opacity', baseAlpha));
			});
			push(root + '/pbrMetallicRoughness/baseColorFactor', values, 4);
			// alpha only draws in BLEND mode, the transparent flag the app raises when a clip fades something
			if (has('opacity') && channels.opacity.some((v) => v < 1)) needs.blend.push(material.index);
		}
		if (has('metalness') && material.hasMetalness !== false)
			push(root + '/pbrMetallicRoughness/metallicFactor', channels.metalness.map((v) => Math.min(1, Math.max(0, v))), 1);
		if (has('roughness') && material.hasRoughness !== false)
			push(root + '/pbrMetallicRoughness/roughnessFactor', channels.roughness.map((v) => Math.min(1, Math.max(0, v))), 1);
		if (has('emissive') && material.hasEmissive !== false) {
			needs.emissive.push(material.index);
			push(root + '/extensions/KHR_materials_emissive_strength/emissiveStrength', channels.emissive.map((v) => Math.max(0, v)), 1);
		}
	}
	return { tracks, needs };
}
