import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, globalCamera, globalScene, globalRenderer, orbitControls, TControls } from '../stores/sceneStore';
import { restoreGraphs, clearGraphs, SCENE_GRAPH, allNodes } from '../stores/flowStore';
import { serializeGraphs, copyGraphFrom } from './flowGraphs';
import { serializeNode, serializeEdge, sendNodes } from './nodesHandler';
import { parkAnimatedAtBase } from './flowRuntime';
import { stripEditOverlays } from './editOverlays';
// B7: a spawner's copies exist only while the world runs — never in a scene file
import { isTransient } from './transientObjects';
import {
	animatedImportUuids,
	animatedImportsSnapshot,
	animatedImportsRestore
} from './animatedImports';
import { animationsSnapshot, animationsRestore, copyAnimationsFrom } from './animationPreview';
import { shaderGraphsSnapshot, shaderGraphsRestore, copyShaderGraphFrom } from './shaderGraph';
import { peers, showToast, showInfoToast, dismissToastById, modulesOpen } from '../stores/appStore';
import { recordObjectPresence } from './history';
import { annotationsSnapshot, annotationsRestore } from './autosave';
// #20 P5: selection + any open edit session ride the file; PANEL LAYOUT does not (that
// is a local preference, workspace.js). Its own module so this file keeps no static edge
// into faceEdit/meshEdit/terrainSculpt.
import { captureEditResume, applyEditResume } from './editResume';
import { jointsSnapshot, jointsRestore } from './joints';
import { scenePostSnapshot, scenePostRestore } from './scenePost';
// A6.1: the scene's LOOK and RULES ride the file beside its objects. They were
// missing, so a template loaded into whatever sky and gravity the room happened to
// have — and a physics scene is unplayable at a peer's edited gravity. Each pair
// follows scenePost exactly: null when default, and restore stamps a fresh
// changedAt because a restore is an authoritative local write.
import { environmentSnapshot, environmentRestore } from './environment';
import { scenePhysicsSnapshot, scenePhysicsRestore } from './scenePhysics';
import { musicSnapshot, musicRestore } from './sceneMusic';
import {
	moduleRequirements,
	classifyRequirements,
	rememberSceneModules
} from './moduleRequirements';
import { disabledModules } from './moduleSDK';
import { findNodeSpec } from './nodeCatalog';
import { hudDocsSnapshot, hudDocsRestore } from './hudDocs';
import { gameStateSnapshot, gameStateRestore } from './gameState';
import { sceneCommand, sendObjects, clearSceneLocal } from './commandsHandler.svelte';
import { nameOf } from './lockControl';
import { idbGet, idbPut, idbDelete, idbKeys } from './idb';
import { showConfirm, showChoice } from './confirmDialog';
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
/**
 * R22 round 11 — THE PICTURE COMES FROM THE VIEWPORT FIRST.
 *
 * The report was that saved entries showed the generic archive icon. MEASURED on this
 * branch, the offscreen path below works: a scene holding one box produced a 1567-byte
 * webp through the real UI, for both the scene save and the project save. So the
 * mechanism is not broken — which means the reported nulls came from one of the two ways
 * it can legitimately return null, and only one of those is acceptable:
 *
 *   · an EMPTY scene has nothing to picture, and a null there is honest;
 *   · anything the offscreen ritual can THROW on is not. It builds a SECOND WebGL context
 *     (browsers cap those), and it round-trips the whole scene through
 *     `ObjectLoader().parse(group.toJSON())` — which cannot rebuild every geometry a real
 *     scene contains (a WireframeGeometry is the documented one). Either failure is caught
 *     and turns into a silent null, and a silent null is exactly what "it shows the
 *     archive icon" looks like.
 *
 * So the primary path is now the one the cloud plugin's room thumbnails already use and
 * that has no second context and no serialization at all: render a fresh frame on the
 * LIVE renderer and read its canvas. It cannot throw on a geometry, it costs no context,
 * and it shows the scene the way the author is looking at it. The offscreen render stays
 * as the FALLBACK, for the one case the live path cannot serve (VR, where the canvas
 * belongs to the headset).
 *
 * A fresh render is what makes this work without `preserveDrawingBuffer`: the drawing
 * buffer is cleared after compositing, so it has to be read in the same tick it is drawn.
 * @param {number} maxW @returns {string|null} a dataURL, or null
 */
function viewportThumbnail(maxW = 256) {
	/** @type {any} */
	const renderer = get(globalRenderer);
	const scene = get(globalScene);
	const camera = get(globalCamera);
	if (!renderer || !scene || !camera || renderer.xr?.isPresenting) return null;
	try {
		renderer.render(scene, camera);
		const source = renderer.domElement;
		const sw = source.width || maxW;
		const scale = Math.min(1, maxW / sw);
		const w = Math.max(1, Math.round(sw * scale));
		const h = Math.max(1, Math.round((source.height || maxW) * scale));
		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.drawImage(source, 0, 0, w, h);
		return canvas.toDataURL('image/webp', 0.7);
	} catch (error) {
		console.log('viewport thumbnail failed', error);
		return null;
	}
}

/** The saved entry's picture. @param {any} group @returns {string|null} */
function renderSceneThumbnail(group) {
	try {
		if (!group || group.children.length === 0) return null;
		// the live viewport first — see viewportThumbnail for why
		const live = viewportThumbnail();
		if (live) return live;
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

/**
 * R22 round 9: HOW BIG IS THIS ENTRY. Two halves measured differently because they are
 * stored differently — the library's files are real Blobs (idb structured-clones them, so
 * `.size` is the truth) while everything else is JSON, whose size has to be encoded to be
 * known. Reported as one number, because the user is asking about disk and not about our
 * storage layout.
 *
 * An ESTIMATE, and labelled as one in the UI: idb's own overhead is not observable from
 * here. It is measured per payload at load, which is affordable because `loadSessions`
 * already reads every payload in full.
 * @param {any} payload @returns {number}
 */
function payloadBytes(payload) {
	let bytes = 0;
	try {
		const { library, ...rest } = payload ?? {};
		for (const row of library?.items ?? []) bytes += Number(row?.blob?.size) || 0;
		bytes += new TextEncoder().encode(JSON.stringify(rest)).length;
	} catch {}
	return bytes;
}

/** @param {any} payload */
function metaOf(payload) {
	return {
		id: payload.id,
		name: payload.name,
		createdAt: payload.createdAt,
		count: payload.count,
		thumbnail: payload.thumbnail,
		// R22 round 9: the PROJECT/SCENE distinction is not a new field to store — a project
		// entry is one that carries a library, which is exactly what `saveSessionWithLibrary`
		// adds. Derived, so every session ever saved answers correctly with no migration.
		hasLibrary: !!payload.library,
		libraryCount: payload.library?.items?.length ?? 0,
		bytes: payloadBytes(payload)
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
	const animatedUuids = animatedImportUuids(group);
	/** @type {any} */
	let graphs;
	// A6.1/A6.2: none of these read the object graph, so they are taken before the
	// serialization block and folded in with a conditional spread below
	const env = environmentSnapshot();
	const gravity = scenePhysicsSnapshot();
	const track = musicSnapshot();
	const mods = moduleRequirements();
	try {
		return {
			id: crypto.randomUUID(),
			name: name || 'Session ' + new Date().toLocaleString(),
			createdAt: Date.now(),
			// V4: format gates loading (a NEWER int asks before importing);
			// appVersion is display-only provenance
			format: SESSION_FORMAT,
			appVersion: APP_VERSION,
			count: (group?.children ?? []).filter((/** @type {any} */ child) => !isTransient(child)).length,
			thumbnail: renderSceneThumbnail(group),
			// animated imports are saved as their ORIGINAL bytes below instead:
				// toJSON carries no AnimationClip and mangles rigs, so a saved scene
				// used to come back with dead, static models
				// B7: and a TRANSIENT object is not saved at all — it exists only while the
				// simulation runs, so saving mid-run would bake a spawner's crates into the
				// scene file as permanent content
				objects: (group?.children ?? [])
					.filter((/** @type {any} */ child) => !animatedUuids.includes(child.uuid) && !isTransient(child))
					.map((/** @type {any} */ child) => child.toJSON()),
				animated: animatedImportsSnapshot(group),
				// authored movement tracks (the Animation window) were never saved
				animations: animationsSnapshot(),
				// H1: full graph map (+ legacy SCENE fields so old builds can load it)
			graphs: (graphs = serializeGraphs(serializeNode, serializeEdge, {
				pruneMissing: (uuid) => !group?.getObjectByProperty?.('uuid', uuid)
			})),
			nodes: graphs[SCENE_GRAPH]?.nodes ?? [],
			edges: graphs[SCENE_GRAPH]?.edges ?? [],
			// SH4: toJSON would write our injected material as the object's own, so the
			// scene is saved PARKED (parkAnimatedAtBase, above) and the graphs ride here
			shaderGraphs: shaderGraphsSnapshot({
				pruneMissing: (uuid) => !group?.getObjectByProperty?.('uuid', uuid)
			}),
			annotations: annotationsSnapshot(),
			joints: jointsSnapshot(),
			// L2: the authored post stack rides BESIDE the objects like joints and
			// annotations — it is scene data, not per-object data. Absent (null) when
			// the scene has no look, so an older build reading this file sees no field.
			post: scenePostSnapshot(),
			// A6.1: sky/fog/exposure + extra lights, scene gravity, the shared music
			// track, and which MODULES the flow needs. Each snapshot is NULL when it
			// is the default, and a null one is OMITTED rather than written as
			// `"environment":null` — so a plain scene's session.json is byte-identical
			// to what a pre-A6 build wrote, and absent already means default on the
			// way back in. (`post` predates this and keeps its explicit null.)
			...(env ? { environment: env } : {}),
			...(gravity ? { physics: gravity } : {}),
			...(track ? { music: track } : {}),
			// A6.2: {id, version} — the handshake's shape, so there is one shape for
			// "which modules" in the whole system.
			...(mods.length ? { modules: mods } : {}),
			// A2: the HUD, on the same reasoning and the same terms — scene data beside the
			// objects, null when nothing is authored so a default scene saves byte-identical
			hud: hudDocsSnapshot({
				pruneMissing: (uuid) => !group?.getObjectByProperty?.('uuid', uuid)
			}),
			// 21-D6: the game shell, null when pristine so a scene with no game is unchanged
			game: gameStateSnapshot(),
			camera: camera
				? { position: camera.position.toArray(), target: controls?.target?.toArray() ?? [0, 0, 0] }
				: null,
			// P5: where the author left off — the selection and any open mesh-edit /
			// sculpt session with its picks. NULL for an ordinary scene, so the field is
			// absent and every existing file stays byte-identical.
			workspace: captureEditResume()
		};
	} finally {
		restore();
	}
}

/**
 * R22 round 11 — A .tpscene OF A SELECTION, not of the world.
 *
 * The user picked the formats themselves: "prefab (.glb), prefab (.tpscene) — tooltip
 * when hovering that it includes animations/object-graph-nodes/shaders/etc". This is what
 * makes that sentence true, and it is a DIFFERENT ACT from buildSessionPayload rather
 * than an option on it. Two reasons to keep them apart: buildSessionPayload is on the
 * hot path that decides "has this scene changed" (sceneSignature, round 11 phase 1) and
 * an `only` flag there is one branch away from a wrong verdict; and what a selection
 * MEANS is different — a subtree, not a world.
 *
 * SO WHAT TRAVELS: the objects, their authored clips, their object flow graphs, their
 * shader graphs, and the joints whose BOTH ends are in the set. What does not: the
 * environment, the look, the gravity, the music, the HUD and the game shell. Those are
 * facts about a world, and a prefab dropped into somebody else's scene has no business
 * changing their sky. The menu's tooltip says both halves out loud.
 *
 * Every snapshot already takes a `pruneMissing` predicate for exactly this shape of
 * question, so the filtering is theirs and not a second copy here.
 * @param {string} name @param {string[]} uuids top-level objects
 * @returns {any} a payload readSessionZip/importObjects understand
 */
export function buildSelectionPayload(name, uuids) {
	const group = get(objectsGroup);
	const roots = (uuids ?? []).filter(Boolean);
	/** every uuid in the selected SUBTREES — a document may be keyed by a child */
	const inSet = new Set();
	for (const uuid of roots) {
		const object = group?.getObjectByProperty('uuid', uuid);
		object?.traverse?.((/** @type {any} */ node) => inSet.add(node.uuid));
	}
	const missing = (/** @type {string} */ id) => !inSet.has(id);
	const restore = parkAnimatedAtBase();
	const animatedUuids = animatedImportUuids(group);
	try {
		const objects = roots
			.map((uuid) => group?.getObjectByProperty('uuid', uuid))
			.filter((/** @type {any} */ object) => object && !animatedUuids.includes(object.uuid) && !isTransient(object))
			.map((/** @type {any} */ object) => object.toJSON());
		const clips = animationsSnapshot();
		/** @type {any} */
		const animations = {};
		for (const [uuid, set] of Object.entries(clips ?? {})) if (inSet.has(uuid)) animations[uuid] = set;
		return {
			id: crypto.randomUUID(),
			name: name || 'Selection',
			createdAt: Date.now(),
			format: SESSION_FORMAT,
			appVersion: APP_VERSION,
			count: objects.length,
			thumbnail: null,
			objects,
			// a rigged import replicates as its ORIGINAL bytes, so it rides the same way here
			animated: animatedImportsSnapshot(group).filter((/** @type {any} */ record) => inSet.has(record.uuid)),
			animations,
			// THE SCENE GRAPH IS NOT PART OF A SELECTION, and `pruneMissing` cannot say so:
			// it asks "is this graph's OBJECT still here", and the scene graph has no object,
			// so it survives every predicate. Measured while building the counterfactual —
			// the payload came out holding `{scene, <the box>}`, which would have travelled
			// the author's whole scene logic inside a prefab.
			graphs: Object.fromEntries(
				Object.entries(serializeGraphs(serializeNode, serializeEdge, { pruneMissing: missing })).filter(
					([key]) => key !== SCENE_GRAPH
				)
			),
			nodes: [],
			edges: [],
			shaderGraphs: shaderGraphsSnapshot({ pruneMissing: missing }),
			annotations: annotationsSnapshot().filter((/** @type {any} */ note) => inSet.has(note.objectUuid)),
			// a joint with one end outside the set would arrive attached to nothing
			joints: jointsSnapshot().filter((/** @type {any} */ joint) => inSet.has(joint.a) && inSet.has(joint.b)),
			post: null,
			hud: null,
			game: null,
			camera: null
		};
	} finally {
		restore();
	}
}

/**
 * 21-F4: a payload with NOTHING in it — what "New scene…" saves as a fresh level asset.
 * The same shape buildSessionPayload writes, minus every capture: an empty level must not
 * inherit whatever scene happens to be open when it is created.
 * @param {string} name
 */
export function emptySessionPayload(name) {
	return {
		id: crypto.randomUUID(),
		name: name || 'New level',
		createdAt: Date.now(),
		format: SESSION_FORMAT,
		appVersion: APP_VERSION,
		count: 0,
		thumbnail: null,
		objects: [],
		animated: [],
		animations: {},
		graphs: {},
		nodes: [],
		edges: [],
		shaderGraphs: {},
		annotations: [],
		joints: [],
		post: null,
		hud: null,
		game: null,
		camera: null
	};
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

/**
 * R22-R8 (locked answer) — SAVE THE PROJECT, THEN ADOPT THE HOST'S.
 *
 * "Save into session" saves the current project into sessions, CLEARS the Explorer and
 * downloads everything from the peers. The middle step is destructive, so the first one
 * has to be complete: an ordinary session payload is a SCENE snapshot and carries only
 * the assets that scene references, which means clearing the library afterwards would
 * throw away every file the scene does not happen to use.
 *
 * So this payload carries the LIBRARY as well — folders, item records and their bytes,
 * as real Blobs, which idb structured-clones for free. It rides BESIDE the scene the way
 * `animated` original bytes already do (the documented rule: anything the scene
 * serializer cannot round-trip travels beside the snapshot, not inside it).
 *
 * Additive: a session without the key restores exactly as it always did.
 * @param {string} name @returns {Promise<any>}
 */
export async function saveSessionWithLibrary(name) {
	const { explorerFolders, explorerItems, itemBlob } = await import('./explorer');
	const base = buildSessionPayload(name);
	if (!base) return null;
	/** @type {any[]} */
	const items = [];
	for (const item of get(explorerItems)) {
		const blob = await itemBlob(item.id);
		if (!blob) continue; // an index row whose bytes are gone carries nothing
		// R22 round 11 (user): "would be nice to be able to see thumbnails from project
		// files". The picture is already on the library record and was simply not copied
		// across, so a saved project's files had nothing to show. Additive: a project saved
		// before this carries no `thumbnail` key and falls back to its kind icon.
		items.push({
			name: item.name,
			kind: item.kind,
			folderId: item.folderId,
			hash: item.hash,
			blob,
			...(item.thumbnail ? { thumbnail: item.thumbnail } : {})
		});
	}
	/** @type {any} */
	const payload = base;
	payload.library = {
		folders: get(explorerFolders).map((f) => ({ id: f.id, name: f.name, parentId: f.parentId })),
		items
	};
	const saved = await persistSession(payload);
	if (saved) showToast('Session saved: ' + saved.name + ' (with ' + items.length + ' library file' + (items.length === 1 ? '' : 's') + ')');
	return saved;
}

/**
 * Put a saved session's library back. Called from the session RESTORE path; a payload
 * with no `library` key is a pre-R8 session and takes this as a no-op.
 * @param {any} payload @returns {Promise<number>} how many files were restored
 */
export async function restoreSessionLibrary(payload) {
	const lib = payload?.library;
	if (!lib) return 0;
	const { createFolder, addItemFromBytes } = await import('./explorer');
	for (const f of lib.folders ?? []) createFolder(String(f.name ?? 'Folder'), f.parentId ?? null, { id: f.id });
	let n = 0;
	for (const row of lib.items ?? []) {
		try {
			const buffer = await row.blob.arrayBuffer();
			await addItemFromBytes(buffer, row.name, row.folderId ?? null);
			n++;
		} catch {}
	}
	return n;
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


/**
 * A6.2: the module-requirement prompt. A scene's `modules` field names what its
 * FLOW needs; this is where a player finds out before the scene lands looking
 * broken.
 *
 * Runs where `confirmSessionFormat` runs — after the format check and BEFORE any
 * restore or asset loop — because a cancelled import must not mutate anything.
 * Returns false only for an explicit Cancel; every other answer proceeds, because
 * this is ADVISORY by design (so is `checkModuleVersions`) and a scene the player
 * wants to look at should never be un-openable.
 *
 * The one sentence it must say out loud is that installing here installs for THIS
 * player: modules do not travel over the wire, so each peer needs their own copy.
 * @param {any} payload @returns {Promise<boolean>} false = cancel the import
 */
async function confirmModuleRequirements(payload) {
	const { missing, disabled } = classifyRequirements(payload?.modules);
	if (!missing.length && !disabled.length) return true;
	const name = (/** @type {any} */ entry) => entry.id + (entry.version ? ' v' + entry.version : '');
	const lines = [];
	if (missing.length) lines.push('Not installed: ' + missing.map(name).join(', '));
	if (disabled.length) lines.push('Switched off: ' + disabled.map(name).join(', '));
	/** @type {{value: string, label: string, color?: string}[]} */
	const choices = [];
	if (missing.length) choices.push({ value: 'install', label: 'Install (' + missing.length + ')' });
	if (disabled.length) choices.push({ value: 'enable', label: 'Enable (' + disabled.length + ')' });
	choices.push({ value: 'anyway', label: 'Load anyway', color: 'alternative' });
	const answer = await showChoice({
		title: 'This scene uses modules',
		message:
			lines.join('\n') +
			'\n\nEach player needs this module — installing it here installs it for you only.',
		choices
	});
	if (!answer) return false; // Cancel / Esc / outside-close: nothing has been touched
	if (answer === 'enable') enableRequired(disabled);
	if (answer === 'install') await installRequired(missing);
	return true;
}

/** Switch requested modules back on (they are already installed).
 * @param {{id: string}[]} entries */
function enableRequired(entries) {
	const ids = entries.map((entry) => entry.id);
	disabledModules.update((list) => list.filter((id) => !ids.includes(id)));
	showToast(
		'Enabled ' + ids.join(', ') + ' — reload if a node still shows as missing'
	);
}

/**
 * Install the missing modules from the gallery. Reuses the Browse tab's own
 * machinery (`loadModuleGallery` + `galleryInstallUrl` + `installUrl`), so there
 * is no second install path to keep correct — and a module the gallery does not
 * list is REPORTED rather than silently skipped.
 * @param {{id: string}[]} entries
 */
async function installRequired(entries) {
	const { loadModuleGallery, galleryModules, galleryInstallUrl } = await import('./moduleGallery');
	const { installUrl } = await import('./userModules');
	await loadModuleGallery();
	const listed = get(galleryModules);
	const absent = [];
	let installed = 0;
	for (const entry of entries) {
		const found = listed.find((/** @type {any} */ item) => item.id === entry.id);
		if (!found) {
			absent.push(entry.id);
			continue;
		}
		if (await installUrl(galleryInstallUrl(found))) installed++;
		else absent.push(entry.id);
	}
	if (installed)
		showToast(
			'Installed ' + installed + ' module' + (installed === 1 ? '' : 's') +
				' — every player needs their own copy'
		);
	if (absent.length)
		showInfoToast(
			'scene-modules-missing',
			'Could not install: ' + absent.join(', ') + '. The scene loads without ' +
				(absent.length === 1 ? 'it' : 'them') + ' — nodes from ' +
				(absent.length === 1 ? 'that module' : 'those modules') + ' will show as missing.',
			[
				{
					label: 'Open Modules',
					// a sticky info toast is only removed by its id, so the action clears
					// its own prompt on the way out (the share-or-stash precedent)
					action: () => {
						dismissToastById('scene-modules-missing');
						modulesOpen.set(true);
					}
				}
			]
		);
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
	// A6.2: BEFORE finishImport writes the slot — a cancelled import must not mutate
	if (!(await confirmModuleRequirements(payload))) return null;
	return finishImport(payload);
}

// ---- session ZIP: session.json + the scene's binary assets (127) ----

/**
 * 21-I5 — THE HONESTY TOAST, and the ONE half of the bundle that survives its revision.
 *
 * The interim 21-I5 build could WRITE a `versions/` section into a `.tpscene` from an
 * Export Settings checkbox. That option is GONE: `saveTpScene` exports whatever is in
 * the viewport, which cannot always answer "and its history" — an unnamed or
 * never-travelled scene has no manifest entry to look one up in, so the box silently
 * produced nothing. Per-scene DOWNLOADS in the Explorer replaced it, where the scene
 * card makes the name and the history unambiguous.
 *
 * **NOTHING IN THE APP WRITES `versions/` ANY MORE**, and nothing ever read it back
 * (the export-only ruling: a second door into the library is exactly what would let a
 * content-addressed item be created from a fat file whose hash is not its content's).
 * This stays because files produced by that interim build EXIST on people's disks, and
 * a load that ignored their extra section in silence would be the dishonest half of
 * what was just removed.
 * @param {Record<string, Uint8Array>} entries @returns {number} versions in the file
 */
function noteBundledVersions(entries) {
	const n = Object.keys(entries).filter((k) => k.startsWith('versions/')).length;
	if (!n) return 0;
	showToast(
		'This scene file also carries ' + n + ' saved version' + (n === 1 ? '' : 's') +
			' of the scene. ' + (n === 1 ? 'It is' : 'They are') +
			' not loaded — unzip the file to open ' + (n === 1 ? 'it' : 'one') + '.'
	);
	return n;
}

/**
 * Build a .zip Uint8Array for a session: session.json + assets/<hash>.<ext>
 * (the 108 scene manifest's audio/config/textures) + an assets/index.json map.
 * Portable — re-importing on a fresh machine restores the assets too.
 *
 * A scene's VERSION HISTORY is deliberately not one of the include-options. The interim
 * 21-I5 build had it as a fourth checkbox and it could not work from here: this function
 * is handed "whatever is in the viewport", which is not always a named project scene, so
 * there was frequently no history to look up and the box wrote nothing. Downloading
 * versions is a per-SCENE action in the Explorer now — see `noteBundledVersions` above.
 *
 * @param {any} payload
 * @param {{assets?: boolean, packs?: boolean, flow?: boolean}} [opts]
 */
export async function exportSessionZip(payload, opts = { assets: true, packs: false, flow: true }) {
	const { zipSync, strToU8 } = await import('fflate');
	const { sceneAssetList } = await import('./sceneAssets');
	const { itemByHash, itemBlob } = await import('./explorer');
	// B3 (.tpscene): the include-checkboxes — flow strips nodes/edges, assets
	// toggles the hash bundle, packs adds the imported-pack section below
	// A6.3 (bug): this stripped the LEGACY nodes/edges fields and left `graphs`
	// untouched, so "don't include the flow" exported every graph document anyway —
	// including per-object ones the legacy fields never carried. `modules` goes with
	// it, because the requirement is DERIVED from the flow: keeping it would prompt
	// for a module the exported file no longer uses.
	if (opts.flow === false) {
		payload = { ...payload, nodes: [], edges: [], graphs: {} };
		delete payload.modules;
	}
	/**
	 * R22 round 12 — THE LIBRARY HAS TO TRAVEL AS FILES.
	 *
	 * MEASURED BUG, pre-existing since R8: this wrote `JSON.stringify(payload)`, and a
	 * PROJECT payload's `library.items[].blob` is a Blob — which stringifies to `{}`. So a
	 * project entry downloaded as a bundle silently arrived with every file gone, and
	 * nothing anywhere said so. It is the documented rule one layer down: what a serializer
	 * cannot round-trip rides BESIDE it, keyed so the reader can put it back.
	 *
	 * So the blobs become real zip entries under `library/` and session.json carries an
	 * INDEX in their place. A payload with no library is byte-identical to before.
	 */
	/** @type {Record<string, any>} */
	const files = {};
	/** @type {any} */
	let wire = payload;
	if (payload?.library?.items?.length) {
		/** @type {any[]} */
		const libIndex = [];
		let n = 0;
		for (const row of payload.library.items) {
			if (!row?.blob) continue;
			const file = 'library/' + n++ + '-' + String(row.name ?? 'file').replace(/[^\w.-]+/g, '_');
			files[file] = new Uint8Array(await row.blob.arrayBuffer());
			libIndex.push({ name: row.name, kind: row.kind, folderId: row.folderId ?? null, hash: row.hash, file, ...(row.thumbnail ? { thumbnail: row.thumbnail } : {}) });
		}
		wire = { ...payload, library: { folders: payload.library.folders ?? [], items: libIndex } };
	}
	files['session.json'] = strToU8(JSON.stringify(wire));
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
 * R22 round 12: the other half of writing the library out as files. A row whose `file` is
 * missing from the zip keeps its index entry and simply has no bytes — the same "counted,
 * never silently dropped" rule a pruned scene hash follows.
 * @param {any} payload @param {Record<string, any>} entries @returns {Promise<any>}
 */
async function restoreLibraryBlobs(payload, entries) {
	const rows = payload?.library?.items;
	if (!Array.isArray(rows)) return payload;
	let restored = 0;
	for (const row of rows) {
		const bytes = row?.file ? entries[row.file] : null;
		if (!bytes) continue;
		row.blob = new Blob([
			/** @type {BlobPart} */ (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
		]);
		restored++;
	}
	if (restored) console.log('session zip: restored ' + restored + ' library file(s)');
	return payload;
}

/** The zip's bundled assets into the Explorer (hash-deduped) so sound/texture hashes
 * resolve. Shared by importSessionZip and 21-F4's readSessionZip.
 * @param {Record<string, Uint8Array>} entries @param {(bytes: Uint8Array) => string} strFromU8 */
async function restoreZipAssets(entries, strFromU8) {
	let index = [];
	try {
		if (entries['assets/index.json']) index = JSON.parse(strFromU8(entries['assets/index.json']));
	} catch {
		index = [];
	}
	if (!index.length) return;
	const { applyAssetFile } = await import('./assetShare');
	for (const entry of index) {
		const bytes = entries[entry.file];
		if (!bytes) continue;
		// pass the Uint8Array VIEW — applyAssetFile slices byteOffset..length
		// so fflate's shared buffers don't corrupt the content hash
		await applyAssetFile({ hash: entry.hash, name: entry.name, buffer: bytes });
	}
}

/**
 * 21-F4: read a session zip WITHOUT importing it — no slot written, no dialogs. LEVEL
 * TRAVEL runs on every peer at once off a replicated trigger, so a confirm dialog has
 * nobody to answer it and a cancel could not be honoured anyway (the others already
 * left). A NEWER format is REFUSED with a toast instead of asked about; assets are
 * restored (hash-deduped) so the level's textures and sounds resolve.
 * @param {ArrayBuffer} buffer @returns {Promise<any|null>} the payload, or null
 */
export async function readSessionZip(buffer) {
	const { unzipSync, strFromU8 } = await import('fflate');
	const entries = unzipSync(new Uint8Array(buffer));
	const sessionBytes = entries['session.json'];
	if (!sessionBytes) return null;
	const payload = parseSessionJson(strFromU8(sessionBytes));
	const format = Number(payload?.format ?? 0);
	if (!payload || format > SESSION_FORMAT) {
		showToast('This level needs a newer app version (format ' + format + ' > ' + SESSION_FORMAT + ')');
		return null;
	}
	await restoreZipAssets(entries, strFromU8);
	// R22 round 12: and the library's own files, which session.json carries only an index of
	await restoreLibraryBlobs(payload, entries);
	// 21-I5: `versions/` is read by NOTHING — say so rather than ignore it silently
	noteBundledVersions(entries);
	return payload;
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
	// A6.2: and the module prompt sits right beside it, above the asset/pack loops
	// for the same reason — a cancelled import must not touch the Explorer either
	if (!(await confirmModuleRequirements(payload))) return null;
	// 21-I5: after the confirms (a cancelled import must not talk about the file it did
	// not read) and before the restore loops, which never touch `versions/`
	noteBundledVersions(entries);
	await restoreZipAssets(entries, strFromU8);
	// R22 round 12: a bundle written by this build carries its library as real files, so
	// an imported PROJECT entry arrives with its files rather than with `{}` where each
	// Blob used to be (the measured pre-existing loss).
	await restoreLibraryBlobs(payload, entries);
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

/**
 * R22 round 11 (user): "for sessions instead of 'import objects' should be 'import files'
 * and within files which are scenes I should be able to import objects from there".
 *
 * THE FILES IN A SAVED ENTRY, which is a two-level thing and always was — it simply had no
 * first level. A PROJECT entry carries `library.items`; a SCENE-only entry carries none,
 * and rather than showing an empty list it shows the one file it IS. So both kinds answer
 * the same question, and drilling into a scene row is what reaches the old object list.
 * @param {any} payload @returns {any[]}
 */
export function sessionFileList(payload) {
	/** the entry's OWN scene, always first — it is the file the entry is about */
	const own = {
		index: -1,
		name: (payload?.name ?? 'Scene') + '.tpscene',
		kind: 'scene',
		own: true,
		thumbnail: payload?.thumbnail ?? null,
		objects: (payload?.objects ?? []).length
	};
	const files = (payload?.library?.items ?? []).map((/** @type {any} */ row, /** @type {number} */ index) => ({
		index,
		name: row.name,
		kind: row.kind,
		own: false,
		thumbnail: row.thumbnail ?? null,
		bytes: Number(row.blob?.size) || 0
	}));
	return [own, ...files];
}

/**
 * R22 round 12 (user): "for saved projects when 'import files' clicked I should be able to
 * multiselect files, or import folders (I do not see folder structure now, but should)".
 *
 * THE STRUCTURE WAS ALWAYS SAVED and simply never rendered: `saveSessionWithLibrary`
 * writes `library.folders = [{id, name, parentId}]` and every item row carries its
 * `folderId`. This lays them out as INDENTED ROWS — a folder followed by its own files,
 * depth-first — which is what makes "I do not see folder structure" answerable without a
 * tree widget: a row IS its place.
 *
 * Files at the ROOT come last rather than first, because a project's loose files are the
 * exception and burying its folders under them reads as no structure at all.
 * @param {any} payload
 * @returns {any[]} rows: {key, kind:'folder'|'file', depth, name, path, index?, id?, kindOf?, thumbnail?, bytes?}
 */
export function sessionLibraryTree(payload) {
	const folders = payload?.library?.folders ?? [];
	const items = payload?.library?.items ?? [];
	/** @type {any[]} */
	const rows = [];
	const childrenOf = (/** @type {any} */ parentId) =>
		folders
			.filter((/** @type {any} */ f) => (f.parentId ?? null) === (parentId ?? null))
			.sort((/** @type {any} */ a2, /** @type {any} */ b2) => String(a2.name).localeCompare(String(b2.name)));
	const filesIn = (/** @type {any} */ folderId) =>
		items
			.map((/** @type {any} */ row, /** @type {number} */ index) => ({ row, index }))
			.filter((/** @type {any} */ e) => (e.row.folderId ?? null) === (folderId ?? null))
			.sort((/** @type {any} */ a2, /** @type {any} */ b2) => String(a2.row.name).localeCompare(String(b2.row.name)));
	/** @param {any} folder @param {number} depth @param {string} path */
	const walk = (folder, depth, path) => {
		const here = path + '/' + folder.name;
		rows.push({ key: 'f:' + folder.id, kind: 'folder', depth, name: folder.name, path: here, id: folder.id });
		for (const child of childrenOf(folder.id)) walk(child, depth + 1, here);
		for (const entry of filesIn(folder.id)) rows.push(fileRow(entry, depth + 1, here));
	};
	for (const folder of childrenOf(null)) walk(folder, 0, '');
	for (const entry of filesIn(null)) rows.push(fileRow(entry, 0, ''));
	return rows;
}

/** @param {any} entry @param {number} depth @param {string} path */
function fileRow(entry, depth, path) {
	return {
		key: 'i:' + entry.index,
		kind: 'file',
		depth,
		name: entry.row.name,
		path: path + '/' + entry.row.name,
		index: entry.index,
		kindOf: entry.row.kind,
		thumbnail: entry.row.thumbnail ?? null,
		bytes: Number(entry.row.blob?.size) || 0
	};
}

/**
 * Bring chosen files out of a saved entry and into the CURRENT library.
 *
 * A DIFFERENT ACT from importing objects into the scene, and the reason it needs saying is
 * that one dialog now offers both: this one writes files and folders into the Explorer,
 * and `importObjects` puts objects in the world.
 *
 * FOLDERS MERGE BY PATH rather than by id. `restoreSessionLibrary` recreates the saved ids
 * because it is putting a whole library BACK; taking two files out of somebody's project
 * is a merge into a library that already exists, so a folder called Textures lands in the
 * Textures you already have instead of a second one wearing a stranger's id.
 * @param {any} payload
 * @param {{items?: number[], folders?: string[]}} selection
 * @returns {Promise<number>} how many files landed
 */
export async function importSessionFiles(payload, selection) {
	const lib = payload?.library;
	if (!lib) return 0;
	const { createFolder, addItemFromBytes, explorerFolders } = await import('./explorer');
	const saved = lib.folders ?? [];
	const rows = lib.items ?? [];
	/** every saved folder id under (and including) the picked ones */
	const subtree = new Set(selection?.folders ?? []);
	let grew = true;
	while (grew) {
		grew = false;
		for (const f of saved)
			if (f.parentId && subtree.has(f.parentId) && !subtree.has(f.id)) {
				subtree.add(f.id);
				grew = true;
			}
	}
	/** @type {Map<string, string|null>} saved folder id -> the LIVE folder it maps onto */
	const mapped = new Map();
	/** @param {string|null|undefined} savedId @returns {string|null} */
	const ensurePath = (savedId) => {
		if (!savedId) return null;
		if (mapped.has(savedId)) return mapped.get(savedId) ?? null;
		const folder = saved.find((/** @type {any} */ f) => f.id === savedId);
		if (!folder) return null;
		const parent = ensurePath(folder.parentId);
		const existing = get(explorerFolders).find(
			(/** @type {any} */ f) => f.name === folder.name && (f.parentId ?? null) === parent
		);
		const live = existing ?? createFolder(String(folder.name ?? 'Folder'), parent);
		mapped.set(savedId, live?.id ?? null);
		return live?.id ?? null;
	};

	const picked = new Set(selection?.items ?? []);
	let n = 0;
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		const inFolder = row.folderId && subtree.has(row.folderId);
		if (!picked.has(index) && !inFolder) continue;
		try {
			const buffer = await row.blob.arrayBuffer();
			await addItemFromBytes(buffer, row.name, ensurePath(row.folderId));
			n++;
		} catch {}
	}
	return n;
}

/**
 * The objects inside ONE file of a saved entry. The entry's own scene is already a payload;
 * a library .tpscene is bytes that have to be read. Anything else has no object list — a
 * texture is not something you import objects FROM, and saying so is better than an empty
 * checklist that looks broken.
 * @param {any} payload @param {any} file a row from sessionFileList
 * @returns {Promise<{payload: any, entries: any[]} | null>}
 */
export async function sessionFilePayload(payload, file) {
	if (file?.own) return { payload, entries: sessionObjectList(payload) };
	const row = payload?.library?.items?.[file?.index];
	if (!row?.blob || row.kind !== 'scene') return null;
	try {
		const inner = await readSessionZip(await row.blob.arrayBuffer());
		return inner ? { payload: inner, entries: sessionObjectList(inner) } : null;
	} catch {
		return null;
	}
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
	/** @type {Map<string, string>} saved uuid -> the fresh one we gave it */
	const uuidMap = new Map();
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
		stripEditOverlays(object); // a stale wireframe saved by an older build
		// A6.3 (bug): every uuid is REASSIGNED here (a merge must not collide with
		// what is already in the scene), and the payload's per-object documents are
		// keyed by the OLD uuid — so a merge import used to drop this object's flow
		// graph, its shader graph and its clips on the floor, silently. Remember the
		// mapping and carry them across afterwards.
		object.traverse((/** @type {any} */ node) => {
			const fresh = crypto.randomUUID();
			uuidMap.set(node.uuid, fresh);
			node.uuid = fresh;
		});
		group.add(object);
		recordObjectPresence('create', object);
		if (peer) peer.send({ type: 'object', element: object.toJSON() });
		added++;
	}
	objectsGroup.update((value) => value);
	carryObjectDocuments(payload, uuidMap);
	showToast('Imported ' + added + ' object' + (added === 1 ? '' : 's') + ' from the session');
	return added;
}

/**
 * A6.3: carry a merge-imported object's PER-OBJECT documents across the uuid
 * reassignment `importObjects` performs — its flow graph, its shader graph and its
 * authored clips. Each rides the copy-from-a-document helper its own module owns,
 * so replication and the never-clobber rule are theirs, not this file's.
 *
 * Only objects we actually imported are remapped: a payload graph keyed by a uuid
 * outside the map belongs to an object the user did not tick.
 * @param {any} payload @param {Map<string, string>} uuidMap
 */
function carryObjectDocuments(payload, uuidMap) {
	if (!uuidMap.size) return;
	for (const [from, to] of uuidMap) {
		const graph = payload.graphs?.[from];
		if (graph) copyGraphFrom(graph, to);
		const shader = payload.shaderGraphs?.[from];
		if (shader) copyShaderGraphFrom(shader, to);
		const clips = payload.animations?.[from];
		if (clips) copyAnimationsFrom(clips, to);
	}
}

/**
 * A6.4: after a scene load, say ONCE how many nodes cannot be rendered and why.
 *
 * The flow editor grows a badge for this, but the dock is closed for most players
 * loading a game, so the Notification Center is the channel that always reaches
 * them. Counted from the LIVE graphs (post-restore), never from the payload, so it
 * agrees with what the editor would show.
 * @param {any} payload
 */
function reportUnknownNodes(payload) {
	// remembered first: the unknown-node card names its provider from this
	rememberSceneModules(payload?.modules);
	const missing = allNodes().filter(
		(/** @type {any} */ node) => node.type && !findNodeSpec(node.type)
	);
	if (!missing.length) return;
	const kinds = [...new Set(missing.map((/** @type {any} */ node) => node.type))];
	const provider = classifyRequirements(payload?.modules).missing.map((entry) => entry.id);
	showInfoToast(
		'scene-unknown-nodes',
		missing.length + ' node' + (missing.length === 1 ? '' : 's') + ' in this scene need a module' +
			(provider.length ? ' (' + provider.join(', ') + ')' : '') + ': ' + kinds.join(', ') +
			'. They are kept exactly as saved — install the module and they come back to life.',
		[
			{
				label: 'Open Modules',
				// a sticky info toast is only removed by its id, so the action clears its
				// own prompt on the way out (the share-or-stash precedent)
				action: () => {
					dismissToastById('scene-unknown-nodes');
					modulesOpen.set(true);
				}
			}
		]
	);
}

/** Replace the scene with a session (safety-stash first). Replicates through
 * the normal clearscene/object/node messages.
 *
 * 21-F4 opts, every default preserving today's behaviour byte-identically:
 *   backup     false skips the safety-stash session — LEVEL TRAVEL runs this on every
 *              peer at once, and N peers each stashing a backup per hop is noise
 *   replicate  false applies LOCALLY with nothing sent — the deterministic model: a
 *              travel trigger already replicated, so EVERY peer runs this itself, and
 *              a replicating apply would be N peers broadcasting the same scene at
 *              each other (clear storms included)
 *   game       false EXCLUDES payload.game — fork 3: game state CARRIES across scene
 *              travel, so the traveller re-asserts the live state after the load
 *   workspace  false skips the edit-resume — a level hop mid-game must not reopen the
 *              author's mesh-edit session
 * @param {any} payload
 * @param {{backup?: boolean, replicate?: boolean, game?: boolean, workspace?: boolean}} [opts]
 */
export async function applySession(payload, opts = {}) {
	const { backup = true, replicate = true, game = true, workspace = true } = opts;
	const group = get(objectsGroup);
	if (backup && group?.children.length) await saveSession('Backup before "' + payload.name + '"');
	// R22-R8: a session saved by "Save into session" carries the whole Explorer library
	// beside the scene, because that gesture EMPTIES the library and the save is the only
	// thing standing between the user and losing it. Restoring it is hash-deduped, so a
	// file already here is not written twice; a payload with no `library` key is every
	// session written before R8 and takes this as a no-op.
	if (payload?.library) {
		const restored = await restoreSessionLibrary(payload);
		if (restored) showToast('Restored ' + restored + ' library file' + (restored === 1 ? '' : 's'));
	}
	if (replicate) sceneCommand('/clear all'); // replicated clear (objects + module content)
	else clearSceneLocal();
	/** @type {any} */
	const peer = get(peers);
	for (const element of payload.objects ?? []) {
		let object;
		try {
			object = new THREE.ObjectLoader().parse(element);
		} catch {
			continue;
		}
		// A scene saved while a mesh-edit session was open carries the edit
		// wireframe as a real child object — it comes back as a permanent,
		// un-updatable wireframe nobody can switch off, and it accumulates on
		// every save/load round trip (the reported "wireframe glitch"). Drop it
		// on the way in; the peers do the same in `createObject`.
		stripEditOverlays(object);
		group.add(object); // keep original uuids — every peer converges on them
		if (replicate && peer) peer.send({ type: 'object', element });
	}
	objectsGroup.update((value) => value);
	// animated imports come back from their original bytes (mixers rebuilt, peers
	// reparse the same file) and authored tracks from the payload
	await animatedImportsRestore(payload.animated ?? [], replicate);
	// replicate: a loaded scene's movements reach the peers already in the room,
	// the way each restored joint is re-broadcast below
	animationsRestore(payload.animations ?? {}, replicate);
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
		if (replicate && peer)
			peer.send({
				type: 'nodes',
				graphs: graphsPayload,
				nodes: graphsPayload[SCENE_GRAPH]?.nodes ?? [],
				edges: graphsPayload[SCENE_GRAPH]?.edges ?? []
			});
	}
	// a scene LOAD replaces the world, so replace the documents too
	shaderGraphsRestore(payload.shaderGraphs ?? {}, replicate);
	annotationsRestore(payload.annotations ?? []);
	// P-B: joints restore locally + replicate each def (receivers only apply)
	jointsRestore(payload.joints ?? []);
	// the look replicates on restore too, so loading a scene into a live room
	// brings its art direction along (the jointsRestore precedent below)
	scenePostRestore(payload.post, replicate);
	// A6.1: and so do the sky, the gravity and the music — a game template that
	// loaded into the room's own sky and gravity was the reason this phase exists.
	// Each is a no-op when the field is absent (= the scene wants the defaults).
	environmentRestore(payload.environment, replicate);
	scenePhysicsRestore(payload.physics, replicate);
	musicRestore(payload.music, replicate);
	// and the HUD with it: loading a game scene into a live room must bring its overlay
	hudDocsRestore(payload.hud ?? null, true, replicate);
	// and the game with it: loading a game scene into a live room must bring its state.
	// 21-F4 fork 3: LEVEL TRAVEL passes game:false — state/round/vars CARRY across the
	// hop (campaign semantics), so the traveller re-asserts the live state after this.
	if (game) gameStateRestore(payload.game ?? null, replicate);
	if (replicate && peer) for (const joint of payload.joints ?? []) peer.send({ type: 'jointcreate', joint });
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
	// P5: last, once the objects exist and the camera is parked — a selection applied
	// before the tree is populated selects nothing, and a session entry needs its object
	if (workspace && payload.workspace) applyEditResume(payload.workspace);
	// A6.4: ONE Notification Center entry naming the unrenderable nodes, because the
	// flow editor's badge is invisible when the dock is closed — which it is for most
	// players loading a game. Runs after restoreGraphs, so the count is the real one.
	reportUnknownNodes(payload);
	showToast('Session loaded: ' + payload.name + ' (' + (payload.count ?? 0) + ' objects)');
}

// ---- proposal flow (50.3) --------------------------------------------------

/** @type {{payload: any, accepts: Set<string>, needed: string[]} | null} */
let pendingProposal = null;

/** Load a session — solo applies immediately, with peers it becomes a proposal
 * every connected peer must accept.
 * @param {string} id
 * @returns {Promise<boolean>} true when the load APPLIED NOW (solo path); false when
 *   it became a proposal (or the session was missing) — 21-G8's "opened as the
 *   current scene, unsaved" marker only makes sense for a load that actually happened */
export async function requestLoadSession(id) {
	const payload = await getSession(id);
	if (!payload) return false;
	/** @type {any} */
	const peer = get(peers);
	const connected = Object.keys(peer?.connections ?? {});
	if (!connected.length) {
		await applySession(payload);
		return true;
	}
	pendingProposal = { payload, accepts: new Set(), needed: connected };
	peer.send({
		type: 'sessionproposal',
		name: payload.name,
		objects: payload.count ?? 0,
		from: peer.peer.id
	});
	showToast('Asked ' + connected.length + ' peer' + (connected.length === 1 ? '' : 's') + ' to load "' + payload.name + '"…');
	return false;
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
 *
 * A1 gave it CONTEXT. The decision is unchanged — the same one-shot latch, the same
 * both-scenes-non-empty gate — but the caller now says who is asking, whether they are
 * the peer we joined, and which scene they are standing in. The one thing that context
 * buys today is ADOPTION (below); the scene-aware decision table is a later commit, and
 * nothing here reads `theirScene` to gate a reply.
 * @param {'objects'|'nodes'} kind @param {string} sender
 * @param {{otherCount?: number, theirScene?: string, theirHash?: string, fromHost?: boolean}|number} [opts]
 *   a bare number is read as `otherCount` — the pre-A1 shape, kept so no call site can
 *   silently pass a count into a field that ignores it
 */
export function deferUntilShareChoice(kind, sender, opts = {}) {
	/** @type {{otherCount?: number, theirScene?: string, theirHash?: string, fromHost?: boolean}} */
	const context = typeof opts === 'number' ? { otherCount: opts } : opts || {};
	const { otherCount = 0, theirScene = '', theirHash = '', fromHost = false } = context;
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
		// A1 ADOPTION. We hold NOTHING and the peer we joined is standing in a named
		// scene, so the world about to arrive down this handshake IS that scene — there
		// is no other world it could be. Without this a joiner who never travelled keeps
		// `currentLevel === null` for the whole session: it shows no name, it publishes an
		// empty `atscene` row, and every scene-aware read on BOTH sides answers "no
		// evidence" about the most ordinary peer there is.
		//
		// Through a DYNAMIC import, because levels.js imports THIS module (applySession)
		// and a static edge back would close the cycle. Fire-and-forget: a name is
		// presentation and the objects are the point, so the reply never waits on it.
		if (count === 0 && fromHost && theirScene) {
			// the hash goes along because the caller has it, and it is what the next
			// phase's "same scene, same version?" question will be asked with. Adoption
			// itself deliberately does not store it — a joiner loaded no file.
			import('./levels')
				.then((m) => m.adoptSceneIdentity(theirScene, theirHash))
				.catch(() => {});
		}
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
