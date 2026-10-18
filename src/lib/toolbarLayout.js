// 41 G23 + G1 — THE BOTTOM TOOLBAR'S LAYOUT MODEL, as a pure leaf (imports NOTHING).
//
// Controls.svelte used to own this as a handful of closures over `$state`, which is why the
// G23 report ("Move left/right several times from the far right of Play to the leftmost,
// reload, and some icons break") could not be pinned down by reading it: the arithmetic was
// right, and the breakage was in how the stored record reached the page. The record is now
// read and written ONLY through these functions, so the rules a stored record must obey live
// in one place and are unit-tested (tests/unit/toolbarLayout.test.js):
//
//   · STABLE IDS. Every slot holds a roster id; an id the app no longer knows is dropped, a
//     non-string is dropped, and an id appears in AT MOST ONE place (the bar, the left
//     stack, the right stack). A hand-edited or half-migrated record cannot render one
//     button twice.
//   · NO HOLES. `spacerIndex` (where Play's well sits in the bar) is clamped into the row it
//     indexes, `hidden` is a subset of `order`, and each corner stack holds at most
//     `SIDE_MAX` ids.
//   · REMOVED STAYS REMOVED. A default button the user took off the bar used to come back on
//     the next reload (the "append any default the record does not list" rule could not tell
//     "added to the app later" from "removed on purpose" — Swap with had that bug since W8b).
//     A record now carries `seen`: every id it has ever placed. Only a default it has never
//     seen is appended, which is the explorer `columnsSeen` rule one domain over. A record
//     from before `seen` existed gets the old reading (nothing to tell them apart with).
//
// THE SHAPE (what `controlsLayout` in localStorage holds — every pre-41 field unchanged):
//   order        the bar's buttons in storage order; `hidden` entries keep their slot here
//   hidden       bar buttons switched off from Customize (they come back where they were)
//   spacerIndex  where Play's well sits among the SHOWN bar buttons
//   collapsed    the bar is Play alone
//   posX         where along the bottom edge the bar sits (0..1, null = centred)
//   left, right  41 G1: the round corner buttons, bottom → top, at most SIDE_MAX each
//   top          42 I9: the top-right group (Users.svelte), left → right, at most SIDE_MAX
//   touch        42 I9: the touch-tools cluster beside the logo (TouchTools.svelte), at most SIDE_MAX
//   seen         41 G23: every id this record has placed (see above)
//   more         43 J2: the bar's trailing "…" (Customize toolbar) is shown — absent = true; it is
//                the bar's own menu button, so it is not an id of `order`: it can be taken off and
//                put back like any item, never moved into the row or a corner
//   connect      43 K3: the Connect pill (top centre) is shown — absent = true; removable / restorable
//                in Edit positions and Customize
//   clusters     44 M12b: per CLUSTER (the bar, the two corner stacks, the row beside the logo, the top-right
//                group, the Connect pill) its free placement `{a, x, y}` — `x`/`y` the fraction (0..1) of the
//                free span along each axis (0 = hugging the left / top edge, 1 = the right / bottom one), `a` the
//                nearest of the nine anchors, for reading — plus `rotated` (turned 90° from its home orientation:
//                the bar and the two rows go vertical, the corner stacks horizontal; never the Connect pill) and
//                `hidden` (never the bar: Play lives there). Absent = at home, as before. See $lib/clusterPlace.
//                48 F1: the budget chip is a cluster too (`budget`) — placed = drawn where put, unplaced = its
//                measured spot beside the bar; `hidden` = off (Edit positions' "−", Customize's switch); never rotated.
//
// 42 I9 — FIVE REGIONS, ONE RECORD. The bar and four STACKS (the two bottom corners, the
// top-right group, the touch tools). A stack holds at most SIDE_MAX (four — the user's "if I
// place all three I want to place a fourth"). Some ids are HOME-ONLY (`cfg.homeOnly`): they may
// only live in one region (the notifications bell and the peers trigger open their panels from
// the top-right corner), and every move/insert/swap/fill refuses to take them anywhere else.
// A pre-42 record has no `top`/`touch`: it reads the default ones, like a pre-41 record read the
// default corners.
//
// Play is never in `order`, `left` or `right`: it is the well, a pseudo-cell (`PLAY`) that
// exists only on the VISUAL row, and the only thing every layout is guaranteed to hold.

/** the play button's well on the visual row (the pre-41 name, kept for every reader) */
export const PLAY = '__spacer';
/** at most this many buttons in each STACK (the two bottom corners, the top-right group, the
 *  touch tools) — 41's "up to three", raised to four by 42 I9 */
export const SIDE_MAX = 4;
/** @typedef {'left' | 'bar' | 'right' | 'top' | 'touch'} Region */
/** @typedef {'left' | 'right' | 'top' | 'touch'} Stack */
/** the stacks, in the order uniqueness is settled after the bar (an id in two keeps the first) */
/** @type {Stack[]} */
export const STACKS = ['left', 'right', 'top', 'touch'];
/** an empty bar slot in an edit-positions DRAFT (`__hole:<n>`), never stored */
export const HOLE = '__hole';
/** @param {unknown} id */
export const isHole = (id) => typeof id === 'string' && id.startsWith(HOLE + ':');

/**
 * @typedef {object} ToolbarLayout
 * @property {string[]} order
 * @property {string[]} hidden
 * @property {number} spacerIndex
 * @property {boolean} collapsed
 * @property {number | null} posX
 * @property {string[]} left
 * @property {string[]} right
 * @property {string[]} top
 * @property {string[]} touch
 * @property {string[]} seen
 * @property {boolean} more
 * @property {boolean} connect
 * @property {Record<string, ClusterState>} [clusters]
 */
/** @typedef {{ a?: string, x?: number, y?: number, rotated?: boolean, hidden?: boolean }} ClusterState */

/** 44 M12b: the clusters a person can place, rotate and hide, in the order overlaps are settled */
export const CLUSTERS = ['bar', 'left', 'right', 'touch', 'top', 'connect', 'budget'];
/** 48 F1: the clusters that never turn 90° (the Connect pill, the budget chip) */
export const UNROTATED = ['connect', 'budget'];
/** the nine anchors, by the fraction along each axis */
export function anchorOf(/** @type {number} */ x, /** @type {number} */ y) {
	const h = x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'center';
	const v = y < 1 / 3 ? 'top' : y > 2 / 3 ? 'bottom' : 'middle';
	return v + '-' + h;
}
/** Turn any stored value into valid cluster states (unknown ids, non-numbers and empty entries dropped) */
export function normalizeClusters(/** @type {unknown} */ raw) {
	/** @type {Record<string, ClusterState>} */
	const out = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
	for (const id of CLUSTERS) {
		const c = /** @type {any} */ (raw)[id];
		if (!c || typeof c !== 'object') continue;
		/** @type {ClusterState} */
		const next = {};
		if (typeof c.x === 'number' && Number.isFinite(c.x) && typeof c.y === 'number' && Number.isFinite(c.y)) {
			next.x = Math.round(clamp(c.x, 0, 1) * 10000) / 10000;
			next.y = Math.round(clamp(c.y, 0, 1) * 10000) / 10000;
			next.a = anchorOf(next.x, next.y);
		}
		if (c.rotated === true && !UNROTATED.includes(id)) next.rotated = true;
		if (c.hidden === true && id !== 'bar') next.hidden = true;
		if (Object.keys(next).length) out[id] = next;
	}
	return out;
}

/**
 * @typedef {object} LayoutConfig
 * @property {string[]} order        the default bar, in order
 * @property {number} spacer         the default well index
 * @property {string[]} left         the default left corner stack, bottom → top
 * @property {string[]} right        the default right corner stack, bottom → top
 * @property {string[]} [top]        42: the default top-right group, left → right
 * @property {string[]} [touch]      42: the default touch-tools cluster
 * @property {Record<string, Region>} [homeOnly]  42: ids that may live in ONE region only
 * @property {(id: string) => boolean} isKnown   is this a roster id the app renders
 * @property {string[]} [legacyRows] shipped default bars, as `id,…,__spacer,…` rows
 * @property {string[]} [promoted]   ids that BECAME default after being opt-in
 */

/**
 * @typedef {object} Placements   the regions as the user sees them
 * @property {string[]} left      bottom → top
 * @property {string[]} bar       left → right, PLAY included exactly once
 * @property {string[]} right     bottom → top
 * @property {string[]} top       left → right
 * @property {string[]} touch     left → right (top → bottom when the cluster stacks)
 * @property {Record<string, Region>} [home]  42: the home-only ids (copied from the config)
 * @property {boolean} [more]  43 J2: the trailing "…" is on the bar (absent = keep the record's)
 * @property {boolean} [connect]  43 K3: the Connect pill is shown (absent = keep the record's)
 * @property {Record<string, ClusterState>} [clusters]  44 M12b: the clusters' placement (absent = keep the record's)
 */

/** @param {unknown} v */
const isId = (v) => typeof v === 'string' && v.length > 0;

/** @param {string[]} list */
const uniq = (list) => list.filter((id, at) => list.indexOf(id) === at);

/** @param {number} n @param {number} lo @param {number} hi */
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** the config's default list for a stack @param {LayoutConfig} cfg @param {Stack} stack */
const cfgStack = (cfg, stack) => cfg[stack] ?? [];

/** @param {LayoutConfig} cfg @returns {ToolbarLayout} */
export function defaultLayout(cfg) {
	return {
		order: [...cfg.order],
		hidden: [],
		spacerIndex: cfg.spacer,
		collapsed: false,
		posX: null,
		left: [...cfg.left],
		right: [...cfg.right],
		top: [...cfgStack(cfg, 'top')],
		touch: [...cfgStack(cfg, 'touch')],
		seen: uniq([...cfg.order, ...STACKS.flatMap((s) => cfgStack(cfg, s))]),
		more: true,
		connect: true,
		clusters: {}
	};
}

/** may `id` live in `region` at all (its home-only rule)? @param {Record<string, Region> | undefined} home */
function homeAllows(home, /** @type {string} */ id, /** @type {Region} */ region) {
	const only = home?.[id];
	return !only || only === region;
}

/** is this stored bar one of the default bars the app used to ship (33 E1)? */
function isLegacyDefault(/** @type {string[]} */ order, /** @type {any} */ saved, /** @type {LayoutConfig} */ cfg) {
	const rows = cfg.legacyRows ?? [];
	// a record carrying `seen` was written by 41+ code, so it is a bar somebody ARRANGED, even
	// when it happens to spell a row the app once shipped — only a pre-41 record can be one
	if (!rows.length || Array.isArray(saved.seen)) return false;
	const hidden = Array.isArray(saved.hidden) ? saved.hidden : [];
	if (hidden.some((/** @type {any} */ id) => order.includes(id))) return false;
	const row = [...order];
	const at = Number.isFinite(saved.spacerIndex) ? clamp(saved.spacerIndex, 0, row.length) : 3;
	row.splice(at, 0, PLAY);
	return rows.includes(row.join(','));
}

/** the stored fraction, clamped (anything else reads as "centred") */
function readPosX(/** @type {any} */ v) {
	return typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : null;
}

/**
 * Turn ANY stored value into a valid layout. Never throws, and is idempotent:
 * `normalizeLayout(normalizeLayout(x)) ≡ normalizeLayout(x)`.
 * @param {unknown} raw  the parsed record (or anything else)
 * @param {LayoutConfig} cfg
 * @returns {ToolbarLayout}
 */
export function normalizeLayout(raw, cfg) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultLayout(cfg);
	const saved = /** @type {any} */ (raw);
	const known = (/** @type {unknown} */ id) => isId(id) && cfg.isKnown(/** @type {string} */ (id));
	const list = (/** @type {unknown} */ v) => (Array.isArray(v) ? uniq(v.filter(known)) : null);

	let order = list(saved.order) ?? [];
	const posX = readPosX(saved.posX);
	const collapsed = saved.collapsed === true;
	const more = saved.more !== false;
	const connect = saved.connect !== false;
	const clusters = normalizeClusters(saved.clusters);
	// 33 E1: a record that is still a SHIPPED default migrates to today's default bar (the
	// corner stacks and `seen` it carries are kept — they are not part of the legacy rows)
	if (isLegacyDefault(order, saved, cfg)) {
		const fresh = defaultLayout(cfg);
		const keepSides = Array.isArray(saved.left) || Array.isArray(saved.right);
		return normalizeLayout(
			{
				...fresh,
				collapsed,
				posX,
				more,
				connect,
				clusters,
				...(keepSides ? { left: saved.left ?? fresh.left, right: saved.right ?? fresh.right, seen: saved.seen } : {})
			},
			{ ...cfg, legacyRows: [] }
		);
	}
	// 42: a home-only id is not on the bar (a hand-edited record could put it there) — the ones
	// found in a WRONG region are remembered and sent home below, when it has room
	/** @type {Set<string>} */
	const evicted = new Set(order.filter((id) => !homeAllows(cfg.homeOnly, id, 'bar')));
	order = order.filter((id) => homeAllows(cfg.homeOnly, id, 'bar'));
	// the stacks: absent (a pre-41 record for the corners, a pre-42 one for top/touch) = the
	// default stack; an id already on the bar, or in an earlier stack, is not ALSO in this one
	// (the bar wins — it is the older, explicit placement), a home-only id only in its home
	/** @type {Record<Stack, string[]>} */
	const stacks = { left: [], right: [], top: [], touch: [] };
	const taken = new Set(order);
	for (const stack of STACKS) {
		const from = list(saved[stack]) ?? [...cfgStack(cfg, stack)].filter(known);
		for (const id of from) if (!homeAllows(cfg.homeOnly, id, stack)) evicted.add(id);
		stacks[stack] = from.filter((id) => !taken.has(id) && homeAllows(cfg.homeOnly, id, stack)).slice(0, SIDE_MAX);
		for (const id of stacks[stack]) taken.add(id);
	}
	let { left, right, top, touch } = stacks;

	// what this record has placed before. A pre-41 record has no `seen`, so it reads the
	// way it always did: every default it does not list is "new to the app" — except the
	// promoted ones, which a custom record left off on purpose (33 E1).
	const storedSeen = list(saved.seen);
	const seen = new Set(storedSeen ?? [...order, ...(cfg.promoted ?? []), ...cfg.left, ...cfg.right]);
	for (const id of [...order, ...left, ...right, ...top, ...touch]) seen.add(id);
	const placed = (/** @type {string} */ id) => order.includes(id) || STACKS.some((s) => stacks[s].includes(id));
	for (const id of cfg.order) if (known(id) && !seen.has(id) && !placed(id)) order.push(id);
	for (const stack of STACKS)
		for (const id of cfgStack(cfg, stack))
			if (known(id) && !seen.has(id) && !placed(id) && stacks[stack].length < SIDE_MAX) stacks[stack].push(id);
	// 42: a home-only id the record dropped from a WRONG region goes home when there is room
	for (const id of evicted) {
		const home = cfg.homeOnly?.[id];
		if (home && home !== 'bar' && !placed(id) && stacks[/** @type {Stack} */ (home)].length < SIDE_MAX)
			stacks[/** @type {Stack} */ (home)].push(id);
	}
	for (const id of [...order, ...left, ...right, ...top, ...touch]) seen.add(id);

	const hidden = (list(saved.hidden) ?? []).filter((id) => order.includes(id));
	const room = order.filter((id) => !hidden.includes(id)).length;
	const spacerIndex = Number.isFinite(saved.spacerIndex)
		? clamp(Math.round(saved.spacerIndex), 0, room)
		: Math.min(cfg.spacer, room);
	return { order, hidden, spacerIndex, collapsed, posX, left, right, top, touch, seen: [...seen].filter(known), more, connect, clusters };
}

/** the bar buttons actually ON the bar, in bar order (Play's well is not one) */
export function shownIds(/** @type {ToolbarLayout} */ l) {
	return l.order.filter((id) => !l.hidden.includes(id));
}

/** THE VISUAL ROW — the shown bar buttons with Play's well spliced in */
export function visualRow(/** @type {ToolbarLayout} */ l) {
	const seq = shownIds(l);
	seq.splice(clamp(l.spacerIndex, 0, seq.length), 0, PLAY);
	return seq;
}

/** a stack of a record, tolerating a record built before the stack existed */
const stackOf = (/** @type {ToolbarLayout} */ l, /** @type {Stack} */ s) => l[s] ?? [];

/** every id that is somewhere the user can see it (Play excluded) */
export function placedIds(/** @type {ToolbarLayout} */ l) {
	return [...shownIds(l), ...STACKS.flatMap((s) => stackOf(l, s))];
}

/** which region an id is in, or null when it is not placed (or only hidden) */
export function regionOf(/** @type {ToolbarLayout} */ l, /** @type {string} */ id) {
	if (id === PLAY) return 'bar';
	for (const s of STACKS) if (stackOf(l, s).includes(id)) return s;
	return shownIds(l).includes(id) ? 'bar' : null;
}

/** Read the bar's record back off a mutated VISUAL row: the well's index is where the well
 *  now is, and the shown buttons are poured back into their slots in `order`, so hidden
 *  entries keep their absolute positions (W1's rule, unchanged). */
function fromRow(/** @type {ToolbarLayout} */ l, /** @type {string[]} */ seq) {
	const shown = seq.filter((cell) => cell !== PLAY);
	const order = [...l.order];
	let next = 0;
	for (let i = 0; i < order.length; i++) if (!l.hidden.includes(order[i])) order[i] = shown[next++];
	return { ...l, order, spacerIndex: seq.indexOf(PLAY) };
}

/** Move one bar cell — a button or Play's well — exactly ONE visual slot (W1). */
export function moveCell(/** @type {ToolbarLayout} */ l, /** @type {string} */ id, /** @type {number} */ dir) {
	const seq = visualRow(l);
	const at = seq.indexOf(id);
	const to = at + dir;
	if (at < 0 || to < 0 || to >= seq.length) return l;
	seq[at] = seq[to];
	seq[to] = id;
	return fromRow(l, seq);
}

/** Take a button off where it is: a bar button is HIDDEN (it keeps its slot for Customize to
 *  bring it back), a corner button leaves its stack. */
export function hideButton(/** @type {ToolbarLayout} */ l, /** @type {string} */ id) {
	for (const s of STACKS) if (stackOf(l, s).includes(id)) return { ...l, [s]: stackOf(l, s).filter((o) => o !== id) };
	const at = shownIds(l).indexOf(id);
	if (at < 0) return l;
	const spacerIndex = at < l.spacerIndex ? l.spacerIndex - 1 : l.spacerIndex;
	return { ...l, hidden: [...l.hidden, id], spacerIndex };
}

/** Put a button back: a hidden bar button returns to its slot; a stack button returns to its
 *  own default stack while that has room; anything else joins the far right of the bar — except
 *  a home-only id, which goes home or nowhere. */
export function showButton(/** @type {ToolbarLayout} */ l, /** @type {string} */ id, /** @type {LayoutConfig} */ cfg) {
	if (!cfg.isKnown(id) || regionOf(l, id)) return l;
	const seen = l.seen.includes(id) ? l.seen : [...l.seen, id];
	if (!l.order.includes(id)) {
		for (const s of STACKS)
			if (cfgStack(cfg, s).includes(id) && stackOf(l, s).length < SIDE_MAX && homeAllows(cfg.homeOnly, id, s))
				return { ...l, [s]: [...stackOf(l, s), id], seen };
	}
	const only = cfg.homeOnly?.[id];
	if (only && only !== 'bar') {
		const home = /** @type {Stack} */ (only);
		return stackOf(l, home).length < SIDE_MAX ? { ...l, [home]: [...stackOf(l, home), id], seen } : l;
	}
	const hidden = l.hidden.filter((h) => h !== id);
	const order = l.order.includes(id) ? l.order : [...l.order, id];
	const at = order.filter((o) => !hidden.includes(o)).indexOf(id);
	const spacerIndex = at > -1 && at < l.spacerIndex ? l.spacerIndex + 1 : l.spacerIndex;
	return { ...l, order, hidden, spacerIndex, seen };
}

/** W8b SWAP: `toId` — a button that is not on screen (unplaced, or a hidden bar button) —
 *  takes `fromId`'s exact slot, bar or corner, and `fromId` leaves. Nothing else moves. */
export function swapCell(
	/** @type {ToolbarLayout} */ l,
	/** @type {string} */ fromId,
	/** @type {string} */ toId,
	/** @type {Record<string, Region> | undefined} */ home = undefined
) {
	if (fromId === toId || fromId === PLAY || toId === PLAY || regionOf(l, toId)) return l;
	const region = regionOf(l, fromId);
	if (!region || !homeAllows(home, toId, region)) return l;
	const seen = l.seen.includes(toId) ? l.seen : [...l.seen, toId];
	const hidden = l.hidden.filter((h) => h !== toId && h !== fromId);
	if (region !== 'bar') return { ...l, hidden, seen, order: l.order.filter((o) => o !== toId), [region]: stackOf(l, region).map((o) => (o === fromId ? toId : o)) };
	const order = l.order.filter((o) => o !== toId).map((o) => (o === fromId ? toId : o));
	return { ...l, order, hidden, seen };
}

// ── 41 G1: EDIT POSITIONS works on PLACEMENTS — the three regions as the user sees them ──

/** @returns {Placements} */
export function placements(/** @type {ToolbarLayout} */ l, /** @type {Record<string, Region> | undefined} */ home = undefined) {
	return {
		left: [...l.left],
		bar: visualRow(l),
		right: [...l.right],
		top: [...stackOf(l, 'top')],
		touch: [...stackOf(l, 'touch')],
		more: l.more !== false,
		connect: l.connect !== false,
		clusters: normalizeClusters(l.clusters),
		...(home ? { home } : {})
	};
}

/** Write edited placements back into a record. The bar's hidden entries (Customize's
 *  switched-off defaults) are not on screen to be edited, so they ride along at the end of
 *  `order` — still hidden, still offered by Customize. Anything the edit took off the screen
 *  simply leaves (it is unplaced, and `seen` keeps it from coming back on its own). */
export function fromPlacements(/** @type {ToolbarLayout} */ l, /** @type {Placements} */ p) {
	const bar = p.bar.includes(PLAY) ? p.bar : [...p.bar, PLAY];
	const shown = uniq(bar.filter((id) => id !== PLAY && !isHole(id) && homeAllows(p.home, id, 'bar')));
	const taken = new Set(shown);
	/** @type {Record<Stack, string[]>} */
	const stacks = { left: [], right: [], top: [], touch: [] };
	for (const s of STACKS) {
		stacks[s] = uniq((p[s] ?? []).filter((id) => id !== PLAY && !isHole(id) && !taken.has(id) && homeAllows(p.home, id, s))).slice(0, SIDE_MAX);
		for (const id of stacks[s]) taken.add(id);
	}
	const placed = [...taken];
	const hidden = l.hidden.filter((id) => !placed.includes(id));
	const order = [...shown, ...hidden];
	const spacerIndex = clamp(bar.indexOf(PLAY), 0, shown.length);
	return { ...l, order, hidden, spacerIndex, ...stacks, seen: uniq([...l.seen, ...placed]), more: typeof p.more === 'boolean' ? p.more : l.more !== false, connect: typeof p.connect === 'boolean' ? p.connect : l.connect !== false, clusters: normalizeClusters(p.clusters ?? l.clusters) };
}

/** @param {Placements} p @param {string} id @returns {Placements} */
function removeFrom(p, id) {
	const drop = (/** @type {string[] | undefined} */ list) => (list ?? []).filter((o) => o !== id);
	return { ...p, left: drop(p.left), bar: drop(p.bar), right: drop(p.right), top: drop(p.top), touch: drop(p.touch) };
}

/** which region of a placements object holds an id */
export function placeRegion(/** @type {Placements} */ p, /** @type {string} */ id) {
	if (p.bar.includes(id)) return /** @type {Region} */ ('bar');
	for (const s of STACKS) if ((p[s] ?? []).includes(id)) return /** @type {Region} */ (s);
	return null;
}

/** Can `id` go into `region` (Play only ever lives on the bar; a home-only id only in its home;
 *  a full stack takes nothing new — moving WITHIN a full stack is fine)? */
export function canPlace(/** @type {Placements} */ p, /** @type {string} */ id, /** @type {Region} */ region) {
	if (!homeAllows(p.home, id, region)) return false;
	if (region === 'bar') return true;
	if (id === PLAY) return false;
	const list = p[region] ?? [];
	return list.includes(id) || list.length < SIDE_MAX;
}

/** Move (or insert) `id` to `index` of `region`. Refused moves return `p` unchanged. */
export function placeAt(/** @type {Placements} */ p, /** @type {string} */ id, /** @type {Region} */ region, /** @type {number} */ index) {
	if (!isId(id) || isHole(id) || !canPlace(p, id, region)) return p;
	const next = removeFrom(p, id);
	const list = [...(next[region] ?? [])];
	list.splice(clamp(Math.round(index), 0, list.length), 0, id);
	return { ...next, [region]: list };
}

/** Take an item off the screen (Play cannot be removed). With `{hole: true}` a BAR item leaves an
 *  empty slot behind (edit mode draws it as a green "+", so the place it came from can be filled
 *  again); holes are a draft-only thing — `fromPlacements` drops them. */
export function placeRemove(/** @type {Placements} */ p, /** @type {string} */ id, { hole = false } = {}) {
	if (id === PLAY || isHole(id)) return id === PLAY ? p : removeFrom(p, id);
	if (!hole || !p.bar.includes(id)) return removeFrom(p, id);
	const used = p.bar.filter(isHole).map((h) => Number(h.slice(HOLE.length + 1)) || 0);
	const next = HOLE + ":" + (used.length ? Math.max(...used) + 1 : 1);
	return { ...p, bar: p.bar.map((o) => (o === id ? next : o)) };
}

/** Put `id` into an empty bar slot (a hole), taking it from wherever it was. */
export function fillHole(/** @type {Placements} */ p, /** @type {string} */ hole, /** @type {string} */ id) {
	const at = p.bar.indexOf(hole);
	if (at < 0 || !isId(id) || isHole(id) || id === PLAY || !homeAllows(p.home, id, 'bar')) return p;
	const next = removeFrom({ ...p, bar: p.bar.map((o) => (o === hole ? "\u0000" : o)) }, id);
	return { ...next, bar: next.bar.map((o) => (o === "\u0000" ? id : o)) };
}

/**
 * One arrow key on a focused item in edit mode. The bar reads left → right and each corner
 * stack bottom → top, and the three are joined at the bar's two ends: ← on the bar's first
 * item steps up into the left stack, → on a left-stack item steps onto the bar's start (and
 * the mirror on the right). Play only moves along the bar.
 * @param {Placements} p @param {string} id
 * @param {'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'} key
 * @returns {Placements}
 */
export function stepItem(p, id, key) {
	const region = placeRegion(p, id);
	if (!region) return p;
	const at = (p[region] ?? []).indexOf(id);
	// 42: the top-right group and the touch tools are islands of their own — every arrow walks
	// along the list (← / ↑ earlier, → / ↓ later), and never out of it (a drag does that)
	if (region === 'top' || region === 'touch') {
		const dir = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
		const to = at + dir;
		return to < 0 || to >= p[region].length ? p : placeAt(p, id, region, to);
	}
	if (region === 'bar') {
		if (key === 'ArrowLeft') return at > 0 ? placeAt(p, id, 'bar', at - 1) : placeAt(p, id, 'left', p.left.length);
		if (key === 'ArrowRight')
			return at < p.bar.length - 1 ? placeAt(p, id, 'bar', at + 1) : placeAt(p, id, 'right', p.right.length);
		return p;
	}
	if (key === 'ArrowUp') return at < p[region].length - 1 ? placeAt(p, id, region, at + 1) : p;
	if (key === 'ArrowDown') return at > 0 ? placeAt(p, id, region, at - 1) : p;
	if (region === 'left' && key === 'ArrowRight') return placeAt(p, id, 'bar', 0);
	if (region === 'right' && key === 'ArrowLeft') return placeAt(p, id, 'bar', p.bar.length);
	return p;
}

/** the roster ids NOT placed anywhere (the "+" popup's list; Play is never in a roster) */
export function unplacedIds(/** @type {Placements} */ p, /** @type {string[]} */ roster) {
	return roster.filter((id) => id !== PLAY && !isHole(id) && !placeRegion(p, id));
}

// ── 43 J10: TOOLBAR OVERFLOW ──────────────────────────────────────────────────────────────────
// When the bar lacks room (a wide pinned sidebar, every button enabled on a laptop), the cells that
// do not fit fold into an overflow "»" whose menu holds them — the Office / VS Code / Figma toolbar
// rule — and come back by themselves as room returns. It is DERIVED, never stored: the user's
// enabled set (`order`/`hidden`, the corners) is not touched, so shrinking a sidebar again is all it
// takes to unfold. PRIORITY IS THE USER'S ORDER, read right to left: the cell at the far right of the
// bar folds first, the next one after it, and Play (the well) never folds. The trailing "…" is the
// lowest priority of all: once anything folds it is the "»" that ends the bar (its menu closes with
// "Customize toolbar…"), so a folded bar is never wider than one that still had its "…".

/**
 * @typedef {object} FoldMetrics   every width in px, measured off the live bar
 * @property {number} [budget]  the room the bar may take (absent / Infinity / NaN = no limit)
 * @property {number} chrome  the bar's own padding + border
 * @property {number} cell    one button cell
 * @property {number} well    Play's well
 * @property {number} gap     the gap between two cells (and before a trailing control)
 * @property {number} tail    what a trailing control adds after the row: the gap, the separator and
 *                            one cell — the "…" while nothing folds, the "»" once anything does
 * @property {boolean} more   the record shows the "…"
 */

/** the bar's width for a row of cells and an optional trailing control @param {string[]} ids @param {FoldMetrics} m @param {boolean} trailing */
export function barWidth(ids, m, trailing) {
	const cells = ids.reduce((sum, id) => sum + (id === PLAY ? m.well : m.cell), 0);
	return m.chrome + cells + Math.max(0, ids.length - 1) * m.gap + (trailing ? m.tail : 0);
}

/**
 * Split the visual row into what stays on the bar and what folds into "»".
 * @param {string[]} row  the visual row (PLAY included once)
 * @param {FoldMetrics} m
 * @returns {{ shown: string[], folded: string[] }}  `folded` keeps the bar's left → right order
 */
export function foldToFit(row, m) {
	if (!((m.budget ?? NaN) > 0) || barWidth(row, m, m.more) <= (m.budget ?? Infinity)) return { shown: [...row], folded: [] };
	const shown = [...row];
	/** @type {string[]} */
	const folded = [];
	for (let i = shown.length - 1; i >= 0 && barWidth(shown, m, true) > (m.budget ?? Infinity); i--) {
		if (shown[i] === PLAY) continue;
		folded.unshift(shown[i]);
		shown.splice(i, 1);
	}
	return { shown, folded };
}
