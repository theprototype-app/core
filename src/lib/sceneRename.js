// ROADMAP 22 R5 — SCENE RENAME, THE PURE HALF. Imports NOTHING, so it is testable with no
// browser (the transferLedger/hudArrange/explorerView shape) and reachable from
// projectManifest (a leaf) and levels alike.
//
// THE PROBLEM A RENAME HAS THAT NOTHING ELSE IN THE MANIFEST HAS. The document is
// `scenes: {name -> {history}}`, whole-document latest-wins with a UNION merge whose
// wipe protection carries "a scene only one side knows about" WHOLE. A plain key move
// (delete `Arena`, add `Forge`) is therefore undone by the next document from any peer
// that still holds `Arena`: the union reads it as a scene we lack and puts it back, and
// the project now has the same history under two names. So a rename is RECORDED —
// `manifest.renames = {from: {to, at}}` — and the merge FOLDS a scene arriving under a
// renamed key into its new name. Omitted when empty, like every other section, so a
// project that never renamed anything serializes byte-identically.
//
// THE DATA HAZARD, and why this file exists at all: a Travel node stores the scene it
// goes to by NAME (`sceneName`, resolved at fire time) or by frozen HASH plus a display
// `levelName`, and those live in saved graphs inside `.tpscene` files on disk. Rewriting
// every file on every peer would mint a new version of every scene that references the
// renamed one, so the answer is two-fold: `rewriteTravelNodes` patches the LIVE graphs
// (each peer applies it to its own — deterministic, so nothing is sent), and
// `resolveSceneName` follows the record at FIRE time for a graph that arrived from disk
// untouched. Either half alone leaves a dead node somewhere; the suite breaks each.
//
// A fresh scene may LEGITIMATELY reuse a renamed-away name (rename Arena → Forge, later
// save a brand-new Arena). The fold tells the two apart by LINEAGE: a scene whose history
// shares a hash with the renamed line is that line, seen from a peer that had not heard;
// one that shares none is new, keeps its name, and SPENDS the record (the self-pruning
// tombstone rule, one section over).

/** @typedef {{to: string, at: number}} SceneRenameRecord */
/** @typedef {Record<string, SceneRenameRecord>} SceneRenames from -> {to, at} */

/** the longest chain a resolve will follow (a cycle is a corrupt document, not a walk) */
export const RENAME_CHAIN_LIMIT = 32;

/**
 * ONE normalize at every boundary: a record needs a non-empty `to` different from its
 * key and a positive stamp; anything else is dropped rather than kept as a permanent
 * redirect nobody can lift.
 * @param {any} raw @returns {SceneRenames}
 */
export function normalizeSceneRenames(raw) {
	/** @type {SceneRenames} */
	const out = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const [key, rec] of Object.entries(raw)) {
		const from = String(key ?? '').trim();
		const to = String(/** @type {any} */ (rec)?.to ?? '').trim();
		const at = Number(/** @type {any} */ (rec)?.at);
		if (!from || !to || from === to || !Number.isFinite(at) || at <= 0) continue;
		out[from] = { to, at };
	}
	return out;
}

/**
 * Where a name points NOW: follows `renames` transitively (Arena → Forge → Vault answers
 * Vault for Arena). A name with no record answers itself; a cycle stops at the limit and
 * answers the last name reached, so a corrupt document degrades to a wrong name rather
 * than a hang.
 * @param {string} name @param {SceneRenames | undefined | null} renames @returns {string}
 */
export function resolveSceneName(name, renames) {
	let here = String(name ?? '').trim();
	if (!here || !renames) return here;
	const seen = new Set([here]);
	for (let i = 0; i < RENAME_CHAIN_LIMIT; i++) {
		const next = renames[here]?.to;
		if (!next || seen.has(next)) return here;
		seen.add(next);
		here = next;
	}
	return here;
}

/**
 * Record one rename. Renaming ONTO a name that was itself renamed away lifts that
 * record: the name is live again, and a redirect from it would send a fresh scene
 * elsewhere. The returned map is a new object; the input is untouched.
 * @param {SceneRenames | undefined | null} renames @param {string} from @param {string} to
 * @param {number} at @returns {SceneRenames}
 */
export function recordSceneRename(renames, from, to, at) {
	const out = normalizeSceneRenames(renames);
	const a = String(from ?? '').trim();
	const b = String(to ?? '').trim();
	if (!a || !b || a === b) return out;
	delete out[b];
	out[a] = { to: b, at: Number(at) || 1 };
	return out;
}

/**
 * Do two histories belong to one line? A shared hash is the evidence: a save mints a
 * fresh hash every time (uuid + createdAt inside the file), so two scenes that share
 * even one are the same scene seen from two places.
 * @param {{history: string[]}} a @param {{history: string[]}} b
 */
function sameLineage(a, b) {
	const set = new Set(a?.history ?? []);
	return (b?.history ?? []).some((h) => set.has(h));
}

/**
 * The default fold: the target's line stays as it is and the folded side's NOVEL hashes
 * are spliced in before the pointer (the adoptSceneVersions precedent) — pinned and
 * labels unioned. The caller may supply the manifest's own richer merge instead.
 * @param {any} target @param {any} folded @returns {any}
 */
export function foldSceneEntries(target, folded) {
	const have = new Set(target.history);
	const novel = (folded.history ?? []).filter((/** @type {string} */ h) => !have.has(h));
	const head = [...target.history];
	const pointer = head.pop();
	const history = pointer === undefined ? [...novel] : [...head, ...novel, pointer];
	const pinned = [...new Set([...(target.pinned ?? []), ...(folded.pinned ?? [])])].filter((h) =>
		history.includes(h)
	);
	/** @type {any} */
	const out = { ...folded, ...target, history, pinned };
	const labels = { ...(folded.labels ?? {}), ...(target.labels ?? {}) };
	if (Object.keys(labels).length) out.labels = labels;
	else delete out.labels;
	return out;
}

/**
 * THE MERGE'S RENAME PASS. Every scene sitting under a key the records say was renamed
 * is moved to where the name points now:
 *   · the target exists and shares lineage  → folded into it (`merge(target, moved)`)
 *   · the target does not exist              → moved whole (a peer that only ever heard
 *                                              the old name)
 *   · the target exists and shares NOTHING   → a NEW scene reusing the old name: it
 *                                              stays, and its record is SPENT
 * Afterwards a record whose `from` is still a live key is dropped (spent), so the map
 * never redirects a living scene. Pure: new objects out, nothing in mutated.
 * @param {Record<string, any>} scenes @param {SceneRenames | undefined | null} renames
 * @param {(target: any, folded: any) => any} [merge] defaults to `foldSceneEntries`
 * @returns {{scenes: Record<string, any>, renames: SceneRenames}}
 */
export function foldRenamedScenes(scenes, renames, merge = foldSceneEntries) {
	const recs = normalizeSceneRenames(renames);
	/** @type {Record<string, any>} */
	const out = { ...(scenes ?? {}) };
	if (!Object.keys(recs).length) return { scenes: out, renames: recs };
	// oldest record first, so a chain folds in the order it was made
	const order = Object.keys(recs)
		.filter((from) => from in out)
		.sort((a, b) => recs[a].at - recs[b].at || a.localeCompare(b));
	for (const from of order) {
		const to = resolveSceneName(from, recs);
		if (to === from) continue;
		const moved = out[from];
		const target = out[to];
		if (!target) {
			out[to] = moved;
			delete out[from];
		} else if (sameLineage(target, moved)) {
			out[to] = merge(target, moved);
			delete out[from];
		} else {
			// a fresh scene under a name that used to be somebody else's: keep it, and the
			// record that would keep redirecting it is spent
			delete recs[from];
		}
	}
	for (const from of Object.keys(recs)) if (from in out) delete recs[from];
	return { scenes: out, renames: recs };
}

/**
 * THE LIVE-GRAPH REWRITE. Returns a patch per Travel node that refers to the renamed
 * scene — by NAME (`sceneName === from`) or by a frozen HASH of its line (`level` in
 * `hashes`, whose display `levelName` follows). A node already pointing at `to` needs
 * nothing, so applying the result twice is a no-op, which is what lets every peer run
 * it on every manifest change rather than exactly once.
 * @param {any[]} nodes every node, each carrying its runtime `__graph` tag (allNodes())
 * @param {string} from @param {string} to
 * @param {Iterable<string>} [hashes] the renamed scene's history, for hash-mode nodes
 * @returns {{id: string, graphId: string, data: Record<string, string>}[]}
 */
export function rewriteTravelNodes(nodes, from, to, hashes) {
	const a = String(from ?? '').trim();
	const b = String(to ?? '').trim();
	/** @type {{id: string, graphId: string, data: Record<string, string>}[]} */
	const out = [];
	if (!a || !b || a === b) return out;
	const line = new Set(hashes ?? []);
	for (const node of nodes ?? []) {
		const data = node?.data;
		if (!node?.id || !data || String(data.type ?? node.type ?? '') !== 'travel') continue;
		const graphId = String(node.__graph ?? 'scene');
		if (String(data.sceneName ?? '') === a) {
			out.push({ id: String(node.id), graphId, data: { sceneName: b } });
			continue;
		}
		const hash = String(data.level ?? '');
		if (hash && line.has(hash) && String(data.levelName ?? '') !== b)
			out.push({ id: String(node.id), graphId, data: { levelName: b } });
	}
	return out;
}
