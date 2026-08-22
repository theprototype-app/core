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
//     and lets the export reuse `ensureScenesFolder` rather than re-deriving it.
//
// WHAT IT DOES NOT DO: neither path here loads a scene into the viewport. OPEN
// (fork 12) replaces the PROJECT — library, folders, manifest — and IMPORT merges the
// file's contents in as a folder; in both cases the user travels when they are ready.
// A project with five scenes has no opinion about which one you want open, and
// auto-loading one would replace the world someone is standing in.

import { get } from 'svelte/store';
import { showToast } from '../stores/appStore';
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
	loadExplorer
} from './explorer';
import { applyAssetFile } from './assetShare';
import {
	projectManifest,
	normalizeManifest,
	manifestInUse,
	manifestRestore,
	keepableHashes,
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
 * @returns {Promise<{bytes: Uint8Array, scenes: number, assets: number, items: number,
 *   skippedScenes: number, skippedAssets: number}>}
 */
export async function exportProject() {
	const { zipSync, strToU8 } = await import('fflate');
	// normalize at the boundary, like every other read of this document
	const manifest = normalizeManifest(get(projectManifest));
	/** @type {Record<string, Uint8Array>} */
	const files = {};
	/** @type {{hash: string, name: string, file: string}[]} */
	const scenes = [];
	/** @type {{hash: string, name: string, file: string}[]} */
	const assets = [];
	let skippedScenes = 0;
	let skippedAssets = 0;

	const seen = new Set();
	for (const name of Object.keys(manifest.scenes)) {
		for (const hash of keepableHashes(name)) {
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

	for (const hash of manifest.assets) {
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
	await loadExplorer();
	const folders = get(explorerFolders).map((f) => ({
		id: f.id,
		name: f.name,
		parentId: f.parentId ?? null
	}));
	/** @type {{hash: string, name: string, kind: string, folderId: string | null, file: string}[]} */
	const items = [];
	/** @type {Record<string, string>} hash -> the zip path already carrying these bytes */
	const carried = {};
	for (const s of scenes) carried[s.hash] = s.file;
	for (const a of assets) carried[a.hash] = a.file;
	for (const item of get(explorerItems)) {
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
			folderId: item.folderId ?? null,
			file
		});
	}

	files['project.json'] = strToU8(
		JSON.stringify({
			format: PROJECT_FORMAT,
			appVersion: APP_VERSION,
			createdAt: Date.now(),
			// G9 owns the setter; normalize preserves the field, so it rides here whether
			// or not this build knows how to edit it
			name: String(/** @type {any} */ (manifest).name ?? ''),
			manifest,
			scenes,
			assets,
			folders,
			items,
			// what this file could NOT carry, so the other end can say so too
			skipped: { scenes: skippedScenes, assets: skippedAssets }
		})
	);
	return {
		bytes: zipSync(files, { level: 6 }),
		scenes: scenes.length,
		assets: assets.length,
		items: items.length,
		skippedScenes,
		skippedAssets
	};
}

/**
 * 21-G9: a project NAME is what the user calls this thing, and a file dialog is the one
 * place that name has to survive a filesystem. Everything Windows, macOS and the shell
 * dislike becomes a dash; a name that sanitizes to nothing falls back to the timestamp,
 * which is what an unnamed project gets anyway.
 * @param {string} name @returns {string} a safe basename, or '' when nothing survives
 */
export function projectFileBase(name) {
	return String(name ?? '')
		.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-')
		.replace(/\s+/g, ' ')
		.slice(0, 80)
		.replace(/^[-. ]+|[-. ]+$/g, '');
}

/** Hand the project to the user as a file — the Explorer's `downloadItem` mechanism,
 * one level up (a Blob, an anchor, a revoked object URL). */
export async function downloadProject() {
	if (!manifestInUse()) {
		showToast('There is no project yet — save a scene first and it becomes one.');
		return null;
	}
	const result = await exportProject();
	// zipSync's Uint8Array is typed over ArrayBufferLike; BlobPart wants ArrayBuffer
	const blob = new Blob([/** @type {BlobPart} */ (result.bytes)], { type: 'application/zip' });
	const a = document.createElement('a');
	document.body.appendChild(a);
	a.style.display = 'none';
	const url = URL.createObjectURL(blob);
	a.href = url;
	const date = new Date().toISOString().replace(/[T:.Z]/g, '-');
	// 21-G9: a named project comes out as `<Name>.tp` — someone who called it "Dungeon
	// Crawl" should not have to recognise it by timestamp in their Downloads folder.
	// The timestamp remains the fallback for a project with no name (or one whose name
	// sanitizes away entirely), so the old behaviour is intact wherever it applied.
	const base = projectFileBase(projectName());
	a.download = base ? `${base}.tp` : `ThePrototype-${date}UTC.tp`;
	a.click();
	URL.revokeObjectURL(url);
	a.remove();
	const skipped = result.skippedScenes + result.skippedAssets;
	showToast(
		'Project exported: ' + result.scenes + ' scene version' + (result.scenes === 1 ? '' : 's') +
			', ' + result.assets + ' asset' + (result.assets === 1 ? '' : 's') +
			(skipped ? ' — ' + skipped + ' whose bytes are not on this machine were left out' : '')
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
 * @returns {Promise<{scenes: number, assets: number, items: number}>}
 */
async function restoreProjectContents(doc, entries, rootId, sceneFolderId) {
	const remap = restoreFolderTree(doc.folders ?? [], rootId);

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
		await addItemFromBytes(exact, row.name || String(row.hash ?? 'item'), folderId);
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
		await addItemFromBytes(exact, entry.name || entry.hash + '.tpscene', sceneFolderId);
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
	// a v2 file's own folder tree usually carries a Scenes folder — premaking ours
	// would duplicate it. Only a v1 file (no item rows) needs the fallback target.
	const sceneFolderId = doc.items?.length ? null : await ensureScenesFolder();
	const counts = await restoreProjectContents(doc, entries, null, sceneFolderId);
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
 * @returns {Promise<{scenes: number, assets: number, items: number}|null>}
 */
export async function importProjectAsFolder(buffer) {
	const read = await readProjectFile(buffer);
	if (!read) return null;
	const { entries, doc } = read;
	if (!(await confirmProjectFormat(doc))) return null;
	await loadExplorer();
	const name = String(doc.name ?? '').trim() || 'Imported project';
	// createFolder validates names — a name its rules refuse falls back to the default
	const folder = createFolder(name, null) ?? createFolder('Imported project', null);
	const rootId = folder?.id ?? null;
	const counts = await restoreProjectContents(doc, entries, rootId, rootId);
	const total = counts.items || counts.scenes + counts.assets;
	showToast(
		'Imported "' + (folder?.name ?? name) + '" as a folder: ' + total + ' item' +
			(total === 1 ? '' : 's') + '. Your project and manifest are untouched.'
	);
	return counts;
}
