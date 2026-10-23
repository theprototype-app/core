// @ts-ignore - no bundled three type declarations (project-wide)
import { PropertyBinding, InterpolateDiscrete } from 'three';

// 59 T1 / fork F2 — CLIPS WHEN A MODEL IS REPLACED. A LEAF (three's constants only, no stores).
//
// The rule (F2, recommended default): a clip the OLD model had and the new file lacks is KEPT
// when every bone it animates exists in the new model, so a re-rig or a weight fix in another
// tool does not cost the clips; a clip naming a bone the new model does not have is DROPPED and
// listed. A clip the new file carries under the same name wins — the file is what you just made.
// Bones are matched by NAME (the name three binds a track to), which is the only identity a rig
// keeps across a trip through Blender.
//
// A kept clip has to live in the new model's BYTES (an animated import replicates and saves as
// its file), so `clipToGlbAnimation` turns it into glTF channels that glbEdit appends.
// TODO(59-int): 57's `.tpanim` clip assets get the same keep rule once they are on the union —
// they bind by skeleton bone names too, so `clipKeepPlan` is the check to call.

/** the node a track animates and the property, or null for a track name three cannot read
 * @param {string} trackName */
export function trackTarget(trackName) {
	try {
		const parsed = PropertyBinding.parseTrackName(trackName);
		return parsed?.nodeName ? { node: String(parsed.nodeName), property: String(parsed.propertyName) } : null;
	} catch {
		return null;
	}
}

/**
 * Which of the old model's clips survive the replace. PURE.
 * @param {{name: string, tracks: {name: string}[]}[]} oldClips the clips the old model plays
 * @param {Iterable<string>} newClipNames the clips the new file brings (those win)
 * @param {(nodeName: string) => boolean} hasNode does the new model have a node of that name
 * @returns {{keep: any[], dropped: {name: string, missing: string[]}[]}}
 */
export function clipKeepPlan(oldClips, newClipNames, hasNode) {
	const fresh = new Set(newClipNames);
	/** @type {any[]} */
	const keep = [];
	/** @type {{name: string, missing: string[]}[]} */
	const dropped = [];
	for (const clip of oldClips ?? []) {
		if (!clip?.name || fresh.has(clip.name)) continue;
		/** @type {Set<string>} */
		const missing = new Set();
		for (const track of clip.tracks ?? []) {
			const target = trackTarget(track.name);
			if (!target || !hasNode(target.node)) missing.add(target?.node ?? track.name);
		}
		if (missing.size || !(clip.tracks ?? []).length) dropped.push({ name: clip.name, missing: [...missing] });
		else keep.push(clip);
	}
	return { keep, dropped };
}

/** three property -> glTF channel path */
const PATHS = /** @type {Record<string, 'translation'|'rotation'|'scale'>} */ ({
	position: 'translation',
	quaternion: 'rotation',
	scale: 'scale'
});

/**
 * One three AnimationClip as glTF channels against `nodeIndex` (name -> glTF node index, from the
 * new file's own parse). Translation/rotation/scale tracks only: a shape-key (`morphTargetInfluences`)
 * track is skipped and counted, because its three name targets a mesh and glTF's targets a node.
 * Interpolation keeps STEP/LINEAR/CUBICSPLINE (GLTFLoader's cubic tracks carry the tangents in
 * glTF's own layout); three's Smooth has no glTF twin and goes out LINEAR.
 * @param {any} clip @param {Map<string, number>} nodeIndex
 * @returns {{animation: import('./glbEdit').GlbAnimation, skipped: number}}
 */
export function clipToGlbAnimation(clip, nodeIndex) {
	/** @type {import('./glbEdit').GlbChannel[]} */
	const channels = [];
	let skipped = 0;
	for (const track of clip.tracks ?? []) {
		const target = trackTarget(track.name);
		const path = target ? PATHS[target.property] : undefined;
		const node = target ? nodeIndex.get(target.node) : undefined;
		if (!path || node === undefined || !track.times?.length) {
			skipped++;
			continue;
		}
		const cubic = !!track.createInterpolant?.isInterpolantFactoryMethodGLTFCubicSpline;
		const interpolation = cubic ? 'CUBICSPLINE' : track.getInterpolation?.() === InterpolateDiscrete ? 'STEP' : 'LINEAR';
		channels.push({
			node,
			path,
			interpolation,
			times: Float32Array.from(track.times),
			values: Float32Array.from(track.values)
		});
	}
	return { animation: { name: clip.name, channels }, skipped };
}

/**
 * name -> glTF node index for a parsed file: three's names are sanitized and de-duplicated in
 * load order, so the only exact map is the loader's own `associations`.
 * @param {any} root the parsed scene @param {any} parser the GLTFLoader parser (gltf.parser)
 * @returns {Map<string, number>}
 */
export function nodeIndexOf(root, parser) {
	/** @type {Map<string, number>} */
	const out = new Map();
	const assoc = parser?.associations;
	root?.traverse?.((/** @type {any} */ o) => {
		const index = assoc?.get(o)?.nodes;
		if (o.name && Number.isInteger(index) && !out.has(o.name)) out.set(o.name, index);
	});
	return out;
}

/** The toast's clip sentence, or '' when nothing was carried or lost. PURE.
 * @param {string[]} kept @param {{name: string, missing: string[]}[]} dropped */
export function clipSummary(kept, dropped) {
	/** @type {string[]} */
	const parts = [];
	if (kept.length) parts.push('kept ' + (kept.length === 1 ? 'clip ' : 'clips ') + kept.join(', '));
	if (dropped.length)
		parts.push(
			'dropped ' +
				dropped
					.map((d) => d.name + (d.missing.length ? ' (no ' + d.missing.slice(0, 2).join(', ') + (d.missing.length > 2 ? ' …' : '') + ')' : ''))
					.join(', ')
		);
	return parts.join('; ');
}
