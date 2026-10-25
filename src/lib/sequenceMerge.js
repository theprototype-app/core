// 77 — TWO PEERS EDIT ONE CUT AT ONCE AND BOTH EDITS SURVIVE. Pure, imports nothing.
//
// A sequence used to replicate whole-document latest-wins (48 S2), so a split on one machine and
// a title added on another inside the same moment converged on ONE of them. This is the merge
// that keeps both: every TRACK and every ITEM carries the stamp of its last change (`at`, the
// hudDocs "per-element stamp" that was declared for exactly this), deletions leave TOMBSTONES
// (`gone: {id: stamp}`), the sequence's own fields (name, length, fps, flags, markers) carry
// `metaAt` and the track ORDER `orderAt`. `mergeSequences` is a join — commutative, associative
// and idempotent — so peers converge whatever order the messages land in, and a receiver that
// ends up with something the sender lacked sends the merged document back once (content-
// idempotent, so it terminates: the manifest precedent).
//
//   resetAt    a LOAD is authoritative: everything older than the loading peer's reset stamp
//              is dropped on merge (a scene load into a live room must replace, not union)
//   stampedAt  the changedAt at which a merge-aware peer last stamped. An OLDER peer (≤ 1.43)
//              re-sends the whole document with a fresh changedAt and every stamp untouched, so
//              `stampedAt < changedAt` means "relayed through an old peer" — and that document
//              takes the old whole-document rule (latest wins), adopted into the stamps
//              locally so a later merge does not undo the old peer's edit
//
// A track of a kind we do not know (a newer peer's) merges WHOLE by its own stamp: its items are
// not ours to reason about. Stamps never reach a save (`stripStamps`), so a file — and the
// scene signature that decides "has this scene changed" — is unchanged by them.

const META_SKIP = new Set(['id', 'tracks', 'changedAt', 'at', 'metaAt', 'orderAt', 'gone', 'stampedAt', 'resetAt']);
const TRACK_SKIP = new Set(['items', 'at']);
const OPAQUE_KINDS = new Set(['camera', 'anim', 'audio', 'event', 'video', 'title', 'prop']);
/** tombstones kept per sequence (the newest win) */
const MAX_GONE = 400;

/** @param {any} v */
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** JSON of an object minus some keys, keys sorted (a stable content key) @param {any} o @param {Set<string>} skip */
function key(o, skip) {
	/** @type {Record<string, any>} */
	const out = {};
	for (const k of Object.keys(o ?? {}).sort()) if (!skip.has(k)) out[k] = o[k];
	return JSON.stringify(out);
}
const ITEM_SKIP = new Set(['at']);

/** Has this document been stamped by a merge-aware peer since its last change? @param {any} doc */
export function isStamped(doc) {
	return !!doc && n(doc.stampedAt) > 0 && n(doc.stampedAt) >= n(doc.changedAt);
}

/** @param {Record<string, number>} a @param {Record<string, number>} [b] */
function joinGone(a, b) {
	/** @type {Record<string, number>} */
	const out = { ...(a ?? {}) };
	for (const [id, s] of Object.entries(b ?? {})) if (!(n(out[id]) >= n(s))) out[id] = n(s);
	const ids = Object.keys(out);
	if (ids.length > MAX_GONE) {
		ids.sort((x, y) => out[y] - out[x] || (x < y ? -1 : 1));
		for (const id of ids.slice(MAX_GONE)) delete out[id];
	}
	return out;
}

/**
 * Stamp what changed between `before` and `after` with `stamp` — the single write path calls
 * this for every LOCAL write. `reset` stamps everything (a load) and raises `resetAt`.
 * @param {any} before @param {any} after @param {number} stamp @param {{reset?: boolean}} [opts]
 */
export function stampChanges(before, after, stamp, opts = {}) {
	if (!after) return after;
	const fresh = !before || opts.reset;
	const doc = { ...after };
	const prevTracks = new Map((fresh ? [] : before.tracks ?? []).map((/** @type {any} */ t) => [t.id, t]));
	/** @type {Record<string, number>} */
	let gone = joinGone(fresh ? {} : before.gone, fresh ? {} : after.gone);
	doc.metaAt = fresh || key(before, META_SKIP) !== key(after, META_SKIP) ? stamp : n(before.metaAt);
	const order = (/** @type {any} */ d) => (d.tracks ?? []).map((/** @type {any} */ t) => t.id).join(',');
	doc.orderAt = fresh || order(before) !== order(after) ? stamp : n(before.orderAt);
	const seen = new Set();
	doc.tracks = (after.tracks ?? []).map((/** @type {any} */ tr) => {
		seen.add(tr.id);
		const old = prevTracks.get(tr.id);
		const track = { ...tr, at: !old || key(old, TRACK_SKIP) !== key(tr, TRACK_SKIP) ? stamp : n(old.at) };
		if (!OPAQUE_KINDS.has(tr.kind)) {
			// a newer peer's kind: its items are one value, stamped with the track
			if (old && JSON.stringify(old.items) !== JSON.stringify(tr.items)) track.at = stamp;
			return track;
		}
		const prevItems = new Map((old?.items ?? []).map((/** @type {any} */ it) => [it.id, it]));
		const kept = new Set();
		track.items = (tr.items ?? []).map((/** @type {any} */ it) => {
			kept.add(it.id);
			const was = prevItems.get(it.id);
			return { ...it, at: !was || key(was, ITEM_SKIP) !== key(it, ITEM_SKIP) ? stamp : n(was.at) };
		});
		for (const id of prevItems.keys()) if (!kept.has(id)) gone[id] = stamp;
		return track;
	});
	for (const id of prevTracks.keys()) if (!seen.has(id)) gone[id] = stamp;
	gone = joinGone(gone);
	if (Object.keys(gone).length) doc.gone = gone;
	else delete doc.gone;
	if (opts.reset) doc.resetAt = stamp;
	else if (before?.resetAt) doc.resetAt = Math.max(n(before.resetAt), n(after.resetAt));
	doc.stampedAt = Math.max(stamp, n(after.changedAt));
	return doc;
}

/** the newer of two versions by stamp; a tie picks by content, so both peers pick the same one
 * @param {any} a @param {any} b @param {Set<string>} skip */
function newer(a, b, skip) {
	if (!a) return b;
	if (!b) return a;
	if (n(a.at) !== n(b.at)) return n(a.at) > n(b.at) ? a : b;
	return key(a, skip) >= key(b, skip) ? a : b;
}

/**
 * Join two versions of one sequence. Null-safe either side.
 * @param {any} mine @param {any} incoming
 * @returns {any}
 */
export function mergeSequences(mine, incoming) {
	if (!mine) return incoming;
	if (!incoming) return mine;
	// either side relayed by an older peer: the old rule, latest wins (ties to the incoming)
	if (!isStamped(mine) || !isStamped(incoming))
		return n(mine.changedAt) > n(incoming.changedAt) ? mine : incoming;
	const reset = Math.max(n(mine.resetAt), n(incoming.resetAt));
	const gone = joinGone(mine.gone, incoming.gone);
	const alive = (/** @type {any} */ x) => !!x && n(x.at) >= reset && !(n(gone[x.id]) >= n(x.at));
	// the sequence's own fields from the newer meta stamp
	const metaA = { ...mine, at: mine.metaAt };
	const metaB = { ...incoming, at: incoming.metaAt };
	const meta = newer(metaA, metaB, META_SKIP);
	/** @type {any} */
	const doc = {};
	for (const [k, v] of Object.entries(meta)) if (!META_SKIP.has(k)) doc[k] = v;
	doc.id = mine.id || incoming.id;
	if (!('markers' in meta)) delete doc.markers;
	const ta = new Map((mine.tracks ?? []).map((/** @type {any} */ t) => [t.id, t]));
	const tb = new Map((incoming.tracks ?? []).map((/** @type {any} */ t) => [t.id, t]));
	/** @type {Map<string, any>} */
	const tracks = new Map();
	for (const id of new Set([...ta.keys(), ...tb.keys()])) {
		const a = ta.get(id);
		const b = tb.get(id);
		const head = newer(a, b, TRACK_SKIP);
		// a track lives while its newest version beats its tombstone (an inner edit does not
		// resurrect a deleted track: deletion wins over a concurrent edit inside it)
		if (!alive({ id, at: Math.max(n(a?.at), n(b?.at)) })) continue;
		if (!OPAQUE_KINDS.has(head.kind)) {
			tracks.set(id, head);
			continue;
		}
		const ia = new Map((a?.items ?? []).map((/** @type {any} */ it) => [it.id, it]));
		const ib = new Map((b?.items ?? []).map((/** @type {any} */ it) => [it.id, it]));
		const items = [];
		for (const iid of new Set([...ia.keys(), ...ib.keys()])) {
			const it = newer(ia.get(iid), ib.get(iid), ITEM_SKIP);
			if (alive(it)) items.push(it);
		}
		items.sort((x, y) => x.t - y.t || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
		const track = { ...head, items };
		track.at = Math.max(n(a?.at), n(b?.at));
		tracks.set(id, track);
	}
	// order: the newer order stamp's list, then any track it does not name, by id
	const orderSrc = newer({ ...mine, at: mine.orderAt }, { ...incoming, at: incoming.orderAt }, META_SKIP);
	const ordered = [];
	for (const t of orderSrc.tracks ?? []) if (tracks.has(t.id)) ordered.push(tracks.get(t.id));
	const named = new Set(ordered.map((t) => t.id));
	for (const id of [...tracks.keys()].sort()) if (!named.has(id)) ordered.push(tracks.get(id));
	doc.tracks = ordered;
	doc.changedAt = Math.max(n(mine.changedAt), n(incoming.changedAt));
	doc.metaAt = Math.max(n(mine.metaAt), n(incoming.metaAt));
	doc.orderAt = Math.max(n(mine.orderAt), n(incoming.orderAt));
	if (Object.keys(gone).length) doc.gone = gone;
	if (reset) doc.resetAt = reset;
	doc.stampedAt = doc.changedAt;
	return doc;
}

/** Same CONTENT (stamps that only restate the same thing are ignored)? @param {any} a @param {any} b */
export function sameContent(a, b) {
	return JSON.stringify(stripStamps(a)) === JSON.stringify(stripStamps(b));
}

/** A copy without any merge stamp — what a save, the scene signature and a test compare. @param {any} doc */
export function stripStamps(doc) {
	if (!doc) return doc;
	/** @type {any} */
	const out = { ...doc };
	for (const k of ['metaAt', 'orderAt', 'gone', 'stampedAt', 'resetAt']) delete out[k];
	out.tracks = (doc.tracks ?? []).map((/** @type {any} */ tr) => {
		const { at: _a, ...rest } = tr;
		if (!Array.isArray(rest.items) || !OPAQUE_KINDS.has(tr.kind)) return rest;
		return { ...rest, items: rest.items.map((/** @type {any} */ it) => { const { at: _b, ...r } = it; return r; }) };
	});
	return out;
}

/**
 * UNDO AS A DELTA: re-apply the change `from → to` onto the CURRENT document, touching only
 * what that step changed (its items, tracks, order, the sequence's own fields). Whole-document
 * undo used to put back the document as it was before the step — including every item a PEER
 * changed since, so one person's Ctrl+Z silently reverted another person's edit.
 * @param {any} cur @param {any} from @param {any} to
 */
export function applyDelta(cur, from, to) {
	if (!cur || !from || !to) return to;
	/** @type {any} */
	const doc = { ...cur, tracks: (cur.tracks ?? []).map((/** @type {any} */ t) => ({ ...t, items: [...(t.items ?? [])] })) };
	if (key(from, META_SKIP) !== key(to, META_SKIP)) {
		for (const k of Object.keys(doc)) if (!META_SKIP.has(k) && !(k in to)) delete doc[k];
		for (const [k, v] of Object.entries(to)) if (!META_SKIP.has(k)) doc[k] = v;
	}
	const fT = new Map((from.tracks ?? []).map((/** @type {any} */ t) => [t.id, t]));
	const tT = new Map((to.tracks ?? []).map((/** @type {any} */ t) => [t.id, t]));
	const byId = () => new Map(doc.tracks.map((/** @type {any} */ t, /** @type {number} */ i) => [t.id, i]));
	for (const [id, t] of tT) {
		const f = fT.get(id);
		const at = byId().get(id);
		if (!f) {
			if (at === undefined) doc.tracks.push({ ...t, items: [...(t.items ?? [])] });
			continue;
		}
		if (at === undefined) continue; // a peer deleted it since: its delete stands
		const track = doc.tracks[/** @type {number} */ (at)];
		if (key(f, TRACK_SKIP) !== key(t, TRACK_SKIP)) {
			for (const k of Object.keys(track)) if (!TRACK_SKIP.has(k) && !(k in t)) delete track[k];
			for (const [k, v] of Object.entries(t)) if (!TRACK_SKIP.has(k)) track[k] = v;
		}
		if (!OPAQUE_KINDS.has(t.kind)) {
			if (JSON.stringify(f.items) !== JSON.stringify(t.items)) track.items = [...(t.items ?? [])];
			continue;
		}
		const fi = new Map((f.items ?? []).map((/** @type {any} */ it) => [it.id, it]));
		const ti = new Map((t.items ?? []).map((/** @type {any} */ it) => [it.id, it]));
		for (const iid of new Set([...fi.keys(), ...ti.keys()])) {
			const a = fi.get(iid);
			const b = ti.get(iid);
			if (a && b && key(a, ITEM_SKIP) === key(b, ITEM_SKIP)) continue;
			const i = track.items.findIndex((/** @type {any} */ it) => it.id === iid);
			if (!b) {
				if (i >= 0) track.items.splice(i, 1);
			} else if (i >= 0) track.items[i] = b;
			else track.items.push(b);
		}
	}
	for (const id of fT.keys()) if (!tT.has(id)) doc.tracks = doc.tracks.filter((/** @type {any} */ t) => t.id !== id);
	const order = (/** @type {any} */ d) => (d.tracks ?? []).map((/** @type {any} */ t) => t.id).join(',');
	if (order(from) !== order(to)) {
		const rank = new Map((to.tracks ?? []).map((/** @type {any} */ t, /** @type {number} */ i) => [t.id, i]));
		doc.tracks.sort((/** @type {any} */ a, /** @type {any} */ b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
	}
	return doc;
}
