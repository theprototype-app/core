// 57 M9 — DOWNLOAD A CHARACTER WITH ITS CLIPS. Object ▸ Download… asks which clips and which layout:
//   (a) ONE GLB with the clips embedded (the default — what Blender, Unity, Unreal and Godot expect)
//   (b) the model + one `.tpanim` per clip, in a zip
//   (c) the model only (its embedded clips stripped)
// A single clip downloads as `.tpanim`, `.glb`, `.vrma` (humanoid only) or `.bvh`. Several objects
// download as one zip. Clips applied from another rig are already BAKED onto this character's own
// skeleton (they were retargeted onto its nodes), so they embed like the model's own.
// THE BYTES ARE THE MODEL'S OWN: a GLB / VRM source is edited in place (glbEdit — nothing else in the
// file changes, a VRM keeps its VRM data); only a source that is not a GLB (an FBX, a .gltf) goes
// through three's exporter, from a FRESH parse of its bytes (never the posed live tree).
// LAZY: the dialog imports this; nothing here is on the boot graph. Local: a download replicates
// nothing.

import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore';
import {
	animatedImportPayload,
	animatedImportKind,
	animatedObjects,
	runtimeClipNames,
	clipOf,
	restRowsOf,
	parseImportBytes
} from '../animatedImports';
import { isGlb, readGlb, animationNames } from './glbEdit.js';
import { glbWithClips, writeClipFile } from './clipFiles.js';
import { addProvenance, normalizeProvenance } from '../provenance.js';
import { APP_VERSION } from '../version';

/** @typedef {'a'|'b'|'c'} Layout */
/** @typedef {'tpanim'|'glb'|'vrma'|'bvh'} ClipFormat */

/** the formats a clip can be, and why one is unavailable @type {{id: string, label: string, needs?: string}[]} */
export const CLIP_FORMATS = [
	{ id: 'tpanim', label: '.tpanim (theprototype clip)' },
	{ id: 'glb', label: '.glb (skeleton + clip)' },
	{ id: 'vrma', label: '.vrma (VRM Animation)', needs: 'humanoid' },
	{ id: 'bvh', label: '.bvh (mocap: Blender, MotionBuilder, Cascadeur)' }
];

/** formats that need an AI box with the `convert` capability (roadmap 58 R19) */
export const CONVERT_FORMATS = [
	{ id: 'fbx', label: '.fbx' },
	{ id: 'usd', label: '.usd' }
];

/** @param {string} uuid */
function rootOf(uuid) {
	return /** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', uuid) ?? null;
}

/** a file-name stem @param {string} name */
export function stem(name) {
	return (
		String(name || 'character')
			.trim()
			.replace(/[^\w\-. ]+/g, '_')
			.replace(/\s+/g, '_') || 'character'
	);
}

/**
 * What a download of this object can offer: its clips (embedded vs applied), whether its bytes
 * are a GLB, whether it is a humanoid (for .vrma).
 * @param {string} uuid
 */
export async function downloadPlan(uuid) {
	const root = rootOf(uuid);
	const bytes = animatedImportPayload(uuid);
	const kind = animatedImportKind(uuid);
	const runtime = new Set(runtimeClipNames(uuid));
	const all = get(animatedObjects)[uuid]?.clips ?? [];
	const { humanoidOf } = await import('../humanoid/humanoidRig.js');
	const h = humanoidOf(uuid);
	return {
		uuid,
		name: root?.name || 'Character',
		kind,
		glb: !!bytes && isGlb(bytes),
		humanoid: !!h?.ok,
		clips: all.map((name) => ({
			name,
			applied: runtime.has(name),
			duration: clipOf(uuid, name)?.duration ?? 0
		}))
	};
}

/** the provenance a downloaded file records: the model's own steps + this download @param {any} root @param {string} what */
function provenanceFor(root, what) {
	const ud = { provenance: normalizeProvenance(root?.userData?.provenance) };
	addProvenance(ud, { tool: 'download', model: what, version: APP_VERSION, source: root?.name });
	return ud.provenance;
}

/**
 * The model's file with exactly these clips embedded (layout (a); `clips = []` is layout (c)).
 * @param {string} uuid @param {string[]} clips @returns {Promise<{name: string, bytes: Uint8Array, notes: string[]}>}
 */
export async function modelFile(uuid, clips) {
	const root = rootOf(uuid);
	const bytes = animatedImportPayload(uuid);
	if (!root || !bytes) throw new Error('not a downloadable model');
	const kind = animatedImportKind(uuid);
	const runtime = new Set(runtimeClipNames(uuid));
	const extra = clips
		.filter((c) => runtime.has(c))
		.map((c) => clipOf(uuid, c))
		.filter(Boolean);
	/** @type {string[]} */
	const notes = [];
	if (isGlb(bytes)) {
		const embedded = animationNames(readGlb(bytes).json);
		const keep = clips.filter((c) => !runtime.has(c) && embedded.includes(c));
		const out = glbWithClips(bytes, extra, keep, {
			provenance: provenanceFor(root, clips.length ? 'model + clips' : 'model')
		});
		if (out.dropped)
			notes.push(out.dropped + ' track(s) named bones the file does not have and were left out.');
		return { name: stem(root.name) + (kind === 'vrm' ? '.vrm' : '.glb'), bytes: out.bytes, notes };
	}
	// an FBX / .gltf source: a fresh parse, exported with three's GLTFExporter (rigs survive it from
	// a pristine tree; materials may simplify — said in the dialog)
	const parsed = await parseImportBytes(bytes, kind);
	const animations = [
		...(parsed.animations ?? []).filter(
			(/** @type {any} */ a) => clips.includes(a.name) && !runtime.has(a.name)
		),
		...extra
	];
	parsed.root.userData = {
		...(parsed.root.userData ?? {}),
		provenance: provenanceFor(root, 'converted to glTF')
	};
	const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
	const glb = await new Promise((resolve, reject) =>
		new GLTFExporter().parse(
			parsed.root,
			(/** @type {any} */ b) => resolve(new Uint8Array(b)),
			reject,
			{ binary: true, animations }
		)
	);
	notes.push(
		'The source was ' +
			kind.toUpperCase() +
			', so it was converted to glTF (materials may look simpler).'
	);
	return { name: stem(root.name) + '.glb', bytes: /** @type {Uint8Array} */ (glb), notes };
}

/**
 * One clip as its own file.
 * @param {string} uuid @param {string} clipName @param {ClipFormat} format
 * @returns {Promise<{name: string, bytes: Uint8Array}>}
 */
export async function clipFile(uuid, clipName, format) {
	const root = rootOf(uuid);
	const clip = clipOf(uuid, clipName);
	const rows = restRowsOf(uuid);
	if (!clip || !rows.length) throw new Error('no such clip');
	const base = stem(root?.name) + '-' + stem(clipName);
	if (format === 'bvh') {
		const { writeBvh } = await import('./bvhWriter.js');
		return { name: base + '.bvh', bytes: new TextEncoder().encode(writeBvh(rows, clip).text) };
	}
	const { humanoidOf } = await import('../humanoid/humanoidRig.js');
	const h = humanoidOf(uuid);
	if (format === 'vrma' && !h?.ok) throw new Error('.vrma needs a humanoid');
	const map = h?.ok ? h.map : null;
	const bytes = writeClipFile(rows, clip, {
		map,
		provenance: provenanceFor(root, 'clip ' + clipName)
	});
	return { name: base + '.' + format, bytes };
}

/**
 * Build what the dialog asked for. One object + (a)/(c) = one file; (b) or several objects = a zip.
 * @param {{uuid: string, clips: string[]}[]} picks @param {Layout} layout
 * @returns {Promise<{name: string, bytes: Uint8Array, notes: string[]}>}
 */
export async function buildDownload(picks, layout) {
	/** @type {Record<string, Uint8Array>} */
	const files = {};
	/** @type {string[]} */
	const notes = [];
	const used = new Set();
	const unique = (/** @type {string} */ name) => {
		let n = name;
		for (let k = 2; used.has(n); k++) n = name.replace(/(\.[^.]+)$/, '-' + k + '$1');
		used.add(n);
		return n;
	};
	for (const { uuid, clips } of picks) {
		const model = await modelFile(uuid, layout === 'a' ? clips : []);
		notes.push(...model.notes);
		const dir = picks.length > 1 ? stem(rootOf(uuid)?.name) + '/' : '';
		files[unique(dir + model.name)] = model.bytes;
		if (layout === 'b')
			for (const c of clips) {
				const f = await clipFile(uuid, c, 'tpanim');
				files[unique(dir + f.name)] = f.bytes;
			}
	}
	const names = Object.keys(files);
	if (names.length === 1)
		return { name: names[0].split('/').pop() ?? names[0], bytes: files[names[0]], notes };
	const { creditsFor } = await import('../sceneLicences.js');
	const credits = creditsFor(picks.map((p) => p.uuid));
	if (credits) files['CREDITS.txt'] = new TextEncoder().encode(credits);
	const { zipSync } = await import('fflate');
	const zipName = picks.length > 1 ? 'characters.zip' : stem(rootOf(picks[0].uuid)?.name) + '.zip';
	return { name: zipName, bytes: zipSync(files, { level: 6 }), notes };
}

/** start the browser download @param {{name: string, bytes: Uint8Array}} file */
export async function saveFile(file) {
	const { saveBytes } = await import('../saveAs');
	const type = /\.zip$/.test(file.name)
		? 'application/zip'
		: /\.bvh$/.test(file.name)
			? 'text/plain'
			: 'model/gltf-binary';
	saveBytes(
		/** @type {ArrayBuffer} */ (
			file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength)
		),
		file.name,
		type
	);
}
