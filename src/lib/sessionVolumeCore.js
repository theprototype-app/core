// Roadmap 56 C13 — THE SESSION VOLUME, its pure half (imports nothing).
//
// A guest who joins a session sees the host's files as a read-only root, "<HOST>'s session", above
// their own Library — never mixed into it. The host decides how much it shows (the SHARE SCOPE), sends
// the rows (names, kinds, sizes, folders; thumbnails ride after) and answers byte pulls only for the
// rows it sent. Everything here is a rule over plain data, so it is unit-tested with no browser:
//
//   · volumeProjection — which of the host's files a scope shows, with the folder chain each needs;
//   · the bandwidth rule — a pull above ~50 MB asks first;
//   · the "When several libraries are open" setting and the Save project dialog's model.

/** The host's share scope. 'scene' is the DEFAULT: never the whole library by default (roadmap 69). */
export const SHARE_SCOPES = /** @type {const} */ (['scene', 'project', 'library', 'none']);
export const DEFAULT_SHARE_SCOPE = 'scene';
export const SHARE_SCOPE_LABELS = {
	scene: "Current scene's files",
	project: 'Project',
	library: 'Whole library',
	none: 'None'
};

/** @param {unknown} v @returns {'scene'|'project'|'library'|'none'} */
export function normalizeShareScope(v) {
	return /** @type {any} */ (SHARE_SCOPES).includes(v) ? /** @type {any} */ (v) : DEFAULT_SHARE_SCOPE;
}

/** Above this, an Open or a Copy asks "Download 72 MB from <HOST>?" first. */
export const BIG_PULL_BYTES = 50 * 1024 * 1024;

/** @param {number} bytes */
export function needsPullConfirm(bytes) {
	return Number(bytes) > BIG_PULL_BYTES;
}

/** "72 MB", "840 KB", "12 bytes" — the sizes every row shows. @param {number} bytes */
export function formatBytes(bytes) {
	const n = Math.max(0, Number(bytes) || 0);
	if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1).replace(/\.0$/, '') + ' MB';
	if (n >= 1024) return Math.round(n / 1024) + ' KB';
	return n + (n === 1 ? ' byte' : ' bytes');
}

/** The confirm's question. @param {number} bytes @param {string} host */
export function pullQuestion(bytes, host) {
	return 'Download ' + formatBytes(bytes) + ' from ' + host + '?';
}

/**
 * The volume's id, and so its `vol:` namespace key, for one host peer. A peer id is
 * `[A-Za-z0-9_-]`; anything else is dropped so the key can never carry a colon (the namespace's
 * separator — `mountedVolumes.volumeOf`).
 * @param {string} peerId
 */
export function sessionVolumeId(peerId) {
	return 'session-' + String(peerId ?? '').replace(/[^A-Za-z0-9_-]/g, '');
}

/** "AB12CD's session" @param {string} host */
export function sessionVolumeName(host) {
	return String(host || 'Host') + "'s session";
}

/**
 * WHAT THE HOST SHOWS. Pure over the host's library rows and the scope's facts.
 *
 *   scene   — the open scene's own file and every hash the scene references (sceneHashes);
 *   project — scene ∪ every project scene file ∪ every file the session already shares (projectHashes);
 *   library — every visible Library file and every folder;
 *   none    — nothing.
 *
 * A file is shown in its own folder; for scene / project only the folders on the chain from a
 * shown file to the root travel (a folder nobody offered stays unnamed — the shared index's
 * placement rule). A hash two records hold is shown once per record: they are two files.
 *
 * @param {{
 *   scope: string,
 *   folders: {id: string, name: string, parentId?: string | null}[],
 *   items: {id: string, name: string, kind: string, folderId?: string | null, hash: string, size?: number}[],
 *   sceneHashes?: Iterable<string>,
 *   projectHashes?: Iterable<string>
 * }} input
 * @returns {{folders: {id: string, name: string, parentId: string | null}[],
 *   items: {id: string, name: string, kind: string, folderId: string | null, hash: string, size: number}[]}}
 */
export function volumeProjection(input) {
	const scope = normalizeShareScope(input?.scope);
	const allFolders = Array.isArray(input?.folders) ? input.folders : [];
	const allItems = Array.isArray(input?.items) ? input.items : [];
	if (scope === 'none') return { folders: [], items: [] };
	/** @type {Set<string> | null} null = every file */
	let wanted = null;
	if (scope !== 'library') {
		wanted = new Set([...(input?.sceneHashes ?? [])].map(String).filter(Boolean));
		if (scope === 'project') for (const h of input?.projectHashes ?? []) if (h) wanted.add(String(h));
	}
	const items = allItems
		.filter((i) => i && i.hash && (!wanted || wanted.has(i.hash)))
		.map((i) => ({
			id: String(i.id),
			name: String(i.name ?? 'file'),
			kind: String(i.kind ?? 'text'),
			folderId: i.folderId ?? null,
			hash: String(i.hash),
			size: Math.max(0, Number(i.size) || 0)
		}));
	const byId = new Map(allFolders.map((f) => [f.id, f]));
	/** @type {Set<string>} */
	const keep = new Set();
	if (scope === 'library') for (const f of allFolders) keep.add(f.id);
	else
		for (const item of items) {
			let at = item.folderId;
			// bounded: a corrupt tree must not hang the projection
			for (let n = 0; at && n < 64 && !keep.has(at); n++) {
				if (!byId.has(at)) break;
				keep.add(at);
				at = byId.get(at)?.parentId ?? null;
			}
		}
	const folders = allFolders
		.filter((f) => keep.has(f.id))
		.map((f) => ({
			id: String(f.id),
			name: String(f.name ?? 'Folder'),
			// a parent outside the projection roots the folder (never names a folder nobody offered)
			parentId: f.parentId && keep.has(f.parentId) ? String(f.parentId) : null
		}));
	// a file whose folder did not travel lands at the volume's root
	for (const item of items) if (item.folderId && !keep.has(item.folderId)) item.folderId = null;
	return { folders, items };
}

/** Does a projection carry this hash? (the host's check before it answers a pull) @param {{items: {hash: string}[]}} proj @param {string} hash */
export function projectionHas(proj, hash) {
	return !!hash && (proj?.items ?? []).some((i) => i.hash === hash);
}

/** Total bytes of some rows (a Copy selection's confirm). @param {{size?: number}[]} rows */
export function totalBytes(rows) {
	return (rows ?? []).reduce((n, r) => n + Math.max(0, Number(r?.size) || 0), 0);
}

// ---- 6: Save project with several libraries open (addendum 2026-10-28f) -------------------------

/** Settings ▸ Save options ▸ "When several libraries are open". 'ask' is the default. */
export const SAVE_MANY_OPTIONS = /** @type {const} */ (['ask', 'active', 'all']);
export const SAVE_MANY_LABELS = { ask: 'Ask', active: 'Save the active one', all: 'Save all I can' };
export const SAVE_MANY_KEY = 'saveManyLibraries';

/** @param {unknown} v @returns {'ask'|'active'|'all'} */
export function normalizeSaveMany(v) {
	return /** @type {any} */ (SAVE_MANY_OPTIONS).includes(v) ? /** @type {any} */ (v) : 'ask';
}

/**
 * @typedef {{id: string, kind: 'library'|'session'|'mount', name: string, active: boolean,
 *   canSave: boolean, reason?: string}} OpenLibrary
 * @typedef {OpenLibrary & {where: string, checked: boolean, disabled: boolean}} SaveRow
 */

/** Where a library saves to, in the dialog's words. @param {OpenLibrary} lib */
export function saveWhere(lib) {
	if (lib.kind === 'session') return 'Save on host';
	if (lib.kind === 'mount') return 'Mounted project';
	return 'This device';
}

/**
 * THE DIALOG'S ROWS: every open library, the ACTIVE one pre-checked (if it can be saved), those
 * this person cannot save disabled with the reason.
 * @param {OpenLibrary[]} libs @returns {SaveRow[]}
 */
export function saveDialogRows(libs) {
	return (libs ?? []).map((lib) => ({
		...lib,
		where: saveWhere(lib),
		disabled: !lib.canSave,
		checked: !!lib.active && !!lib.canSave
	}));
}

/**
 * What a Save project press (or Ctrl+S) does. One library = save it, no dialog. Several = the
 * setting decides: 'ask' opens the dialog, 'active' saves the active one (if it can be saved),
 * 'all' saves every one that can be.
 * @param {string} setting @param {OpenLibrary[]} libs
 * @returns {{dialog: boolean, save: string[]}}
 */
export function resolveSaveMany(setting, libs) {
	const list = libs ?? [];
	if (list.length <= 1) return { dialog: false, save: list.filter((l) => l.canSave).map((l) => l.id) };
	const mode = normalizeSaveMany(setting);
	if (mode === 'ask') return { dialog: true, save: [] };
	if (mode === 'all') return { dialog: false, save: list.filter((l) => l.canSave).map((l) => l.id) };
	const active = list.find((l) => l.active && l.canSave);
	return { dialog: false, save: active ? [active.id] : [] };
}

/**
 * A peer's folder rows as a tree the Explorer can walk: one row per id, and every parent chain ends
 * (a row in a loop or one too deep goes to the root).
 * @template {{id: string, parentId: string | null}} F
 * @param {F[]} rows @returns {F[]}
 */
export function safeFolderTree(rows) {
	const byId = new Map();
	for (const f of rows) if (!byId.has(f.id)) byId.set(f.id, f);
	return [...byId.values()].map((f) => {
		const seen = new Set([f.id]);
		let at = f.parentId;
		for (let depth = 0; at != null; depth++) {
			if (seen.has(at) || depth >= 64) return { ...f, parentId: null };
			seen.add(at);
			at = byId.get(at)?.parentId ?? null;
		}
		return f;
	});
}
