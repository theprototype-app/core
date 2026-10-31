// Roadmap 56 C9 — the `import_model` agent tool: a GLB built OUTSIDE the app (an img2threejs rebuild,
// a Blender export, a download) lands in the scene through the app's OWN import path — the same one a
// dropped .glb takes (fileHandler.importFile: auto-optimize with KTX2 twins + LOD above the import
// thresholds, the device-budget verdict, the replicated add with its undo entry, the lock and the
// selection). So it syncs to every peer, saves and undoes like any model.
//
// THE RULES, each one refused with a reason the agent can act on:
//   · editors and admins only (a viewer page refuses; the agent page also refuses a viewer's request)
//   · SELF-CONTAINED GLB only — binary glTF 2.0, every buffer and image inside the file or a data: URI.
//     An external URI would make the app fetch whatever the file names; nothing in a GLB executes, and
//     a file that points outside itself is the one way to make it reach for something.
//   · ≤ 25 MB (the Explorer's own import cap, and what assetShare carries)
//   · bytes from `data` (base64 — the bridge turns an agent's local `path` into this) or `url`
//   · ONE undo step for the whole import (the agent's exec batch, or our own when called alone)
//   · the device-budget ASK becomes a WARNING in the result: an agent page has nobody at a dialog
//
// PROVENANCE (shaped for roadmap 57 M7 `{tool, model, version, licence, prompt?, date}`): stamped on the
// root's userData BEFORE the add, so it rides the first sync, GLTF extras and every save.

import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore.js';
import { peers, userdata } from '../../stores/appStore.js';
import { rolesInfo } from '$lib/cloudHooks';
import { beginHistoryBatch, endHistoryBatch, historyBatchOpen } from '$lib/history';
import { APP_VERSION } from '$lib/version.js';

import { inspectGlb, MAX_IMPORT_BYTES } from './importModelCore.js';
export { inspectGlb, MAX_IMPORT_BYTES };

/** base64 (with or without a data: prefix) → bytes @param {string} s */
function decodeBase64(s) {
	const b64 = s.startsWith('data:') ? s.slice(s.indexOf(',') + 1) : s;
	const bin = atob(b64.replace(/\s+/g, ''));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** @param {string} url @returns {Promise<Uint8Array | {error: string}>} */
async function fetchGlb(url) {
	/** @type {URL} */
	let u;
	try {
		u = new URL(url, location.href);
	} catch {
		return { error: 'not a URL: ' + url };
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'only http(s) URLs can be imported' };
	/** @type {Response} */
	let res;
	try {
		res = await fetch(u.href, { credentials: 'omit' });
	} catch (e) {
		return { error: 'could not fetch ' + u.href + ' (' + String(/** @type {any} */ (e)?.message ?? e) + ') — the site may block other origins; pass the file as data (base64) or a local path instead' };
	}
	if (!res.ok) return { error: 'fetching ' + u.href + ' answered ' + res.status };
	const declared = Number(res.headers.get('content-length') || 0);
	if (declared > MAX_IMPORT_BYTES) return { error: 'the file is ' + Math.round(declared / 1048576) + ' MB — the limit is 25 MB' };
	return new Uint8Array(await res.arrayBuffer());
}

/** @param {unknown} v @param {number} n */
function nums(v, n) {
	return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? /** @type {number[]} */ (v) : null;
}

/** who is importing: this page's peer, as the roster names it */
function importer() {
	/** @type {any} */
	const p = get(peers);
	const id = p?.peer?.id ?? '';
	const row = (/** @type {any[]} */ (get(userdata)) ?? []).find((u) => Array.isArray(u) && u[0] === id);
	return { peerId: id, name: row?.[1] ? String(row[1]) : '' };
}

/** the object a `parent` arg names: a uuid, else the first object with that exact name @param {string} ref */
function findParent(ref) {
	/** @type {any} */
	const group = get(objectsGroup);
	if (!group || !ref) return null;
	return group.getObjectByProperty('uuid', ref) ?? group.getObjectByName(ref) ?? null;
}

/** the named hierarchy, as paths the agent can address (pivots / sockets), capped @param {any} root */
function hierarchyOf(root, cap = 200) {
	/** @type {{name: string, path: string, uuid: string, type: string}[]} */
	const out = [];
	const walk = (/** @type {any} */ o, /** @type {string} */ path) => {
		if (out.length >= cap) return;
		const here = path ? path + '/' + (o.name || o.type) : o.name || o.type;
		out.push({ name: o.name || '', path: here, uuid: o.uuid, type: o.type });
		for (const c of o.children ?? []) walk(c, here);
	};
	walk(root, '');
	return out;
}

/**
 * The tool. Never throws: `{uuid, name, nodes, bytes, provenance, warnings?}` or `{error}`.
 * @param {any} args `{data?, url?, name?, position?, rotation? (degrees XYZ), scale?, parent?, source?, prompt?, licence?, model?}`
 */
export async function importModelTool(args = {}) {
	/** @type {any} */
	const roles = get(rolesInfo);
	if (roles?.myRole === 'viewer') return { error: 'view-only: this session made you a viewer, and viewers cannot import models', refused: true };
	/** @type {Uint8Array} */
	let bytes;
	let fromUrl = '';
	if (typeof args.data === 'string' && args.data.length) {
		try {
			bytes = decodeBase64(args.data);
		} catch {
			return { error: 'data is not valid base64' };
		}
	} else if (typeof args.url === 'string' && args.url) {
		const got = await fetchGlb(args.url);
		if ('error' in got) return got;
		bytes = got;
		fromUrl = args.url;
	} else return { error: 'pass the GLB as `data` (base64), `url`, or (through the bridge) a local `path`' };
	if (bytes.length > MAX_IMPORT_BYTES) return { error: 'the file is ' + (bytes.length / 1048576).toFixed(1) + ' MB — the limit is 25 MB (decimate, or resize the textures)' };
	const glb = inspectGlb(bytes);
	if (!glb.ok) return { error: glb.error };

	const name = String(args.name ?? '').trim().slice(0, 80) || String(glb.json?.scenes?.[glb.json.scene ?? 0]?.name ?? '').trim() || 'Imported model';
	const position = nums(args.position, 3) ?? [0, 0, 0];
	const rotation = nums(args.rotation, 3) ?? [0, 0, 0];
	const scale = typeof args.scale === 'number' && Number.isFinite(args.scale) && args.scale > 0 ? [args.scale, args.scale, args.scale] : (nums(args.scale, 3) ?? [1, 1, 1]);
	if (scale.some((s) => !(s > 0))) return { error: 'scale must be positive' };
	const parent = args.parent ? findParent(String(args.parent)) : null;
	if (args.parent && !parent) return { error: 'no object "' + args.parent + '" to parent under — call list_scene for uuids' };

	const THREE = await import('three');
	const local = new THREE.Matrix4().compose(
		new THREE.Vector3(...position),
		new THREE.Quaternion().setFromEuler(new THREE.Euler((rotation[0] * Math.PI) / 180, (rotation[1] * Math.PI) / 180, (rotation[2] * Math.PI) / 180, 'XYZ')),
		new THREE.Vector3(...scale)
	);
	// position / rotation / scale are LOCAL to the parent: place at the matching WORLD pose, then
	// parent (attach keeps the world transform, so the local pose comes out as asked)
	const world = parent ? (parent.updateWorldMatrix(true, false), new THREE.Matrix4().multiplyMatrices(parent.matrixWorld, local)) : local;
	const p = new THREE.Vector3();
	const q = new THREE.Quaternion();
	const s = new THREE.Vector3();
	world.decompose(p, q, s);

	const { hashBytes } = await import('$lib/explorer');
	const exact = /** @type {ArrayBuffer} */ (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
	const sha256 = await hashBytes(exact);
	const who = importer();
	const provenance = {
		tool: 'import_model',
		model: String(args.model ?? (who.name || 'agent')).slice(0, 120),
		version: String(APP_VERSION),
		licence: String(args.licence ?? '').slice(0, 120),
		...(args.prompt ? { prompt: String(args.prompt).slice(0, 500) } : {}),
		date: new Date().toISOString(),
		source: String(args.source ?? fromUrl ?? '').slice(0, 300) || (fromUrl ? fromUrl : 'agent file'),
		by: who,
		generator: String(glb.generator ?? '').slice(0, 120),
		sha256,
		bytes: bytes.length
	};
	/** @type {string[]} */
	const warnings = [];
	const ownBatch = !historyBatchOpen();
	if (ownBatch) beginHistoryBatch();
	/** @type {string | null} */
	let uuid = null;
	try {
		const { importFile } = await import('$lib/fileHandler.svelte.js');
		const { gateMessage } = await import('$lib/importGate');
		const file = new File([exact], name.replace(/\.glb$/i, '') + '.glb', { type: 'model/gltf-binary' });
		uuid = await importFile(file, name, 'glb', p.toArray(), undefined, {
			quaternion: q.toArray(),
			scale: s.toArray(),
			stamp: { provenance },
			admit: 'load',
			onVerdict: (/** @type {any} */ v) => {
				if (v?.gate) warnings.push(gateMessage(v, name) + ' Consider a lighter model (fewer triangles, smaller textures).');
			}
		});
		if (uuid && parent) {
			const { moveObjectToGroup } = await import('$lib/objectActions');
			moveObjectToGroup(uuid, parent.uuid, { anyParent: true });
		}
	} catch (e) {
		if (ownBatch) endHistoryBatch('Import ' + name);
		return { error: 'the import failed: ' + String(/** @type {any} */ (e)?.message ?? e) };
	}
	if (ownBatch) endHistoryBatch('Import ' + name);
	if (!uuid) return { error: 'the model could not be imported (the file may be corrupt or use an unsupported extension)' };
	/** @type {any} */
	const root = get(objectsGroup)?.getObjectByProperty?.('uuid', uuid);
	const nodes = root ? hierarchyOf(root) : [];
	return {
		uuid,
		name: root?.name ?? name,
		...(parent ? { parent: parent.uuid } : {}),
		nodes,
		bytes: bytes.length,
		provenance,
		...(warnings.length ? { warnings } : {}),
		note: 'Imported as one undo step and synced to every peer. Address parts by the uuids in nodes (update_objects).'
	};
}

/** the OpenAI-format schema (agents only: tpAgent offers it; a small local model is not handed base64) */
export const IMPORT_MODEL_TOOL = {
	type: 'function',
	function: {
		name: 'import_model',
		description:
			'Import a self-contained GLB (binary glTF 2.0, everything embedded, ≤ 25 MB) into the scene through the app\'s own import pipeline (auto-optimize, LOD, budget check). Named nodes are kept as a hierarchy and returned with uuids. One undo step; syncs to every peer; provenance is recorded. Use for models built outside the app (e.g. an img2threejs rebuild exported with named pivots). Materials: standard PBR only — custom shaders do not survive glTF.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'a local .glb path on the agent\'s machine (the bridge reads it)' },
				data: { type: 'string', description: 'the GLB as base64 (alternative to path/url)' },
				url: { type: 'string', description: 'an http(s) URL of a .glb (the host may block other origins)' },
				name: { type: 'string' },
				position: { type: 'array', items: { type: 'number' }, description: '[x,y,z] metres (local to parent when given)' },
				rotation: { type: 'array', items: { type: 'number' }, description: '[x,y,z] degrees, XYZ order' },
				scale: { description: 'a number or [x,y,z]' },
				parent: { type: 'string', description: 'uuid (or exact name) of the object to parent under' },
				source: { type: 'string', description: 'where the model came from, e.g. "img2threejs from photo campfire.jpg"' },
				licence: { type: 'string', description: 'its licence, e.g. CC0, CC-BY-4.0, "own work"' },
				prompt: { type: 'string', description: 'the request it was made for' }
			}
		}
	}
};
