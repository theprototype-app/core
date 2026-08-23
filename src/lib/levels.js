// 21-F4 — SCENES AS LEVELS. 21-G1 renamed the vocabulary: what this module moves between
// is a SCENE. The exported function names keep their `level` spelling on purpose — they
// are load-bearing in saved graphs, the debug hook and every suite, and a rename would
// be churn for a word.
//
// 21-H1 (locked answer 6): a save no longer lands in a folder this module INVENTS. It
// lands in the folder the user is browsing, else at the library ROOT — see targetFolder.
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
import { showToast, showInfoToast, dismissToastById } from '../stores/appStore';
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
	adoptSceneVersions,
	projectManifest,
	sceneEntry
} from './projectManifest';
import { sessionHost } from './connectionState';
// loose-scenes fix: the prompt is for an EDITOR, so it stands down in play mode (see
// armSaveIntoProject). sceneStore is a leaf; sceneEntry answers "does the project know
// this exact file", which is what makes a dragged-in .tpscene loose.
import { isLocked } from '../stores/sceneStore';

/** 21-G1: the name of the conventional scenes folder. It is freely renamable and
 * deletable, because it is NOT how a scene is found: `levelItems()` discovers by KIND
 * (see below), so the folder is a tidy default and never a registry.
 *
 * 21-H1: nothing lands here by default any more — only the empty-library bootstrap
 * premakes it (see `ensureScenesFolder`).
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

/** The `Scenes` folder's id, created at the root on first use. A caller that finds an
 * existing one reuses it; a user who renamed or deleted it simply gets a fresh one, and
 * every scene they already had stays discoverable regardless.
 *
 * 21-H1: this is no longer where a save LANDS (see `targetFolder`). It survives with
 * exactly ONE caller — projectFile's "Save a scene" bootstrap, offered when the library
 * is completely empty — because that path is the one place where inventing a starting
 * structure is worth more than the never-invent-a-folder rule. */
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
 * being deleted.
 *
 * 21-H1 (locked answer 6): anything that fails that test now falls back to the library
 * ROOT — `null` — and NOT to a premade `Scenes` folder. A scene lands where you are
 * looking, or at the root; the app never invents a folder to put your work in. The one
 * deliberate exception is the rule-5 BOOTSTRAP (projectFile's "Save a scene" action for
 * a completely empty library), which is the sole remaining caller of
 * `ensureScenesFolder` — there, a starting structure beats the purity of this rule
 * because "the root" is not a place a first-time user recognises.
 * @param {string|null} [folderId] @returns {Promise<string|null>}
 */
async function targetFolder(folderId) {
	const id = typeof folderId === 'string' ? folderId.trim() : '';
	if (id) {
		await loadExplorer();
		if (get(explorerFolders).some((/** @type {any} */ f) => f.id === id)) return id;
	}
	return null;
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
 *
 * 21-I1 — THE REPORTED BUG: this used to fold only hashes the HISTORY names, so an item
 * the manifest never recorded stayed a visible card FOREVER — a save from before the
 * manifest existed, a viewer's save (publishSceneVersion refuses those), anything where
 * the publish returned false. A clean profile keeps one card through three saves and a
 * reload; a long-lived one grows a shelf of twins. So the fold is by NAME as well:
 * an item CALLED `<scene>.tpscene` which is not the pointer is an old version of that
 * scene, whether or not the document ever heard of its hash.
 *
 * And folding alone would be worse than the bug — it would hide bytes into a place with
 * no door, since Version history lists the HISTORY. So every such orphan is ADOPTED into
 * the history first (see adoptSceneVersions for where it lands and why the pointer may
 * not move), and only then folded. Both shelves are scanned: an orphan already hidden by
 * an earlier build of this sweep is exactly the doorless case.
 * @param {string} name @returns {number} how many items changed shelf
 */
export function hideOldVersions(name) {
	const scene = String(name ?? '').trim();
	const entry = get(projectManifest).scenes[scene];
	if (!entry) return 0;
	const pointer = entry.history[entry.history.length - 1];
	const fileName = levelFileName(scene);
	const known = new Set(entry.history);
	// orphans on EITHER shelf, oldest first — `createdAt` is the only ordering signal an
	// item the document never recorded can offer (deterministic tie-break on the hash,
	// because two saves inside one millisecond must not order differently on two peers)
	// THE WHOLE NAME-BASED SWEEP IS WRITER-ONLY, and the gate lives HERE because
	// projectManifest is a leaf that may not import connectionState.
	//
	// Matching by NAME is a migration of YOUR OWN library against YOUR OWN project. It is
	// not evidence that two machines' files are the same scene, and on a joiner it gets
	// both halves wrong at once. ADOPTION would file your unrelated `Arena.tpscene` into
	// the HOST's Arena history and broadcast it, so travelling to that version loads a
	// world nobody in the room has seen. And FOLDING is no safer: a joiner that has not
	// pulled the host's Arena bytes holds only its OWN file, so the sweep hides the one
	// copy it has — measured, and it left the library with zero Arena cards. Local data
	// must never disappear because a REMOTE document happened to name a scene the same.
	//
	// So a joiner does exactly what it did before 21-I1: the HISTORY-based fold below,
	// which only ever touches hashes the shared document itself names. The by-name
	// migration runs when you are the writer — which is every solo user, and the case the
	// reported bug actually came from.
	const writer = get(sessionHost) === null;
	const orphans = writer
		? [...get(explorerItems), ...get(hiddenItems)]
				.filter(
					(it) =>
						it.name === fileName &&
						it.hash !== pointer &&
						!known.has(it.hash) &&
						// loose-scenes fix (bug 1, second half): NOT a file the user imported.
						// Matching by name is a migration of the app's OWN old saves against the
						// app's OWN project, and two .tpscene files a user dragged in
						// independently are not versions of one scene just because they share a
						// name — folding them hid one of them with no warning, which is the
						// reported "a file disappeared" half of this bug. The stamp's ABSENCE
						// means "this app minted it", so the 21-I1 migration is untouched for
						// every profile that already has duplicates to migrate.
						!it.imported
				)
				.sort(
					(a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.hash).localeCompare(b.hash)
				)
		: [];
	if (orphans.length) adoptSceneVersions(scene, orphans.map((it) => it.hash));
	// re-read: adoption committed a new document, and `older` must reflect it
	const after = get(projectManifest).scenes[scene] ?? entry;
	const older = new Set(after.history.filter((h) => h !== pointer));
	// an adoption that was REFUSED — a viewer (fork 3), or a joiner under the gate above —
	// would leave its orphans unfolding on every sweep, so fold them by NAME regardless:
	// one card per scene is a local truth even when the document write is not ours
	for (const it of orphans) older.add(it.hash);
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

/**
 * 21-G8 fork 12, EXTRACTED here in the loose-scenes fix so both ways of arriving at a
 * loose scene share one path. It used to live in fileHandler and serve only "a .tpscene
 * opened off disk"; travel to a file the project does not name is the same state, and
 * re-deriving the offer at a second call site is how two of them drift apart.
 *
 * Arms a ONE-SHOT: on the user's first real edit, offer to save this scene into the
 * project. It stands down while PLAYING — a travel node hopping between frozen library
 * scenes is not somebody authoring, and an info toast about project membership in the
 * middle of a game is noise with no action behind it.
 * @param {string} name the scene's name, which is the manifest key it would be saved under
 * @returns {Promise<void>}
 */
export async function armSaveIntoProject(name) {
	const scene = String(name ?? '').trim();
	if (!scene) return;
	if (get(isLocked) === true) return;
	const { onNextDirty } = await import('./autosave');
	// arm AFTER the load settles — applying a session storms markDirty, and the prompt is
	// about the user's first edit, not about the load's own store pokes
	setTimeout(() => {
		if (get(isLocked) === true) return;
		onNextDirty(() => {
			showInfoToast(
				'save-into-project',
				'"' + scene + '" is not part of your project yet — your edits live only in the autosave.',
				[
					{
						label: 'Save into project',
						action: () => {
							void saveSceneAsLevel(scene);
							dismissToastById('save-into-project');
						}
					}
				]
			);
		});
	}, 1500);
}

/** @param {string} name a scene name, filesystem-safe enough for an item name */
function levelFileName(name) {
	const base = String(name ?? '').trim() || 'Scene';
	return /\.tpscene$/i.test(base) ? base : base + '.tpscene';
}

/**
 * 21-I1 — the inverse: the scene NAME an item file name stands for. The Version history
 * panel needs it for a scene the manifest has no entry for yet (a New scene…, a viewer's
 * save): without it the panel derived its name only from `sceneOfHash` and rendered
 * NOTHING at all, which is an empty pane where "Save version…" belongs.
 * @param {string} fileName @returns {string}
 */
export function levelSceneName(fileName) {
	return String(fileName ?? '')
		.trim()
		.replace(/\.tpscene$/i, '');
}

/**
 * Save the CURRENT scene as a level asset: the existing .tpscene bundle (session.json +
 * the scene's binary assets), content-hashed into the Levels folder. The author's
 * workspace (open edit session, selection) is STRIPPED — a level is a place to travel
 * to, not a resume point.
 * @param {string} name
 * @param {string|null} [folderId] 21-G9: land it HERE when it is a real library folder
 *   (the Explorer's active folder); 21-H1: the library ROOT otherwise
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
	// REPORTED: saving a version of a scene that lived in a subfolder put the new file at
	// the ROOT — and since the new version becomes the pointer, and the pointer is the one
	// visible card, the scene appeared to MOVE there. The cause was this call passing
	// `null`, which since 21-H1 means "the library root" (locked answer 6 retired the
	// invented `Scenes` folder). A version is not a new scene: it belongs beside the
	// version it supersedes, which is the rule the travel-away write-back already used.
	return saveSceneAsLevel(name, sceneFolderOf(name), { label: String(label ?? '').trim() });
}

/**
 * 21-I: WHERE this scene's files live — the folder a NEW VERSION of it belongs in.
 *
 * The pointer's own folder when this machine holds those bytes, else the newest older
 * version it still holds: a PRUNED pointer (fork 4 drops local bytes, never history) must
 * not send the next save to the root, which is the same "the app moved my files" surprise
 * one step removed. Null — the library root — only when no file of this scene is here at
 * all, which is the honest answer then.
 * @param {string} name @returns {string|null}
 */
function sceneFolderOf(name) {
	const entry = get(projectManifest).scenes[String(name ?? '').trim()];
	if (!entry) return null;
	for (let i = entry.history.length - 1; i >= 0; i--) {
		const item = itemByHash(entry.history[i]);
		if (item) return item.folderId ?? null;
	}
	return null;
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
	// 21-H1: a NEW VERSION of a scene belongs beside the version it supersedes — the
	// folder the pointer's item lives in, whatever that is, and the library ROOT when
	// this machine does not hold those bytes. It used to premake `Scenes`, which is
	// exactly the invented folder locked answer 6 retires: an automatic write-back is
	// the last thing that should be moving a user's files around.
	// 21-I: `sceneFolderOf` is the fallback for a PRUNED pointer — without it a scene whose
	// current bytes were pruned locally sent its next auto-version to the root as well.
	const pointerItem = itemByHash(at.hash);
	const folderId = await targetFolder(
		pointerItem ? pointerItem.folderId ?? null : sceneFolderOf(at.name)
	);
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
		const here = name || payload.name || item.name;
		// LOOSE-SCENES FIX (bug 1). Every gate in publishCurrentIfChanged asked a question
		// about US — are we the writer, is auto-versioning on, has the content changed —
		// and not one asked whether the project has ever heard of this scene. So opening a
		// .tpscene somebody dragged into the library, editing it and leaving MINTED a
		// project scene the user never created: publishSceneVersion creates the entry when
		// it is missing, and the manifest then owns a name it invented.
		//
		// A file the project does not name is exactly the case 21-G8 already solved for a
		// .tpscene opened off DISK, so it takes the same answer: mark it unsaved, and the
		// existing gates do the rest (travel-away publishes nothing, the first edit offers
		// to save it in). It was only missed here because opening an ITEM is normally how
		// you reach a project scene.
		//
		// The test is HASH-in-history, not name-in-manifest. An unrelated Arena.tpscene
		// dragged in beside a project scene called Arena is a different file with a
		// colliding name, and a name-only test would adopt it into that scene's history.
		// travelToScene resolves THROUGH the manifest, so its hash is always in there and
		// tracked travel is unaffected.
		const tracked = !!sceneEntry(here)?.history?.includes(key);
		currentLevel.set({
			hash: key,
			name: here,
			signature: sceneSignature(payload),
			...(tracked ? {} : { unsaved: true })
		});
		if (!tracked) void armSaveIntoProject(here);
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
