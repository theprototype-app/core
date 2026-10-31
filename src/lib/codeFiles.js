// 70 W1 — FILES AND FOLDERS FROM THE CODE TAB: the verbs. New file (from a template), New folder,
// rename, move, delete — on the Explorer's OWN records, through the Explorer's own writers
// (explorer.js, and sharedLibrary.js for delete/restore). There is no second file model, so what
// the Code tab makes IS an Explorer file: it shows in the Explorer, follows the Explorer's sharing
// rules (shareNewFiles, folder inheritance) and reaches peers through the shared index exactly as
// a file made in the Explorer does. The rules (templates, names, moves) are codeFilesCore.js.
//
// ROLES: the Explorer's — a viewer (a roles plugin's read-only peer) changes nothing here; every
// verb refuses with the reason (`refusal()`), and the sidebar shows its controls disabled with it.
//
// UNDO, ONE PER ACTION, and NOT the scene history. A library edit never enters the scene's undo
// stack (Explorer.svelte 21-I3: Ctrl+Z belongs to the viewport), so each verb here offers its own
// Undo — the toast (undoToast.js, 37 R25) and Ctrl+Z in the Code tab's Project tree, which pops
// this module's small stack. The reverse runs through the same replicated writers, so an undo
// reaches every peer the action reached: undo New = to the bin (its tombstone hides the peers'
// copies), undo Delete = restore from the bin, undo rename / move = rename / move back.
//
// Not a leaf (explorer, sharedLibrary, codeWorkspace); nothing in history's subtree reaches it.

import { get, writable } from 'svelte/store';
import {
	explorerItems,
	explorerFolders,
	addItemFromBytes,
	createFolder,
	renameFolder,
	renameItem,
	moveFolder,
	moveItem,
	itemById,
	loadExplorer
} from './explorer';
import { deleteItemsToBin, deleteFolderToBin, restoreDeletedItem, restoreDeletedFolder, recycleBinEnabled } from './sharedLibrary';
import { isViewer } from './objectPermissions';
import { offerUndo, withdrawUndo } from './undoToast';
import { showToast } from '../stores/appStore';
import { codeTabs, openCode, closeCodeTab } from './codeWorkspace';
import { isDirty } from './codeTabs';
import {
	templateText,
	templateOf,
	fileNameFor,
	nameProblem,
	uniqueName,
	nameTakenBy,
	folderNameTaken,
	moveProblem,
	subtreeOf,
	isTextFileName,
	renamedFileName
} from './codeFilesCore.js';

/** why a viewer cannot change files, word for word what the sidebar shows */
export const VIEWER_REASON = 'View only — files can be changed by editors (ask the host for editor access)';

/** why nothing here can change, or null when it can @returns {string | null} */
export function refusal() {
	return isViewer() ? VIEWER_REASON : null;
}

/**
 * @typedef {{op: 'create', kind: 'file' | 'folder', id: string, name: string}
 *   | {op: 'rename', kind: 'file' | 'folder', id: string, from: string, to: string}
 *   | {op: 'move', kind: 'file' | 'folder', id: string, from: string | null, to: string | null, name: string}
 *   | {op: 'delete', kind: 'file' | 'folder', id: string, name: string}} FileOp
 */

/** the Code tab's own undo stack, newest last (LOCAL: an undo is this person's) @type {FileOp[]} */
let stack = [];
const STACK_MAX = 30;
/** the newest op's label for the tree's Ctrl+Z hint; null = nothing to undo */
export const lastFileOp = writable(/** @type {string | null} */ (null));
const debug = { done: 0, undone: 0, refused: 0, last: /** @type {FileOp | null} */ (null) };

/** @param {FileOp} op */
function describe(op) {
	const what = (op.kind === 'folder' ? 'folder ' : '') + '"' + ('name' in op ? op.name : op.to) + '"';
	if (op.op === 'create') return 'Created ' + what;
	if (op.op === 'rename') return 'Renamed "' + op.from + '" to "' + op.to + '"';
	if (op.op === 'move') return 'Moved ' + what + ' to ' + folderLabel(op.to);
	return 'Deleted ' + what;
}

/** @param {string | null} id */
function folderLabel(id) {
	if (!id) return 'the Library root';
	const f = get(explorerFolders).find((x) => x.id === id);
	return f ? '"' + f.name + '"' : 'a folder';
}

/** record a done op: onto the stack, and offered as the toast's Undo @param {FileOp} op */
function record(op) {
	stack = [...stack, op].slice(-STACK_MAX);
	debug.done++;
	debug.last = op;
	lastFileOp.set(describe(op));
	offerUndo({ id: 'codefiles', text: describe(op), undo: () => undoOp(op) });
}

/** @param {string} reason @param {boolean} [quiet] the caller shows the reason itself (an inline name field) */
function refuse(reason, quiet = false) {
	debug.refused++;
	if (!quiet) showToast(reason);
	return { ok: false, reason };
}

/** @param {string} name */
const takenReason = (name) => 'A file called "' + name + '" already exists — two files with one name would share one editor';

/** the library's text-file names, for the uniqueness rule */
const textItems = () => get(explorerItems).filter((i) => isTextFileName(i.name));

/** a folder id that still exists, else the root @param {string | null | undefined} id */
function liveFolder(id) {
	return id && get(explorerFolders).some((f) => f.id === id) ? id : null;
}

/**
 * New file from a template, in `folderId` (null = the Library root). An empty name takes the
 * template's default, numbered when taken; a typed name that is taken is REFUSED with the holder
 * named (a silent rename would leave the person looking for the name they typed). Opens in a
 * Code tab unless `open: false`.
 * @param {{template?: string, name?: string, folderId?: string | null, open?: boolean, quiet?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, reason?: string, item?: any, tabId?: string | null}>}
 */
export async function createCodeFile(opts = {}) {
	const q = !!opts.quiet;
	const no = refusal();
	if (no) return refuse(no, q);
	await loadExplorer();
	const tpl = templateOf(opts.template ?? 'script');
	const typed = String(opts.name ?? '').trim();
	const name = typed ? fileNameFor(typed, tpl.key) : uniqueName(tpl.defaultName, textItems().map((i) => i.name));
	const bad = nameProblem(name, 'file');
	if (bad) return refuse(bad, q);
	const holder = nameTakenBy(name, get(explorerItems));
	if (holder) return refuse(takenReason(holder.name), q);
	const folderId = liveFolder(opts.folderId);
	const bytes = /** @type {ArrayBuffer} */ (new TextEncoder().encode(templateText(tpl.key, name)).buffer);
	// a NEW record even when the bytes match one we hold (two empty JSON files are two files)
	const item = await addItemFromBytes(bytes, name, folderId, { allowDuplicate: true });
	if (!item) return refuse('Could not create "' + name + '"', q);
	record({ op: 'create', kind: 'file', id: item.id, name: item.name });
	const tabId = opts.open === false ? null : await openCode({ source: tpl.key === 'script' ? 'script' : 'text', ref: { itemId: item.id } });
	return { ok: true, item, tabId };
}

/**
 * New folder in `parentId` (null = the root). An empty name is "New folder", numbered.
 * @param {{name?: string, parentId?: string | null, quiet?: boolean}} [opts]
 * @returns {{ok: boolean, reason?: string, folder?: any}}
 */
export function createCodeFolder(opts = {}) {
	const q = !!opts.quiet;
	const no = refusal();
	if (no) return refuse(no, q);
	const parentId = liveFolder(opts.parentId);
	const typed = String(opts.name ?? '').trim();
	const siblings = get(explorerFolders).filter((f) => (f.parentId ?? null) === parentId).map((f) => f.name);
	const name = typed || uniqueName('New folder', siblings);
	const bad = nameProblem(name, 'folder');
	if (bad) return refuse(bad, q);
	if (folderNameTaken(name, parentId, get(explorerFolders))) return refuse('There is already a folder called "' + name + '" here', q);
	const folder = createFolder(name, parentId);
	if (!folder) return refuse('Could not create the folder "' + name + '"', q);
	record({ op: 'create', kind: 'folder', id: folder.id, name: folder.name });
	return { ok: true, folder };
}

/**
 * Rename a file or a folder. Open tabs follow (codeWorkspace.followNames).
 * @param {{kind: 'file' | 'folder', id: string, name: string}} opts
 * @param {{undoing?: boolean, quiet?: boolean}} [how]
 * @returns {{ok: boolean, reason?: string}}
 */
export function renameCodeEntry(opts, how = {}) {
	const q = !!how.quiet;
	const no = refusal();
	if (no) return refuse(no, q);
	let to = String(opts.name ?? '').trim();
	if (opts.kind === 'folder') {
		const folder = get(explorerFolders).find((f) => f.id === opts.id);
		if (!folder) return refuse('That folder is gone', q);
		if (to === folder.name) return { ok: true };
		const bad = nameProblem(to, 'folder');
		if (bad) return refuse(bad, q);
		if (folderNameTaken(to, folder.parentId ?? null, get(explorerFolders), folder.id)) return refuse('There is already a folder called "' + to + '" here', q);
		renameFolder(folder.id, to);
		if (!how.undoing) record({ op: 'rename', kind: 'folder', id: folder.id, from: folder.name, to });
		return { ok: true };
	}
	const item = get(explorerItems).find((i) => i.id === opts.id);
	if (!item) return refuse('That file is gone', q);
	to = renamedFileName(to, item.name);
	if (to === item.name) return { ok: true };
	const bad = nameProblem(to, 'file');
	if (bad) return refuse(bad, q);
	const holder = nameTakenBy(to, get(explorerItems), item.id);
	if (holder) return refuse(takenReason(holder.name), q);
	renameItem(item.id, to);
	if (!how.undoing) record({ op: 'rename', kind: 'file', id: item.id, from: item.name, to });
	return { ok: true };
}

/**
 * Move a file or a folder into `to` (a folder id, null = the root). Open tabs keep pointing at
 * the file: a tab is addressed by the item's id, which a move does not touch.
 * @param {{kind: 'file' | 'folder', id: string, to: string | null}} opts
 * @param {{undoing?: boolean}} [how]
 * @returns {{ok: boolean, reason?: string}}
 */
export function moveCodeEntry(opts, how = {}) {
	const no = refusal();
	if (no) return refuse(no);
	const folders = get(explorerFolders);
	const to = opts.to ?? null;
	if (opts.kind === 'folder') {
		const folder = folders.find((f) => f.id === opts.id);
		if (!folder) return refuse('That folder is gone');
		const bad = moveProblem({ kind: 'folder', id: folder.id, parentId: folder.parentId ?? null }, to, folders);
		if (bad) return refuse(bad);
		if (folderNameTaken(folder.name, to, folders, folder.id)) return refuse('There is already a folder called "' + folder.name + '" there');
		if (!moveFolder(folder.id, to)) return refuse('A folder cannot move into itself');
		if (!how.undoing) record({ op: 'move', kind: 'folder', id: folder.id, from: folder.parentId ?? null, to, name: folder.name });
		return { ok: true };
	}
	const item = get(explorerItems).find((i) => i.id === opts.id);
	if (!item) return refuse('That file is gone');
	const bad = moveProblem({ kind: 'file', id: item.id, parentId: item.folderId ?? null }, to, folders);
	if (bad) return refuse(bad);
	moveItem(item.id, to);
	if (!how.undoing) record({ op: 'move', kind: 'file', id: item.id, from: item.folderId ?? null, to, name: item.name });
	return { ok: true };
}

/**
 * What a delete would take, for the confirm: a file is itself; a folder is every folder below it
 * and EVERY file in them — the Explorer's own files too, not only the ones the Code tab lists.
 * @param {{kind: 'file' | 'folder', id: string}} entry
 * @returns {{folders: number, files: number, hidden: number}} `hidden` = files the Code tab does not list
 */
export function deleteCounts(entry) {
	if (entry.kind === 'file') return { folders: 0, files: 1, hidden: 0 };
	const ids = new Set(subtreeOf(entry.id, get(explorerFolders)));
	const inside = get(explorerItems).filter((i) => ids.has(i.folderId ?? ''));
	return { folders: ids.size, files: inside.length, hidden: inside.filter((i) => !isTextFileName(i.name)).length };
}

/** close the clean tabs of files that left the library (a dirty one stays: its text is unsaved
 * work, and its Save says the file is gone) @param {Set<string>} itemIds */
function closeTabsOf(itemIds) {
	for (const tab of get(codeTabs)) if (tab.kind === 'file' && tab.itemId && itemIds.has(tab.itemId) && !isDirty(tab)) closeCodeTab(tab.id, { keepOpen: true });
}

/**
 * Delete a file or a folder — to the bin, the Explorer's ONE delete path (it tells the peers and
 * Restore puts it back). With the recycle bin off the Explorer deletes for good; there is then
 * nothing to restore and no Undo is offered.
 * @param {{kind: 'file' | 'folder', id: string}} entry
 * @param {{undoing?: boolean}} [how]
 * @returns {{ok: boolean, reason?: string}}
 */
export function deleteCodeEntry(entry, how = {}) {
	const no = refusal();
	if (no) return refuse(no);
	const undoable = get(recycleBinEnabled);
	if (entry.kind === 'folder') {
		const folder = get(explorerFolders).find((f) => f.id === entry.id);
		if (!folder) return refuse('That folder is gone');
		const ids = new Set(subtreeOf(folder.id, get(explorerFolders)));
		const inside = new Set(get(explorerItems).filter((i) => ids.has(i.folderId ?? '')).map((i) => i.id));
		deleteFolderToBin(folder.id);
		closeTabsOf(inside);
		if (!how.undoing && undoable) record({ op: 'delete', kind: 'folder', id: folder.id, name: folder.name });
		return { ok: true };
	}
	const item = get(explorerItems).find((i) => i.id === entry.id);
	if (!item) return refuse('That file is gone');
	deleteItemsToBin([item.id]);
	closeTabsOf(new Set([item.id]));
	if (!how.undoing && undoable) record({ op: 'delete', kind: 'file', id: item.id, name: item.name });
	return { ok: true };
}

/**
 * Take one op back. Every branch is the replicated writer the forward action used (or its
 * mirror), so the undo reaches the same peers.
 * @param {FileOp} op @returns {boolean} false when it could not (said in a toast)
 */
function undoOp(op) {
	const no = refusal();
	if (no) {
		refuse(no);
		return false;
	}
	stack = stack.filter((o) => o !== op);
	lastFileOp.set(stack.length ? describe(stack[stack.length - 1]) : null);
	withdrawUndo('codefiles');
	let ok = false;
	if (op.op === 'create') {
		if (op.kind === 'folder') {
			const c = deleteCounts({ kind: 'folder', id: op.id });
			// files put in it since are the person's work: an undo of "New folder" must not bin them
			if (c.files) {
				refuse('"' + op.name + '" has files in it now — delete it instead');
				return false;
			}
			ok = deleteCodeEntry({ kind: 'folder', id: op.id }, { undoing: true }).ok;
		} else ok = deleteCodeEntry({ kind: 'file', id: op.id }, { undoing: true }).ok;
	} else if (op.op === 'rename') ok = renameCodeEntry({ kind: op.kind, id: op.id, name: op.from }, { undoing: true }).ok;
	else if (op.op === 'move') ok = moveCodeEntry({ kind: op.kind, id: op.id, to: liveFolder(op.from) }, { undoing: true }).ok;
	else if (op.kind === 'folder') ok = restoreDeletedFolder(op.id).folders > 0;
	else ok = restoreDeletedItem(op.id) || !!itemById(op.id);
	if (ok) debug.undone++;
	else showToast('Could not undo — ' + describe(op).toLowerCase());
	return ok;
}

/** Ctrl+Z in the Project tree: undo the newest file op. @returns {boolean} did anything happen */
export function undoLastFileOp() {
	const op = stack[stack.length - 1];
	if (!op) return false;
	const ok = undoOp(op);
	if (ok) showToast('Undone — ' + describe(op).replace(/^\w/, (c) => c.toLowerCase()));
	return ok;
}

/** the suites' view */
export function codeFilesDebug() {
	return { ...debug, stack: stack.map((o) => ({ ...o })) };
}
