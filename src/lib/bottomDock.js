import { writable, derived, get } from 'svelte/store';
import { viewPrefs } from './viewPrefs';
import { onLayoutRestore } from './uiLayoutsCore';
import { safeStorage } from './safeStorage';
import { scaledPx } from './uiScale'; // 53 A1: the dock's default + minimum height follow the UI scale
import { phoneShell } from './ui/phoneShell.js';

// Bottom dock: the dock shows exactly ONE panel at a time, and every panel that is
// docked+open is a notebook TAB in it — the Flow family (Node editor / Flow Code /
// Animation / UV editor / Shader editor / HUD editor) AND the Explorer alike, one
// strip rendered by whichever panel is showing (DockTabs.svelte). Nothing here
// force-closes anything: switching tabs changes only WHICH panel renders, so an
// Explorer covered by the Node editor stays open as a hidden tab (it used to be
// closed outright — the dock's two systems collapsed into one in the controls
// rework). Each panel reports present(docked+open)+height via setDockOccupant; only
// the visible one renders (the rest hide) and its height publishes as --bottom-inset
// so drawers/edge-docked windows sit above it.
// This module imports NO app stores — it is dock bookkeeping and nothing else.

export const FLOW_FAMILY = ['flow', 'flowcode', 'animation', 'uv', 'shader', 'hud', 'timeline'];
/** every panel that can be a dock tab, in strip order (Node editor first) */
export const DOCK_FAMILY = [...FLOW_FAMILY, 'explorer', 'profiler', 'code'];
/**
 * 41b H1 — the PHONE's content tabs. On a phone the content panels that are side drawers or
 * floating windows on a wider screen (the Inspector as Properties / Configure Scene, the Objects
 * list, the notes list, the workspace Layouts) are tabs in this same dock, so they stop being
 * sheets stacked behind it. They are dock tabs ONLY in the phone posture: `$lib/phoneDock`
 * reports them present there and nowhere else, so on a wider screen they never appear in the
 * strip and keep their own homes. Kept apart from DOCK_FAMILY on purpose: that list is also
 * "views with a floating dock window" (dockAllOf, dockTab, a floating group's Dock button), and
 * `objects` is a floating window key there.
 */
// 43 J1: Statistics too ("statistics also as tab in mobile view, not its floating window") — like the
// Objects list it is a floating window on a wider screen and keeps that mode on a phone that allows
// undocking (Settings ▸ Interface)
// 78 PL23 (owner bug G19, option a): Chat, the AI assistant and Free assets too — on a fold they became floating
// sheets piled over the bar (they were docked a moment before); they are phone dock tabs now, and take their
// wider-screen place back on the unfold (bottom dock, a sidebar column or floating: their own mode, untouched)
export const PHONE_DOCK_TABS = ['properties', 'objects', 'notes', 'layouts', 'scene', 'stats', 'chat', 'assets']; // uir-chat: the AI assistant is Chat's Assistant tab
/**
 * 42 I6 — floating windows that have NO docked layout of their own (no `docked` flag, no
 * second render branch) and still dock as tabs on a wider screen: the dock frame HOSTS their
 * element, the mechanism the phone already uses for the Objects list (41b H1, `$lib/dockHost`).
 * The user: "I should be able to put 'object list' also to dock", and every floating window
 * docks by dropping on the strip. These are the content/tool windows; the one-off viewers
 * (file/model previews, the text viewer), What's new and the tool palettes keep floating.
 */
// uir-timeline: 'meshGen' = the Generate window (prompt, jobs, history)
export const HOSTED_DOCK_TABS = ['objects', 'stats', 'chat', 'assets', 'preview', 'meshGen']; // uir-chat: Chat + AI = one window
/** every key the strip can hold (the tab order may name any of them) */
export const DOCK_KEYS = [...new Set([...DOCK_FAMILY, ...PHONE_DOCK_TABS, ...HOSTED_DOCK_TABS])];
/**
 * 42 I6 — every floating window that can become a dock tab by a drop on the strip / the
 * bottom edge, a group's Dock button or the "+" menu: the views with a docked branch of
 * their own (DOCK_FAMILY) and the hosted ones. ONE predicate for 41 G7's drop code
 * (bottomDockDrop, TabStrips, dockMenu), generalised rather than forked.
 */
export const FLOAT_DOCKABLE = [...DOCK_FAMILY, ...HOSTED_DOCK_TABS];
/** @param {string} key */
export function canDockFloating(key) {
	return FLOAT_DOCKABLE.includes(key);
}
/** @type {Record<string, string>} */
export const DOCK_TITLES = { flow: 'Node editor', flowcode: 'Flow Code', animation: 'Animation', uv: 'UV editor', shader: 'Shader editor', hud: 'HUD editor', timeline: 'Timeline', explorer: 'Explorer', profiler: 'Profiler', code: 'Code', imageEditor: 'Image editor', properties: 'Properties', objects: 'Objects', notes: 'Notes', layouts: 'Layouts', scene: 'Configure Scene', stats: 'Statistics', chat: 'Chat', aiAssistant: 'AI assistant', assets: 'Free assets', preview: 'Preview', meshGen: 'Generate 3D' };
/** 38 NOTES-38 #23: the view icon each dock tab shows before its name (ui/Icon names) */
/** @type {Record<string, string>} */
export const DOCK_ICONS = { flow: 'workflow', flowcode: 'code', animation: 'clapperboard', uv: 'grid-3x3', shader: 'sparkles', hud: 'app-window', timeline: 'video', explorer: 'folder-open', profiler: 'activity', code: 'code', imageEditor: 'image', properties: 'sliders-horizontal', objects: 'list', notes: 'sticky-note', layouts: 'panels-top-left', scene: 'sun', stats: 'gauge', chat: 'message-square', aiAssistant: 'sparkles', assets: 'package-open', preview: 'eye', meshGen: 'wand-sparkles' };

const ls = typeof localStorage !== 'undefined' ? localStorage : null;

/** which panel owns the dock right now */
export const bottomDockActive = writable(ls?.getItem('bottomDockActive') ?? 'flow');
bottomDockActive.subscribe((value) => {
	try {
		ls?.setItem('bottomDockActive', value);
	} catch {}
});

/** @param {number} h */
function clampH(h) {
	// phone-polish (HONOR, 718 x 587 at 130 % interface scale): 80 % of a short screen left the floating toolbar, which
	// rides above the dock, inside the top row (logo, undo, bell). The dock also leaves TOP_RESERVE for that row + the
	// tab strip + the bar (~200 px at 100 %, scaled) — on a tall desktop screen 80 % is still the tighter limit.
	const vh = typeof window !== 'undefined' ? window.innerHeight : 1000;
	const max = Math.max(scaledPx(160), Math.round(Math.min(vh * 0.8, vh - scaledPx(200))));
	return Math.min(Math.max(h || scaledPx(320), scaledPx(160)), max);
}
/** shared height of the dock — ONE value for every tab, Explorer included */
export const dockHeight = writable(clampH(parseInt(ls?.getItem('flowDockHeight') ?? '')));
dockHeight.subscribe((value) => {
	try {
		ls?.setItem('flowDockHeight', String(value));
	} catch {}
});

/**
 * W2: the dock is MINIMIZED — every tab stays open, nothing renders, and the dock
 * reserves no space (`bottomInset` reads 0), so the viewport is clear without closing
 * anybody's work. DELIBERATELY NOT PERSISTED: a minimized dock leaves no trace on
 * screen (the tab strip lives INSIDE the visible panel, so there is none), and the only
 * restore affordance is the toolbar's own buttons — a reload therefore brings the dock
 * back rather than handing someone a lost panel with no visible way to it.
 * `activateDock` clears it, so every path that asks for a tab (toolbar button, O/N key,
 * the "+" menu, a panel opening itself) restores the dock as a side effect.
 */
export const dockMinimized = writable(false);

/**
 * W5: ASK a panel to become a dock tab / a floating window.
 *
 * Every panel's `docked` flag is component-local `$state`, read from localStorage
 * exactly ONCE at mount — so writing that key from outside is MEASURABLY inert at a
 * live panel and the caller's row reads as a dead button. The panel's own `setDocked`
 * owns the mode (the flag, the render branch and the dock occupancy move together),
 * so an outside caller asks and the owner acts. That seam already existed for the
 * Explorer alone (`explorerDockArm` in appStore); this is the same shape GENERALISED
 * to every DOCK_FAMILY member, which is what lets the tab strip's own context menu
 * undock whichever tab was right-clicked — including one that is not currently the
 * visible panel, since a hidden tab hides with a class and stays mounted.
 *
 * Write-once: a consumer clears it as it acts, and the `token` makes two identical
 * asks in a row two distinct events.
 *
 * It lives HERE and not in appStore because it is dock bookkeeping and holds no app
 * state (see the no-app-stores note at the top of this module).
 * @type {import('svelte/store').Writable<{token: number, key: string, docked: boolean}|null>}
 */
export const dockModeArm = writable(null);
let dockArmToken = 0;
/** @param {string} key @param {boolean} docked */
export function armDockMode(key, docked) {
	dockModeArm.set({ token: ++dockArmToken, key, docked: !!docked });
}

/**
 * 40 F8 — arm SEVERAL panels in turn. `dockModeArm` is one write-once slot (a panel
 * consumes it by clearing it), so arming in a loop left only the last key armed. This
 * queues them: the next arm goes out once the previous one was consumed, or after a short
 * grace when no panel is mounted to consume it (a closed view).
 * @type {{key: string, docked: boolean}[]}
 */
const armQueue = [];
let armPumping = false;
/** @param {string[]} keys @param {boolean} docked */
export function armDockModes(keys, docked) {
	for (const key of keys) armQueue.push({ key, docked: !!docked });
	pumpArms();
}
function pumpArms() {
	if (armPumping) return;
	const next = armQueue.shift();
	if (!next) return;
	armPumping = true;
	armDockMode(next.key, next.docked);
	const started = Date.now();
	const wait = () => {
		if (get(dockModeArm) === null || Date.now() - started > 600) {
			armPumping = false;
			pumpArms();
			return;
		}
		setTimeout(wait, 16);
	};
	setTimeout(wait, 0);
}

/**
 * 40 F8 — what the dock's undock button (beside "minimize the dock") does: 'active' takes
 * out the visible tab (the default, user 2026-10-08), 'group' takes out every docked tab as
 * ONE floating tabbed window. Device-scoped, Settings ▸ Interface ▸ Windows & chrome.
 */
export const undockButtonMode = writable(safeStorage.getItem('dockUndockMode') === 'group' ? 'group' : 'active');
undockButtonMode.subscribe((value) => safeStorage.setItem('dockUndockMode', value));

/** {key: {present, height}} — docked AND open */
export const dockOccupants = writable(
	/** @type {Record<string, {present: boolean, height: number}>} */ ({})
);

/** @param {string} key @param {boolean} present @param {number=} height */
export function setDockOccupant(key, present, height = 0) {
	dockOccupants.update((state) => {
		const entry = state[key];
		if (entry && entry.present === present && entry.height === height) return state;
		return { ...state, [key]: { present, height } };
	});
	// a view REPORTING ITSELF DOCKED is what "added" means — see `noteDockOrder`. It is
	// safe to call on every report: a key already in the order is left exactly where it is.
	if (present) noteDockOrder(key);
}

/** the Flow-family panels currently open+docked (the Node editor button owns this
 * group, and the flow-dock suites read it — it is NOT the tab strip) */
export const flowTabs = derived(dockOccupants, ($o) =>
	FLOW_FAMILY.filter((k) => $o[k]?.present).map((k) => ({ key: k, title: DOCK_TITLES[k], icon: DOCK_ICONS[k] }))
);

/**
 * W7 — THE TAB ORDER IS USER DATA, and since the follow-up round it is DOCKING ORDER:
 * a view takes its place in the strip when it is docked, at the END, and keeps it until
 * it is dragged elsewhere. `DOCK_FAMILY` is only the order the module DECLARES its views
 * in; it is not what the strip sorts by. Reported as "tabs should add in the order I add
 * them" — before this the list was seeded with the whole family, so every key was
 * already placed and adding the Explorer then the Animation tab showed them the other
 * way round, which reads as the strip ignoring you.
 *
 * LOCAL and persisted, exactly like `bottomDockActive`: where a tab sits in the strip is
 * a fact about this screen, never about the scene, so it neither replicates nor saves.
 * Persisted is also what makes the order survive a reload — a panel re-reporting itself
 * docked at boot is already IN the list, so `noteDockOrder` leaves it alone.
 *
 * WHAT LEAVES THE LIST is the other half of the rule, and the two cases are not the same:
 *   UNDOCK  -> `forgetDockTab`, so re-docking is a fresh add at the end (the convention
 *              a tab strip has everywhere else).
 *   CLOSE   -> the slot is KEPT. A close is not a rearrangement, and the app closes
 *              panels on its own — `hidePanels()` shuts the Node editor whenever Settings
 *              or the Modules manager opens — so treating it as one would silently walk a
 *              hand-made arrangement apart every time somebody opened a dialog.
 * @type {import('svelte/store').Writable<string[]>}
 */
export const dockTabOrder = writable(readTabOrder());

function readTabOrder() {
	try {
		const raw = JSON.parse(ls?.getItem('dockTabOrder') ?? 'null');
		if (!Array.isArray(raw)) return [];
		const out = resolveOrder(raw);
		// MIGRATION: the old model wrote the whole shipped family out on the first
		// subscribe whether anybody had arranged anything or not, so a list that IS the
		// shipped order carries no information — and keeping it would leave every
		// existing install with all seven keys placed, i.e. with the reported bug intact.
		// Any OTHER order was arranged by hand and is kept verbatim.
		return out.join(',') === DOCK_FAMILY.join(',') ? [] : out;
	} catch {
		return [];
	}
}
dockTabOrder.subscribe((value) => {
	try {
		ls?.setItem('dockTabOrder', JSON.stringify(value));
	} catch {}
});

// 37 R14: a named workspace layout rewrote the dock's height and tab order — adopt them.
// (Which tab is in front rides the layout's workspace record; minimized never persists.)
onLayoutRestore(() => {
	dockHeight.set(clampH(parseInt(ls?.getItem('flowDockHeight') ?? '')));
	dockTabOrder.set(readTabOrder());
	dockMinimized.set(false);
});

/**
 * A stored (possibly stale, possibly hand-edited) order -> a usable one: unknown keys
 * dropped, duplicates collapsed, nothing added. A key the list has never heard of — a
 * view from a LATER release, or one just docked — is not this function's business: it
 * joins the strip at the END, through `noteDockOrder`.
 * @param {string[]} stored @returns {string[]}
 */
export function resolveOrder(stored) {
	return [...new Set((stored ?? []).filter((k) => DOCK_KEYS.includes(k)))];
}

/** the keys currently docked+open */
function presentKeys() {
	const o = get(dockOccupants);
	return DOCK_KEYS.filter((k) => o[k]?.present);
}

/**
 * `keys` in the strip's order. Anything the order list has never placed goes at the END
 * in family order — the safety net for a tab that somehow reached the dock without a
 * `noteDockOrder` (an order list hand-edited in localStorage, a future caller): a strip
 * that silently DROPPED such a tab would be a panel with no way back.
 * @param {string[]} keys @param {string[]} order
 */
function inOrder(keys, order) {
	const placed = resolveOrder(order);
	return [...placed.filter((k) => keys.includes(k)), ...keys.filter((k) => !placed.includes(k))];
}

/** every panel currently open+docked, as the dock's tabs (what DockTabs renders),
 * in the user's own order */
export const dockTabs = derived([dockOccupants, dockTabOrder], ([$o, $order]) =>
	inOrder(
		DOCK_KEYS.filter((k) => $o[k]?.present),
		$order
	).map((k) => ({ key: k, title: DOCK_TITLES[k], icon: DOCK_ICONS[k] }))
);

/**
 * Give `key` a place in the strip — at the END, which is what "added in the order I add
 * them" means. Called from `setDockOccupant`, so EVERY route into the dock earns its
 * slot the same way: the "+" menu, a toolbar button, a panel's own Dock button, a window
 * dropped on the bottom band, or a panel opening itself at boot.
 * A key already placed is left where it is — that is what makes a reload, a tab switch
 * and a panel re-mounting after Settings closes all no-ops.
 * @param {string} key
 */
export function noteDockOrder(key) {
	if (!DOCK_KEYS.includes(key)) return;
	const cur = resolveOrder(get(dockTabOrder));
	if (cur.includes(key)) return;
	dockTabOrder.set([...cur, key]);
}

/**
 * Drop `key`'s slot, so the next time it docks it joins the strip as a fresh add at the
 * end. Called by each panel's own `setDocked(false)` — the ONE thing every undock route
 * passes through (the tab menu's Undock row and a tab dragged out of the strip both ask
 * through `dockModeArm`, which the panel answers by calling it).
 * Deliberately NOT called when a view merely CLOSES: see the note on `dockTabOrder`.
 * @param {string} key
 */
export function forgetDockTab(key) {
	// 44 M9: an undocked member ends its split (its partner stays, full width)
	dissolveSplitOf(key);
	const cur = resolveOrder(get(dockTabOrder));
	if (!cur.includes(key)) return;
	dockTabOrder.set(cur.filter((k) => k !== key));
}

/**
 * Commit a new order for the tabs that are PRESENT. The absent ones keep their own
 * slots: the present keys re-fill the positions they already occupied, in the order
 * given. That is what makes a drag mean "put this tab there" rather than "rewrite the
 * whole list" — a closed Animation tab does not silently migrate because somebody
 * dragged the Explorer past the UV editor.
 * @param {string[]} keys the present tabs, in their new order
 */
export function reorderDockTabs(keys) {
	// the arrangement list PLUS anything present it has not placed, so the slot map below
	// can always find every key it was asked about (`inOrder`'s safety net, committed)
	const placed = resolveOrder(get(dockTabOrder));
	const full = [...placed, ...presentKeys().filter((k) => !placed.includes(k))];
	const slots = full.map((k, i) => (keys.includes(k) ? i : -1)).filter((i) => i >= 0);
	if (slots.length !== keys.length) return false; // asked about a tab that isn't present
	const next = [...full];
	slots.forEach((slot, n) => (next[slot] = keys[n]));
	dockTabOrder.set(next);
	return true;
}

/**
 * 41 G7 — a floating window dropped ON the docked tab strip docks exactly where the caret
 * showed: give `keys` their slots before `before` (a present tab) — or after the last
 * present tab when `before` is null — BEFORE they report themselves docked, so
 * `noteDockOrder` finds them placed and leaves them there instead of appending.
 * @param {string[]} keys @param {string|null} before
 */
export function placeDockTabs(keys, before) {
	const moving = keys.filter((k) => canDockFloating(k));
	if (!moving.length) return;
	const present = presentKeys().filter((k) => !moving.includes(k));
	const full = [...resolveOrder(get(dockTabOrder)), ...present].filter((k, i, a) => a.indexOf(k) === i).filter((k) => !moving.includes(k));
	let at = before && full.includes(before) && !moving.includes(before) ? full.indexOf(before) : -1;
	if (at < 0) {
		const last = present.length ? full.indexOf(present[present.length - 1]) : -1;
		at = last < 0 ? full.length : last + 1;
	}
	full.splice(at, 0, ...moving);
	dockTabOrder.set(full);
}

/**
 * Move a tab one place left/right among the tabs that are PRESENT — moving past a tab
 * that is closed is meaningless, so the neighbour is the next VISIBLE one.
 * @param {string} key @param {'left'|'right'} dir @returns {boolean} did it move
 */
export function moveDockTab(key, dir) {
	// 44 M9: the STRIP's entries move — a split pair is one entry and moves as one
	const strip = get(dockStripTabs);
	const i = strip.findIndex((t) => t.key === key || t.pair?.b === key);
	const j = i + (dir === 'left' ? -1 : 1);
	if (i < 0 || j < 0 || j >= strip.length) return false;
	const next = [...strip];
	next[i] = strip[j];
	next[j] = strip[i];
	return reorderStripTabs(next.map((t) => t.key));
}

/**
 * 44 M9 — commit a new order of STRIP entries (a pair named by its left member): each pair's right
 * member follows its left one, the rest is `reorderDockTabs`.
 * @param {string[]} entryKeys
 */
export function reorderStripTabs(entryKeys) {
	const present = get(dockTabs).map((t) => t.key);
	const pairs = get(dockStripTabs).filter((t) => t.pair);
	/** @type {string[]} */
	const keys = [];
	for (const k of entryKeys) {
		keys.push(k);
		const b = pairs.find((t) => t.key === k)?.pair?.b;
		if (b) keys.push(b);
	}
	for (const k of present) if (!keys.includes(k)) keys.push(k);
	return reorderDockTabs(keys.filter((k) => present.includes(k)));
}

/** the single panel that is actually VISIBLE in the dock (null if the dock is empty) */
export const visibleDockKey = derived([dockOccupants, bottomDockActive], ([$o, $a]) => {
	if ($o[$a]?.present) return $a;
	// active isn't docked (undocked/closed) — fall back to any present panel so the
	// dock never goes blank while a tab is still open
	return Object.keys($o).find((k) => $o[k]?.present) ?? null;
});

/**
 * 44 M9 — THE DOCK SPLIT (decision: Blender / VS Code "split editor"). Two docked views side by
 * side with a draggable vertical divider; the pair is ONE strip tab labelled "A / B". A pair is
 * `{a, b, r}`: `a` the left pane, `b` the right one (null = an EMPTY right pane with its own "+"),
 * `r` the divider's place as a fraction of the dock's width. Several pairs may exist (each key in
 * one at most); the one on screen is the pair the visible tab belongs to.
 *
 * LOCAL and persisted, like the tab order: an arrangement of this screen, part of a workspace
 * layout (uiLayoutsCore), never of the scene. Wider screens only — the folded phone's dock is one
 * column, so there a pair simply shows as its two ordinary tabs (the record is kept for the unfold).
 *
 * WHAT ENDS A PAIR: unsplit, a member UNDOCKED (`forgetDockTab`) or closed from the strip / tab
 * menu (`dissolveSplitOf`). A close the app makes on its own (Settings hiding the Node editor)
 * keeps it, the rule the tab order follows — and while a member is closed the other one shows
 * alone, full width, until it is back.
 * @typedef {{a: string, b: string|null, r: number}} DockSplit
 */
/** the narrowest a pane may be, as a fraction of the dock */
export const SPLIT_MIN = 0.15;
// (above the store: its initial read runs `resolveSplits`, which needs these — a TDZ throw there was
// swallowed by readSplits' catch and every reload came back with no splits)
const clampR = (/** @type {number} */ r) => (Number.isFinite(r) ? Math.min(Math.max(r, SPLIT_MIN), 1 - SPLIT_MIN) : 0.5);
/** @type {import('svelte/store').Writable<DockSplit[]>} */
export const dockSplits = writable(readSplits());

/** a stored (possibly stale, hand-edited, pre-44) record -> a usable list @param {unknown} raw @returns {DockSplit[]} */
export function resolveSplits(raw) {
	if (!Array.isArray(raw)) return [];
	/** @type {Set<string>} */
	const used = new Set();
	/** @type {DockSplit[]} */
	const out = [];
	for (const p of raw) {
		if (!p || typeof p !== 'object') continue;
		const a = /** @type {any} */ (p).a;
		const b = /** @type {any} */ (p).b ?? null;
		if (!DOCK_KEYS.includes(a) || used.has(a)) continue;
		if (b !== null && (!DOCK_KEYS.includes(b) || used.has(b) || b === a)) continue;
		used.add(a);
		if (b) used.add(b);
		out.push({ a, b, r: clampR(Number(/** @type {any} */ (p).r)) });
	}
	return out;
}
function readSplits() {
	try {
		return resolveSplits(JSON.parse(ls?.getItem('bottomDockSplits') ?? 'null'));
	} catch {
		return [];
	}
}
dockSplits.subscribe((value) => {
	try {
		ls?.setItem('bottomDockSplits', JSON.stringify(value));
	} catch {}
});
onLayoutRestore(() => dockSplits.set(readSplits()));

/** the pair `key` is in (null: none) @param {string|null|undefined} key */
export function splitOf(key) {
	if (!key) return null;
	return get(dockSplits).find((p) => p.a === key || p.b === key) ?? null;
}

/**
 * The split ON SCREEN: the visible tab's pair, when every member of it is docked+open (an empty
 * right pane counts as there). Null on a phone, while minimized, or when a member is away.
 * @type {import('svelte/store').Readable<DockSplit|null>}
 */
export const dockSplitView = derived([dockSplits, dockOccupants, visibleDockKey, dockMinimized, phoneShell], ([$splits, $o, $key, $min, $phone]) => {
	if ($min || $phone || !$key) return null;
	const p = $splits.find((s) => s.a === $key || s.b === $key);
	if (!p || !$o[p.a]?.present || (p.b && !$o[p.b]?.present)) return null;
	return p;
});

/** every dock key RENDERING now: the visible tab, or both halves of the split on screen */
export const dockShownKeys = derived([dockSplitView, visibleDockKey, dockMinimized], ([$split, $key, $min]) => {
	if ($split) return /** @type {string[]} */ ([$split.a, $split.b].filter(Boolean));
	return $key && !$min ? [$key] : [];
});

/** key -> 'a' (left pane) | 'b' (right pane) while a split is on screen; {} otherwise.
 *  Each docked view puts it on its root as `data-dock-pane` (windows.css places the panes). */
export const dockPaneOf = derived(dockSplitView, ($split) => {
	/** @type {Record<string, 'a'|'b'>} */
	const out = {};
	if ($split) {
		out[$split.a] = 'a';
		if ($split.b) out[$split.b] = 'b';
	}
	return out;
});

/**
 * The STRIP's entries: every present tab in the user's order, with a split pair folded into ONE
 * entry at its left member's slot ("Node editor / Explorer"). A pair whose member is away shows
 * the present one as an ordinary tab. Off on the folded phone (one column).
 * @type {import('svelte/store').Readable<{key: string, title: string, icon: string, pair: DockSplit|null}[]>}
 */
export const dockStripTabs = derived([dockTabs, dockSplits, phoneShell], ([$tabs, $splits, $phone]) => {
	const present = new Set($tabs.map((t) => t.key));
	/** @type {{key: string, title: string, icon: string, pair: DockSplit|null}[]} */
	const out = [];
	for (const t of $tabs) {
		const p = $phone ? null : $splits.find((s) => (s.a === t.key || s.b === t.key) && present.has(s.a) && (!s.b || present.has(s.b)));
		if (!p) out.push({ ...t, pair: null });
		else if (p.a === t.key) out.push({ ...t, title: `${DOCK_TITLES[p.a]} / ${p.b ? DOCK_TITLES[p.b] : 'Empty'}`, pair: p });
		// (the right member rides in its pair's entry)
	}
	return out;
});

/** @param {(splits: DockSplit[]) => DockSplit[]} fn */
function editSplits(fn) {
	dockSplits.set(resolveSplits(fn(get(dockSplits).map((p) => ({ ...p })))));
}

/**
 * Split `a` with `b` side by side (`b` null: an empty right pane with its own "+"). Either key
 * leaves any pair it was in first. Shows the split (the left pane in front).
 * @param {string} a @param {string|null} [b] @param {number} [r]
 */
export function splitDock(a, b = null, r = 0.5) {
	if (!DOCK_KEYS.includes(a) || a === b) return false;
	editSplits((all) => [...all.filter((p) => p.a !== a && p.b !== a && (!b || (p.a !== b && p.b !== b))), { a, b, r }]);
	activateDock(a);
	return true;
}

/** the tab after `key` in the strip that is not in a pair (null: none) @param {string} key */
export function nextSplitPartner(key) {
	const strip = get(dockStripTabs);
	const at = strip.findIndex((t) => t.key === key);
	if (at < 0) return null;
	return strip.slice(at + 1).find((t) => !t.pair)?.key ?? null;
}

/** 44 M9 — the split button / "Split right": `key` with the next tab, or with an empty pane @param {string} key */
export function splitWithNext(key) {
	return splitDock(key, nextSplitPartner(key));
}

/** end `key`'s pair; both views stay docked as ordinary tabs, the one in front stays in front @param {string} key */
export function unsplitDock(key) {
	const p = splitOf(key);
	if (!p) return false;
	editSplits((all) => all.filter((s) => s.a !== p.a));
	return true;
}
/** a member leaving the dock (or closed from the strip) ends its pair @param {string} key */
export function dissolveSplitOf(key) {
	if (splitOf(key)) unsplitDock(key);
}

/** "Swap sides" @param {string} key */
export function swapSplitSides(key) {
	const p = splitOf(key);
	if (!p || !p.b) return false;
	editSplits((all) => all.map((s) => (s.a === p.a ? { a: /** @type {string} */ (p.b), b: p.a, r: 1 - p.r } : s)));
	return true;
}

/**
 * Put `key` into `pane` of `pairKey`'s pair (a tab dropped onto a pane, a pick from an empty pane's
 * "+"). The view it replaces stays docked as an ordinary tab; `key` leaves any other pair first;
 * dropping a pair's own member onto its other pane swaps them.
 * @param {string} pairKey any member of the pair @param {'a'|'b'} pane @param {string} key
 */
export function setSplitPane(pairKey, pane, key) {
	const p = splitOf(pairKey);
	if (!p || !DOCK_KEYS.includes(key)) return false;
	if (key === p.a || key === p.b) {
		if ((pane === 'a' && key === p.a) || (pane === 'b' && key === p.b)) return false;
		if (!p.b) return false;
		return swapSplitSides(key);
	}
	const next = pane === 'a' ? { a: key, b: p.b, r: p.r } : { a: p.a, b: key, r: p.r };
	editSplits((all) => [...all.filter((s) => s.a !== p.a && s.a !== key && s.b !== key), next]);
	return true;
}

/** move the divider of `key`'s pair @param {string} key @param {number} r */
export function setSplitRatio(key, r) {
	const p = splitOf(key);
	if (!p) return;
	const next = clampR(r);
	if (Math.abs(next - p.r) < 1e-4) return;
	editSplits((all) => all.map((s) => (s.a === p.a ? { ...s, r: next } : s)));
}

// the divider's place on the root, for windows.css: the panes are laid out by CSS from it
if (typeof document !== 'undefined') {
	dockSplitView.subscribe((split) => {
		const root = document.documentElement;
		if (split) {
			root.style.setProperty('--dock-split-r', String(split.r));
			root.dataset.dockSplit = split.b ? 'pair' : 'empty';
		} else {
			root.style.removeProperty('--dock-split-r');
			delete root.dataset.dockSplit;
		}
	});
}

/**
 * 44 M5 — THE EMPTY DOCK. "T" with every window dragged out of the dock used to open the last
 * view again (the user: "'T' only should show empty docked window view with '+' in tab"); now it
 * opens the dock with nothing in it — its frame, its strip with only the "+", and a helper line
 * (PhoneDockHost draws it on a wider screen). It is a fact about THIS moment, like `dockMinimized`:
 * not persisted (a reload with nothing docked shows no dock), and it ends by itself the moment a
 * tab arrives — so a dock that later loses its last tab closes as it always did, and "T" is the
 * way back to the empty one.
 */
export const dockEmptyOpen = writable(false);

/** the empty dock is on screen: asked for, nothing docked, not minimized */
export const dockEmptyShown = derived([dockEmptyOpen, visibleDockKey, dockMinimized], ([$open, $key, $min]) => $open && !$key && !$min);

visibleDockKey.subscribe((key) => {
	if (key && get(dockEmptyOpen)) dockEmptyOpen.set(false);
});

/** height of the visible docked panel (0 when nothing is docked, and 0 while the dock
 * is minimized — a minimized dock draws nothing, so it may not reserve any space).
 * 44 M5: the EMPTY dock reserves the dock's height like any tab. */
export const bottomInset = derived(
	[dockOccupants, visibleDockKey, dockMinimized, dockEmptyShown, dockHeight],
	([$o, $key, $min, $empty, $h]) => ($min ? 0 : $key && $o[$key]?.present ? $o[$key].height : $empty ? $h : 0)
);

/**
 * W9 — the height the VIEWPORT gives up to the dock: `bottomInset` when the dock
 * RESIZES the viewport (the default) and 0 when it merely overlays a full-window
 * canvas. The store twin of App.svelte's `.viewport-inset` rule, so the canvas and the
 * chrome measured against it (the framing guide's letterbox, the camera PiP's rect)
 * cannot end up disagreeing about where the viewport ends.
 *
 * The `viewPrefs` import is the one exception to the no-app-stores note at the top: it
 * is a pure localStorage leaf (svelte/store only), and one shared derived beats the
 * same two-line rule copied into each consumer.
 */
export const viewportInset = derived([bottomInset, viewPrefs], ([$inset, $prefs]) =>
	$prefs?.dockPushesViewport ? $inset : 0
);

/**
 * Make `key` the visible dock panel. Purely a selection: the tab that was showing
 * stays open and simply stops rendering, so no panel is ever closed by another one
 * arriving. Asking for a tab also UN-MINIMIZES the dock: every restore path in the app
 * (toolbar buttons, the O/N keys through panelToggles, the "+" menu, a panel opening
 * itself) already funnels through here, so the clear lives in one place.
 * @param {string} key
 */
export function activateDock(key) {
	bottomDockActive.set(key);
	dockMinimized.set(false);
}

/**
 * 44 M5: open the dock EMPTY (only its "+"), or close an empty one again. Nothing here docks a
 * view; the "+" in the strip is how one arrives.
 * @param {boolean} on
 */
export function setDockEmptyOpen(on) {
	if (on) dockMinimized.set(false);
	dockEmptyOpen.set(!!on);
}

// publish the visible dock height as a CSS var so drawers/docked windows adjust (105)
if (typeof document !== 'undefined') {
	bottomInset.subscribe((inset) => {
		document.documentElement.style.setProperty('--bottom-inset', inset + 'px');
	});
	// 24-B3: the GATED height too — what the dock actually takes from the viewport.
	// `--bottom-inset` above is the raw dock height whether or not it pushes the
	// viewport; the window clamp (windowSize.bottomReserve) and the toolbox cap need
	// the pushing case only, an overlay dock sits BELOW the window tier.
	viewportInset.subscribe((inset) => {
		document.documentElement.style.setProperty('--viewport-inset', inset + 'px');
	});
}
