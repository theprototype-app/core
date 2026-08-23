// 21-G3 — THE .tp PROJECT FILE: a whole project as ONE file.
//
// FORK 1 (locked): "OSS without cloud — a project exports/imports as one .tp file
// (manifest + hashes zipped): the .tpscene machinery, ONE LEVEL UP." That sentence is
// the whole design. A .tpscene is `session.json` + the bytes that scene references; a
// .tp is `project.json` + the SCENES that project references + the assets its manifest
// tracks. Same zip, same fflate, same content-hash addressing, same "restore the bytes
// first, then the document" import order — no new concepts and nothing new on the wire.
//
// WHY ITS OWN MODULE, and not levels.js or projectManifest.js:
//   · `projectManifest.js` is a deliberate LEAF (stores + idb + two store-only reads).
//     fflate, the Explorer and a confirm dialog have no business in it.
//   · `levels.js` is reached from flowRuntime through a PRIMED DYNAMIC import for the
//     travel node — its import surface is load-bearing, and growing it for a
//     user-triggered file dialog would put the zip machinery on the travel path.
//   · This module is only ever reached from UI (the Explorer menu, fileHandler's open
//     switch, the debug hook), so a static edge to levels.js from HERE closes no cycle
//     and lets the rule-5 bootstrap reuse `ensureScenesFolder` rather than re-deriving
//     it — it is that function's one remaining caller (21-H1).
//
// WHAT IT DOES NOT DO: neither path here loads a scene into the viewport. OPEN
// (fork 12) replaces the PROJECT — library, folders, manifest — and IMPORT merges the
// file's contents in as a folder; in both cases the user travels when they are ready.
// A project with five scenes has no opinion about which one you want open, and
// auto-loading one would replace the world someone is standing in.

import { get } from 'svelte/store';
import { showToast, explorerClose, armExplorerSceneSave } from '../stores/appStore';
import { bottomDockActive } from './bottomDock';
import { APP_VERSION } from './version.js';
import { showConfirm } from './confirmDialog';
import {
	addItemFromBytes,
	itemByHash,
	itemBlob,
	clearLibrary,
	createFolder,
	explorerFolders,
	explorerItems,
	folderSubtree,
	allItems,
	loadExplorer,
	hashBytes,
	kindOf
} from './explorer';
// loose-scenes fix (bug 2a): a .tp merge is an IMPORT a person asked for, so bytes it
// brings that we already hold get the same visible treatment a dropped file gets.
import { resolveDuplicates } from './importDuplicates';
import { applyAssetFile } from './assetShare';
import { fileNameBase, saveFileBase } from './saveName';
import {
	projectManifest,
	normalizeManifest,
	manifestInUse,
	manifestRestore,
	keepableHashes,
	latestSceneHash,
	projectName
} from './projectManifest';
import { ensureScenesFolder, currentLevel } from './levels';

/** V4's gating pattern with its own int: a NEWER format ASKS before importing, an
 * older or absent one loads silently. `appVersion` beside it is display-only
 * provenance, exactly as in a .tpscene.
 *
 * FORMAT 2 (21-G8, fork 11): a .tp is the WHOLE Explorer — project.json gains
 * `name`, `folders[]` and `items[]` (every library item, whatever its kind), with the
 * bytes hash-deduped across the zip's sections. A format-1 file still reads through
 * the same loops (its missing keys are empty lists — the additive-read rule), and a
 * format-1 READER of a format-2 file still gets what it understands: `scenes/` and
 * `assets/` are written exactly as format 1 wrote them. */
export const PROJECT_FORMAT = 2;

/** @param {any} item @returns {string} the item's extension INCLUDING the dot, lowered */
function extOf(item) {
	return (String(item?.name ?? '').match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase();
}

/**
 * 21-I4 (locked answer 3) — THE SCOPE of an export. `null` is the whole project; a
 * folder id scopes it to that folder's SUBTREE, and **the folder becomes the exported
 * project's ROOT**.
 *
 * Making it the root — rather than a top-level row inside the file — is what keeps both
 * import paths sane. `openProject` turns the library INTO that folder's contents, which
 * is what "this folder is a project" means; and `importProjectAsFolder`, which already
 * creates one folder named after the project, lands them in `<Folder>/` instead of
 * `<Folder>/<Folder>/`.
 *
 * `allItems()` and not `explorerItems` is load-bearing: 21-G7 folds a scene's old
 * versions onto the HIDDEN shelf, and a hidden record keeps its `folderId`, so a
 * folder's scene versions are inside its subtree exactly the way its visible cards are.
 * A folder export that walked the visible shelf alone would claim a history it could
 * not carry.
 *
 * @param {string | null | undefined} folderId
 * @returns {{id: string, ids: Set<string>, name: string, hashes: Set<string>} | null}
 */
function folderScope(folderId) {
	const id = typeof folderId === 'string' ? folderId.trim() : '';
	if (!id) return null;
	const ids = new Set(folderSubtree(id));
	/** @type {Set<string>} */
	const hashes = new Set();
	for (const item of allItems()) if (ids.has(item.folderId ?? '')) hashes.add(item.hash);
	// an id that names no folder scopes to nothing, which exports an empty project —
	// honest, and never the silent "whole project" a null fallback would produce
	const name = get(explorerFolders).find((f) => f.id === id)?.name ?? '';
	return { id, ids, name, hashes };
}

/** The stored bytes of a content hash, or null when this machine does not hold them.
 * @param {string} hash @returns {Promise<{item: any, bytes: Uint8Array}|null>} */
async function bytesOf(hash) {
	const item = itemByHash(hash);
	if (!item) return null;
	const blob = await itemBlob(item.id);
	if (!blob) return null;
	return { item, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

/**
 * EXPORT: the manifest plus every scene version this machine still KEEPS locally, plus
 * the assets the manifest tracks — one zip.
 *
 *   project.json          the normalized manifest + format/appVersion + the two indexes
 *   scenes/<hash>.tpscene one per kept scene version (newest KEEP_VERSIONS + pinned)
 *   assets/<hash><ext>    one per tracked asset whose bytes are here
 *
 * The manifest carries the FULL history whatever the bytes situation is — pruning was
 * always a statement about local disk, never about history (fork 4) — so a hash whose
 * bytes were pruned away stays in `project.json`'s history and is simply absent from
 * `scenes/`. It is COUNTED and reported rather than silently dropped: "8 scenes" when
 * the project has 10 versions is information, and a silent cap is how a lossy export
 * gets discovered a month later.
 *
 * 21-I5 (locked answer 2) adds a GATE, not machinery: "Include scene version history",
 * DEFAULT ON, because carrying history is what a .tp has done since 21-G3 and turning
 * that off silently would make an existing behaviour vanish. With it OFF the file
 * carries each scene's POINTER version only — the project still opens, every scene is
 * there, and the history in `project.json` is untouched (a manifest hash whose bytes are
 * absent is the pruned case, which this format already handles). What was left out is
 * COUNTED separately from the pruned ones: "we chose not to" and "we could not" are
 * different facts and the toast says which.
 *
 * 21-I4 adds `folderId` — the same export SCOPED to one folder's subtree (see
 * `folderScope`). THE MANIFEST QUESTION it forces, and the answer: a .tp's manifest may
 * only claim scenes the file CARRIES, or the other end opens a project full of dead
 * pointers (the rule this module's header states). So a scoped export filters the
 * manifest's scene MAP to the scenes whose files live in that folder, and its `assets`
 * list to the hashes the subtree holds — while each surviving scene's own entry
 * (history, pins, labels) rides VERBATIM. That asymmetry is deliberate and matches what
 * this format already does: a history hash whose bytes are absent is the PRUNED case,
 * which every reader has handled since 21-G3, so trimming a history would throw away
 * pins and version names to solve a problem the format does not have.
 *
 * @param {{versions?: boolean, folderId?: string | null}} [opts] `versions` overrides
 *   the stored preference; `folderId` scopes the whole export to one folder's subtree
 * @returns {Promise<{bytes: Uint8Array, scenes: number, assets: number, items: number,
 *   folder: string | null, skippedScenes: number, skippedAssets: number,
 *   omittedVersions: number, omittedScenes: number}>}
 */
export async function exportProject(opts = {}) {
	const { zipSync, strToU8 } = await import('fflate');
	const withVersions = opts.versions ?? projectVersionsEnabled();
	// the scope reads the folder tree, so the library has to be loaded before it — the
	// v2 item walk below used to be the first thing that needed this
	await loadExplorer();
	const scope = folderScope(opts.folderId);
	// normalize at the boundary, like every other read of this document
	const manifest = normalizeManifest(get(projectManifest));
	// which SCENES this file may claim: all of them, or the ones with a file in the
	// folder. "In the folder" is ANY of the scene's versions, not just its pointer — a
	// scene dragged into a folder is in that folder whichever of its versions is the
	// visible card, and the pointer's bytes may have been pruned away locally.
	const sceneNames = Object.keys(manifest.scenes).filter(
		(name) => !scope || manifest.scenes[name].history.some((h) => scope.hashes.has(h))
	);
	const omittedScenes = Object.keys(manifest.scenes).length - sceneNames.length;
	const assetHashes = manifest.assets.filter((h) => !scope || scope.hashes.has(h));
	/** @type {Record<string, Uint8Array>} */
	const files = {};
	/** @type {{hash: string, name: string, file: string}[]} */
	const scenes = [];
	/** @type {{hash: string, name: string, file: string}[]} */
	const assets = [];
	let skippedScenes = 0;
	let skippedAssets = 0;
	let omittedVersions = 0;

	const seen = new Set();
	for (const name of sceneNames) {
		const keep = keepableHashes(name);
		// the GATE: pointer-only when history is switched off. The pointer is what the
		// project's own travel resolves, so a gated file is still a whole project.
		const pointer = latestSceneHash(name);
		const wanted = withVersions ? keep : new Set(pointer ? [pointer] : []);
		if (!withVersions) omittedVersions += [...keep].filter((h) => !wanted.has(h)).length;
		for (const hash of wanted) {
			if (seen.has(hash)) continue; // two scenes may keep the same version
			seen.add(hash);
			const found = await bytesOf(hash);
			if (!found) {
				skippedScenes++;
				continue;
			}
			const file = 'scenes/' + hash + '.tpscene';
			files[file] = found.bytes;
			scenes.push({ hash, name: found.item.name, file });
		}
	}

	for (const hash of assetHashes) {
		const found = await bytesOf(hash);
		if (!found) {
			skippedAssets++;
			continue;
		}
		const file = 'assets/' + hash + extOf(found.item);
		files[file] = found.bytes;
		assets.push({ hash, name: found.item.name, file });
	}

	// FORMAT 2 (fork 11): the WHOLE Explorer. Folders as rows, every library item as a
	// row with its placement, bytes hash-deduped against what scenes/ and assets/
	// already carry — an item whose hash travels there gets a row pointing at that
	// file rather than a second copy under items/.
	// 21-I4: a scoped export re-roots the tree — the exported folder itself is not a row
	// (it IS the project), and its direct children become top-level
	const inScope = (/** @type {string | null | undefined} */ id) =>
		!scope || scope.ids.has(id ?? '');
	const reparent = (/** @type {string | null | undefined} */ id) =>
		scope && id === scope.id ? null : (id ?? null);
	const folders = get(explorerFolders)
		.filter((f) => inScope(f.id) && (!scope || f.id !== scope.id))
		.map((f) => ({
			id: f.id,
			name: f.name,
			parentId: reparent(f.parentId)
		}));
	/** @type {{hash: string, name: string, kind: string, folderId: string | null, file: string}[]} */
	const items = [];
	/** @type {Record<string, string>} hash -> the zip path already carrying these bytes */
	const carried = {};
	for (const s of scenes) carried[s.hash] = s.file;
	for (const a of assets) carried[a.hash] = a.file;
	for (const item of get(explorerItems)) {
		if (!inScope(item.folderId)) continue;
		let file = carried[item.hash];
		if (!file) {
			const found = await bytesOf(item.hash);
			if (!found) continue; // an index row whose blob is gone — nothing to carry
			file = 'items/' + item.hash + extOf(item);
			files[file] = found.bytes;
			carried[item.hash] = file;
		}
		items.push({
			hash: item.hash,
			name: item.name,
			kind: item.kind,
			folderId: reparent(item.folderId),
			file
		});
	}

	/**
	 * 21-I (user): THE GATE COVERS THE DOCUMENT, NOT ONLY THE BYTES. With scene history
	 * switched off this file carries one version per scene — so it must CLAIM one, or the
	 * manifest names hashes the zip does not contain and the recipient opens a project
	 * showing five versions of which four say "Not held". That is the dead-pointer shape
	 * the 21-G3 header forbids, and the same reasoning 21-I4 used to scope a folder
	 * export's manifest; this is that rule applied to the other gate.
	 *
	 * `pinned` and `labels` come along for the ride: a pin or a name for a version this
	 * file does not carry is metadata about nothing (and `normalizeManifest` drops a label
	 * whose hash has left the history anyway, so leaving them would only differ until the
	 * first read). Trimming is safe HERE and nowhere else — the LOCAL manifest is never
	 * touched, because pruning was always about bytes and never about history.
	 * @param {any} entry @returns {any}
	 */
	const gateEntry = (entry) => {
		if (withVersions || !entry) return entry;
		const pointer = entry.history?.[entry.history.length - 1];
		if (!pointer) return entry;
		const label = entry.labels?.[pointer];
		const gated = {
			...entry,
			history: [pointer],
			pinned: (entry.pinned ?? []).filter((/** @type {string} */ h) => h === pointer)
		};
		if (label) gated.labels = { [pointer]: label };
		else delete gated.labels;
		return gated;
	};

	// 21-I4: THE SCOPED MANIFEST — the document the file is allowed to claim. Filtered
	// to what this zip carries, and NAMED after the folder, because the folder is the
	// project now (that name is also the .tp's filename and, on import-as-folder, the
	// folder it lands in).
	const claimed = scope ? sceneNames : Object.keys(manifest.scenes);
	/** @type {any} */
	const outManifest = {
		...manifest,
		...(scope ? { name: scope.name, assets: assetHashes } : {}),
		scenes: Object.fromEntries(claimed.map((name) => [name, gateEntry(manifest.scenes[name])]))
	};

	files['project.json'] = strToU8(
		JSON.stringify({
			format: PROJECT_FORMAT,
			appVersion: APP_VERSION,
			createdAt: Date.now(),
			// G9 owns the setter; normalize preserves the field, so it rides here whether
			// or not this build knows how to edit it
			name: String(outManifest.name ?? ''),
			manifest: outManifest,
			scenes,
			assets,
			folders,
			items,
			// what this file could NOT carry, so the other end can say so too.
			// 21-I5: `omittedVersions` is the other kind — versions this file could carry
			// and was told not to. Additive; a reader that does not know the key sees the
			// pruned counts exactly as before.
			// 21-I4: `omittedScenes` is the THIRD kind — project scenes that are simply
			// not in this folder. Recorded so the file itself says it is a slice.
			skipped: { scenes: skippedScenes, assets: skippedAssets, omittedVersions, omittedScenes }
		})
	);
	return {
		bytes: zipSync(files, { level: 6 }),
		scenes: scenes.length,
		assets: assets.length,
		items: items.length,
		folder: scope ? scope.name : null,
		skippedScenes,
		skippedAssets,
		omittedVersions,
		omittedScenes
	};
}

/** 21-I5: the .tp half of the export-settings cog. DEFAULT ON (locked answer 2) — a
 * project file has carried its scene history since 21-G3. LOCAL, like every other
 * export preference. */
export function projectVersionsEnabled() {
	try {
		return localStorage.getItem('tpProjectVersions') !== 'false';
	} catch {
		return true;
	}
}

/**
 * 21-G9: a project NAME is what the user calls this thing, and a file dialog is the one
 * place that name has to survive a filesystem. Everything Windows, macOS and the shell
 * dislike becomes a dash; a name that sanitizes to nothing falls back to the timestamp,
 * which is what an unnamed project gets anyway.
 * 21-I5: the implementation moved to `saveName.fileNameBase` so the save-name template
 * and this share ONE sanitiser. The name stays — it is what the suites and call sites
 * know it as, and the contract is unchanged.
 * @param {string} name @returns {string} a safe basename, or '' when nothing survives
 */
export function projectFileBase(name) {
	return fileNameBase(name);
}

/**
 * 21-H1 (locked answer 5): the BOOTSTRAP out of a completely empty library. The old
 * refusal DESCRIBED the thing to do next; this does it — open the Explorer, make a
 * `Scenes` folder the place you are looking at, and start the inline name input there.
 *
 * This is the ONE caller of `ensureScenesFolder` left in the app, and deliberately so:
 * every other save now lands where the user is looking or at the root (locked answer 6),
 * but a first-time user with nothing at all is better served by a starting structure
 * than by the purity of that rule — "the root" is not a place they recognise yet.
 *
 * The Explorer is reached through a write-once ARM store rather than a callback (the
 * `hudPickArm`/`hudPickResult` shape): the inline editor is component state in a panel
 * this module must not import, and a store is the seam that needs nothing back.
 */
async function startSceneSaveBootstrap() {
	const folderId = await ensureScenesFolder();
	explorerClose.set(false);
	bottomDockActive.set('explorer'); // if it is docked, make it the visible panel
	armExplorerSceneSave(folderId);
}

/** Hand the project to the user as a file — the Explorer's `downloadItem` mechanism,
 * one level up (a Blob, an anchor, a revoked object URL).
 *
 * 21-H1 (locked answer 5 + the design note beside it): the gate is "is there anything
 * here", not "is the manifest in use". Fork 11 made a .tp the WHOLE Explorer, so a
 * library of models with no scene in it is a legitimate project export and not an empty
 * zip — refusing it was the first of the two things wrong with this refusal. The second
 * was that it only described what to do; it carries the action now.
 *
 * 21-I4 (locked answer 3): with a `folderId` this is "Export folder as .tp" — the same
 * file, scoped to one subtree. ONE function rather than two, because the gate, the
 * anchor, the filename rule and the honesty toast are the same three facts either way,
 * and a second copy of the toast is how two counts drift apart.
 * @param {{folderId?: string | null}} [opts]
 */
export async function downloadProject(opts = {}) {
	await loadExplorer();
	const scope = folderScope(opts.folderId);
	if (scope) {
		// a folder with no files and no subfolders would write a zip of nothing
		if (!scope.hashes.size && scope.ids.size <= 1) {
			showToast(
				'"' + (scope.name || 'That folder') + '" is empty — there is nothing to export yet.'
			);
			return null;
		}
	} else {
		const hasLibrary = get(explorerItems).length > 0 || get(explorerFolders).length > 0;
		if (!manifestInUse() && !hasLibrary) {
			showToast('There is nothing here yet — save a scene and this becomes a project.', [
				{ label: 'Save a scene', action: () => void startSceneSaveBootstrap() }
			]);
			return null;
		}
	}
	const result = await exportProject({ folderId: opts.folderId ?? null });
	// zipSync's Uint8Array is typed over ArrayBufferLike; BlobPart wants ArrayBuffer
	const blob = new Blob([/** @type {BlobPart} */ (result.bytes)], { type: 'application/zip' });
	const a = document.createElement('a');
	document.body.appendChild(a);
	a.style.display = 'none';
	const url = URL.createObjectURL(blob);
	a.href = url;
	// 21-G9: a named project comes out as `<Name>.tp` — someone who called it "Dungeon
	// Crawl" should not have to recognise it by timestamp in their Downloads folder.
	// 21-I5: through the save-name template, whose DEFAULT is `[name]` and whose no-name
	// fallback is the old timestamp shape verbatim — so the behaviour above is intact and
	// a user who wants a date in the filename can now say so once, for every save path.
	// 21-I4: a folder export is a project called after the FOLDER — that is the thing the
	// user pointed at, and the name their file manager should show them
	a.download = `${saveFileBase(scope ? scope.name : projectName())}.tp`;
	a.click();
	URL.revokeObjectURL(url);
	a.remove();
	const skipped = result.skippedScenes + result.skippedAssets;
	const plural = (/** @type {number} */ n, /** @type {string} */ word) =>
		n + ' ' + word + (n === 1 ? '' : 's');
	showToast(
		(scope ? 'Folder exported: ' + (scope.name || 'folder') + ' — ' : 'Project exported: ') +
			plural(result.scenes, 'scene version') +
			', ' + plural(result.items, 'library item') +
			', ' + plural(result.assets, 'asset') +
			(skipped ? ' — ' + skipped + ' whose bytes are not on this machine were left out' : '') +
			// 21-I4: what a SLICE left behind. "we chose not to", "we could not" and "it is
			// not in this folder" are three different facts and the toast names each.
			(result.omittedScenes
				? ' — ' + plural(result.omittedScenes, 'project scene') +
					' outside this folder ' + (result.omittedScenes === 1 ? 'was' : 'were') + ' left out'
				: '') +
			(result.omittedVersions
				? ' — ' + plural(result.omittedVersions, 'older version') +
					' left out (scene version history is off in Export settings)'
				: '')
	);
	return result;
}

/** V4's confirm, verbatim in shape: a newer format ASKS. Unlike travel — which runs on
 * every peer at once off a replicated trigger and so cannot be asked anything — an
 * import is ONE person's deliberate action at a file dialog, so a dialog is right here.
 * @param {any} doc */
async function confirmProjectFormat(doc) {
	const format = Number(doc?.format) || 0;
	if (format <= PROJECT_FORMAT) return true;
	return showConfirm({
		title: 'Newer project format',
		message:
			'This project was saved by app ' + (doc?.appVersion || 'unknown') + ' (format ' + format +
			'); this app supports format ' + PROJECT_FORMAT + '. Some content may not load correctly.',
		confirmLabel: 'Import anyway'
	});
}

/** Unzip + parse a .tp's project.json, with the not-a-project toasts. The format
 * confirm is the CALLER's (open and import warn differently above it).
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{entries: Record<string, Uint8Array>, doc: any}|null>} */
async function readProjectFile(buffer) {
	const { unzipSync, strFromU8 } = await import('fflate');
	/** @type {Record<string, Uint8Array>} */
	let entries;
	try {
		entries = unzipSync(new Uint8Array(buffer));
	} catch {
		showToast('That file could not be read as a project (.tp).');
		return null;
	}
	const raw = entries['project.json'];
	if (!raw) {
		showToast('That .tp file has no project.json — it is not a project export.');
		return null;
	}
	/** @type {any} */
	let doc = null;
	try {
		doc = JSON.parse(strFromU8(raw));
	} catch {
		doc = null;
	}
	if (!doc?.manifest) {
		showToast('That project file is missing its manifest.');
		return null;
	}
	return { entries, doc };
}

/**
 * Rebuild a saved folder TREE with fresh ids (ids are local identity — an import must
 * never collide with what this library already has). Top-level rows land under
 * `rootId` (null = the library root); children follow their parents; a row whose
 * parent could not be built (an invalid name, a cyclic file) falls back to `rootId`
 * rather than vanishing.
 * @param {any[]} rows @param {string | null} rootId
 * @returns {Map<string, string>} saved folder id -> the fresh one
 */
function restoreFolderTree(rows, rootId) {
	/** @type {Map<string, string>} */
	const remap = new Map();
	const pending = [...(rows ?? [])];
	let stuck = 0;
	while (pending.length && stuck <= pending.length) {
		const row = /** @type {any} */ (pending.shift());
		const savedParent = row?.parentId == null ? null : String(row.parentId);
		const parent = savedParent === null ? rootId : remap.get(savedParent);
		if (savedParent !== null && parent === undefined) {
			// parent not built yet — requeue; `stuck` breaks a cycle or an orphan chain
			pending.push(row);
			stuck++;
			continue;
		}
		stuck = 0;
		const folder = createFolder(String(row?.name ?? 'Folder'), parent ?? rootId);
		if (folder && row?.id != null) remap.set(String(row.id), folder.id);
	}
	// orphans (their parent never resolved) land at the root rather than being lost
	for (const row of pending) {
		const folder = createFolder(String(row?.name ?? 'Folder'), rootId);
		if (folder && row?.id != null) remap.set(String(row.id), folder.id);
	}
	return remap;
}

/**
 * The shared restore loops — bytes first, document last (the .tpscene rule, because a
 * manifest naming hashes the library does not hold is a project full of dead
 * pointers). Every loop is hash-dedupe-safe (`addItemFromBytes`/`applyAssetFile`), so
 * running all of them over a format-1 OR format-2 file is correct: a v1 file simply
 * has empty `folders`/`items` and takes the scenes/assets loops alone.
 * @param {any} doc @param {Record<string, Uint8Array>} entries
 * @param {string | null} rootId where the folder tree and loose items land
 * @param {string | null} sceneFolderId where `scenes/` entries WITHOUT an item row land
 * @param {{imported?: boolean, duplicates?: string}} [opts] loose-scenes fix: `imported`
 *   stamps provenance on everything written (an IMPORT, never a project-minted save), and
 *   `duplicates: 'ask'` surfaces bytes we already hold instead of deduping in silence
 * @returns {Promise<{scenes: number, assets: number, items: number}>}
 */
async function restoreProjectContents(doc, entries, rootId, sceneFolderId, opts = {}) {
	const remap = restoreFolderTree(doc.folders ?? [], rootId);
	const imported = !!opts.imported;

	// loose-scenes fix (bug 2a): BEFORE writing anything, find out how much of this file
	// we already hold. addItemFromBytes dedupes silently, which is correct for the app
	// writing its own bytes and wrong for a person importing a project — a .tp that is
	// entirely already here used to report "Imported N items" having added nothing.
	// The ask happens ONCE for the whole file rather than per row, and its answer is a
	// set of copies keyed by hash that the loops below splice in.
	/** @type {Map<string, {name: string, buffer: ArrayBuffer}[]>} */
	const extraCopies = new Map();
	if (opts.duplicates === 'ask') {
		/** @type {any[]} */
		const dupes = [];
		const seen = new Set();
		for (const row of [...(doc.items ?? []), ...(doc.scenes ?? [])]) {
			const bytes = entries[row.file];
			if (!bytes) continue;
			const exact = /** @type {ArrayBuffer} */ (
				bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
			);
			const hash = await hashBytes(exact);
			if (seen.has(hash)) continue;
			seen.add(hash);
			const existing = itemByHash(hash);
			if (!existing) continue;
			const name = row.name || String(row.hash ?? 'item');
			dupes.push({ name, kind: kindOf(name) ?? 'text', hash, buffer: exact, existing });
		}
		if (dupes.length) {
			const { copies } = (await resolveDuplicates(dupes, { group: 'from this project file' })) ?? {
				copies: []
			};
			// keyed by the hash each was copied FROM, so a copy lands in the folder its own
			// row named rather than all of them at the project root
			for (const copy of copies ?? []) {
				const list = extraCopies.get(copy.from) ?? [];
				list.push(copy);
				extraCopies.set(copy.from, list);
			}
		}
	}

	// v2 items — every library item, placed where its saved folder landed
	let items = 0;
	for (const row of doc.items ?? []) {
		const bytes = entries[row.file];
		if (!bytes) continue;
		// slice the exact bytes out of fflate's shared buffer, or the content hash the
		// Explorer computes is not the hash the manifest names (the assetShare rule)
		const exact = /** @type {ArrayBuffer} */ (
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
		);
		const folderId = row.folderId == null ? rootId : (remap.get(String(row.folderId)) ?? rootId);
		await addItemFromBytes(exact, row.name || String(row.hash ?? 'item'), folderId, { imported });
		for (const copy of extraCopies.get(await hashBytes(exact)) ?? [])
			await addItemFromBytes(copy.buffer, copy.name, folderId, { imported });
		items++;
	}

	// v1 assets (and any v2 straggler whose bytes ride assets/ without an item row) —
	// applyAssetFile hash-dedupes into Shared and registers the pull path
	let assets = 0;
	for (const entry of doc.assets ?? []) {
		const bytes = entries[entry.file];
		if (!bytes) continue;
		// pass the VIEW — applyAssetFile slices byteOffset..length itself
		await applyAssetFile({ hash: entry.hash, name: entry.name, buffer: bytes });
		assets++;
	}

	// v1 scenes (for a v2 file the item rows above already placed these — the
	// hash-dedupe makes this loop a no-op there)
	let scenes = 0;
	for (const entry of doc.scenes ?? []) {
		const bytes = entries[entry.file];
		if (!bytes) continue;
		const exact = /** @type {ArrayBuffer} */ (
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
		);
		await addItemFromBytes(exact, entry.name || entry.hash + '.tpscene', sceneFolderId, {
			imported
		});
		for (const copy of extraCopies.get(await hashBytes(exact)) ?? [])
			await addItemFromBytes(copy.buffer, copy.name, sceneFolderId, { imported });
		scenes++;
	}

	return { scenes, assets, items };
}

/**
 * OPEN (21-G8, fork 12): a .tp REPLACES the current project. A real warning modal
 * first — this is the one destructive file operation in the app — then: wipe the user
 * library, restore the file's whole Explorer, install its manifest (replicated, so
 * opening a project inside a live room brings the room along), and FORGET
 * `currentLevel`. That last one is load-bearing: the scene on screen belongs to the
 * OLD project, and leaving it named would let the next travel-away publish old
 * content into the new project's history (the NAMED-ONLY gate reads the name). The
 * viewport itself is deliberately untouched — this module never loads a scene.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{scenes: number, assets: number, items: number}|null>} null = not
 *   a project file, or the user declined a confirm
 */
export async function openProject(buffer) {
	const read = await readProjectFile(buffer);
	if (!read) return null;
	const { entries, doc } = read;
	if (!(await confirmProjectFormat(doc))) return null;
	const name = String(doc.name ?? '').trim();
	const ok = await showConfirm({
		title: 'Open project' + (name ? ': ' + name : ''),
		message:
			'This replaces your current project — the Explorer library, its folders and the scene history. ' +
			'The scene on screen stays, but it no longer belongs to a saved project scene until you save it. Continue?',
		confirmLabel: 'Open project'
	});
	if (!ok) return null;

	await loadExplorer();
	await clearLibrary();
	// 21-H1 (locked answer 6): a v1 file carries no folder tree, and its scenes land at
	// the library ROOT rather than in a `Scenes` folder we invent for them. A v2 file's
	// own tree places its items itself, exactly as before.
	// OPEN wiped the library first, so nothing here can be a duplicate — and its manifest
	// becomes OURS, so its scene files are project-minted, never imported strangers
	const counts = await restoreProjectContents(doc, entries, null, null);
	manifestRestore(doc.manifest, true);
	// the open scene belongs to no scene of THIS project — a named currentLevel would
	// let travel-away publish the old world into the new project's history
	currentLevel.set(null);
	const names = Object.keys(normalizeManifest(doc.manifest).scenes);
	showToast(
		'Project opened' + (name ? ': ' + name : '') + ' — ' + names.length + ' scene' +
			(names.length === 1 ? '' : 's') + ', ' + (counts.items || counts.scenes + counts.assets) +
			' library item' + ((counts.items || counts.scenes + counts.assets) === 1 ? '' : 's') +
			'. Nothing was loaded — travel to a scene when you are ready.'
	);
	return counts;
}

/**
 * IMPORT (21-G8, fork 12): both file types ADD to the Explorer without opening
 * anything. A .tp merges in as ONE FOLDER named after the project (hash-dedupe
 * inside — re-importing what you already have adds nothing); the manifest is NOT
 * installed, because importing is furnishing, not switching projects. (.tpscene
 * import needs no code here — it is an ordinary library item and the Explorer's drop
 * already lands it in the active folder.)
 * @param {ArrayBuffer} buffer
 * @param {{fileName?: string, parentId?: string|null}} [opts] 21-I: `fileName` NAMES the
 *   folder (minus its extension) and `parentId` is where the command was started — see
 *   the two comments in the body for why each is the caller's fact to supply.
 * @returns {Promise<{scenes: number, assets: number, items: number}|null>}
 */
export async function importProjectAsFolder(buffer, opts = {}) {
	const read = await readProjectFile(buffer);
	if (!read) return null;
	const { entries, doc } = read;
	if (!(await confirmProjectFormat(doc))) return null;
	await loadExplorer();
	// 21-I (user): the folder is named after the FILE, not after the project document
	// inside it — you picked `Dungeon v3.tp` off a disk, so `Dungeon v3` is the name you
	// will look for afterwards, and two exports of one project would otherwise both land
	// under the same name. The document's own name is the fallback for a caller that has
	// no filename to offer.
	const fromFile = String(opts.fileName ?? '').replace(/\.tp$/i, '').trim();
	const name = fromFile || String(doc.name ?? '').trim() || 'Imported project';
	// …and it lands WHERE THE COMMAND WAS STARTED. `parentId` is honoured only when it is
	// a real library folder that still exists: `activeFolder` also holds pseudo locations
	// (`prefabs`, `packs`, `pack:<name>`, `scene…`) that hold no items of ours, and a
	// stale id survives a folder being deleted. Anything else means the root, as before.
	const wanted = typeof opts.parentId === 'string' ? opts.parentId.trim() : '';
	const parentId =
		wanted && get(explorerFolders).some((/** @type {any} */ f) => f.id === wanted) ? wanted : null;
	// createFolder validates names — a name its rules refuse falls back to the default
	const folder = createFolder(name, parentId) ?? createFolder('Imported project', parentId);
	const rootId = folder?.id ?? null;
	// IMPORT merges into a library that already has things in it, so both halves of the
	// loose-scenes fix apply: ask about bytes we already hold, and stamp what lands as
	// IMPORTED so another project's Arena.tpscene is never folded into ours as a version
	const counts = await restoreProjectContents(doc, entries, rootId, rootId, {
		imported: true,
		duplicates: 'ask'
	});
	const total = counts.items || counts.scenes + counts.assets;
	showToast(
		'Imported "' + (folder?.name ?? name) + '" as a folder: ' + total + ' item' +
			(total === 1 ? '' : 's') + '. Your project and manifest are untouched.'
	);
	return counts;
}
