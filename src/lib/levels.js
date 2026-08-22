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
	hiddenItems,
	createFolder,
	addItemFromBytes,
	itemByHash,
	itemBlob,
	deleteItem,
	setItemHidden,
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
	autoVersionsOff,
	setVersionLabel,
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
 * 21-G8 fork 12: `unsaved` marks a loose .tpscene OPENED from disk — named, on screen,
 * but NOT a member of the project until the user saves it in.
 * @type {import('svelte/store').Writable<{hash: string, name: string, signature?: string, unsaved?: boolean} | null>} */
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

/**
 * 21-G7 fork 10 — FOLD one scene's old versions onto the hidden shelf. After a publish
 * the manifest names the whole history; everything in it except the POINTER stops being
 * a card in the library and becomes a row in Version history instead. The bytes and the
 * blobs are untouched, so travel-by-hash, the .tp export and a peer's assetShare pull
 * all still find them (itemByHash searches both shelves).
 *
 * The G2 behaviour minted one visible .tpscene per save, so a scene edited five times
 * showed five identical-looking cards and no way to tell which one the project meant —
 * which is the whole reason this exists.
 *
 * It reconciles BOTH directions, because the pointer moves BACKWARDS as well: restoring
 * an older version makes a hidden record the current one, and a scene whose only card
 * sits on the hidden shelf is a scene that has vanished from the library.
 * @param {string} name @returns {number} how many items changed shelf
 */
export function hideOldVersions(name) {
	const scene = String(name ?? '').trim();
	const entry = get(projectManifest).scenes[scene];
	if (!entry) return 0;
	const pointer = entry.history[entry.history.length - 1];
	const older = new Set(entry.history.filter((h) => h !== pointer));
	let moved = 0;
	for (const item of [...get(explorerItems)])
		if (older.has(item.hash) && setItemHidden(item.id, true)) moved++;
	for (const item of [...get(hiddenItems)])
		if (item.hash === pointer && setItemHidden(item.id, false)) moved++;
	return moved;
}

/**
 * THE MIGRATION (and the ongoing invariant): fold every manifest scene at once. Run
 * after boot, and again whenever a manifest lands from a peer or a .tp import — a
 * project that arrives with five versions of one scene must not unfold five cards.
 * Idempotent and cheap: it only ever moves items that are visible and stale.
 * @returns {Promise<number>} how many items were folded away
 */
export async function foldSceneVersions() {
	await loadExplorer();
	let folded = 0;
	for (const name of Object.keys(get(projectManifest).scenes)) folded += hideOldVersions(name);
	return folded;
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
 * @param {string} name
 * @param {string|null} [folderId] 21-G9: land it HERE when it is a real library folder
 *   (the Explorer's active folder); `Scenes` otherwise
 * @param {{label?: string}} [opts] 21-G7: `label` NAMES this version in the history
 *   panel (the manual "Save version…" path); absent = "Auto"
 * @returns {Promise<{id: string, hash: string, name: string}|null>}
 */
export async function saveSceneAsLevel(name, folderId = null, opts = {}) {
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
	if (opts.label) setVersionLabel(payload.name, item.hash, opts.label);
	// 21-G7: one visible card per scene name — the pointer we just wrote
	hideOldVersions(payload.name);
	pruneSceneVersions(payload.name);
	showToast('Scene saved: ' + payload.name + ' (' + (payload.count ?? 0) + ' objects)');
	return item;
}

/**
 * 21-G7 fork 13 — the MANUAL "Save version…": an ordinary save that carries a name you
 * chose. It is deliberately the same write path (there is no second kind of version),
 * and it works even with auto-versions switched off, because it is the user asking.
 * @param {string} name @param {string} label
 */
export async function saveSceneVersion(name, label) {
	return saveSceneAsLevel(name, null, { label: String(label ?? '').trim() });
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
 *
 * 21-G7 extracted this out of the travel path so RESTORE can share it verbatim: taking
 * a checkpoint before loading an older version is the same act, under the same three
 * rules, and re-deriving them at a second call site is how they drift apart. It also
 * gained a fourth gate — `keepVersionsSetting === 0` means "don't cut versions behind
 * my back", and this is the only place that cuts one unasked.
 * @param {{force?: boolean}} [opts] `force` = the user asked (a restore checkpoint),
 *   so the auto-versions-off gate does not apply
 * @returns {Promise<boolean>} did a version get published
 */
export async function publishCurrentIfChanged(opts = {}) {
	const at = get(currentLevel);
	if (!at?.name) return false;
	// 21-G8 fork 12: a loose .tpscene opened from disk carries a name but is NOT a
	// project member — publishing it on travel-away would add it to the project
	// uninvited. The user was offered "Save into project" on their first edit; until
	// they take it, this scene has the protection an unnamed scene has (the autosave).
	if (at.unsaved) return false;
	if (get(sessionHost) !== null) return false; // not the writer
	if (!opts.force && autoVersionsOff()) return false; // fork 10: auto-versions off
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
	if (published) {
		// where we ARE is now this hash and this content — so a second call (travel runs
		// this too, right after a restore checkpoint) has nothing left to publish
		currentLevel.set({ hash: item.hash, name: at.name, signature });
		hideOldVersions(at.name);
		pruneSceneVersions(at.name);
	}
	return published;
}

/**
 * 21-G7 fork 13 — RESTORE an older version, DCC-standard: nothing is ever destroyed by
 * going back.
 *   1. CHECKPOINT the current scene (forced — you asked, so the auto-versions setting
 *      does not get to lose your unsaved work),
 *   2. RE-APPEND the old hash so the pointer moves TO it (the G2a rule: history is
 *      append-only, and "we went back to v3" is itself an event worth recording),
 *   3. load it here.
 * There is no new message: the manifest replicates, so every peer already knows where
 * the scene's pointer went and can travel to it. Saying so in the toast is the whole
 * "offer travel for the session" half of the fork.
 * @param {string} name @param {string} hash @returns {Promise<boolean>}
 */
export async function restoreSceneVersion(name, hash) {
	const scene = String(name ?? '').trim();
	const key = String(hash ?? '').trim();
	if (!scene || !key) return false;
	try {
		await publishCurrentIfChanged({ force: true });
	} catch {}
	publishSceneVersion(scene, key);
	const loaded = await travelToLevel(key, scene);
	if (!loaded) return false;
	hideOldVersions(scene);
	showToast('Restored an earlier version of ' + scene + ' — peers can travel to it too.');
	return true;
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
		// replaced (writer-only, signature-gated — see publishCurrentIfChanged)
		try {
			await publishCurrentIfChanged();
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

// ---- 21-G7: keeping the one-visible-item invariant true -------------------------------
//
// Every publish folds its own scene, so this only has to cover the manifests we did NOT
// write: the idb load at boot (a project built before G7 has a card per save), a peer's
// `manifest` message and a .tp import. The document is the trigger because the document
// is the thing that says which hash is the pointer.
//
// Coalesced through a microtask: a commit writes the store once, but a restore writes it
// twice in a row (checkpoint, then re-append) and there is no sense sweeping between them.
// This lives HERE and not in projectManifest.js, which is a leaf and must stay one.
let foldQueued = false;
projectManifest.subscribe(() => {
	if (foldQueued) return;
	foldQueued = true;
	queueMicrotask(() => {
		foldQueued = false;
		foldSceneVersions().catch(() => {});
	});
});
