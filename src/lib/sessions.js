import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, globalCamera, orbitControls, TControls } from '../stores/sceneStore';
import { restoreGraphs, clearGraphs, SCENE_GRAPH } from '../stores/flowStore';
import { serializeGraphs } from './flowGraphs';
import { serializeNode, serializeEdge, sendNodes } from './nodesHandler';
import { parkAnimatedAtBase } from './flowRuntime';
import { peers, showToast, showInfoToast } from '../stores/appStore';
import { recordObjectPresence } from './history';
import { annotationsSnapshot, annotationsRestore } from './autosave';
import { jointsSnapshot, jointsRestore } from './joints';
import { sceneCommand, sendObjects } from './commandsHandler.svelte';
import { nameOf } from './lockControl';
import { idbGet, idbPut, idbDelete, idbKeys } from './idb';
import { showConfirm } from './confirmDialog';
import { APP_VERSION } from './version.js';

// Multi-slot sessions (phase 50) on top of the autosave format. Each session
// stores its top-level objects as individual ObjectLoader jsons — that makes
// selective import trivial and full loads replicate per object. Loading with
// peers connected is a PROPOSAL: everyone gets an Accept/Decline toast and the
// load only applies when all connected peers accept (the apply then goes out
// through the normal clearscene/object messages).

const KEY = 'session:';
const MAX_SESSION_BYTES = 50 * 1024 * 1024;

/** meta list for the manager: [{id, name, createdAt, count, thumbnail}] */
export const sessions = writable(/** @type {any[]} */ ([]));

/** Small offscreen render of the whole scene group @param {any} group */
function renderSceneThumbnail(group) {
	try {
		if (!group || group.children.length === 0) return null;
		const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		renderer.setSize(256, 160);
		const scene = new THREE.Scene();
		scene.background = new THREE.Color('#232a33');
		scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 2.2));
		const clone = new THREE.ObjectLoader().parse(group.toJSON());
		scene.add(clone);
		const box = new THREE.Box3().setFromObject(clone);
		if (!isFinite(box.min.x)) return null;
		const size = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
		const center = box.getCenter(new THREE.Vector3());
		const camera = new THREE.PerspectiveCamera(40, 256 / 160, size / 100, size * 10);
		camera.position.copy(center).add(new THREE.Vector3(size * 0.65, size * 0.5, size * 0.85));
		camera.lookAt(center);
		renderer.render(scene, camera);
		const url = renderer.domElement.toDataURL('image/webp', 0.7);
		renderer.dispose();
		renderer.forceContextLoss?.();
		return url;
	} catch (error) {
		console.log('session thumbnail failed', error);
		return null;
	}
}

/** @param {any} payload */
function metaOf(payload) {
	return {
		id: payload.id,
		name: payload.name,
		createdAt: payload.createdAt,
		count: payload.count,
		thumbnail: payload.thumbnail
	};
}

export async function loadSessions() {
	try {
		const keys = await idbKeys();
		const list = [];
		for (const key of keys.filter((/** @type {any} */ k) => String(k).startsWith(KEY))) {
			const payload = await idbGet(String(key));
			if (payload) list.push(metaOf(payload));
		}
		list.sort((a, b) => b.createdAt - a.createdAt);
		sessions.set(list);
	} catch {
		sessions.set([]);
	}
}

/** Build a session payload from the current scene @param {string} name */
export function buildSessionPayload(name) {
	const group = get(objectsGroup);
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const controls = get(orbitControls);
	// sessions store animation BASE poses, not the current swing (88);
	// toJSON + thumbnail read the graph synchronously
	const restore = parkAnimatedAtBase();
	/** @type {any} */
	let graphs;
	try {
		return {
			id: crypto.randomUUID(),
			name: name || 'Session ' + new Date().toLocaleString(),
			createdAt: Date.now(),
			// V4: format gates loading (a NEWER int asks before importing);
			// appVersion is display-only provenance
			format: SESSION_FORMAT,
			appVersion: APP_VERSION,
			count: group?.children.length ?? 0,
			thumbnail: renderSceneThumbnail(group),
			objects: (group?.children ?? []).map((/** @type {any} */ child) => child.toJSON()),
			// H1: full graph map (+ legacy SCENE fields so old builds can load it)
			graphs: (graphs = serializeGraphs(serializeNode, serializeEdge, {
				pruneMissing: (uuid) => !group?.getObjectByProperty?.('uuid', uuid)
			})),
			nodes: graphs[SCENE_GRAPH]?.nodes ?? [],
			edges: graphs[SCENE_GRAPH]?.edges ?? [],
			annotations: annotationsSnapshot(),
			joints: jointsSnapshot(),
			camera: camera
				? { position: camera.position.toArray(), target: controls?.target?.toArray() ?? [0, 0, 0] }
				: null
		};
	} finally {
		restore();
	}
}

/** Persist a payload as a slot @param {any} payload */
async function persistSession(payload) {
	if (JSON.stringify(payload).length > MAX_SESSION_BYTES) {
		showToast('Scene is too large to save as a session (>50 MB)');
		return null;
	}
	await idbPut(KEY + payload.id, payload);
	await loadSessions();
	return payload;
}

/** Snapshot the current scene into a named session @param {string} name */
export async function saveSession(name) {
	const payload = await persistSession(buildSessionPayload(name));
	if (payload) showToast('Session saved: ' + payload.name);
	return payload;
}

/** @param {string} id */
export function getSession(id) {
	return idbGet(KEY + id);
}

/** @param {string} id */
export async function deleteSession(id) {
	await idbDelete(KEY + id);
	await loadSessions();
}

/** @param {string} id @param {string} name */
export async function renameSession(id, name) {
	if (!name) return;
	const payload = await idbGet(KEY + id);
	if (!payload) return;
	payload.name = name;
	await idbPut(KEY + id, payload);
	await loadSessions();
}

/** JSON string for a .session.json download @param {any} payload */
export function exportSession(payload) {
	return JSON.stringify(payload);
}

/** V4: the .tpscene/.session format this build writes and knows how to read. */
export const SESSION_FORMAT = 1;

/** Parse + shape-validate a session JSON string. @param {string} json */
function parseSessionJson(json) {
	const payload = JSON.parse(json);
	if (!payload || !Array.isArray(payload.objects)) throw new Error('not a session file');
	return payload;
}

/** V4: true when the payload's format is loadable; a NEWER format asks first.
 * Older/absent formats (0) load silently — no noise after routine upgrades.
 * @param {any} payload */
async function confirmSessionFormat(payload) {
	const format = Number(payload?.format) || 0;
	if (format <= SESSION_FORMAT) return true;
	return showConfirm({
		title: 'Newer scene format',
		message:
			'This scene was saved by app ' + (payload?.appVersion || 'unknown') + ' (format ' + format +
			'); this app supports format ' + SESSION_FORMAT + '. Some content may not load correctly.',
		confirmLabel: 'Load anyway'
	});
}

/** Store an imported payload as a fresh slot. @param {any} payload */
async function finishImport(payload) {
	payload.id = crypto.randomUUID(); // never collide with an existing slot
	payload.name = payload.name || 'Imported session';
	payload.createdAt = Date.now();
	await idbPut(KEY + payload.id, payload);
	await loadSessions();
	return payload;
}

/** Import a previously exported session file. Resolves NULL when the user cancels
 * a newer-format confirm (callers treat null as a silent no-op, not an error).
 * @param {string} json */
export async function importSession(json) {
	const payload = parseSessionJson(json);
	if (!(await confirmSessionFormat(payload))) return null;
	return finishImport(payload);
}

// ---- session ZIP: session.json + the scene's binary assets (127) ----

/**
 * Build a .zip Uint8Array for a session: session.json + assets/<hash>.<ext>
 * (the 108 scene manifest's audio/config/textures) + an assets/index.json map.
 * Portable — re-importing on a fresh machine restores the assets too.
 * @param {any} payload
 */
export async function exportSessionZip(payload, opts = { assets: true, packs: false, flow: true }) {
	const { zipSync, strToU8 } = await import('fflate');
	const { sceneAssetList } = await import('./sceneAssets');
	const { itemByHash, itemBlob } = await import('./explorer');
	// B3 (.tpscene): the include-checkboxes — flow strips nodes/edges, assets
	// toggles the hash bundle, packs adds the imported-pack section below
	if (opts.flow === false) payload = { ...payload, nodes: [], edges: [] };
	/** @type {Record<string, any>} */
	const files = { 'session.json': strToU8(JSON.stringify(payload)) };
	/** @type {Array<{hash: string, name: string, kind: string, file: string}>} */
	const index = [];
	const seen = new Set();
	if (opts.assets !== false)
		for (const asset of sceneAssetList()) {
			if (!asset.hash || seen.has(asset.hash)) continue;
			const item = /** @type {any} */ (itemByHash(asset.hash));
			if (!item) continue;
			const blob = await itemBlob(item.id);
			if (!blob) continue;
			seen.add(asset.hash);
			const ext = (item.name?.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase();
			const file = 'assets/' + asset.hash + ext;
			files[file] = new Uint8Array(await blob.arrayBuffer());
			index.push({ hash: asset.hash, name: item.name, kind: asset.kind, file });
		}
	files['assets/index.json'] = strToU8(JSON.stringify(index));
	if (opts.packs) {
		// bundle the IMPORTED packs (built-ins are bundled/CDN — nothing to carry):
		// pack metadata + each item's Explorer blob, re-registered on import
		const { installedPacksSnapshot } = await import('./packs');
		const packs = installedPacksSnapshot();
		/** @type {any[]} */
		const packIndex = [];
		for (const pack of packs) {
			for (const it of pack.items ?? []) {
				const blob = it.id ? await itemBlob(it.id) : null;
				if (!blob) continue;
				const file = `packs/${pack.name}/${it.id}`;
				files[file] = new Uint8Array(await blob.arrayBuffer());
				packIndex.push({ pack: pack.name, itemId: it.id, name: it.name, file });
			}
		}
		files['packs/index.json'] = strToU8(JSON.stringify({ packs, items: packIndex }));
	}
	return zipSync(files, { level: 6 });
}

/**
 * Import a session .zip: restore its bundled assets into the Explorer (Shared,
 * hash-deduped) FIRST so sound/texture hashes resolve, then the session.json.
 * @param {ArrayBuffer} buffer
 */
export async function importSessionZip(buffer) {
	const { unzipSync, strFromU8 } = await import('fflate');
	const entries = unzipSync(new Uint8Array(buffer));
	const sessionBytes = entries['session.json'];
	if (!sessionBytes) throw new Error('zip has no session.json');
	// V4: parse + confirm the format BEFORE the asset/pack restore loops — a
	// cancelled import must not mutate the Explorer library
	const payload = parseSessionJson(strFromU8(sessionBytes));
	if (!(await confirmSessionFormat(payload))) return null;
	let index = [];
	try {
		if (entries['assets/index.json']) index = JSON.parse(strFromU8(entries['assets/index.json']));
	} catch {
		index = [];
	}
	if (index.length) {
		const { applyAssetFile } = await import('./assetShare');
		for (const entry of index) {
			const bytes = entries[entry.file];
			if (!bytes) continue;
			// pass the Uint8Array VIEW — applyAssetFile slices byteOffset..length
			// so fflate's shared buffers don't corrupt the content hash
			await applyAssetFile({ hash: entry.hash, name: entry.name, buffer: bytes });
		}
	}
	// B3: restore bundled packs — re-store each item blob (content-hash deduped;
	// ids can CHANGE, so remap the pack's item ids), then re-register the pack
	if (entries['packs/index.json']) {
		try {
			const packData = JSON.parse(strFromU8(entries['packs/index.json']));
			const { addItemFromBytes } = await import('./explorer');
			const { registerImportedPack } = await import('./packs');
			/** @type {Record<string, string>} old itemId -> restored id */
			const remap = {};
			for (const entry of packData.items ?? []) {
				const bytes = entries[entry.file];
				if (!bytes) continue;
				const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
				const stored = await addItemFromBytes(buf, entry.name || 'item', null);
				remap[entry.itemId] = stored.id;
			}
			for (const pack of packData.packs ?? []) {
				registerImportedPack({
					...pack,
					items: (pack.items ?? []).map((/** @type {any} */ it) => ({ ...it, id: remap[it.id] ?? it.id }))
				});
			}
		} catch (error) {
			console.log('pack restore failed', error);
		}
	}
	// finishImport, NOT importSession — the format was already confirmed above
	// (importSession would double-confirm)
	return finishImport(payload);
}

/** Top-level entries for the selective-import checklist @param {any} payload */
export function sessionObjectList(payload) {
	return (payload.objects ?? []).map((/** @type {any} */ element, /** @type {number} */ index) => ({
		index,
		name: element.object?.name || element.object?.type || 'Object',
		type: element.object?.type ?? 'Object3D'
	}));
}

/** Instantiate chosen session objects into the CURRENT scene (fresh uuids,
 * replicated + undoable — the prefab path). @param {any} payload @param {number[]} indices */
export function importObjects(payload, indices) {
	const group = get(objectsGroup);
	if (!group) return 0;
	/** @type {any} */
	const peer = get(peers);
	let added = 0;
	for (const index of indices) {
		const element = payload.objects?.[index];
		if (!element) continue;
		let object;
		try {
			object = new THREE.ObjectLoader().parse(element);
		} catch {
			continue;
		}
		object.traverse((/** @type {any} */ node) => (node.uuid = crypto.randomUUID()));
		group.add(object);
		recordObjectPresence('create', object);
		if (peer) peer.send({ type: 'object', element: object.toJSON() });
		added++;
	}
	objectsGroup.update((value) => value);
	showToast('Imported ' + added + ' object' + (added === 1 ? '' : 's') + ' from the session');
	return added;
}

/** Replace the scene with a session (safety-stash first). Replicates through
 * the normal clearscene/object/node messages. @param {any} payload */
export async function applySession(payload) {
	const group = get(objectsGroup);
	if (group?.children.length) await saveSession('Backup before "' + payload.name + '"');
	sceneCommand('/clear all'); // replicated clear (objects + module content)
	/** @type {any} */
	const peer = get(peers);
	for (const element of payload.objects ?? []) {
		let object;
		try {
			object = new THREE.ObjectLoader().parse(element);
		} catch {
			continue;
		}
		group.add(object); // keep original uuids — every peer converges on them
		if (peer) peer.send({ type: 'object', element });
	}
	objectsGroup.update((value) => value);
	// H1: new format restores EVERY graph document; legacy payloads carry the
	// scene graph only. One 'nodes' snapshot replicates the whole map.
	const graphsPayload =
		payload.graphs && typeof payload.graphs === 'object'
			? payload.graphs
			: payload.nodes?.length || payload.edges?.length
				? { [SCENE_GRAPH]: { nodes: payload.nodes ?? [], edges: payload.edges ?? [] } }
				: null;
	if (graphsPayload) {
		restoreGraphs(graphsPayload);
		if (peer)
			peer.send({
				type: 'nodes',
				graphs: graphsPayload,
				nodes: graphsPayload[SCENE_GRAPH]?.nodes ?? [],
				edges: graphsPayload[SCENE_GRAPH]?.edges ?? []
			});
	}
	annotationsRestore(payload.annotations ?? []);
	// P-B: joints restore locally + replicate each def (receivers only apply)
	jointsRestore(payload.joints ?? []);
	if (peer) for (const joint of payload.joints ?? []) peer.send({ type: 'jointcreate', joint });
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const controls = get(orbitControls);
	if (payload.camera && camera) {
		camera.position.fromArray(payload.camera.position);
		if (controls) {
			controls.target.fromArray(payload.camera.target);
			controls.update();
		}
	}
	showToast('Session loaded: ' + payload.name + ' (' + (payload.count ?? 0) + ' objects)');
}

// ---- proposal flow (50.3) --------------------------------------------------

/** @type {{payload: any, accepts: Set<string>, needed: string[]} | null} */
let pendingProposal = null;

/** Load a session — solo applies immediately, with peers it becomes a proposal
 * every connected peer must accept. @param {string} id */
export async function requestLoadSession(id) {
	const payload = await getSession(id);
	if (!payload) return;
	/** @type {any} */
	const peer = get(peers);
	const connected = Object.keys(peer?.connections ?? {});
	if (!connected.length) {
		await applySession(payload);
		return;
	}
	pendingProposal = { payload, accepts: new Set(), needed: connected };
	peer.send({
		type: 'sessionproposal',
		name: payload.name,
		objects: payload.count ?? 0,
		from: peer.peer.id
	});
	showToast('Asked ' + connected.length + ' peer' + (connected.length === 1 ? '' : 's') + ' to load "' + payload.name + '"…');
}

/** Receiver side: Accept/Decline toast @param {any} data */
export function applySessionProposal(data) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	const answer = (/** @type {boolean} */ accept) =>
		peer.send({ type: 'sessionanswer', accept, from: peer.peer.id, to: data.from });
	showToast(
		nameOf(data.from) + ' wants to load session "' + data.name + '" (' + data.objects + ' objects). This replaces the current scene.',
		[
			{ label: 'Accept', action: () => answer(true) },
			{ label: 'Decline', action: () => answer(false) }
		]
	);
}

// ---- share-or-stash on connect (50.4) --------------------------------------
// The first time another peer requests our state while we own local objects,
// the objects/nodes replies DEFER behind a choice: share them into the joint
// space (old behavior) or stash them to a session and join clean. Asked once
// per app session; the prompt is STICKY with NO ✕ and waits for an explicit
// Share/Stash click (15-P2 — it used to auto-share after 14s, which could
// silently publish a scene the user meant to stash; a dismiss-that-shares
// would be the same trap smaller).

let shareChoiceMade = false;
/** @type {{senders: {objects: Set<string>, nodes: Set<string>}, payload: any, uuids: string[], done: boolean} | null} */
let gate = null;

// sendObjects' second param only matters for the null-peerId group path —
// the handshake reply has always called it with the sender alone
const sendObjectsTo = /** @type {any} */ (sendObjects);

/** @param {'objects'|'nodes'} kind @param {string} sender */
function replyTo(kind, sender) {
	if (kind === 'objects') sendObjectsTo(sender);
	else sendNodes(sender);
}

/** How many objects we own — rides on the handshake getobjects request so the
 * other side only asks share-or-stash when BOTH scenes are non-empty. */
export function localSceneCount() {
	return get(objectsGroup)?.children.length ?? 0;
}

function resolveGate() {
	if (!gate || gate.done) return;
	gate.done = true;
	const pending = gate;
	gate = null;
	for (const sender of pending.senders.objects) sendObjectsTo(sender);
	for (const sender of pending.senders.nodes) sendNodes(sender);
}

async function stashAndJoin() {
	if (!gate || gate.done) return;
	const { payload, uuids } = gate;
	await persistSession(payload);
	// drop OUR pre-connect objects locally WITHOUT broadcasting deletes —
	// anything that already arrived from the peer stays untouched
	const group = get(objectsGroup);
	/** @type {any} */
	const controls = get(TControls);
	for (const uuid of uuids) {
		const object = group?.getObjectByProperty('uuid', uuid);
		if (!object) continue;
		if (controls?.object?.uuid === uuid) controls.detach();
		object.parent?.remove(object);
	}
	objectsGroup.update((value) => value);
	clearGraphs(); // H1: stash empties every graph document
	showToast('Stashed to Sessions: ' + payload.name);
	resolveGate();
}

/**
 * Gatekeeper for the handshake state requests. Runs the reply immediately
 * when no choice is needed (empty scene on either side, or already answered);
 * otherwise queues it behind the Share/Stash toast.
 * @param {'objects'|'nodes'} kind @param {string} sender @param {number=} otherCount
 */
export function deferUntilShareChoice(kind, sender, otherCount = 0) {
	const group = get(objectsGroup);
	const count = group?.children.length ?? 0;
	if (gate && !gate.done) {
		gate.senders[kind].add(sender); // a dialog is already open — queue behind it
		return;
	}
	// only a merge of two NON-empty scenes needs the question — a fresh viewer
	// joining an existing scene always just receives it
	if (shareChoiceMade || count === 0 || !otherCount) {
		if (count > 0) shareChoiceMade = true; // we shared into the space
		replyTo(kind, sender);
		return;
	}
	shareChoiceMade = true;
	gate = {
		senders: { objects: new Set(), nodes: new Set() },
		payload: buildSessionPayload('Stashed before joining ' + nameOf(sender) + ' ' + new Date().toLocaleTimeString()),
		uuids: (group?.children ?? []).map((/** @type {any} */ child) => child.uuid),
		done: false
	};
	gate.senders[kind].add(sender);
	// 15-P2: a STICKY prompt with NO ✕ — this decides whether the user's work
	// merges into the joint space, so nothing may decide it implicitly: the 14s
	// auto-share could silently publish a scene they meant to stash, and a
	// dismiss-that-shares would be the same trap smaller. The joiner's handshake
	// reply simply waits until Share or Stash is clicked.
	showInfoToast(
		'share-or-stash',
		'Share your ' + count + ' object' + (count === 1 ? '' : 's') + ' with ' + nameOf(sender) + ', or stash them to a session first?',
		[
			{ label: 'Share', action: () => resolveGate() },
			{ label: 'Stash', action: () => stashAndJoin() }
		],
		undefined,
		true
	);
}

/** Proposer side: collect answers, apply when everyone accepted @param {any} data */
export function applySessionAnswer(data) {
	/** @type {any} */
	const peer = get(peers);
	if (!pendingProposal || data.to !== peer?.peer?.id) return;
	if (!data.accept) {
		showToast(nameOf(data.from) + ' declined the session load');
		pendingProposal = null;
		return;
	}
	pendingProposal.accepts.add(data.from);
	if (pendingProposal.needed.every((id) => pendingProposal?.accepts.has(id))) {
		const proposal = pendingProposal;
		pendingProposal = null;
		applySession(proposal.payload);
	}
}
