// mcp-diorama2 (item 9) — `import_shape`, the connector's create_shape {action: "import"}: a glTF / GLB / OBJ model
// from base64 (`data`, or `chunk` parts like assets.image), or an https `url`, into the scene through the app's own
// import path (fileHandler.importFile — the path a dropped model takes: optimise, budget verdict, the replicated
// add and its undo entry). Named parts (glTF nodes, OBJ `o` / `g` groups) come back as named children with uuids,
// so animate_parts and update_objects can move them.
//
// THE URL RULES are the ones every agent URL fetch keeps (B4a, readHttpsBytes): https only, no user / password, no
// local or private address (checked again where a redirect LANDED), no credentials or referrer sent, a size cap
// read as it streams. The bytes are not believed: importShapeCore sniffs them, and a model is data — nothing in one
// runs; a uri pointing outside the file is refused. The file is COPIED INTO THE LIBRARY first (folder
// "Imported models", shared), so the scene never depends on the address again.
//
// Unlike import_model (56 C9, local agents only: it reads a path on the agent's machine), this takes no path, so the
// claude.ai connector may offer it.

import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore.js';
import { rolesInfo } from '$lib/cloudHooks';
import { beginHistoryBatch, endHistoryBatch, historyBatchOpen } from '$lib/history';
import { APP_VERSION } from '$lib/version.js';
import { addChunk } from './importFileCore.js';
import { checkTextureUrl } from './lookToolsCore.js';
import { FETCH_TIMEOUT_MS } from './imageToolCore.js';
import { parentTarget } from './parentTarget.js';
import { shapePose } from './shapeBatchCore.js';
import { applyShadowFlags } from './shadowFlags.js';
import { sniffModel, MAX_IMPORT_BYTES } from './importShapeCore.js';

export { sniffModel };

/** unfinished chunked uploads, by id (addChunk owns the rules) @type {Map<string, any>} */
const uploads = new Map();

/** @param {string} s base64 with or without a data: prefix */
function decodeBase64(s) {
	const b64 = s.startsWith('data:') ? s.slice(s.indexOf(',') + 1) : s;
	const bin = atob(b64.replace(/\s+/g, ''));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** the named hierarchy as the agent addresses it, capped @param {any} root */
function partsOf(root, cap = 200) {
	/** @type {{name: string, uuid: string, type: string, path: string}[]} */
	const out = [];
	const walk = (/** @type {any} */ o, /** @type {string} */ path) => {
		if (out.length >= cap) return;
		const here = path ? path + '/' + (o.name || o.type) : o.name || o.type;
		if (o !== root) out.push({ name: o.name || '', uuid: o.uuid, type: o.type, path: here });
		for (const c of o.children ?? []) walk(c, here);
	};
	walk(root, '');
	return out;
}

/** @param {any} args @returns {Promise<{bytes: Uint8Array, source: string} | {partial: any} | {error: string}>} */
async function bytesOf(args) {
	if (typeof args.url === 'string' && args.url) {
		const checked = checkTextureUrl(args.url);
		if (!checked.ok) return { error: 'url: ' + checked.error };
		const { readHttpsBytes } = await import('./lookTools.js');
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
		try {
			const got = await readHttpsBytes(checked.url, fetch, abort.signal, MAX_IMPORT_BYTES);
			if ('error' in got) return { error: 'url: ' + got.error };
			return { bytes: got.bytes, source: checked.url };
		} catch (e) {
			return { error: 'url: ' + (/** @type {any} */ (e)?.name === 'AbortError' ? 'it took over ' + FETCH_TIMEOUT_MS / 1000 + ' s' : 'could not read it') };
		} finally {
			clearTimeout(timer);
		}
	}
	if (typeof args.data !== 'string' || !args.data) return { error: 'give the model as data (base64; chunk: {id, index, total} for parts) or an https url' };
	let data = args.data;
	if (args.chunk) {
		const got = addChunk(uploads, args.chunk, data, Date.now());
		if ('error' in got) return { error: got.error };
		if (!got.done) return { partial: { received: got.received, of: got.total, partial: true, note: 'part kept; send the rest with the same chunk.id' } };
		data = got.data;
	}
	if (data.length > ((MAX_IMPORT_BYTES + 3) / 3) * 4 + 128) return { error: 'the model is over the ' + MAX_IMPORT_BYTES / 1048576 + ' MB limit' };
	try {
		return { bytes: decodeBase64(data), source: 'agent file' };
	} catch {
		return { error: 'data is not valid base64' };
	}
}

/**
 * The tool. Never throws. `{created: [{uuid, name}], uuid, format, parts: [{name, uuid, type, path}], file}` or `{error}`.
 * @param {any} args `{data?, chunk?, url?, name?, position?, rotation? (radians), scale?, parentUuid?, folder?, castShadow?, receiveShadow?, source?, licence?}`
 */
export async function importShapeTool(args = {}) {
	/** @type {any} */
	const roles = get(rolesInfo);
	if (roles?.myRole === 'viewer') return { error: 'view-only: this session made you a viewer, and viewers cannot import models' };
	const target = parentTarget(args.parentUuid);
	if (target && 'error' in target) return { error: target.error };
	const pose = shapePose(args, !!target);
	if ('error' in pose) return { error: pose.error };
	const got = await bytesOf(args);
	if ('partial' in got) return got.partial;
	if ('error' in got) return got;
	const kind = sniffModel(got.bytes);
	if ('error' in kind) return { error: kind.error };
	const stem = String(args.name ?? '').trim().slice(0, 80) || (args.url ? decodeURIComponent(new URL(args.url).pathname.split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '') : '') || 'Imported model';
	const fileName = stem.replace(/\.(glb|gltf|obj)$/i, '') + '.' + kind.ext;

	const THREE = await import('three');
	const local = new THREE.Matrix4().compose(
		new THREE.Vector3(...(pose.position ?? [0, 0, 0])),
		new THREE.Quaternion().setFromEuler(new THREE.Euler(...(/** @type {[number, number, number]} */ (pose.rotation ?? [0, 0, 0])))),
		new THREE.Vector3(...(pose.scale ?? [1, 1, 1]))
	);
	// the pose is LOCAL to the parent: place at the matching world pose, then attach (it keeps the world pose)
	const world = target ? (target.parent.updateWorldMatrix(true, false), new THREE.Matrix4().multiplyMatrices(target.parent.matrixWorld, local)) : local;
	const p = new THREE.Vector3();
	const q = new THREE.Quaternion();
	const s = new THREE.Vector3();
	world.decompose(p, q, s);

	const provenance = {
		tool: 'import_shape',
		version: String(APP_VERSION),
		licence: String(args.licence ?? '').slice(0, 120),
		date: new Date().toISOString(),
		source: String(args.source ?? got.source).slice(0, 300),
		generator: String(kind.generator ?? '').slice(0, 120),
		bytes: got.bytes.length
	};
	/** @type {string[]} */
	const warnings = [...kind.warnings];
	const ownBatch = !historyBatchOpen();
	if (ownBatch) beginHistoryBatch();
	/** @type {string | null} */
	let uuid = null;
	/** @type {any} */
	let file = null;
	try {
		const { fileIntoLibrary } = await import('./importFile.js');
		file = await fileIntoLibrary(got.bytes, fileName, args.folder ?? 'Imported models');
		const { importFile } = await import('$lib/fileHandler.svelte.js');
		const { gateMessage } = await import('$lib/importGate');
		const exact = /** @type {ArrayBuffer} */ (got.bytes.buffer.slice(got.bytes.byteOffset, got.bytes.byteOffset + got.bytes.byteLength));
		const blob = new File([exact], fileName, { type: kind.mime });
		uuid = await importFile(blob, stem, kind.ext, p.toArray(), undefined, {
			quaternion: q.toArray(),
			scale: s.toArray(),
			stamp: { provenance: { ...provenance, sha256: file.item.hash } },
			admit: 'load',
			onVerdict: (/** @type {any} */ v) => {
				if (v?.gate) warnings.push(gateMessage(v, stem) + ' Consider a lighter model (fewer triangles, smaller textures).');
			}
		});
		if (uuid && target) {
			const { moveObjectToGroup } = await import('$lib/objectActions');
			moveObjectToGroup(uuid, target.parent.uuid, { anyParent: true });
		}
		/** @type {any} */
		const placed = uuid ? get(objectsGroup)?.getObjectByProperty?.('uuid', uuid) : null;
		if (placed) warnings.push(...applyShadowFlags(placed, args));
	} catch (e) {
		if (ownBatch) endHistoryBatch('Import ' + stem);
		return { error: 'the import failed: ' + String(/** @type {any} */ (e)?.message ?? e) };
	}
	if (ownBatch) endHistoryBatch('Import ' + stem);
	if (!uuid) return { error: 'the model could not be placed (the file may be damaged or use a glTF extension this app does not read); it is in the library as ' + fileName };
	/** @type {any} */
	const root = get(objectsGroup)?.getObjectByProperty?.('uuid', uuid);
	const parts = root ? partsOf(root) : [];
	return {
		created: [{ uuid, name: root?.name ?? stem }],
		uuid,
		format: kind.format,
		parts,
		file: { name: file.item.name, hash: file.item.hash, folder: file.folder, ...(file.created ? {} : { existed: true }) },
		...(target ? { parent: target.parent.uuid } : {}),
		...(warnings.length ? { warnings } : {}),
		note: 'One undo step; everyone sees it. Move named parts with animate_parts or update_objects by the uuids in parts.'
	};
}

/** the shared registry schema */
export const IMPORT_SHAPE_TOOL = {
	type: 'function',
	function: {
		name: 'import_shape',
		description:
			'Bring in a 3D model file: glTF 2.0 (.glb, or .gltf JSON with everything embedded) or Wavefront .obj, as data (base64; for a big file send chunk: {id, index, total} parts, each a multiple of 4 base64 characters) or an https url (public addresses only, ≤ 25 MB; the file is copied into the library first, so the scene never needs the address again). Named sub-meshes become named children, returned in parts with uuids, so animate_parts can move them (a lid, a wheel, a door). position / rotation (radians) / scale as create_objects; with parentUuid they are the group\'s own space. castShadow / receiveShadow apply to every mesh in it. A model is data: nothing in it runs, and a file that points at outside files is refused. One undo step; everyone sees it.',
		parameters: {
			type: 'object',
			properties: {
				data: { type: 'string', description: 'the file as base64 (or this chunk\'s part of it)' },
				chunk: { type: 'object', description: '{id, index (from 0), total}: one part of a big file; the model is placed when the last part lands', properties: { id: { type: 'string' }, index: { type: 'integer' }, total: { type: 'integer' } } },
				url: { type: 'string', description: 'an https address of a .glb / .gltf / .obj (the server must allow cross-origin reads)' },
				name: { type: 'string' },
				position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
				rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'radians, XYZ' },
				scale: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
				parentUuid: { type: 'string', description: 'a group (or any object) to put it in' },
				folder: { type: 'string', description: 'Explorer folder (default "Imported models")' },
				castShadow: { type: 'boolean' },
				receiveShadow: { type: 'boolean' },
				source: { type: 'string', description: 'where it came from (kept with the model)' },
				licence: { type: 'string', description: 'its licence, e.g. CC0' }
			}
		}
	}
};
