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
	loadExplorer
} from './explorer';
import { requestAsset } from './assetShare';
import { gameState, gameStateRestore } from './gameState';

/** 21-G1: the folder a SAVED SCENE lands in when there is nowhere else to put it —
 * premade on the first save, and nothing more than that. It is freely renamable and
 * deletable, because it is NOT how a scene is found: `levelItems()` discovers by KIND
 * (see below), so the folder is a tidy default and never a registry.
 *
 * Renamed from `Levels` in 21-G1 — the project is not only for games, and "level" is a
 * game word. An existing `Levels` folder keeps working BY CONSTRUCTION: its items are
 * ordinary kind-'scene' items, which is the only thing discovery looks at. */
export const SCENES_FOLDER = 'Scenes';

/** Where we are: `{hash, name}` after a travel or a save-as-level, null before either.
 * LOCAL on purpose — a late joiner converges on the level's CONTENT through the ordinary
 * handshake sync and simply shows no name until the next travel names one.
 * @type {import('svelte/store').Writable<{hash: string, name: string} | null>} */
export const currentLevel = writable(null);

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
 * @param {string} name @returns {Promise<{id: string, hash: string, name: string}|null>}
 */
export async function saveSceneAsLevel(name) {
	const folderId = await ensureScenesFolder();
	const payload = /** @type {any} */ (buildSessionPayload(String(name ?? '').trim() || 'Scene'));
	delete payload.workspace;
	const bytes = await exportSessionZip(payload, { assets: true, packs: false, flow: true });
	const item = await addItemFromBytes(
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		levelFileName(payload.name),
		folderId
	);
	if (!item) return null;
	currentLevel.set({ hash: item.hash, name: payload.name });
	showToast('Scene saved: ' + payload.name + ' (' + (payload.count ?? 0) + ' objects)');
	return item;
}

/**
 * A brand-new EMPTY scene asset — it deliberately captures nothing from the open scene.
 * @param {string} name
 */
export async function newLevel(name) {
	const folderId = await ensureScenesFolder();
	const payload = emptySessionPayload(String(name ?? '').trim() || 'New scene');
	const bytes = await exportSessionZip(payload, { assets: false, packs: false, flow: true });
	const item = await addItemFromBytes(
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		levelFileName(payload.name),
		folderId
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
		currentLevel.set({ hash: key, name: name || payload.name || item.name });
		return true;
	} finally {
		inFlight.delete(key);
	}
}
