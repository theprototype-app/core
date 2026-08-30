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
import { showToast, showInfoToast, dismissToastById, peers } from '../stores/appStore';
// R22 round 34: the adopt message names the peer who saved. `sessions.js` — which this
// module already imports — imports lockControl too, so this closes no new edge.
import { nameOf } from './lockControl';
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
	sceneEntry,
	noteSceneOpened,
	// R22 round 35: privacy's WIRE half — the outbound manifest withholds a scene marked
	// here, which is the only thing that makes the promise true for a HOST (it publishes
	// its project whole, so withholding consent alone would buy it nothing).
	setScenePrivateHere,
	sendProjectManifest
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
 * R22 round 35: `private` marks a scene the user opened with "Edit privately" — its NAME
 * never leaves this machine and no scene content crosses in either direction. It rides
 * HERE rather than in a store of its own so that every later writer of this record clears
 * it by construction: travelling elsewhere, or `set(null)`, is leaving the private scene.
 * @type {import('svelte/store').Writable<{hash: string, name: string, signature?: string, unsaved?: boolean, private?: boolean} | null>} */
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
		// R22 round 11: every keyed or singleton block below goes through stripStamps —
		// see it for why, and why objects/animated deliberately do not
		animations: stripStamps(payload.animations ?? {}),
		graphs: stripStamps(payload.graphs ?? {}),
		shaderGraphs: stripStamps(payload.shaderGraphs ?? {}),
		annotations: payload.annotations ?? [],
		joints: payload.joints ?? [],
		post: stripStamps(payload.post ?? null),
		environment: stripStamps(payload.environment ?? null),
		physics: stripStamps(payload.physics ?? null),
		music: stripStamps(payload.music ?? null),
		hud: stripStamps(payload.hud ?? null)
	};
	return JSON.stringify(pick);
}

/**
 * R22 round 11 — REPLICATION BOOKKEEPING IS NOT CONTENT, and until this existed the
 * signature called every freshly loaded scene dirty.
 *
 * MEASURED: save a scene with an environment, travel away, travel back, touch nothing —
 * and sceneSignature differed in exactly one field, `environment`, whose two values were
 * `{preset:"sunset",exposure:1,customPreset:null,lights:[],changedAt:1787721934690}` and
 * the identical object stamped 1787721946780. The stamp was the load.
 *
 * That is not a bug in the restore. Every latest-wins singleton restores by taking a
 * FRESH `Date.now()` on purpose — "a restore is an authoritative local write, so it must
 * WIN over whatever changedAt the file happens to carry", which environment, scenePhysics,
 * sceneMusic, scenePost, hudDocs and shaderGraph each say in as many words. The bug was on
 * this side: the stamp answers WHEN a block was last written, and this function asks WHAT
 * it says.
 *
 * TWO USER-VISIBLE SYMPTOMS, one cause. The reported one is the guard in the Explorer's
 * `openSceneItem`: open a scene, change nothing, double-click another, and it offered to
 * save work that did not exist. The quieter one is `publishCurrentIfChanged`, whose
 * SIGNATURE-GATED rule exists precisely so "an idle hop must not mint versions" — with the
 * stamp inside the signature, every hop through such a scene minted a ghost version.
 *
 * WHY IT CANNOT MISS A REAL EDIT: nothing moves `changedAt` on its own. It moves because
 * something else in the same block moved, and that something is still compared. Writing a
 * block back to the value it already held is a no-op, and reading it as one is right.
 *
 * WHY `objects` AND `animated` ARE LEFT ALONE — the cost rule. This runs over a
 * whole-scene serialization and those two are the megabytes in it; the blocks that carry
 * stamps are all small. Deep-copying a mesh's vertex buffer to hunt for a key it cannot
 * contain is the one thing this function may not afford. An object's `userData` is also
 * the one place a `changedAt` could legitimately BE content, since a module owns it.
 */
const VOLATILE_STAMPS = new Set([
	// the latest-wins stamp every singleton and keyed document carries
	'changedAt',
	// sceneMusic re-bases the loop PHASE to the moment of the load, for the same reason
	'startedAt'
]);

/**
 * A copy of `value` without the keys above, at any depth. Pure.
 * @param {any} value @returns {any}
 */
function stripStamps(value) {
	if (Array.isArray(value)) return value.map(stripStamps);
	if (value && typeof value === 'object') {
		/** @type {any} */
		const out = {};
		for (const key of Object.keys(value)) {
			if (VOLATILE_STAMPS.has(key)) continue;
			out[key] = stripStamps(value[key]);
		}
		return out;
	}
	return value;
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
 * REPORTED (bug 1): rename the FILE of the scene you are standing in, edit, then
 * save - and the save landed under the OLD name, minting a second .tpscene beside
 * the renamed one. `currentLevel.name` is the manifest key every save and publish
 * reads, and nothing carried a file rename into it.
 *
 * Scoped to a LOOSE scene on purpose (locked answer: the scene is primary and files
 * follow). For a loose file there is no manifest entry to protect and the file IS
 * the scene's only identity, so the rename is the rename. For a scene the project
 * DOES name, renaming its file must not rekey the document behind the user's back -
 * that is the header rename, and it belongs with the shared-library work.
 * @param {string} hash the renamed item's content hash
 * @param {string} fileName its new name @returns {boolean} did the open scene move
 */
export function renameOpenLooseScene(hash, fileName) {
	const at = get(currentLevel);
	if (!at?.unsaved || at.hash !== String(hash ?? '')) return false;
	const next = levelSceneName(fileName);
	if (!next || next === at.name) return false;
	// the SIGNATURE is content identity and the content did not change, so it rides
	// across unchanged - renaming a scene must not make it look edited
	currentLevel.set({ ...at, name: next });
	return true;
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
 * @param {{label?: string, consent?: boolean}} [opts] 21-G7: `label` NAMES this version in
 *   the history panel (the manual "Save version…" path); absent = "Auto".
 *   R22 round 33: `consent: false` withholds the C4 publish consent — see below. Absent
 *   means consent, so every existing caller is byte-identical.
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
	// REPORTED: read where we WERE before the save moves us — a LOOSE scene is about to
	// become a project scene, and its source file is the only record of what it looked
	// like before this save. Captured here because currentLevel.set below destroys it.
	const cameFrom = get(currentLevel);
	// R22 ROUND 35 — A SAVE IS NOT A PUBLISH WHILE THE SCENE IS PRIVATE, and this is the one
	// `currentLevel` writer that deliberately CARRIES the flag forward rather than clearing
	// it. Every other writer clearing it is right: travelling elsewhere is leaving. Saving is
	// not. "Edit privately" promises the scene stays on this machine until the user says
	// otherwise, and the routes into this function include the unsaved-changes guard's own
	// "Save and open" — so a save that published would break the promise as a SIDE EFFECT of
	// an unrelated dialog, which is the worst way for a privacy rule to fail.
	//
	// It survives a rename (Save as) too, and marks the NEW name private: the same argument,
	// since the session has never heard of that name either. Leaving private mode is the
	// explicit act — Share with the session, granting access, or travelling away.
	const staysPrivate = cameFrom?.private === true;
	if (staysPrivate) setScenePrivateHere(payload.name, true);
	currentLevel.set({
		hash: item.hash,
		name: payload.name,
		signature: sceneSignature(payload),
		...(staysPrivate ? { private: true } : {})
	});
	// 21-G2: a manual save IS a version — the manifest pointer moves with it (refused
	// for viewers inside publishSceneVersion; the local item exists either way)
	// C4: saving IS the consent to publish, and it has to be recorded BEFORE the write —
	// publishSceneVersion commits, and a commit is a broadcast, so consent given after it
	// scopes out the very version it was meant to release and nothing sends again until
	// the next manifest write. (Measured: the host's document stayed without the scene.)
	//
	// R22 round 33 — WITH ONE EXCEPTION, and it is the exception that proves the rule.
	// "Save scene & connect" saves in order to LEAVE the scene behind and join somebody
	// else's world clean. That is not the act of publishing it to the room ("it should not
	// share any changes unless I choose"), so the connect decision passes `consent: false`
	// and the name stays out of `outboundManifest`'s scope. The version is still written
	// locally, and saving it again — deliberately, later — is consent like any other save.
	// R22 round 35: `staysPrivate` is the third way to decline consent, and it declines it
	// for the same reason the two above do — the version is still written LOCALLY, and the
	// manifest mark keeps its name out of every outbound document until the user shares.
	if (opts.consent !== false && !staysPrivate) noteSceneOpened(payload.name);
	publishSceneVersion(payload.name, item.hash);
	// ADOPT THE FILE WE CAME FROM. Reported as: open a dragged-in cube.tpscene, rename
	// it, move something, then save — and a SECOND cube2.tpscene appeared beside the
	// first. Both cards were real and different (the save is a new version), but the
	// source was left OUTSIDE the history, so the one-card-per-scene invariant could
	// not apply to it: `hideOldVersions` folds by name and deliberately skips imported
	// files, because two files a user dragged in independently are not versions of one
	// scene. This one is not a stranger — it is literally the scene we are standing in,
	// and `currentLevel.hash` says so, which is the signal the by-name sweep never has.
	//
	// Adopting it (rather than clearing its `imported` stamp) is what keeps both rules
	// true at once: the file becomes version 1 of this scene, the fold hides it because
	// the HISTORY now names it, and Version history gives those bytes a door. Nothing is
	// deleted, and a scene saved from nowhere adopts nothing.
	if (cameFrom?.unsaved && cameFrom.hash && cameFrom.hash !== item.hash && itemByHash(cameFrom.hash))
		adoptSceneVersions(payload.name, [cameFrom.hash]);
	if (opts.label) setVersionLabel(payload.name, item.hash, opts.label);
	// 21-G7: one visible card per scene name — the pointer we just wrote
	hideOldVersions(payload.name);
	pruneSceneVersions(payload.name);
	// R22 round 34 — A SAVE NAMES THE ROOM. Last, after the manifest publish above: a peer
	// that takes the name and goes looking for the scene must find its history already
	// there, and PeerJS conns are ordered, so "after" here is "after" over there too.
	const announced = await announceSceneName(cameFrom, payload.name, item.hash, opts);
	showToast(
		'Scene saved: ' + payload.name + ' (' + (payload.count ?? 0) + ' objects)' + announced.note
	);
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
	// R22 round 35: a PRIVATE scene gets the protection an unsaved one has, and for the same
	// reason one line up — this is an AUTOMATIC publish, and automatic is exactly what a
	// scene the user has declared private may not be. It calls `noteSceneOpened` below, so
	// without this a private HOST travelling away would consent to its own secret. The
	// ordinary autosave still protects the work.
	if (at.private) return false;
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
	// C4, and BEFORE the publish for the reason saveSceneAsLevel spells out: an
	// auto-published version is still this peer's own edit to this scene, so it carries
	// the same consent a manual save does. Belt and braces beside the writer gate above —
	// only the host reaches here today, and a host publishes whole anyway.
	noteSceneOpened(at.name);
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
 * @param {{private?: boolean}} [opts] R22 round 35: open it PRIVATELY — no C4 consent, no
 *   "save into project" nag, no arrival re-sync, and the record carries the flag that
 *   isolates it. Absent means today's behaviour byte for byte, which is what keeps the
 *   travel NODE and every other caller untouched.
 * @returns {Promise<boolean>} did a load happen
 */
export async function travelToLevel(hash, name = '', opts = {}) {
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
		// R22 round 35: PRIVATE. The flag is written WITH the record rather than after it, so
		// the `currentLevel.subscribe` that publishes our `atscene` row sees one write and
		// publishes the private shape once — a two-step would broadcast the NAME first and
		// take it back a tick later, which is a leak with a stack trace.
		const secret = opts.private === true;
		currentLevel.set({
			hash: key,
			name: here,
			signature: sceneSignature(payload),
			...(tracked ? {} : { unsaved: true }),
			...(secret ? { private: true } : {})
		});
		// C4: travelling INTO a scene is opening it, which is the consent that lets this
		// machine's copy of that scene's history leave it. Keyed by the name the project
		// files it under, which is the key the scope is keyed by too.
		//
		// R22 round 35 — AND THAT IS EXACTLY WHAT "Edit privately" DECLINES. Round 33's
		// `consent: false` on the save path is the same act one door over: consent is an act
		// a person performs, and this person has just declined it. The manifest MARK is the
		// other half, and it is the half that covers a host (which publishes whole).
		if (secret) setScenePrivateHere(here, true);
		else noteSceneOpened(here);
		// …and the "save this into your project" prompt is an invitation to publish, so
		// arming it here would nag a decision the user has just made
		if (!tracked && !secret) void armSaveIntoProject(here);
		// A2 - ARRIVAL RE-SYNC. The room gate withholds every scene-scoped message from a
		// peer standing somewhere else, so the world we have just walked into is missing
		// whatever happened in it while we were away: the .tpscene we loaded is a
		// SNAPSHOT, and the live room has moved on. Ask everybody in it for full state,
		// which is the burst a fresh connection already sends.
		//
		// DYNAMIC, because peerScenes imports THIS module (currentLevel) and a static edge
		// back would close the cycle. Fire-and-forget: the load already happened.
		//
		// NOT wired to `currentLevel.subscribe` - which is where it would go if travel
		// were the only writer, and it is not. Adoption (A1) writes currentLevel too, on a
		// joiner whose host has ALREADY sent it everything down the handshake; asking
		// there would double the join transfer for nothing. This is about ARRIVING
		// somewhere the room has been running without us, which is what travel is.
		try {
			const m = await import('./peerScenes');
			m.resyncRoomPeers();
		} catch {}
		return true;
	} finally {
		inFlight.delete(key);
	}
}

/**
 * A1 — ADOPT the scene identity of the peer whose session we joined.
 *
 * A joiner who never travelled has `currentLevel === null`, so it publishes
 * `atscene {scene:''}` and nothing in the app ever teaches it the host's name: both
 * peer lists say nothing forever, and every scene-aware read answers "no evidence"
 * about the most ordinary peer in the session. The CONTENT is already on its way down
 * the handshake — this only names it, which is why it is safe to do unasked.
 *
 * THE NAME AND NOTHING ELSE — this is `fileHandler`'s loose-scene shape,
 * `{hash: '', name, unsaved: true}`, and for the same reason it exists there: named,
 * on screen, not a member of the project.
 *
 * NO HASH. A hash in `currentLevel` means "these are the bytes I loaded", and every
 * reader treats it that way — `openSceneItem` refuses to re-open the scene you are
 * already in, `publishCurrentIfChanged` places a new version beside that item. A joiner
 * loaded no file at all: it is standing in the host's LIVE world, which is that scene's
 * content plus whatever has happened since. Claiming the host's hash was tried and it
 * broke exactly the reader above — the Explorer's "Open here (downloads it)" on the
 * joiner became "you are already in it", so the bytes never arrived and a card that
 * exists precisely to fetch them could not (scene-rooms, three checks).
 *
 * NO SIGNATURE either, one step further down the same argument: a signature says "this
 * is exactly what that file holds", which we have never compared. Absent, the dirty
 * check answers false by construction rather than answering wrongly.
 *
 * So `unsaved` is unconditional, not derived: without a hash there is nothing to test
 * against the manifest, and the honest reading of this machine is that it holds no file
 * for this scene. It also keeps `publishCurrentIfChanged` refusing, which is belt and
 * braces beside the writer gate (`sessionHost !== null`) a joiner already fails.
 *
 * There is therefore NOTHING for the arriving manifest to lift, which is why the fold
 * sweep at the foot of this file is untouched: `unsaved` here is a fact about this
 * machine, and a document written by somebody else cannot settle it. It lifts the
 * ordinary way — travel to the scene, or save it in.
 * @param {string} name @param {string} [hash] the peer's hash — accepted because the
 *   caller has it and the next phase's "same scene, same version?" question will want
 *   it, deliberately not stored (see above)
 * @returns {boolean} did we take it
 */
export function adoptSceneIdentity(name, hash) {
	const scene = String(name ?? '').trim();
	if (!scene) return false;
	// C4: deliberately NO `noteSceneOpened`. Adoption is something the app does to a
	// joiner unasked, and consent must be an act the user performed — and it would buy
	// nothing anyway, because the name arrived in the host's manifest and is therefore
	// already inside `sessionSceneNames`.
	currentLevel.set({ hash: '', name: scene, unsaved: true });
	return true;
}

// ---- R22 round 34: A SAVE NAMES THE ROOM ---------------------------------------------
//
// REPORTED: two peers edit ONE untitled world together; one of them saves it in the
// Library; from that moment the peers popup shows them in two different scenes, Watch
// reads wrong, and the identity has diverged from the content. Nothing was broken about
// the CONTENT — `currentLevel` is LOCAL by design, an unnamed side is never evidence of
// "elsewhere" (the only-on-evidence rule), so edits kept flowing exactly as before. What
// diverged was the NAME: only the saver's copy learned it.
//
// A1 already solved the joiner's half of this — `adoptSceneIdentity` names an empty
// joiner from the host's handshake. This is the same act at the other end of the session:
// the world acquires a name while everybody is standing in it, so everybody takes it.
//
// ONE SMALL MESSAGE, and it earns its keep by joining `ROOM_SCOPED`, which is the whole
// reason it is a type of its own rather than a field on something else. That membership
// buys, with no code here at all: withheld on SEND from a peer demonstrably elsewhere
// (`broadcast`), dropped on RECEIVE from one (`canApplyByRoom`), and dropped from a peer
// held behind an open share-or-stash / connect decision (`gateHolds`). A save made in
// one room can therefore never rename another.

/**
 * Tell the room what it is now called — when this save is the one that NAMED it.
 *
 * THREE GATES, and each excludes a real case rather than a hypothetical one:
 *   · the world was UNNAMED before this save. A re-save of an already-named scene changes
 *     no name (the manifest pointer machinery owns versions), and `newLevel` opens
 *     nothing, so neither has anything to announce.
 *   · CONSENT was recorded. Round 33's "Save scene & connect" passes `consent: false`: it
 *     saves in order to LEAVE this world behind and join somebody else's clean, so
 *     renaming everybody's scene on the way out is precisely what that button promises not
 *     to do. A private-by-intent save must not name a room.
 *   · somebody is HERE to hear it — an open conn we have no evidence is somewhere else,
 *     which is the same test `broadcast` will apply to the message itself, so this count
 *     is exactly its audience.
 * @param {{name?: string} | null} cameFrom `currentLevel` as it was BEFORE the save
 * @param {string} name @param {string} hash
 * @param {{consent?: boolean}} opts
 * @returns {Promise<{told: number, note: string}>} `note` is the save toast's suffix
 */
async function announceSceneName(cameFrom, name, hash, opts) {
	const wasUnnamed = !String(cameFrom?.name ?? '').trim();
	const shared = opts.consent !== false;
	const here = await roommatePeers();
	if (!here.length || !shared) return { told: 0, note: '' };
	// the note is about SHARING and not about naming, so it rides every consented save
	// made with company — a re-save publishes this version to the room just the same
	const note = ' — shared with this session.';
	if (!wasUnnamed) return { told: 0, note };
	try {
		/** @type {any} */
		const peer = get(peers);
		peer.send({ type: 'sceneadopt', name, hash, peerId: peer.peer.id, at: Date.now() });
	} catch {
		return { told: 0, note };
	}
	return { told: here.length, note };
}

/**
 * The peers we can reach in OUR room: every open conn minus anybody demonstrably
 * elsewhere. `elsewhereThan` is the same predicate `broadcast` filters with, so this is
 * the audience of a room-scoped message, counted before one is sent.
 *
 * DYNAMIC import, the shape `travelToLevel`'s arrival re-sync already uses here:
 * `peerScenes` imports THIS module (currentLevel) and a static edge back would close the
 * cycle — and its module body subscribes at eval, which is where that bites.
 * @returns {Promise<string[]>}
 */
async function roommatePeers() {
	try {
		/** @type {any} */
		const peer = get(peers);
		if (!peer?.peer?.id) return [];
		const conns = peer.connections ?? {};
		const open = Object.keys(conns).filter((id) => conns[id]?.open);
		if (!open.length) return [];
		const m = await import('./peerScenes');
		// R22 round 35: while WE are private nobody is in our room BY DEFINITION, so the
		// audience is empty — which also stops the save toast claiming a scene was "shared
		// with this session" when the whole point of the save was that it was not.
		if (m.amPrivate()) return [];
		const map = get(m.peerScenes);
		const mine = m.myScene()?.scene ?? '';
		return open.filter((id) => !m.elsewhereThan(map, mine, id));
	} catch {
		return [];
	}
}

/**
 * THE OTHER END: a peer saved the world we are standing in, so it has a name now.
 *
 * TWO GATES:
 *   (a) OUR OWN SCENE IS UNNAMED. A named scene is either a different room — in which case
 *       their save is none of our business — or this identity already, which makes a
 *       repeat message a no-op; so this is the idempotence guard too. An `unsaved: true`
 *       loose scene HAS a name and is therefore NOT unnamed: it is a file this machine
 *       opened, and a stranger's save does not get to re-label it.
 *   (b) the sender is in our room. Redundant by construction — `sceneadopt` is
 *       ROOM_SCOPED, so `canApplyByRoom` has already dropped this message from a peer
 *       standing elsewhere — and kept anyway as the backstop against a build that does not
 *       gate on send, which is the same reason the receive-side gate exists at all.
 *
 * THE NAME AND NOTHING ELSE, hash included: `adoptSceneIdentity` spells out why claiming
 * somebody else's hash broke the Explorer's "Open here". And adoption is NOT consent, so
 * nothing here widens `outboundManifest`'s scope — see that function's own note.
 * @param {any} data @returns {Promise<boolean>} did we take the name
 */
export async function applyRemoteSceneAdopt(data) {
	const scene = String(data?.name ?? '').trim();
	const from = String(data?.peerId ?? '');
	if (!scene) return false;
	if (String(get(currentLevel)?.name ?? '').trim()) return false;
	try {
		const m = await import('./peerScenes');
		if (from && !m.sameRoomOrUnknown(from)) return false;
	} catch {}
	if (!adoptSceneIdentity(scene, String(data?.hash ?? ''))) return false;
	showToast(nameOf(from) + ' saved this scene as "' + scene + '"');
	return true;
}

// ---- R22 round 35: THE ONE WAY OUT OF PRIVATE MODE -----------------------------------

/**
 * SHARE THE PRIVATE SCENE WITH THE SESSION — the exit path, and deliberately the ONLY one
 * that publishes. Both routes to it (the "Share scene" button on an access request, and
 * the popup's own Share) come through here, because the ORDER of these five steps is the
 * whole correctness of the thing and a second copy would get one of them wrong:
 *
 *   1. the WIRE mark comes off first, so anything the steps below send is already allowed
 *      to carry the name (`outboundManifest` reads that set on every send).
 *   2. CONSENT, recorded BEFORE the write that publishes it — the C4 rule this file states
 *      twice already, for the same measured reason: a commit is a broadcast, and consent
 *      given after one scopes out the very document it was meant to release.
 *   3. the RECORD, whose write is what publishes our real `atscene` row (the module-level
 *      subscribe in peerScenes) — so from here on the popup can offer Go to.
 *   4. the MANIFEST, pushed rather than waited for. The scene's history exists locally
 *      (it was saved before it was opened), and the send-back only fires when a document
 *      ARRIVES, so without this the room learns the history at the next unrelated write.
 *      A scene with no entry at all — a loose .tpscene — is fine: Go to travels HASH-first.
 *   5. the arrival re-sync, for what the room withheld while we were away.
 * @returns {Promise<{scene: string, hash: string} | null>} null when we were not private
 */
export async function sharePrivateScene() {
	const at = get(currentLevel);
	if (at?.private !== true) return null;
	const scene = String(at.name ?? '').trim();
	setScenePrivateHere(scene, false);
	noteSceneOpened(scene);
	const next = { ...at };
	delete next.private;
	currentLevel.set(next);
	try {
		sendProjectManifest('');
	} catch {}
	try {
		const m = await import('./peerScenes');
		m.resyncRoomPeers();
	} catch {}
	return { scene, hash: String(at.hash ?? '') };
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
