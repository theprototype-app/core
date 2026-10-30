// 70 W1 — FILES AND FOLDERS FROM THE CODE TAB, the pure half (a LEAF: imports nothing, so the
// rules are testable with no store and no browser — the codeProject shape).
//
// The Code tab's Project tree shows the Explorer's OWN folders and text files (there is no second
// file model: codeFiles.js writes through explorer.js / sharedLibrary.js). This module holds what
// those verbs decide before they write:
//
//   templates   what a new file starts with — a script with the behaviour lifecycle stub, a
//               Markdown note, a JSON document
//   names       a file name is valid, gets its template's extension when it has none, and is
//               UNIQUE among the library's text files. Unique library-wide, not per folder: the
//               shared-typing document of a file tab is keyed by its NAME (sharedTextCore
//               `'f:' + name`), so two open `rules.js` in two folders would type into one buffer
//   moves       a folder never moves into itself or below itself; a move to where it already
//               is is not a move
//   the tree    folders nested by `parentId`, text files under their folder, both sorted by name

/** what the Code tab lists as a file: the Explorer's text kind (explorer.js EXTENSIONS.text) */
export const TEXT_EXTENSIONS = ['js', 'md', 'json', 'txt', 'cfg'];

/** the longest name the Code tab accepts (a name is also a shared-document key) */
export const MAX_NAME = 120;

/** @param {string} name the extension, lower case, without the dot ('' when none) */
export function extensionOf(name) {
	const m = /\.([^./\\]+)$/.exec(String(name ?? ''));
	// a dot-file (".env") has no extension: the whole name is the stem
	return m && m.index > 0 ? m[1].toLowerCase() : '';
}

/** is this name a file the Code tab lists @param {string} name */
export function isTextFileName(name) {
	return TEXT_EXTENSIONS.includes(extensionOf(name));
}

/** the name without its extension @param {string} name */
export function stemOf(name) {
	const n = String(name ?? '');
	const ext = extensionOf(n);
	return ext ? n.slice(0, -(ext.length + 1)) : n;
}

/** "door_switch.js" -> "Door switch": what a behaviour calls itself @param {string} name */
function titleOf(name) {
	const words = stemOf(name)
		.replace(/[-_]+/g, ' ')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.trim();
	return words ? words[0].toUpperCase() + words.slice(1) : 'My behaviour';
}

/** a string safe inside a single-quoted JS literal @param {string} s */
const jsQuote = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * @typedef {{key: 'script' | 'note' | 'json', label: string, ext: string, defaultName: string,
 *   icon: string, tooltip: string, body: (name: string) => string}} FileTemplate
 */

/** @type {FileTemplate[]} */
export const FILE_TEMPLATES = [
	{
		key: 'script',
		label: 'Script (.js)',
		ext: 'js',
		defaultName: 'script.js',
		icon: 'file-code',
		tooltip: 'A behaviour with the lifecycle handlers stubbed out — bind it to a Behaviour node',
		body: (name) =>
			`// ${name} — a behaviour: game logic that runs ONCE, on the authority peer; \`state\` reaches everyone.
// Bind it to a Behaviour node to run it. Handlers you do not need can go.
export default behaviour({
	name: '${jsQuote(titleOf(name))}',
	params: {},
	state: {},
	on: {
		// once per session, on the authority
		start() {},
		// on EVERY peer when the behaviour (re)starts there: per-device setup, read state only
		load() {},
		// a round begins, is won, is lost
		roundStart() {},
		won() {},
		lost() {}
	}
});
`
	},
	{
		key: 'note',
		label: 'Note (.md)',
		ext: 'md',
		defaultName: 'notes.md',
		icon: 'file-text',
		tooltip: 'A Markdown note — plain text everyone in the session can edit together',
		body: (name) => `# ${stemOf(name) || 'Notes'}\n\n`
	},
	{
		key: 'json',
		label: 'JSON (.json)',
		ext: 'json',
		defaultName: 'data.json',
		icon: 'braces',
		tooltip: 'A JSON document — settings or data a script can read',
		body: () => '{\n\t\n}\n'
	}
];

/** @param {string} key @returns {FileTemplate} the template (the script one for an unknown key) */
export function templateOf(key) {
	return FILE_TEMPLATES.find((t) => t.key === key) ?? FILE_TEMPLATES[0];
}

/** the text a new file of this template starts with @param {string} key @param {string} name */
export function templateText(key, name) {
	return templateOf(key).body(String(name ?? ''));
}

/**
 * Why a typed name cannot be used, or null when it can. The Explorer's own rule (no `* \ /`,
 * not blank — explorer.isValidName) plus what makes a name a usable file name HERE: a file
 * keeps a text extension (call it on the name `fileNameFor` produced).
 * @param {string} name @param {'file' | 'folder'} [what]
 * @returns {string | null}
 */
export function nameProblem(name, what = 'file') {
	const n = String(name ?? '').trim();
	if (!n) return 'A name cannot be empty';
	if (/[*\\/]/.test(n)) return 'A name cannot contain * \\ or /';
	if (n === '.' || n === '..') return 'That name is reserved';
	if (n.length > MAX_NAME) return 'A name can be at most ' + MAX_NAME + ' characters';
	// the Code tab lists text files only: a rename to "notes.png" would make the file vanish
	// from the very tree it was renamed in (it is still in the Explorer)
	if (what === 'file' && !isTextFileName(n)) return 'The Code tab keeps .' + TEXT_EXTENSIONS.join(' .') + ' files — end the name with one';
	return null;
}

/**
 * The name a new file takes: what was typed, trimmed, with the template's extension added
 * when it has none ("player" -> "player.js"; "notes.txt" stays).
 * @param {string} typed @param {string} templateKey
 */
export function fileNameFor(typed, templateKey) {
	const n = String(typed ?? '').trim();
	const t = templateOf(templateKey);
	if (!n) return t.defaultName;
	return extensionOf(n) ? n : n + '.' + t.ext;
}

/**
 * What a file rename makes: a typed name with no extension keeps the file's own (the field
 * selects only the stem, so typing over it is the common case — "boss" on enemy.js is boss.js).
 * @param {string} typed @param {string} oldName
 */
export function renamedFileName(typed, oldName) {
	const n = String(typed ?? '').trim();
	const old = String(oldName ?? '');
	if (!n || extensionOf(n) || !extensionOf(old)) return n;
	return n + old.slice(old.lastIndexOf('.'));
}

/**
 * A free name: `name` when nobody has it, else "name 2", "name 3"… before the extension. Case
 * is ignored for the comparison (two files differing only in case confuse every reader).
 * @param {string} name @param {Iterable<string>} taken
 */
export function uniqueName(name, taken) {
	const have = new Set([...taken].map((s) => String(s).toLowerCase()));
	const n = String(name ?? '').trim();
	if (!have.has(n.toLowerCase())) return n;
	const ext = extensionOf(n);
	const stem = stemOf(n).replace(/ \d+$/, '');
	for (let i = 2; i < 10000; i++) {
		const candidate = stem + ' ' + i + (ext ? '.' + ext : '');
		if (!have.has(candidate.toLowerCase())) return candidate;
	}
	return stem + ' ' + Date.now() + (ext ? '.' + ext : '');
}

/**
 * Is `name` taken by ANOTHER text file (a rename keeps its own name free)?
 * @param {string} name @param {{id: string, name: string}[]} items the library's visible items
 * @param {string} [selfId] the item being renamed
 * @returns {{id: string, name: string} | null} the holder
 */
export function nameTakenBy(name, items, selfId) {
	const n = String(name ?? '').trim().toLowerCase();
	return items.find((i) => i.id !== selfId && isTextFileName(i.name) && i.name.toLowerCase() === n) ?? null;
}

/**
 * Is `name` taken by another folder under the same parent (folders are places — a duplicate
 * name in one parent is two places nobody can tell apart)?
 * @param {string} name @param {string | null} parentId
 * @param {{id: string, name: string, parentId: string | null}[]} folders @param {string} [selfId]
 */
export function folderNameTaken(name, parentId, folders, selfId) {
	const n = String(name ?? '').trim().toLowerCase();
	return folders.some((f) => f.id !== selfId && (f.parentId ?? null) === (parentId ?? null) && f.name.toLowerCase() === n);
}

/**
 * Every folder id at or below `id`. BOUNDED like every other walk over the index: a corrupted
 * parent chain must not hang the caller.
 * @param {string} id @param {{id: string, parentId: string | null}[]} folders
 */
export function subtreeOf(id, folders) {
	const out = [id];
	for (let i = 0; i < out.length && out.length < 10000; i++) for (const f of folders) if (f.parentId === out[i] && !out.includes(f.id)) out.push(f.id);
	return out;
}

/**
 * Can this entry move into `target` (a folder id, null = the library root)? Returns the reason
 * when it cannot, null when it can.
 * @param {{kind: 'file' | 'folder', id: string, parentId: string | null}} entry
 * @param {string | null} target
 * @param {{id: string, parentId: string | null}[]} folders
 * @returns {string | null}
 */
export function moveProblem(entry, target, folders) {
	const to = target ?? null;
	if (to && !folders.some((f) => f.id === to)) return 'That folder is gone';
	if ((entry.parentId ?? null) === to) return 'It is already there';
	if (entry.kind === 'folder' && to && subtreeOf(entry.id, folders).includes(to)) return 'A folder cannot move into itself';
	return null;
}

/**
 * THE FILES GROUP of the Project tree: the Explorer's folders, nested, with the text files under
 * the folder they live in. Leaves carry the `request` openCode takes and the `f:<itemId>` key
 * `keyOfTab` computes; folders are `dir:<id>` (never `grp:` — a graph's group key is `grp:<id>`).
 * A file whose folder is not in the list (a stale `folderId`) lands at the root rather than
 * vanishing.
 * @param {{
 *   folders?: {id: string, name: string, parentId: string | null}[],
 *   files?: {id: string, name: string, hash?: string, folderId?: string | null}[],
 *   detailOf?: (file: any) => string | undefined
 * }} input
 * @returns {any[]} ProjectNode[] (codeProject's shape)
 */
export function filesTree(input) {
	const folders = input.folders ?? [];
	const files = (input.files ?? []).filter((f) => isTextFileName(f.name));
	const known = new Set(folders.map((f) => f.id));
	const byName = (/** @type {{name: string}} */ a, /** @type {{name: string}} */ b) => a.name.localeCompare(b.name);
	/** @param {string | null} parentId @param {number} depth @returns {any[]} */
	const level = (parentId, depth) => {
		if (depth > 64) return [];
		const dirs = folders
			.filter((f) => (f.parentId && known.has(f.parentId) ? f.parentId : null) === parentId && f.id !== parentId)
			.sort(byName)
			.map((f) => ({ key: 'dir:' + f.id, label: f.name, icon: 'folder', folderId: f.id, parentId, children: level(f.id, depth + 1) }));
		const leaves = files
			.filter((f) => (f.folderId && known.has(f.folderId) ? f.folderId : null) === parentId)
			.sort(byName)
			.map((f) => {
				const detail = input.detailOf?.(f);
				return {
					key: 'f:' + f.id,
					label: f.name,
					...(detail ? { detail } : {}),
					icon: extensionOf(f.name) === 'js' ? 'file-code' : extensionOf(f.name) === 'json' ? 'braces' : 'file-text',
					itemId: f.id,
					parentId,
					request: { source: extensionOf(f.name) === 'js' ? 'script' : 'text', ref: { itemId: f.id } }
				};
			});
		return [...dirs, ...leaves];
	};
	return level(null, 0);
}
