// loose-scenes fix — IMPORTING SOMETHING YOU ALREADY HAVE.
//
// An Explorer item's identity IS its content hash, so bytes already in the library are,
// by construction, the same file. Until now that fact was applied SILENTLY: one import
// path deduped and said nothing (a re-import looked like a dead button) while the other
// did not dedupe at all and minted a second item sharing one hash — quietly breaking the
// one-item-per-hash invariant that travel-by-hash, the .tp export and every assetShare
// pull stand on.
//
// This module is the decision layer. Three answers, one setting (Settings ▸ Files ▸
// "When importing files already in your library"):
//   ask   — the modal, per file, with a select-all and a Reveal
//   skip  — keep what you have, and SAY how many were left out
//   copy  — bring them in beside the originals
//
// THE COPY RULE IS NOT SYMMETRIC, and that is deliberate. Two items may never share a
// hash, so for most kinds "a copy" cannot exist — identical bytes ARE one file, and the
// honest answer is to say so rather than to offer a button that cannot work. A SCENE is
// the exception: a .tpscene embeds its own uuid and createdAt, which is exactly why two
// saves of an untouched scene hash apart (see sceneSignature), so rewriting those two
// fields yields genuinely different bytes, a new hash, and a scene with a history of its
// own. The copy is RENAMED too: the payload's `name` is the manifest key, so a copy that
// kept it would share the original's version history and defeat the whole point.
//
// Import discipline: a LEAF. Stores + explorer + fflate, nothing else — it REGISTERS
// itself into explorer's resolver seam rather than being imported by it, because
// explorer.js is the module every one of its consumers sits above.
import { writable, get } from 'svelte/store';
import { explorerItems, hiddenItems, registerDuplicateResolver } from './explorer';
import { showToast } from '../stores/appStore';

export const DUPLICATE_MODES = ['ask', 'skip', 'copy'];
const STORAGE_KEY = 'importDuplicateMode';

function readMode() {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored && DUPLICATE_MODES.includes(stored)) return stored;
	} catch {}
	return 'ask';
}

/** 'ask' | 'skip' | 'copy' — LOCAL, like every other Files rule.
 * @type {import('svelte/store').Writable<string>} */
export const duplicateImportMode = writable(readMode());
duplicateImportMode.subscribe((mode) => {
	try {
		localStorage.setItem(STORAGE_KEY, String(mode));
	} catch {}
});

/** @param {string} mode */
export function setDuplicateImportMode(mode) {
	if (DUPLICATE_MODES.includes(mode)) duplicateImportMode.set(mode);
}

/**
 * The open modal, or null: `{rows, group, resolve}`. Rows carry everything a card
 * shows — the incoming name, the item already held, whether a copy is even possible.
 * @type {import('svelte/store').Writable<any>}
 */
export const duplicateImportDialog = writable(null);

/** Settle the modal. @param {any} answer `{action, hashes}`, or null for cancel */
export function resolveDuplicateImport(answer) {
	duplicateImportDialog.update((current) => {
		if (current?.resolve) current.resolve(answer ?? null);
		return null;
	});
}

/**
 * A SCENE COPY: the same bundle with a fresh identity. Rewriting session.json in place
 * beats re-exporting, because an export reads the LIVE scene and this file may be one
 * the user has never opened — the copy has to be of the FILE, not of the world.
 * @param {ArrayBuffer} buffer @param {string} name the copy's scene name
 * @returns {Promise<ArrayBuffer | null>} null when it is not a readable .tpscene
 */
export async function sceneCopyBytes(buffer, name) {
	try {
		const { unzipSync, zipSync, strToU8, strFromU8 } = await import('fflate');
		const entries = unzipSync(new Uint8Array(buffer));
		const sessionBytes = entries['session.json'];
		if (!sessionBytes) return null;
		const payload = JSON.parse(strFromU8(sessionBytes));
		if (!payload || typeof payload !== 'object') return null;
		payload.id = crypto.randomUUID();
		payload.createdAt = Date.now();
		if (name) payload.name = name;
		entries['session.json'] = strToU8(JSON.stringify(payload));
		const out = zipSync(entries);
		return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
	} catch {
		return null;
	}
}

/** Is this row something a real copy can be made of? @param {any} row */
export function canCopy(row) {
	return row?.kind === 'scene' || /\.tpscene$/i.test(String(row?.name ?? ''));
}

/**
 * "Arena" already taken becomes "Arena (copy)", then "Arena (copy 2)". Checked against
 * BOTH shelves AND the names minted earlier in this same batch, so dropping one file
 * three times gives three distinct names rather than three collisions.
 * @param {string} fileName @param {Set<string>} taken @returns {string}
 */
export function copyName(fileName, taken) {
	const base = String(fileName ?? 'Scene').replace(/\.tpscene$/i, '');
	const held = new Set([
		...get(explorerItems).map((/** @type {any} */ i) => String(i.name).toLowerCase()),
		...get(hiddenItems).map((/** @type {any} */ i) => String(i.name).toLowerCase()),
		...[...taken].map((n) => n.toLowerCase())
	]);
	for (let n = 1; n < 500; n++) {
		const candidate = base + ' (copy' + (n === 1 ? '' : ' ' + n) + ').tpscene';
		if (!held.has(candidate.toLowerCase())) return candidate;
	}
	return base + ' (copy ' + Date.now() + ').tpscene';
}

/**
 * THE RESOLVER explorer.js calls. Given the duplicates an import found, decide what
 * happens and hand back the extra files to write.
 * @param {any[]} dupes each `{name, kind, hash, buffer, existing}`
 * @param {{group?: string}} [context] a label for the modal's message
 * @returns {Promise<{copies: {name: string, buffer: ArrayBuffer, from: string}[]}>}
 */
export async function resolveDuplicates(dupes, context = {}) {
	const rows = (dupes ?? []).filter(Boolean);
	if (!rows.length) return { copies: [] };
	const mode = get(duplicateImportMode);
	/** @type {any[]} */
	let chosen = [];
	if (mode === 'skip') {
		showToast(
			'Skipped ' +
				rows.length +
				' file' +
				(rows.length === 1 ? '' : 's') +
				' already in your library'
		);
		return { copies: [] };
	}
	if (mode === 'copy') {
		chosen = rows.filter(canCopy);
		const stuck = rows.length - chosen.length;
		if (stuck)
			showToast(
				stuck +
					' file' +
					(stuck === 1 ? ' was' : 's were') +
					' already in your library — identical files of that kind are the same file, so nothing was added'
			);
	} else {
		/** @type {any} */
		const answer = await new Promise((resolve) => {
			duplicateImportDialog.update((previous) => {
				// a second request replaces the first — a dangling promise is worse than a
				// cancelled one (showConfirm's rule, one module over)
				if (previous?.resolve) previous.resolve(null);
				return { rows, group: context.group ?? '', resolve };
			});
		});
		// cancel / Esc / outside-close = skip, and say nothing: the user just declined
		if (!answer || answer.action !== 'copy') return { copies: [] };
		const wanted = new Set(answer.hashes ?? []);
		chosen = rows.filter((row) => wanted.has(row.hash) && canCopy(row));
	}
	// each copy carries the hash it came FROM, so a caller with per-row context (the
	// .tp import knows which folder each row belonged in) can put it back in the right
	// place rather than dropping every copy at the root
	/** @type {{name: string, buffer: ArrayBuffer, from: string}[]} */
	const copies = [];
	/** @type {Set<string>} */
	const taken = new Set();
	for (const row of chosen) {
		const name = copyName(row.name, taken);
		const bytes = await sceneCopyBytes(row.buffer, name.replace(/\.tpscene$/i, ''));
		if (!bytes) continue;
		taken.add(name);
		copies.push({ name, buffer: bytes, from: row.hash });
	}
	if (copies.length)
		showToast('Imported ' + copies.length + ' cop' + (copies.length === 1 ? 'y' : 'ies'));
	return { copies };
}

// The seam is wired at module eval — importing this module is what turns the whole
// feature on, which is why App.svelte imports it and explorer.js does not.
registerDuplicateResolver(resolveDuplicates);
