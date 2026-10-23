// 50 Y1/Y2 — SHARED TEXT, the part that is plain arithmetic (a LEAF: imports nothing).
//
// An open code or text tab is a BUFFER (codeTabs.js); since roadmap 50 the buffer of a
// shareable tab is a Yjs document every peer with that source open edits together. The
// source itself (a Script node's `data.code`, an Explorer file's bytes) is unchanged: it is
// plain text, written only by Ctrl+S, replicated exactly as before. The Y.Doc is SESSION
// state — it lives while somebody has the tab open and is never saved.
//
// What is easy to get subtly wrong lives here, testable with no Yjs, no store and no peer:
//   - IDENTITY: which document a tab means on EVERY peer (`sharedDocKey`). A node is its id;
//     a file is its NAME, because a save re-hashes it and an Explorer item id is per-device —
//     the name is what `followOne` already uses to follow "the same file one save behind".
//   - THE SEED: a document nobody holds yet starts from the source text through a client id
//     derived from (key, text). Two peers opening the same source at the same moment write
//     the SAME struct (same client, same clock, same content) and Yjs keeps one copy — while
//     a different text gets a different client, so nothing is ever claimed twice.
//   - THE ONE WRITER of a change that arrives through the SOURCE rather than the buffer (an
//     undo of the node, an older peer's save): every peer sees it, so if every peer pushed
//     it into the shared buffer it would land N times. The lowest peer id holding the
//     document writes it; the rest receive it.

/** 32-bit FNV-1a of a string, as 8 hex digits @param {string} text */
export function fnv1a(text) {
	let h = 0x811c9dc5;
	const s = String(text ?? '');
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/**
 * The Yjs client id a seed is written under: a pure function of the document and the text
 * it starts from. Never 0 (Yjs reserves nothing there, but a falsy id reads as "unset" in
 * too many places), and inside Yjs's uint32 range.
 * @param {string} key @param {string} text
 */
export function seedClientId(key, text) {
	const n = parseInt(fnv1a(String(key) + '\u0000' + String(text ?? '')), 16) >>> 0;
	return n || 1;
}

/**
 * Which shared document a code tab edits, the same string on every peer — or null when the
 * tab is not shared: a module's source and a module-bound node are read-only for everyone,
 * and a graph's JSON is a view of a document that already replicates node by node.
 * @param {{kind?: string, nodeId?: string, graphId?: string, name?: string, title?: string, readOnly?: boolean} | null | undefined} tab
 * @returns {string | null}
 */
export function sharedDocKey(tab) {
	if (!tab || tab.readOnly) return null;
	if ((tab.kind === 'node' || tab.kind === 'behaviour') && tab.nodeId) return 'n:' + (tab.graphId || 'scene') + ':' + tab.nodeId;
	if (tab.kind === 'file') {
		const name = String(tab.name ?? tab.title ?? '').trim();
		return name ? 'f:' + name : null;
	}
	return null;
}

/** a key the wire will carry: a short printable string @param {unknown} key */
export function isDocKey(key) {
	return typeof key === 'string' && key.length > 2 && key.length <= 512 && /^[nf]:/.test(key);
}

/**
 * The smallest single replace turning `from` into `to`: a common prefix and suffix are kept,
 * so a cursor outside the changed span does not move and a concurrent edit elsewhere
 * survives. @param {string} from @param {string} to
 * @returns {{index: number, remove: number, insert: string} | null} null when equal
 */
export function minimalEdit(from, to) {
	const a = String(from ?? '');
	const b = String(to ?? '');
	if (a === b) return null;
	let start = 0;
	const max = Math.min(a.length, b.length);
	while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
		endA--;
		endB--;
	}
	return { index: start, remove: endA - start, insert: b.slice(start, endB) };
}

/**
 * Keys typed before the shared document was ready: `base` is what the editor opened with,
 * `local` what it holds now, `shared` what the room's document says. Returns the edit to make
 * in `shared` so the typing survives (null = nothing typed). An edit beside the room's own
 * change is moved past it; one overlapping it keeps the room's text and lands just after it
 * — both people keep what they typed, the same promise the live buffer makes.
 * @param {string} base @param {string} local @param {string} shared
 * @returns {{index: number, remove: number, insert: string} | null}
 */
export function rebaseEdit(base, local, shared) {
	const mine = minimalEdit(base, local);
	if (!mine) return null;
	const b = String(base ?? '');
	const s = String(shared ?? '');
	const theirs = minimalEdit(b, s);
	if (!theirs) return mine;
	const end = theirs.index + theirs.remove;
	if (mine.index >= end) return { ...mine, index: mine.index + theirs.insert.length - theirs.remove };
	if (mine.index + mine.remove <= theirs.index) return mine;
	return { index: theirs.index + theirs.insert.length, remove: 0, insert: mine.insert };
}

/**
 * Does THIS peer write a change that arrived through the source? The lowest id among the
 * peers holding the document (us included) — every peer computes it from the same roster.
 * @param {Iterable<string>} holders @param {string} me
 */
export function isExternalWriter(holders, me) {
	let low = me;
	for (const id of holders) if (id && (!low || id < low)) low = id;
	return !!me && low === me;
}

/** 1-based line of a character offset @param {string} text @param {number} index */
export function lineAt(text, index) {
	const s = String(text ?? '');
	const n = Math.max(0, Math.min(s.length, Math.floor(index) || 0));
	let line = 1;
	for (let i = 0; i < n; i++) if (s.charCodeAt(i) === 10) line++;
	return line;
}

/**
 * The words a screen reader hears for one person in a shared document (the presence strip's
 * label; the coloured caret in the editor is decoration).
 * @param {{name?: string, line?: number | null, selected?: number}} p
 */
export function presenceLabel(p) {
	const who = String(p.name || 'A peer');
	if (!p.line) return who + ' has this file open';
	return who + ' is on line ' + p.line + (p.selected ? ', ' + p.selected + ' character' + (p.selected === 1 ? '' : 's') + ' selected' : '');
}

/**
 * A light, see-through version of a peer colour for their selection highlight. Accepts the
 * `hsl(h, s%, l%)` shape `peerColor` produces; anything else is returned as is.
 * @param {string} color @param {number} [alpha]
 */
export function selectionTint(color, alpha = 0.3) {
	const m = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/.exec(String(color ?? ''));
	return m ? `hsla(${m[1]}, ${m[2]}%, ${m[3]}%, ${alpha})` : String(color ?? '');
}
