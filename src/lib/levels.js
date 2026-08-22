// 21-F4 — SCENES AS LEVELS. 21-G1 renamed the vocabulary: what this module moves between
// is a SCENE, and the folder they land in is `Scenes`. The exported function names keep
// their `level` spelling on purpose — they are load-bearing in saved graphs, the debug
// hook and every suite, and a rename would be churn for a word.
//
// A SCENE ASSET is a .tpscene living in the Explorer as an ordinary content-hashed item, which
// is the whole design: the Explorer already gives us content addressing, thumbnails,
// folders, and — through assetfile/getasset — a pull path for a peer who does not hold
// the bytes yet. Nothing new travels on the wire for a level EXCEPT the travel trigger,
// which is an ordinary replicated node pulse: on the stamp edge EVERY peer loads the
// level itself through the existing session-apply path, locally and silently (the
// deterministic sync model — determinism IS the netcode). A replicating apply would be
// N peers broadcasting the same scene at each other.
//
// FORK 1 (locked): levels are travel-TOGETHER — one active scene per session. Per-peer
// scenes are a future roadmap on the rooms layer.
// FORK 3 (locked): game state CARRIES across travel (campaign semantics) — the level
// payload's own `game` field is EXCLUDED and the live state re-asserted after the load.
// Collectible latches are per-scene for free: the latch NODES live in the level's own
// graph, so a new level brings fresh latches while `vars` (the score) ride the carried
// singleton.
//
// Import discipline: svelte stores + sessions/explorer/assetShare/gameState. This module
// is reached from flowRuntime (the travel node) via a PRIMED DYNAMIC import only —
// sessions.js sits next to history-family modules, and a static edge from flowRuntime
// would close the TDZ cycle (the moduleSDK rule).

import { writable, get } from 'svelte/store';
import { showToast } from '../stores/appStore';
import {
	buildSessionPayload,
	emptySessionPayload,
	exportSessionZip,
	readSessionZip,
	applySession
} from './sessions';
import {
	explorerFolders,
	explorerItems,
	createFolder,
	addItemFromBytes,
	itemByHash,
	itemBlob,
	deleteItem,
	loadExplorer
} from './explorer';
import { requestAsset } from './assetShare';
import { gameState, gameStateRestore } from './gameState';
// 21-G2: the manifest is the project's one mutable document; travel-away publishes
// the departing scene into it. connectionState answers "are we the writer".
import {
	publishSceneVersion,
	latestSceneHash,
	keepableHashes,
	projectManifest
} from './projectManifest';
import { sessionHost } from './connectionState';

/** 21-G1: the folder a SAVED SCENE lands in when there is nowhere else to put it —
 * premade on the first save, and nothing more than that. It is freely renamable and
 * deletable, because it is NOT how a scene is found: `levelItems()` discovers by KIND
 * (see below), so the folder is a tidy default and never a registry.
 *
 * Renamed from `Levels` in 21-G1 — the project is not only for games, and "level" is a
 * game word. An existing `Levels` folder keeps working BY CONSTRUCTION: its items are
 * ordinary kind-'scene' items, which is the only thing discovery looks at. */
export const SCENES_FOLDER = 'Scenes';

/** Where we are: `{hash, name, signature}` after a travel or a save, null before
 * either. LOCAL on purpose — a late joiner converges on the level's CONTENT through the
 * ordinary handshake sync and simply shows no name until the next travel names one.
 * `signature` is the content identity the auto-save compares against (see sceneSignature).
 * @type {import('svelte/store').Writable<{hash: string, name: string, signature?: string} | null>} */
export const currentLevel = writable(null);

/**
 * 21-G2: the CONTENT identity of a scene payload — what "has this scene changed" means.
 * The zip's own hash cannot answer it: a .tpscene embeds a fresh uuid, createdAt and a
 * re-rendered THUMBNAIL on every save, so two saves of an untouched scene hash apart.
 * This stringifies only the MEANINGFUL fields, in a fixed order. `game` is excluded on
 * purpose — travel already excludes it on load (fork 3), so a round ticking over must
 * not mint a scene version.
 * @param {any} payload @returns {string}
 */
export function sceneSignature(payload) {
	if (!payload) return '';
	const pick = {
		objects: payload.objects ?? [],
		animated: payload.animated ?? [],
		animations: payload.animations ?? {},
		graphs: payload.graphs ?? {},
		shaderGraphs: payload.shaderGraphs ?? {},
		annotations: payload.annotations ?? [],
		joints: payload.joints ?? [],
		post: payload.post ?? null,
		environment: payload.environment ?? null,
		physics: payload.physics ?? null,
		music: payload.music ?? null,
		hud: payload.hud ?? null
	};
	return JSON.stringify(pick);
}

/** Travels currently waiting on bytes or applying, keyed by hash — a re-stamped trigger
 * while a pull is in flight must not stack a second load of the same level.
 * @type {Set<string>} */
const inFlight = new Set();

/** The `Scenes` folder's id, created at the root on first use. A save that finds an
 * existing one reuses it; a user who renamed or deleted it simply gets a fresh one on
 * the next save, and every scene they already had stays discoverable regardless. */
export async function ensureScenesFolder() {
	await loadExplorer();
	const existing = get(explorerFolders).find(
		(/** @type {any} */ f) => f.name === SCENES_FOLDER && !f.parentId
	);
	if (existing) return existing.id;
	const folder = createFolder(SCENES_FOLDER, null);
	return folder?.id ?? null;
}

/**
 * 21-G9: WHERE a save lands. The caller may name a folder — the Explorer passes
 * whatever the user is looking at — and it is honoured only when it is a REAL library
 * folder: the activeFolder store also holds pseudo locations (`prefabs`, `packs`,
 * `pack:<name>`, `scene…`) that hold no items of ours, and a stale id survives a folder
 * being deleted. Anything that fails the existence test falls back to `Scenes`, which is
 * what every caller got before this argument existed.
 * @param {string|null} [folderId] @returns {Promise<string|null>}
 */
async function targetFolder(folderId) {
	const id = typeof folderId === 'string' ? folderId.trim() : '';
	if (id) {
		await loadExplorer();
		if (get(explorerFolders).some((/** @type {any} */ f) => f.id === id)) return id;
	}
	return ensureScenesFolder();
}

/**
 * 21-G1: every scene on offer, discovered BY KIND — an item of kind 'scene' (a
 * .tpscene), wherever in the library it happens to live. There is deliberately NO
 * folder filter: the folder-name convention made the folder load-bearing, so renaming
 * it (or dragging a scene into `Prototypes/`) silently emptied the travel picker. The
 * extension test is the fallback for an item stored before the 'scene' kind existed —
 * both answer the same question, "is this file a scene".
 */
export function levelItems() {
	return get(explorerItems).filter(
		(/** @type {any} */ item) =>
			item.kind === 'scene' || /\.tpscene$/i.test(String(item.name ?? ''))
	);
}

/** @param {string} name a scene name, filesystem-safe enough for an item name */
function levelFileName(name) {
	const base = String(name ?? '').trim() || 'Scene';
	return /\.tpscene$/i.test(base) ? base : base + '.tpscene';
}

/**
 * Save the CURRENT scene as a level asset: the existing .tpscene bundle (session.json +
 * the scene's binary assets), content-hashed into the Levels folder. The author's
 * workspace (open edit session, selection) is STRIPPED — a level is a place to travel
 * to, not a resume point.
 * @param {string} name @param {string|null} [folderId] 21-G9: land it HERE when it is a
 *   real library folder (the Explorer's active folder); `Scenes` otherwise
 * @returns {Promise<{id: string, hash: string, name: string}|null>}
 */
export async function saveSceneAsLevel(name, folderId = null) {
	const target = await targetFolder(folderId);
	const payload = /** @type {any} */ (buildSessionPayload(String(name ?? '').trim() || 'Scene'));
	delete payload.workspace;
	const bytes = await exportSessionZip(payload, { assets: true, packs: false, flow: true });
	const item = await addItemFromBytes(
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		levelFileName(payload.name),
		target
	);
	if (!item) return null;
	currentLevel.set({ hash: item.hash, name: payload.name, signature: sceneSignature(payload) });
	// 21-G2: a manual save IS a version — the manifest pointer moves with it (refused
	// for viewers inside publishSceneVersion; the local item exists either way)
	publishSceneVersion(payload.name, item.hash);
	pruneSceneVersions(payload.name);
	showToast('Scene saved: ' + payload.name + ' (' + (payload.count ?? 0) + ' objects)');
	return item;
}

/**
 * 21-G2 THE TRAVEL-AWAY AUTO-SAVE (fork 9): leaving a scene publishes the departing
 * scene to a NEW hash so edits survive round trips — the reported case: build in a new
 * scene, hop away and back, the objects were gone, because file-based travel had no
 * write-back. Three deliberate rules:
 *
 *   WRITER-ONLY. Every peer runs travel, but a .tpscene embeds a fresh uuid/createdAt/
 *   thumbnail per save, so N peers saving identical CONTENT would mint N different
 *   HASHES and spam the history with ghosts. One peer speaks for the session — the
 *   HOST (`sessionHost === null`, the F3 abandon-watch rule), which is also every solo
 *   user. Other peers pull the new hash by content when they travel back.
 *
 *   SIGNATURE-GATED. An idle hop must not mint versions, and the zip hash cannot tell
 *   idle from edited (see sceneSignature). Compare content identity, not bytes.
 *
 *   NAMED-ONLY. A scene that has never been saved or travelled to has no name to file
 *   a version under — inventing one would opt the user into the project machinery
 *   uninvited. The ordinary autosave still protects that scene locally.
 * @returns {Promise<boolean>} did a version get published
 */
async function autoSavePublishDeparting() {
	const at = get(currentLevel);
	if (!at?.name) return false;
	if (get(sessionHost) !== null) return false; // not the writer
	/** @type {any} */
	let payload = null;
	try {
		payload = buildSessionPayload(at.name);
	} catch {
		return false;
	}
	delete payload.workspace;
	const signature = sceneSignature(payload);
	if (signature === at.signature) return false; // untouched since its hash — no ghost versions
	const folderId = await ensureScenesFolder();
	const bytes = await exportSessionZip(payload, { assets: true, packs: false, flow: true });
	const item = await addItemFromBytes(
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		levelFileName(at.name),
		folderId
	);
	if (!item) return false;
	const published = publishSceneVersion(at.name, item.hash);
	if (published) pruneSceneVersions(at.name);
	return published;
}

/**
 * 21-G2 fork 4: prune LOCAL BYTES of old versions — the newest KEEP_VERSIONS plus every
 * pin stay; a hash that another scene's history still wants to keep is left alone. The
 * MANIFEST keeps the full list either way: pruning is about disk, never history.
 * @param {string} name
 */
export function pruneSceneVersions(name) {
	const m = get(projectManifest);
	const entry = m.scenes[String(name ?? '').trim()];
	if (!entry) return 0;
	const keep = keepableHashes(name);
	// a hash may appear in ANOTHER scene's keep set (a duplicated level) — respect it
	const keptElsewhere = new Set();
	for (const other of Object.keys(m.scenes))
		if (other !== name) for (const h of keepableHashes(other)) keptElsewhere.add(h);
	let dropped = 0;
	for (const hash of entry.history) {
		if (keep.has(hash) || keptElsewhere.has(hash)) continue;
		const item = itemByHash(hash);
		if (!item) continue;
		void deleteItem(item.id);
		dropped++;
	}
	return dropped;
}

/**
 * 21-G2 TRAVEL BY NAME: resolve a scene NAME through the replicated manifest to its
 * CURRENT pointer at fire time. Deterministic across peers — the manifest is the one
 * shared truth about where "the latest of Arena" is, unlike any local folder order.
 * @param {string} name @returns {Promise<boolean>}
 */
export async function travelToScene(name) {
	const scene = String(name ?? '').trim();
	if (!scene) return false;
	const hash = latestSceneHash(scene);
	if (!hash) {
		showToast('No scene called "' + scene + '" in this project yet.');
		return false;
	}
	return travelToLevel(hash, scene);
}

/**
 * A brand-new EMPTY scene asset — it deliberately captures nothing from the open scene.
 * @param {string} name @param {string|null} [folderId] 21-G9: as saveSceneAsLevel
 */
export async function newLevel(name, folderId = null) {
	const target = await targetFolder(folderId);
	const payload = emptySessionPayload(String(name ?? '').trim() || 'New scene');
	const bytes = await exportSessionZip(payload, { assets: false, packs: false, flow: true });
	const item = await addItemFromBytes(
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		levelFileName(payload.name),
		target
	);
	if (item) showToast('Scene created: ' + payload.name);
	return item;
}

/**
 * Resolve a level hash to its Explorer item, PULLING it from peers when missing — the
 * LUT precedent: ask once, then WATCH the library until the bytes land, never a second
 * attempt that never comes. Resolves null only if watching is impossible.
 * @param {string} hash @returns {Promise<any>}
 */
function resolveLevelItem(hash) {
	const item = itemByHash(hash);
	if (item) return Promise.resolve(item);
	requestAsset(hash);
	showToast('Pulling the scene from your peers…');
	return new Promise((resolve) => {
		const unsub = explorerItems.subscribe(() => {
			const found = itemByHash(hash);
			if (!found) return;
			// never resolve inside the subscriber's own flush — read refs first, then act
			queueMicrotask(() => {
				unsub();
				resolve(found);
			});
		});
	});
}

/**
 * TRAVEL: load a level on THIS peer. The caller (the travel node's stamp edge, or a
 * menu action that pulsed that node) already replicated the intent, so this applies
 * locally with nothing sent, skips the safety-stash (N peers stashing a backup per hop
 * is noise), EXCLUDES the file's `game` field, and re-asserts the carried state after
 * the load. `gameStateRestore` stamps a fresh changedAt on purpose — each peer stamps
 * its own, the content is identical, and latest-wins converges.
 * @param {string} hash @param {string} [name] display name for the toast/store
 * @returns {Promise<boolean>} did a load happen
 */
export async function travelToLevel(hash, name = '') {
	const key = String(hash ?? '').trim();
	if (!key) return false;
	if (inFlight.has(key)) return false;
	inFlight.add(key);
	try {
		// 21-G2 fork 9: the departing scene's edits are PUBLISHED before the world is
		// replaced (writer-only, signature-gated — see autoSavePublishDeparting)
		try {
			await autoSavePublishDeparting();
		} catch {}
		const item = await resolveLevelItem(key);
		if (!item) return false;
		const blob = await itemBlob(item.id);
		if (!blob) return false;
		/** @type {any} */
		let payload = null;
		try {
			payload = await readSessionZip(await blob.arrayBuffer());
		} catch {
			payload = null;
		}
		if (!payload) {
			showToast('That scene could not be read.');
			return false;
		}
		// fork 3: capture the LIVE game before the world is replaced…
		const carried = { ...get(gameState), vars: { ...get(gameState).vars } };
		await applySession(payload, { backup: false, replicate: false, game: false, workspace: false });
		// …and put it back. The level's own `game` field never applied (game: false).
		gameStateRestore(carried, false);
		// the signature of what we LOADED, so an untouched stay here publishes nothing
		currentLevel.set({
			hash: key,
			name: name || payload.name || item.name,
			signature: sceneSignature(payload)
		});
		return true;
	} finally {
		inFlight.delete(key);
	}
}
