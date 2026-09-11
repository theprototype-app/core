// 24-C1: the Explorer's IN-APP clipboard for files and folders. A web page cannot put a
// file on the system clipboard (the roadmap's not-doing list), so Copy / Cut / Paste
// between folders is a store: what was copied, whether it was a cut, and where from.
// Store-only leaf — the paste itself (duplicate or move) is the Explorer's business,
// which knows folders, mounts and the active view.
import { writable, get } from 'svelte/store';

/**
 * @typedef {{ id: string, kind: 'item' | 'folder', volumeId?: string }} ClipEntry
 * @typedef {{ entries: ClipEntry[], mode: 'copy' | 'cut', from: string | null }} Clip
 */

/** @type {import('svelte/store').Writable<Clip | null>} */
export const explorerClipboard = writable(null);

/** @param {ClipEntry[]} entries @param {'copy'|'cut'} mode @param {string | null} from */
export function setClipboard(entries, mode, from) {
	explorerClipboard.set(entries.length ? { entries: [...entries], mode, from } : null);
}

export function clearClipboard() {
	explorerClipboard.set(null);
}

/** Is this record waiting in a CUT (rendered dimmed until pasted)? @param {string} id */
export function isCutPending(id) {
	const clip = get(explorerClipboard);
	return !!clip && clip.mode === 'cut' && clip.entries.some((e) => e.id === id);
}

/** "Paste 3 files" / "Paste a folder" — the label the menu shows @param {Clip | null} clip */
export function clipboardLabel(clip) {
	if (!clip?.entries.length) return 'Paste';
	const files = clip.entries.filter((e) => e.kind === 'item').length;
	const folders = clip.entries.length - files;
	const parts = [];
	if (files) parts.push(files === 1 ? '1 file' : files + ' files');
	if (folders) parts.push(folders === 1 ? '1 folder' : folders + ' folders');
	return 'Paste ' + parts.join(' + ');
}
