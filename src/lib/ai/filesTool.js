// Roadmap 104 C1 — `files`: the assistant works the person's Explorer (list / read / create / write /
// rename / move / delete / restore). A lazy chunk: personTools.js loads it on the first call.
//
// THE PERSON'S OWN PATHS, NOTHING NEW. Every verb that changes the Library is the Code tab's
// (codeFiles.js, 70 W1), which writes through the Explorer's own writers, so what the assistant does
// is exactly what the person's own press does: it follows the sharing rules, reaches peers through
// the shared index, and offers the person the same Undo line ("Claude created "door.js" · Undo").
//
// DELETE GOES TO "Deleted", the Explorer's bin (owner correction, 22 Nov): `deleteItemsToBin` /
// `deleteFolderToBin`, the ONE delete path a person's card, marquee or drop-on-the-bin takes
// (Explorer.svelte deleteSelection / dropOnDeleted). `restore` brings it back
// (`restoreDeletedItem` / `restoreDeletedFolder`). Emptying Deleted is never an agent action.
// The scout read `explorer.deleteItem` as THE delete: that function is the DESTROYER the bin itself
// calls only when the person has switched the recycle bin off (sharedLibrary binOneItem), and the
// one Version history's own "Delete version" uses. With the bin off the assistant's delete would be
// for good, so it asks on the person's screen first (personAsk.js); a folder with files in it asks too.
//
// THE TEN SAFETY RULES (scout report row 7a), where each lives:
//   1 the person's own Explorer, in their tab only: explorerItems / explorerFolders, never the disk, a URL,
//     a mounted project volume or another peer's library      → visibleRows()
//   2 text kinds + folders only (txt json md cfg js); binary stays with assets {upload} → textOnly()
//   3 caps: 256 KB a file, 20 writes a minute, 200 made per session, list 100 a page, read 64 KB → filesCore
//   4 nothing runs: a .js write attaches to nothing, and a .js a Script node runs is refused
//     (edit_behaviour / the Code tab change running code)       → boundRefusal()
//   5 delete → Deleted; a folder with files asks; the bin off asks   → deleteEntry()
//   6 a viewer may list and read, never change                 → codeFiles.refusal()
//   7 new files are private: never created in (or moved into) a shared folder; no share action
//   8 a file or folder somebody else shared is read-only       → foreign()
//   9 headless agents do not get the tool (tpAgent: connector only; getAiTools {person})
//  10 file text is data: every read says so (DATA_NOTE)

import { get } from 'svelte/store';
import { explorerItems, explorerFolders, itemBlob, itemById, loadExplorer, updateItemBytes } from '../explorer';
import { recycleBinEnabled, deletedLog, isFolderRow, folderRowId, canRestoreDeleted, restoreDeletedItem, restoreDeletedFolder, buildDeletedTree } from '../sharedLibrary';
import { createCodeFile, createCodeFolder, renameCodeEntry, moveCodeEntry, deleteCodeEntry, deleteCounts, refusal } from '../codeFiles';
import { nodesBoundTo } from '../scriptAssets';
import { codeTabs } from '../codeWorkspace';
import { isDirty } from '../codeTabs';
import { offerUndo } from '../undoToast';
import { showToast } from '../../stores/appStore';
import { askPerson } from './personAsk.js';
import {
	MAX_FILE_BYTES,
	MAX_AGENT_FILES,
	LIST_PAGE,
	WRITE_ACTIONS,
	DATA_NOTE,
	isTextName,
	extOf,
	splitPath,
	findFolder,
	pathOfFolder,
	pathOfItem,
	resolveRef,
	readWindow,
	spliceLines,
	byteLength,
	createRateLimit
} from './filesCore.js';

const writes = createRateLimit();
/** files the assistant made in this page's life (rule 3) */
let made = 0;

/** @param {string} msg @param {any} [extra] */
const fail = (msg, extra) => ({ error: msg, ...(extra ?? {}) });

/** the person's own Library rows (visible shelf only: hidden versions and mounted volumes are not files here) */
function visibleRows() {
	return { folders: /** @type {any[]} */ (get(explorerFolders)), items: /** @type {any[]} */ (get(explorerItems)) };
}

/** someone else shared it (rule 8) @param {any} row */
const foreign = (row) => row?.share === 'peer';
/** it is in the session's shared index (rule 7) @param {any} row */
const sharedRow = (row) => row?.share === 'mine' || row?.share === 'peer';

/** @param {any} item @param {any[]} folders */
function fileRow(item, folders) {
	return {
		type: 'file',
		name: item.name,
		path: pathOfItem(item, folders),
		id: item.id,
		kind: item.kind,
		size: item.size,
		...(isTextName(item.name) ? {} : { text: false }),
		...(sharedRow(item) ? { shared: true } : {}),
		...(foreign(item) ? { readOnly: 'shared by someone else' } : {})
	};
}

/** @param {any} f @param {any[]} folders */
function folderRow(f, folders) {
	return {
		type: 'folder',
		name: f.name,
		path: pathOfFolder(f.id, folders) + '/',
		id: f.id,
		...(sharedRow(f) ? { shared: true } : {}),
		...(foreign(f) ? { readOnly: 'shared by someone else' } : {})
	};
}

/** why a folder may not take a new or moved file (rules 7, 8), or null @param {string | null} id @param {any[]} folders */
function sharedFolderRefusal(id, folders) {
	for (let at = id, i = 0; at && i < 64; i++) {
		const f = folders.find((x) => x.id === at);
		if (!f) break;
		if (sharedRow(f))
			return '"' + f.name + '" is shared with the session, and sharing a file stays the person\'s own choice: put it in one of their own folders (or the Library root) and they can move it in.';
		at = f.parentId ?? null;
	}
	return null;
}

/** a .js a Script node runs: changing it would change running code (rule 4) @param {any} item */
function boundRefusal(item) {
	if (extOf(item.name) !== 'js') return null;
	const bound = nodesBoundTo(item.hash ?? '');
	if (!bound.length) return null;
	return (
		'"' + item.name + '" runs in ' + bound.length + ' Script node' + (bound.length === 1 ? '' : 's') +
		', so files cannot change it (nothing written with files ever runs). Change running code with edit_behaviour, or open it for the person with show {action: "code"} so they edit it.'
	);
}

/** the open Code tab with unsaved edits on this file, if any @param {any} item */
function dirtyTab(item) {
	return /** @type {any[]} */ (get(codeTabs)).find((t) => t.kind === 'file' && t.itemId === item.id && isDirty(t)) ?? null;
}

/** a path that names nothing, in words @param {any} r @param {string} what */
function notFound(r, what) {
	if (r.missing?.length) return 'no folder "' + r.missing.join('/') + '" in the Library (files {action: "list"} shows what is there)';
	return 'no ' + what + ' "' + (r.name ?? '') + '" in the Library (files {action: "list"} shows what is there)';
}

/** @param {any} args */
function listAction(args) {
	const { folders, items } = visibleRows();
	if (args.deleted === true) return listDeleted(args);
	let at = /** @type {string | null} */ (null);
	if (args.path || args.id) {
		const r = resolveRef({ path: args.path ? String(args.path).replace(/\/*$/, '/') : undefined, id: args.id }, folders, items);
		if (r.type !== 'folder') return fail(r.type === 'file' ? '"' + String(args.path ?? args.id) + '" is a file: read it with files {action: "read"}' : notFound(r, 'folder'));
		at = r.id;
	}
	/** @type {Set<string | null>} */
	const scope = new Set([at]);
	if (args.recursive === true) for (const f of folders) if (isUnder(f.id, at, folders)) scope.add(f.id);
	const subFolders = folders.filter((f) => (args.recursive === true ? scope.has(f.parentId ?? null) : (f.parentId ?? null) === at)).sort(byName);
	const files = items.filter((i) => scope.has(i.folderId ?? null) && (args.textOnly !== true || isTextName(i.name))).sort(byName);
	const all = [...subFolders.map((f) => folderRow(f, folders)), ...files.map((i) => fileRow(i, folders))];
	const pages = Math.max(1, Math.ceil(all.length / LIST_PAGE));
	const page = Math.max(1, Math.min(pages, Math.floor(Number(args.page) || 1)));
	return {
		folder: at ? pathOfFolder(at, folders) + '/' : '/',
		entries: all.slice((page - 1) * LIST_PAGE, page * LIST_PAGE),
		total: all.length,
		page,
		pages,
		...(page < pages ? { next: { action: 'list', path: at ? pathOfFolder(at, folders) + '/' : '/', page: page + 1 } } : {}),
		note: 'Only text files (txt, json, md, cfg, js) can be read and written here; images, sounds and models are listed for reference (assets handles those).'
	};
}

/** @param {string} id @param {string | null} root @param {any[]} folders */
function isUnder(id, root, folders) {
	if (root === null) return true;
	for (let at = /** @type {string | null} */ (id), i = 0; at && i < 64; i++) {
		const f = folders.find((x) => x.id === at);
		if (!f) return false;
		if (f.parentId === root) return true;
		at = f.parentId ?? null;
	}
	return false;
}

/** @param {any} a @param {any} b */
const byName = (a, b) => String(a.name).localeCompare(String(b.name));

/** what Deleted holds that can come back @param {any} args */
function listDeleted(args) {
	const rows = restorableRows();
	const all = rows.map((r) => ({
		type: isFolderRow(r) ? 'folder' : 'file',
		name: r.name,
		was: [...(r.path ?? []), r.name].join('/') + (isFolderRow(r) ? '/' : ''),
		id: isFolderRow(r) ? folderRowId(r) : r.id ?? r.hash,
		deletedAt: r.at,
		...(r.by?.name ? { by: r.by.name } : {})
	}));
	const pages = Math.max(1, Math.ceil(all.length / LIST_PAGE));
	const page = Math.max(1, Math.min(pages, Math.floor(Number(args.page) || 1)));
	return {
		deleted: all.slice((page - 1) * LIST_PAGE, page * LIST_PAGE),
		total: all.length,
		page,
		pages,
		note: 'These are in the Explorer\'s Deleted bin; files {action: "restore", id} puts one back where it was. Emptying Deleted stays the person\'s own choice.'
	};
}

/** @param {any} args */
async function readAction(args) {
	const { folders, items } = visibleRows();
	const r = resolveRef(args, folders, items);
	if (r.type === 'folder') return fail('that is a folder: list it with files {action: "list", path: "' + (r.id ? pathOfFolder(r.id, folders) : '') + '/"}');
	if (r.type !== 'file') return fail(notFound(r, 'file'));
	const item = r.item;
	if (!isTextName(item.name)) return fail('"' + item.name + '" is not a text file (txt, json, md, cfg, js): files reads text only');
	const blob = await itemBlob(item.id);
	if (!blob) return fail('the bytes of "' + item.name + '" are not on this device yet (a shared file still arriving): try again in a moment');
	const text = await blob.text();
	const win = readWindow(text, { from: args.from, lines: args.lines });
	return {
		path: pathOfItem(item, folders),
		id: item.id,
		lines: { from: win.from, to: win.to, total: win.total },
		text: win.text,
		...(win.next ? { more: { action: 'read', id: item.id, from: win.next } } : {}),
		...(foreign(item) ? { readOnly: 'shared by someone else' } : {}),
		note: DATA_NOTE + ' Lines are numbered "N| " (the numbers are not in the file).'
	};
}

/** @param {string} by */
function gateWrite(by) {
	const no = refusal();
	if (no) return fail(no, { refused: true, role: 'viewer' });
	const wait = writes.check();
	if (wait) return fail('too many file changes at once (20 a minute): wait ' + wait + ' s, then go on', { retryAfter: wait });
	void by;
	return null;
}

/** @param {any} args @param {string} by */
async function createAction(args, by) {
	const { folders, items } = visibleRows();
	const { folders: names, name, dir } = splitPath(String(args.path ?? ''));
	const wantFolder = dir || args.folder === true;
	const leaf = dir ? names[names.length - 1] : name;
	const parentNames = dir ? names.slice(0, -1) : names;
	if (!leaf) return fail('path: the name to create, e.g. "Scripts/door.js" or "Notes/" for a folder');
	// parents: an existing path, or folders made on the way (each one counts as a write)
	let parent = parentNames.length ? findFolder(parentNames, folders) : null;
	/** @type {string[]} */
	const madeFolders = [];
	if (parent === undefined) {
		parent = null;
		for (const n of parentNames) {
			const here = folders.find((f) => (f.parentId ?? null) === parent && f.name.toLowerCase() === n.toLowerCase());
			if (here) {
				parent = here.id;
				continue;
			}
			const shared = sharedFolderRefusal(parent ?? null, get(explorerFolders));
			if (shared) return fail(shared);
			const out = createCodeFolder({ name: n, parentId: parent, quiet: true, by });
			if (!out.ok || !out.folder) return fail(out.reason ?? 'could not make the folder "' + n + '"');
			writes.note();
			madeFolders.push(n);
			parent = out.folder.id;
		}
	}
	const shared = sharedFolderRefusal(parent ?? null, get(explorerFolders));
	if (shared) return fail(shared);
	if (wantFolder) {
		const out = createCodeFolder({ name: leaf, parentId: parent ?? null, quiet: true, by });
		if (!out.ok || !out.folder) return fail(out.reason ?? 'could not make the folder');
		writes.note();
		return { created: 'folder', path: pathOfFolder(out.folder.id, get(explorerFolders)) + '/', id: out.folder.id, ...(madeFolders.length ? { madeFolders } : {}) };
	}
	if (!isTextName(leaf)) return fail('files makes text files only (.txt .json .md .cfg .js): give the name one of those extensions. Images, sounds and models go in with assets.');
	if (made >= MAX_AGENT_FILES) return fail('this tab has made ' + MAX_AGENT_FILES + ' files for the assistant already: ask the person before making more (reload resets the count)');
	const text = typeof args.text === 'string' ? args.text : undefined;
	if (text !== undefined && byteLength(text) > MAX_FILE_BYTES) return fail('text: at most 256 KB per file');
	void items;
	const out = await createCodeFile({ name: leaf, folderId: parent ?? null, open: false, quiet: true, ...(text !== undefined ? { text } : {}), by });
	if (!out.ok || !out.item) return fail(out.reason ?? 'could not make "' + leaf + '"');
	writes.note();
	made++;
	const item = out.item;
	return {
		created: 'file',
		path: pathOfItem(item, get(explorerFolders)),
		id: item.id,
		bytes: item.size,
		...(text === undefined ? { template: true, note: 'Made from the ' + (extOf(leaf) === 'js' ? 'behaviour script' : extOf(leaf)) + ' template: pass text to write your own.' } : {}),
		...(madeFolders.length ? { madeFolders } : {}),
		shared: sharedRow(itemById(item.id))
	};
}

/** @param {any} args @param {string} by */
async function writeAction(args, by) {
	const { folders, items } = visibleRows();
	const r = resolveRef(args, folders, items);
	if (r.type === 'folder') return fail('that is a folder: write a file in it, e.g. "' + pathOfFolder(r.id, folders) + '/notes.md" with files {action: "create"}');
	if (r.type !== 'file') return fail(notFound(r, 'file') + ' (to make a new file use files {action: "create"})');
	const item = r.item;
	if (!isTextName(item.name)) return fail('"' + item.name + '" is not a text file: files writes text only');
	if (foreign(item)) return fail('"' + item.name + '" was shared by someone else: only they change it. Make your own copy with files {action: "create"}.', { refused: true });
	const bound = boundRefusal(item);
	if (bound) return fail(bound, { refused: true });
	const tab = dirtyTab(item);
	if (tab) return fail('the person has unsaved edits to "' + item.name + '" open in the Code tab: ask them to save or discard first', { refused: true });
	if (typeof args.text !== 'string') return fail('text: the new text (the whole file, or the lines given in lines: [from, to])');
	const blob = await itemBlob(item.id);
	const old = blob ? await blob.text() : '';
	let next = args.text;
	if (Array.isArray(args.lines)) {
		const out = spliceLines(old, args.text, /** @type {[number, number]} */ (args.lines));
		if ('error' in out) return fail(out.error);
		next = out.text;
	}
	if (byteLength(next) > MAX_FILE_BYTES) return fail('the file would be over 256 KB, the most files writes');
	if (next === old) return { written: false, path: pathOfItem(item, folders), id: item.id, note: 'the text was already that: nothing changed' };
	await updateItemBytes(item.id, next);
	writes.note();
	const at = item.id;
	offerUndo({
		id: 'files-write',
		text: by + ' changed "' + item.name + '"',
		undo: async () => {
			const now = itemById(at);
			if (!now) return false;
			await updateItemBytes(at, old);
			return true;
		}
	});
	return { written: true, path: pathOfItem(item, folders), id: item.id, bytes: byteLength(next), lines: next.split('\n').length };
}

/** @param {any} args @param {string} by */
function renameAction(args, by) {
	const { folders, items } = visibleRows();
	const r = resolveRef(args, folders, items);
	const to = String(args.to ?? args.name ?? '').trim();
	if (!to) return fail('to: the new name (just the name; use files {action: "move"} to change the folder)');
	if (to.includes('/')) return fail('to: a name without "/" — use files {action: "move"} to change the folder');
	if (r.type === 'none' || (r.type === 'folder' && r.id === null)) return fail(r.type === 'none' ? notFound(r, 'file or folder') : 'the Library root has no name to change');
	if (r.type === 'file') {
		const item = r.item;
		if (foreign(item)) return fail('"' + item.name + '" was shared by someone else: only they rename it', { refused: true });
		if (!isTextName(item.name)) return fail('"' + item.name + '" is not a text file: files renames text files and folders only (the person renames the rest in the Explorer)');
		const out = renameCodeEntry({ kind: 'file', id: item.id, name: to }, { quiet: true, by });
		if (!out.ok) return fail(out.reason ?? 'could not rename');
		writes.note();
		const now = itemById(item.id);
		return { renamed: 'file', from: item.name, path: now ? pathOfItem(now, get(explorerFolders)) : to, id: item.id };
	}
	const folder = folders.find((f) => f.id === r.id);
	if (foreign(folder)) return fail('"' + folder.name + '" was shared by someone else: only they rename it', { refused: true });
	const out = renameCodeEntry({ kind: 'folder', id: String(r.id), name: to }, { quiet: true, by });
	if (!out.ok) return fail(out.reason ?? 'could not rename');
	writes.note();
	return { renamed: 'folder', from: folder?.name, path: pathOfFolder(String(r.id), get(explorerFolders)) + '/', id: r.id };
}

/** @param {any} args @param {string} by */
function moveAction(args, by) {
	const { folders, items } = visibleRows();
	const r = resolveRef(args, folders, items);
	if (r.type === 'none' || (r.type === 'folder' && r.id === null)) return fail(r.type === 'none' ? notFound(r, 'file or folder') : 'the Library root cannot move');
	const toPath = String(args.to ?? '').trim();
	const dest = toPath === '' || toPath === '/' ? null : findFolder(splitPath(toPath.replace(/\/*$/, '/')).folders, folders);
	if (dest === undefined) return fail('to: no folder "' + toPath + '" (make it first with files {action: "create", path: "' + toPath.replace(/\/*$/, '/') + '"})');
	const shared = sharedFolderRefusal(dest, folders);
	if (shared) return fail(shared);
	const row = r.type === 'file' ? r.item : folders.find((f) => f.id === r.id);
	if (foreign(row)) return fail('"' + row.name + '" was shared by someone else: only they move it', { refused: true });
	if (r.type === 'file' && !isTextName(r.item.name)) return fail('"' + r.item.name + '" is not a text file: files moves text files and folders only');
	const out = moveCodeEntry({ kind: r.type, id: r.type === 'file' ? r.item.id : String(r.id), to: dest }, { quiet: true, by });
	if (!out.ok) return fail(out.reason ?? 'could not move');
	writes.note();
	const fresh = visibleRows();
	if (r.type === 'file') {
		const now = itemById(r.item.id);
		return { moved: 'file', path: now ? pathOfItem(now, fresh.folders) : r.item.name, id: r.item.id };
	}
	return { moved: 'folder', path: pathOfFolder(String(r.id), fresh.folders) + '/', id: r.id };
}

/** @param {any} args @param {string} by */
async function deleteAction(args, by) {
	const { folders, items } = visibleRows();
	const r = resolveRef(args, folders, items);
	if (r.type === 'none' || (r.type === 'folder' && r.id === null)) return fail(r.type === 'none' ? notFound(r, 'file or folder') : 'the Library root cannot be deleted');
	const kind = r.type;
	const id = kind === 'file' ? r.item.id : String(r.id);
	const row = kind === 'file' ? r.item : folders.find((f) => f.id === id);
	if (foreign(row)) return fail('"' + row.name + '" was shared by someone else: only they delete it', { refused: true });
	if (kind === 'file' && !isTextName(r.item.name)) return fail('"' + r.item.name + '" is not a text file: files deletes text files and folders only (the person deletes the rest in the Explorer)');
	if (kind === 'file') {
		const tab = dirtyTab(r.item);
		if (tab) return fail('the person has unsaved edits to "' + r.item.name + '" open in the Code tab: ask them to save or discard first', { refused: true });
	}
	const counts = kind === 'folder' ? deleteCounts({ kind: 'folder', id }) : { folders: 0, files: 1, hidden: 0 };
	const binOn = get(recycleBinEnabled);
	const name = String(row?.name ?? '');
	const run = () => {
		const out = deleteCodeEntry({ kind, id }, { quiet: true, by });
		if (!out.ok) return fail(out.reason ?? 'could not delete');
		writes.note();
		if (!binOn) showToast(by + ' deleted "' + name + '" for good (the recycle bin is off)');
		return {
			deleted: kind,
			name,
			...(kind === 'folder' ? { files: counts.files, folders: counts.folders } : {}),
			...(binOn
				? { in: 'Deleted', note: 'It is in the Explorer\'s Deleted bin: files {action: "restore", id: "' + id + '"} brings it back.' }
				: { gone: true, note: 'The person has the recycle bin switched off, so it is gone for good (they agreed).' })
		};
	};
	if (binOn && (kind === 'file' || counts.files === 0)) return run();
	// rule 5: a folder holding files, or a delete with no bin behind it, is the person's call
	const what = kind === 'folder' ? 'the folder "' + name + '" and the ' + counts.files + ' file' + (counts.files === 1 ? '' : 's') + ' in it' : '"' + name + '"';
	return askPerson('files', args, {
		summary: 'delete ' + what + (binOn ? ' (to Deleted)' : ' for good'),
		prompt: by + ' wants to delete ' + what + (binOn ? '. It goes to Deleted, where you can restore it.' : '. Your recycle bin is off, so this cannot be undone.'),
		choices: [
			{ label: 'Delete', value: 'delete' },
			{ label: 'Keep', value: 'keep', cancel: true }
		],
		apply: () => run()
	});
}

/**
 * What restore can bring back: a file whose bytes this device holds (canRestoreDeleted), and a deleted
 * FOLDER the bin's own tree shows as a real row. A folder row has no bytes, so canRestoreDeleted alone
 * reads every deleted folder as gone (found by the e2e: "the folder comes back").
 */
function restorableRows() {
	const log = deletedLog();
	const live = /** @type {any[]} */ (get(explorerFolders));
	const tree = buildDeletedTree(log, live);
	return log.filter((r) => {
		if (!isFolderRow(r)) return canRestoreDeleted(r.id ?? r.hash);
		const fid = String(folderRowId(r));
		return !!tree.nodes.get(fid)?.row && !live.some((f) => f.id === fid);
	});
}

/** @param {any} args @param {string} by */
function restoreAction(args, by) {
	const want = String(args.id ?? '').trim();
	const { folders: names, name } = splitPath(String(args.path ?? args.name ?? ''));
	const leaf = name || names[names.length - 1] || '';
	const restorable = restorableRows();
	const hits = want
		? restorable.filter((r) => (isFolderRow(r) ? folderRowId(r) === want : (r.id ?? r.hash) === want || r.hash === want))
		: restorable.filter((r) => String(r.name).toLowerCase() === leaf.toLowerCase());
	if (!hits.length) return fail('nothing called "' + (want || leaf) + '" can be restored from Deleted (files {action: "list", deleted: true} shows what can)');
	if (hits.length > 1 && !want) return fail('several deleted entries are called "' + leaf + '": pass the id from files {action: "list", deleted: true}', { ids: hits.slice(0, 10).map((r) => (isFolderRow(r) ? folderRowId(r) : r.id ?? r.hash)) });
	const row = hits[0];
	if (isFolderRow(row)) {
		const fid = String(folderRowId(row));
		const out = restoreDeletedFolder(fid);
		if (!out.folders && !out.files) return fail('could not restore "' + row.name + '"');
		writes.note();
		showToast(by + ' restored the folder "' + row.name + '"');
		return { restored: 'folder', name: row.name, path: pathOfFolder(fid, get(explorerFolders)) + '/', files: out.files };
	}
	const key = row.id ?? row.hash;
	if (!restoreDeletedItem(key)) return fail('could not restore "' + row.name + '"');
	writes.note();
	const now = itemById(row.id ?? '') ?? /** @type {any[]} */ (get(explorerItems)).find((i) => i.hash === row.hash);
	offerUndo({ id: 'files-restore', text: by + ' restored "' + row.name + '"', undo: () => (now ? deleteCodeEntry({ kind: 'file', id: now.id }, { quiet: true, undoing: true }).ok : false) });
	return { restored: 'file', name: row.name, path: now ? pathOfItem(now, get(explorerFolders)) : row.name, id: now?.id };
}

/**
 * The tool. `by` = how the person's lines name the assistant ("Claude", "The assistant").
 * @param {any} args @param {{by?: string}} [ctx]
 */
export async function filesTool(args, ctx = {}) {
	const a = args && typeof args === 'object' ? args : {};
	const action = String(a.action ?? '');
	const by = String(ctx.by || 'The assistant');
	await loadExplorer();
	if (WRITE_ACTIONS.includes(action) && a.confirmId === undefined) {
		const no = gateWrite(by);
		if (no) return no;
	} else if (WRITE_ACTIONS.includes(action)) {
		const no = refusal();
		if (no) return fail(no, { refused: true, role: 'viewer' });
	}
	switch (action) {
		case 'list':
			return listAction(a);
		case 'read':
			return readAction(a);
		case 'create':
			return createAction(a, by);
		case 'write':
			return writeAction(a, by);
		case 'rename':
			return renameAction(a, by);
		case 'move':
			return moveAction(a, by);
		case 'delete':
			return deleteAction(a, by);
		case 'restore':
			return restoreAction(a, by);
		default:
			return fail('action: one of list, read, create, write, rename, move, delete, restore');
	}
}

/** unit / e2e: reset the per-page counters */
/** @param {{used?: number}} [opts] used: writes already spent this minute (a slow runner cannot make 21 calls inside one) */
export function filesToolResetForTest(opts) {
	writes.reset();
	for (let i = 0; i < (opts?.used ?? 0); i++) writes.note();
	made = 0;
}
