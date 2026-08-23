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
// WHAT IT DOES NOT DO: importing a project never loads a scene. It furnishes the
// library and installs the manifest; the user travels when they are ready. A project
// with five scenes has no opinion about which one you want open, and auto-loading one
// would replace the world someone is standing in.

import { get } from 'svelte/store';
import { showToast } from '../stores/appStore';
import { APP_VERSION } from './version.js';
import { showConfirm } from './confirmDialog';
import { addItemFromBytes, itemByHash, itemBlob } from './explorer';
import { applyAssetFile } from './assetShare';
import {
	projectManifest,
	normalizeManifest,
	manifestInUse,
	manifestRestore,
	keepableHashes,
	projectName
} from './projectManifest';
import { ensureScenesFolder } from './levels';

/** V4's gating pattern with its own int: a NEWER format ASKS before importing, an
 * older or absent one loads silently. `appVersion` beside it is display-only
 * provenance, exactly as in a .tpscene. */
export const PROJECT_FORMAT = 1;

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
 * @returns {Promise<{bytes: Uint8Array, scenes: number, assets: number,
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

	files['project.json'] = strToU8(
		JSON.stringify({
			format: PROJECT_FORMAT,
			appVersion: APP_VERSION,
			createdAt: Date.now(),
			manifest,
			scenes,
			assets,
			// what this file could NOT carry, so the other end can say so too
			skipped: { scenes: skippedScenes, assets: skippedAssets }
		})
	);
	return { bytes: zipSync(files, { level: 6 }), scenes: scenes.length, assets: assets.length, skippedScenes, skippedAssets };
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

/**
 * IMPORT: bytes first, document last — the .tpscene rule, because a manifest naming
 * hashes the library does not hold is a project full of dead pointers.
 *
 *   1. the format confirm, BEFORE anything is written (a cancelled import mutates
 *      nothing — the same reason importSessionZip confirms above its restore loops)
 *   2. assets through `applyAssetFile` (hash-deduped into `Shared`; it slices the
 *      typed-array VIEW itself, which is why fflate's shared buffers are safe here)
 *   3. scenes as ordinary library items in the `Scenes` folder — `addItemFromBytes`
 *      dedupes by content hash, so re-importing a project you already have adds
 *      nothing and every hash in the manifest still resolves
 *   4. `manifestRestore(..., true)` — REPLACING the local project document and
 *      replicating it, so importing a project inside a live room brings the room along
 *
 * Nothing is loaded into the scene: see the module header.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{scenes: number, assets: number, skipped: {scenes: number, assets: number}}|null>}
 *   null = not a project file, or the user declined the format confirm
 */
export async function importProject(buffer) {
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
	if (!(await confirmProjectFormat(doc))) return null;

	let assets = 0;
	for (const entry of doc.assets ?? []) {
		const bytes = entries[entry.file];
		if (!bytes) continue;
		// pass the VIEW — applyAssetFile slices byteOffset..length so fflate's shared
		// buffer cannot corrupt the content hash (the documented rule)
		await applyAssetFile({ hash: entry.hash, name: entry.name, buffer: bytes });
		assets++;
	}

	const folderId = await ensureScenesFolder();
	let scenes = 0;
	for (const entry of doc.scenes ?? []) {
		const bytes = entries[entry.file];
		if (!bytes) continue;
		// slice the exact bytes out of fflate's shared buffer, or the content hash the
		// Explorer computes is not the hash the manifest names (the assetShare rule)
		const exact = /** @type {ArrayBuffer} */ (
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
		);
		await addItemFromBytes(exact, entry.name || entry.hash + '.tpscene', folderId);
		scenes++;
	}

	manifestRestore(doc.manifest, true);
	const names = Object.keys(normalizeManifest(doc.manifest).scenes);
	showToast(
		'Project imported: ' + names.length + ' scene' + (names.length === 1 ? '' : 's') +
			' (' + scenes + ' version' + (scenes === 1 ? '' : 's') + ', ' + assets + ' asset' +
			(assets === 1 ? '' : 's') + '). Nothing was loaded — travel to a scene when you are ready.'
	);
	return { scenes, assets, skipped: doc.skipped ?? { scenes: 0, assets: 0 } };
}
