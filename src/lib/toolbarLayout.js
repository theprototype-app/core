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
//   seen         41 G23: every id this record has placed (see above)
//
// Play is never in `order`, `left` or `right`: it is the well, a pseudo-cell (`PLAY`) that
// exists only on the VISUAL row, and the only thing every layout is guaranteed to hold.

/** the play button's well on the visual row (the pre-41 name, kept for every reader) */
export const PLAY = '__spacer';
/** at most this many round buttons stacked in each bottom corner (the user's "up to three") */
export const SIDE_MAX = 3;
/** @typedef {'left' | 'bar' | 'right'} Region */

/**
 * @typedef {object} ToolbarLayout
 * @property {string[]} order
 * @property {string[]} hidden
 * @property {number} spacerIndex
 * @property {boolean} collapsed
 * @property {number | null} posX
 * @property {string[]} left
 * @property {string[]} right
 * @property {string[]} seen
 */

/**
 * @typedef {object} LayoutConfig
 * @property {string[]} order        the default bar, in order
 * @property {number} spacer         the default well index
 * @property {string[]} left         the default left corner stack, bottom → top
 * @property {string[]} right        the default right corner stack, bottom → top
 * @property {(id: string) => boolean} isKnown   is this a roster id the app renders
 * @property {string[]} [legacyRows] shipped default bars, as `id,…,__spacer,…` rows
 * @property {string[]} [promoted]   ids that BECAME default after being opt-in
 */

/**
 * @typedef {object} Placements   the three regions as the user sees them
 * @property {string[]} left      bottom → top
 * @property {string[]} bar       left → right, PLAY included exactly once
 * @property {string[]} right     bottom → top
 */

/** @param {unknown} v */
const isId = (v) => typeof v === 'string' && v.length > 0;

/** @param {string[]} list */
const uniq = (list) => list.filter((id, at) => list.indexOf(id) === at);

/** @param {number} n @param {number} lo @param {number} hi */
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

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
		seen: uniq([...cfg.order, ...cfg.left, ...cfg.right])
	};
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
				...(keepSides ? { left: saved.left ?? fresh.left, right: saved.right ?? fresh.right, seen: saved.seen } : {})
			},
			{ ...cfg, legacyRows: [] }
		);
	}
	// the corner stacks: absent (a pre-41 record) = the default corners; an id already on
	// the bar is not ALSO in a stack (the bar wins — it is the older, explicit placement)
	let left = (list(saved.left) ?? [...cfg.left].filter(known)).filter((id) => !order.includes(id));
	let right = (list(saved.right) ?? [...cfg.right].filter(known)).filter((id) => !order.includes(id) && !left.includes(id));
	left = left.slice(0, SIDE_MAX);
	right = right.slice(0, SIDE_MAX);

	// what this record has placed before. A pre-41 record has no `seen`, so it reads the
	// way it always did: every default it does not list is "new to the app" — except the
	// promoted ones, which a custom record left off on purpose (33 E1).
	const storedSeen = list(saved.seen);
	const seen = new Set(storedSeen ?? [...order, ...(cfg.promoted ?? []), ...cfg.left, ...cfg.right]);
	for (const id of [...order, ...left, ...right]) seen.add(id);
	const placed = (/** @type {string} */ id) => order.includes(id) || left.includes(id) || right.includes(id);
	for (const id of cfg.order) if (known(id) && !seen.has(id) && !placed(id)) order.push(id);
	for (const id of cfg.left) if (known(id) && !seen.has(id) && !placed(id) && left.length < SIDE_MAX) left.push(id);
	for (const id of cfg.right) if (known(id) && !seen.has(id) && !placed(id) && right.length < SIDE_MAX) right.push(id);
	for (const id of [...order, ...left, ...right]) seen.add(id);

	const hidden = (list(saved.hidden) ?? []).filter((id) => order.includes(id));
	const room = order.filter((id) => !hidden.includes(id)).length;
	const spacerIndex = Number.isFinite(saved.spacerIndex)
		? clamp(Math.round(saved.spacerIndex), 0, room)
		: Math.min(cfg.spacer, room);
	return { order, hidden, spacerIndex, collapsed, posX, left, right, seen: [...seen].filter(known) };
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

/** every id that is somewhere the user can see it (Play excluded) */
export function placedIds(/** @type {ToolbarLayout} */ l) {
	return [...shownIds(l), ...l.left, ...l.right];
}

/** which region an id is in, or null when it is not placed (or only hidden) */
export function regionOf(/** @type {ToolbarLayout} */ l, /** @type {string} */ id) {
	if (id === PLAY) return 'bar';
	if (l.left.includes(id)) return 'left';
	if (l.right.includes(id)) return 'right';
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
	if (l.left.includes(id)) return { ...l, left: l.left.filter((o) => o !== id) };
	if (l.right.includes(id)) return { ...l, right: l.right.filter((o) => o !== id) };
	const at = shownIds(l).indexOf(id);
	if (at < 0) return l;
	const spacerIndex = at < l.spacerIndex ? l.spacerIndex - 1 : l.spacerIndex;
	return { ...l, hidden: [...l.hidden, id], spacerIndex };
}

/** Put a button back: a hidden bar button returns to its slot; a corner button returns to its
 *  own default corner while that has room; anything else joins the far right of the bar. */
export function showButton(/** @type {ToolbarLayout} */ l, /** @type {string} */ id, /** @type {LayoutConfig} */ cfg) {
	if (!cfg.isKnown(id) || regionOf(l, id)) return l;
	const seen = l.seen.includes(id) ? l.seen : [...l.seen, id];
	if (!l.order.includes(id)) {
		if (cfg.left.includes(id) && l.left.length < SIDE_MAX) return { ...l, left: [...l.left, id], seen };
		if (cfg.right.includes(id) && l.right.length < SIDE_MAX) return { ...l, right: [...l.right, id], seen };
	}
	const hidden = l.hidden.filter((h) => h !== id);
	const order = l.order.includes(id) ? l.order : [...l.order, id];
	const at = order.filter((o) => !hidden.includes(o)).indexOf(id);
	const spacerIndex = at > -1 && at < l.spacerIndex ? l.spacerIndex + 1 : l.spacerIndex;
	return { ...l, order, hidden, spacerIndex, seen };
}

/** W8b SWAP: `toId` — a button that is not on screen (unplaced, or a hidden bar button) —
 *  takes `fromId`'s exact slot, bar or corner, and `fromId` leaves. Nothing else moves. */
export function swapCell(/** @type {ToolbarLayout} */ l, /** @type {string} */ fromId, /** @type {string} */ toId) {
	if (fromId === toId || fromId === PLAY || toId === PLAY || regionOf(l, toId)) return l;
	const region = regionOf(l, fromId);
	if (!region) return l;
	const seen = l.seen.includes(toId) ? l.seen : [...l.seen, toId];
	const hidden = l.hidden.filter((h) => h !== toId && h !== fromId);
	if (region !== 'bar') return { ...l, hidden, seen, order: l.order.filter((o) => o !== toId), [region]: l[region].map((o) => (o === fromId ? toId : o)) };
	const order = l.order.filter((o) => o !== toId).map((o) => (o === fromId ? toId : o));
	return { ...l, order, hidden, seen };
}

// ── 41 G1: EDIT POSITIONS works on PLACEMENTS — the three regions as the user sees them ──

/** @returns {Placements} */
export function placements(/** @type {ToolbarLayout} */ l) {
	return { left: [...l.left], bar: visualRow(l), right: [...l.right] };
}

/** Write edited placements back into a record. The bar's hidden entries (Customize's
 *  switched-off defaults) are not on screen to be edited, so they ride along at the end of
 *  `order` — still hidden, still offered by Customize. Anything the edit took off the screen
 *  simply leaves (it is unplaced, and `seen` keeps it from coming back on its own). */
export function fromPlacements(/** @type {ToolbarLayout} */ l, /** @type {Placements} */ p) {
	const bar = p.bar.includes(PLAY) ? p.bar : [...p.bar, PLAY];
	const shown = uniq(bar.filter((id) => id !== PLAY));
	const left = uniq(p.left.filter((id) => id !== PLAY && !shown.includes(id))).slice(0, SIDE_MAX);
	const right = uniq(p.right.filter((id) => id !== PLAY && !shown.includes(id) && !left.includes(id))).slice(0, SIDE_MAX);
	const placed = [...shown, ...left, ...right];
	const hidden = l.hidden.filter((id) => !placed.includes(id));
	const order = [...shown, ...hidden];
	const spacerIndex = clamp(bar.indexOf(PLAY), 0, shown.length);
	return { ...l, order, hidden, spacerIndex, left, right, seen: uniq([...l.seen, ...placed]) };
}

/** @param {Placements} p @param {string} id @returns {Placements} */
function removeFrom(p, id) {
	return { left: p.left.filter((o) => o !== id), bar: p.bar.filter((o) => o !== id), right: p.right.filter((o) => o !== id) };
}

/** which region of a placements object holds an id */
export function placeRegion(/** @type {Placements} */ p, /** @type {string} */ id) {
	return /** @type {Region | null} */ (p.left.includes(id) ? 'left' : p.bar.includes(id) ? 'bar' : p.right.includes(id) ? 'right' : null);
}

/** Can `id` go into `region` (Play only ever lives on the bar; a full stack takes nothing
 *  new — moving WITHIN a full stack is fine)? */
export function canPlace(/** @type {Placements} */ p, /** @type {string} */ id, /** @type {Region} */ region) {
	if (region === 'bar') return true;
	if (id === PLAY) return false;
	return p[region].includes(id) || p[region].length < SIDE_MAX;
}

/** Move (or insert) `id` to `index` of `region`. Refused moves return `p` unchanged. */
export function placeAt(/** @type {Placements} */ p, /** @type {string} */ id, /** @type {Region} */ region, /** @type {number} */ index) {
	if (!isId(id) || !canPlace(p, id, region)) return p;
	const next = removeFrom(p, id);
	const list = [...next[region]];
	list.splice(clamp(Math.round(index), 0, list.length), 0, id);
	return { ...next, [region]: list };
}

/** Take an item off the screen (Play cannot be removed). */
export function placeRemove(/** @type {Placements} */ p, /** @type {string} */ id) {
	return id === PLAY ? p : removeFrom(p, id);
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
	const at = p[region].indexOf(id);
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
	return roster.filter((id) => id !== PLAY && !placeRegion(p, id));
}
