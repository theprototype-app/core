// A2 (roadmap #21) — HUD documents: the data half of the core HUD system.
//
// Not one UI/2D/screen node existed in core, so a game's menu and score could not be
// authored at all. `dungeon-realms` hand-rolls a `#dr-gui` fixed overlay at a hardcoded
// `z-index: 900`; `dungeon` hand-rolls `#dungeon-panel` at 40, inside the `--z-window`
// band it does not own.
//
// This is deliberately the `shaderGraph.js` shape, not a new one: that module already
// solves "keyed documents that replicate, save four ways and undo", and copying it means
// the monotonic-stamp bug, the normalize-at-every-boundary rule and the
// preserve-a-newer-peer's-fields rule come pre-solved. A LEAF (`svelte/store` only), so
// it stays out of the TDZ family around `history.js`; `hudSync.js` closes the loop.
//
// KEYED rather than a singleton, even though the v1 UI only ever creates `'scene'`: a HUD
// is scene data like the post stack, but a game prefab will want to bring its own overlay,
// and `'scene' | objectUuid` costs nothing today (flowGraphs, shaderGraphs and animations
// all key this way) while retrofitting a key later is a migration.
//
// THE RUNTIME HALF IS NOT HERE AND IS NEVER REPLICATED. This module owns WHERE things
// are; what an element SAYS comes from the already-replicated flow graph, so every peer
// computes the same string with no message of its own. Screen visibility is per-peer ON
// PURPOSE — one player on the start menu while another plays.

import { writable, get } from 'svelte/store';
// 21-D1: the kind REGISTRY. hudKinds imports nothing, so this stays a leaf.
import { HUD_KINDS as REGISTERED_KINDS, defaultsForKind, styleDefaultsForKind, kindDef } from './hudKinds';
// 21-D6: a screen can follow the GAME STATE. gameState is a leaf too, so this closes no
// cycle — and it is what lets a menu hide itself when the game starts, with no wiring.
import { gameState } from './gameState';

/** The scene-wide HUD, and the only key the v1 UI creates. */
export const HUD_SCENE_KEY = 'scene';

/** The 9-grid. Anchors are a corner/edge plus a PIXEL offset, never 0..1 fractions:
 * fractions stretch text and borders on resize, and the 9-grid is literally what
 * `dungeon-realms/src/gui.js` hardcoded as its CORNERS map — the demand spec authored
 * the answer. */
export const HUD_ANCHORS = [
	'top-left', 'top-center', 'top-right',
	'middle-left', 'center', 'middle-right',
	'bottom-left', 'bottom-center', 'bottom-right'
];

/** Element kinds this build can RENDER, from the registry (21-D1) so a kind is declared
 * ONCE. An UNKNOWN kind is preserved verbatim and skipped at render (the
 * normalizeAnnotation / scenePost rule) — a newer peer's element must never be deleted
 * by our editor, so this is a render capability and never a validation whitelist. */
export const HUD_KINDS = REGISTERED_KINDS;

/**
 * The fields below are the ones EVERY kind has. The rest are PER KIND and declared in
 * `hudKinds.js` (a bar's min/max, an image's src, an input's shared flag), so the type is
 * deliberately open - a closed type would have to list the whole registry here and would
 * go stale the first time a kind is added, which is the drift the registry exists to stop.
 * @typedef {{id: string, kind: string, anchor: string, x: number, y: number, w: number,
 *   h: number, z: number, label: string, bind?: string, style?: any, at?: number,
 *   [key: string]: any}} HudElement
 * @typedef {{id: string, name: string, showWhile: string, elements: HudElement[]}} HudScreen
 * @typedef {{screens: HudScreen[], active: string, changedAt: number}} HudDoc
 */

/** Every HUD document, keyed 'scene' | objectUuid.
 * @type {import('svelte/store').Writable<Record<string, HudDoc>>} */
export const hudDocs = writable({});

/** Which document the editor is scoped to.
 * @type {import('svelte/store').Writable<string|null>} */
export const activeHudDoc = writable(null);

/** Which screen is SHOWING, per document. LOCAL and per-peer by design: one player can
 * sit on the start menu while another plays, so this is not part of the document and is
 * never replicated. `null`/absent means "the document's own `active`".
 * @type {import('svelte/store').Writable<Record<string, string|null>>} */
export const hudScreenOverride = writable({});

/** The editor's current selection, per document key -> element ids. LOCAL.
 * @type {import('svelte/store').Writable<Record<string, string[]>>} */
export const hudSelection = writable({});

/** 21-D5: paint the HUD over the VIEWPORT while the HUD editor is open?
 *
 * Default FALSE, which is the answer to "why do I immediately see the HUD while I am
 * building it": you author on the artboard, and the viewport stays yours. This is only
 * about the AUTHORING session — with the editor closed the HUD renders normally, and
 * `viewportOverrides.hud` is the separate, persistent local kill switch.
 * @type {import('svelte/store').Writable<boolean>} */
export const hudPreviewInViewport = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('hudPreviewInViewport') === 'true'
);
if (typeof localStorage !== 'undefined')
	hudPreviewInViewport.subscribe((on) => {
		try {
			localStorage.setItem('hudPreviewInViewport', String(!!on));
		} catch {}
	});

/** What each element currently SAYS, keyed by element id. Written by A3's one collection
 * pass in flowRuntime's tick, THROTTLED to ~10Hz and only on change — `flowValues`
 * throttles to 150ms for exactly this reason, and a per-frame store write re-renders the
 * whole layer 60 times a second.
 *
 * DERIVED, never replicated: the values come from the already-replicated flow graph, so
 * every peer computes the same thing from the same data (golden rule 8, deterministic).
 * @type {import('svelte/store').Writable<Record<string, any>>} */
export const hudRuntime = writable({});

// ---- 21-D4: INPUT VALUES -------------------------------------------------------
//
// What a slider/toggle/dropdown/text field currently HOLDS. This is a THIRD kind of state
// beside the authored document and the derived runtime, and it needed to be, because it is
// neither: it is authored by the PLAYER, at play time, and it is not derivable from
// anything already replicated.
//
// LOCAL BY DEFAULT, and that default is the whole design. A volume slider is mine; a
// difficulty setting is the host's. Making everything shared would mean my own volume
// changed everyone else's - the failure nobody would file as a sync bug, because it looks
// like the feature working. So the element carries a `shared` flag and only those values
// leave this machine.
//
// The shared half is latest-wins PER ELEMENT with a MONOTONIC stamp, the hudDocs rule one
// level down: two peers dragging the same slider inside one millisecond would otherwise
// have every write after the first dropped.
/** @type {import('svelte/store').Writable<Record<string, any>>} */
export const hudValues = writable({});

/** per-element stamps for the SHARED entries only; a local value needs no ordering */
/** @type {Record<string, number>} */
const valueStamps = {};

/** @type {((id: string, value: any, at: number) => void)|null} */
let valueBroadcastHook = null;

/** hudSync fills this; hudDocs stays a leaf. @param {(id: string, value: any, at: number) => void} fn */
export function registerHudValueBroadcast(fn) {
	valueBroadcastHook = fn;
	return () => {
		if (valueBroadcastHook === fn) valueBroadcastHook = null;
	};
}

/** @param {string} id @param {any} fallback */
export function hudValueOf(id, fallback = undefined) {
	const key = String(id ?? '').trim();
	if (!key) return fallback;
	const held = get(hudValues)[key];
	return held === undefined ? fallback : held;
}

/**
 * The ONE write path for an input's value (the setHudDocFor precedent).
 * @param {string} id @param {any} value
 * @param {{shared?: boolean, silent?: boolean, at?: number}} [opts] `silent` = an applier,
 *   which must not echo; `at` carries a remote stamp.
 */
export function setHudValue(id, value, opts = {}) {
	const key = String(id ?? '').trim();
	if (!key) return;
	if (opts.at !== undefined) {
		// REFUSE only a STRICTLY older write: an ordered DataConnection means an equal stamp
		// arrived later, so it wins (the hudDocs / shaderGraph rule).
		const held = valueStamps[key] ?? 0;
		if (opts.at < held) return;
		valueStamps[key] = opts.at;
	} else if (opts.shared) {
		valueStamps[key] = Math.max(Date.now(), (valueStamps[key] ?? 0) + 1);
	}
	hudValues.update((all) => (all[key] === value ? all : { ...all, [key]: value }));
	if (opts.shared && !opts.silent) valueBroadcastHook?.(key, value, valueStamps[key]);
}

/** Everything a late joiner needs: the SHARED values only, with their stamps. Local values
 * are nobody else's business, which is the point of the flag. */
export function sharedHudValues() {
	const all = get(hudValues);
	/** @type {Record<string, {value: any, at: number}>} */
	const out = {};
	for (const [id, at] of Object.entries(valueStamps)) out[id] = { value: all[id], at };
	return out;
}

/** @param {Record<string, {value: any, at: number}>} map */
export function applyHudValues(map) {
	for (const [id, entry] of Object.entries(map ?? {}))
		setHudValue(id, entry?.value, { at: Number(entry?.at) || 1, silent: true });
}

/** Session/autosave restore and leaveSession: a value is play-time state, so a fresh scene
 * starts from the AUTHORED defaults rather than inheriting the last game's. */
export function clearHudValues() {
	for (const k of Object.keys(valueStamps)) delete valueStamps[k];
	hudValues.set({});
}

/** The value an element STARTS from, before anyone touches it: its authored `value`. Kept
 * here so the renderer, the flow node and a reset all agree. @param {any} el */
export function startValueOf(el) {
	if (!el) return undefined;
	return el.value;
}

let elementSeq = 0;

/** A short, collision-free element id. Not `Date.now()`-based: two elements added in the
 * same millisecond would collide, and an each-block keyed on a repeated value THROWS in
 * svelte (the animation-window crash). @param {string} kind */
export function newElementId(kind) {
	elementSeq++;
	return (kind || 'el') + '-' + elementSeq.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

/** @param {any} v @param {number} fallback */
function num(v, fallback) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

/**
 * ONE normalize at every store boundary (wire, autosave restore, session load, undo).
 * SPREADS its input, so a field a NEWER peer added survives our edit and rides back onto
 * the wire — the `normalizeAnnotation` rule.
 * @param {any} el @param {number} i @returns {HudElement}
 */
export function normalizeHudElement(el, i = 0) {
	const kind = typeof el?.kind === 'string' && el.kind ? el.kind : 'text';
	// hoisted, because the explicit fields below must fall back to the KIND's default and
	// not to a literal — they are written AFTER the spread, so a literal there would
	// silently beat the registry (a text element's 'Text' became '' exactly that way).
	const kd = defaultsForKind(kind);
	const size = kindDef(kind)?.defaultSize;
	return {
		// 21-D1: the kind's own params, merged UNDERNEATH the authored element — an absent
		// param gains its default and an authored one is untouched. An UNKNOWN kind answers
		// {} here, so it still passes through byte-unchanged.
		...kd,
		...(el ?? {}),
		id: typeof el?.id === 'string' && el.id ? el.id : kind + '-' + i,
		// NOT clamped to HUD_KINDS: an unknown kind is kept and skipped at RENDER, which
		// is a rendering decision rather than a silent delete of a newer peer's work
		kind,
		anchor: HUD_ANCHORS.includes(el?.anchor) ? el.anchor : 'top-left',
		x: num(el?.x, 16),
		y: num(el?.y, 16),
		w: Math.max(8, num(el?.w, size?.w ?? 120)),
		h: Math.max(8, num(el?.h, size?.h ?? 28)),
		z: num(el?.z, 0),
		label: typeof el?.label === 'string' ? el.label : kd.label ?? '',
		// style values may be THEME TOKEN names, resolved at render with a literal
		// fallback (the ToolboxWindow rule: every var() must end in a literal, because
		// neither dark nor light defines --surface)
		style: { ...styleDefaultsForKind(kind), ...(el?.style && typeof el.style === 'object' ? el.style : {}) },
		// `at` is a per-element stamp, DECLARED NOW AND UNREAD (the viewportOverrides
		// trick): the document replicates whole today, and a future per-element merge is
		// then additive rather than a redesign.
		at: num(el?.at, 0)
	};
}

/** @param {any} screen @param {number} i @returns {HudScreen} */
export function normalizeHudScreen(screen, i = 0) {
	const id = typeof screen?.id === 'string' && screen.id ? screen.id : 'screen-' + i;
	return {
		...(screen ?? {}),
		id,
		name: typeof screen?.name === 'string' && screen.name ? screen.name : id,
		// 21-D6: "show this screen while the game is X". Absent means "only when asked", so
		// every existing document is byte-unchanged. This is what makes a late joiner see
		// the right screen: it never witnessed the transition that switched everyone else.
		showWhile: typeof screen?.showWhile === 'string' ? screen.showWhile : '',
		elements: (Array.isArray(screen?.elements) ? screen.elements : []).map(normalizeHudElement)
	};
}

/** @param {any} doc @returns {HudDoc} */
export function normalizeHudDoc(doc) {
	const screens = (Array.isArray(doc?.screens) ? doc.screens : []).map(normalizeHudScreen);
	const list = screens.length ? screens : [normalizeHudScreen({ id: 'main', name: 'Main' }, 0)];
	const active = list.some((/** @type {HudScreen} */ s) => s.id === doc?.active) ? doc.active : list[0].id;
	return { ...(doc ?? {}), screens: list, active, changedAt: num(doc?.changedAt, 0) };
}

/**
 * Find a screen by its ID **or its NAME**.
 *
 * Users think in names — the picker shows names, and a node authored by hand or by a
 * template will carry whichever the author had in front of them. Accepting both is the
 * difference between a screen switch that works and one that silently renders NOTHING
 * (which is exactly what a name in an id field did).
 * @param {HudDoc|null} doc @param {string|null|undefined} idOrName @returns {HudScreen|null}
 */
export function resolveScreen(doc, idOrName) {
	if (!doc || idOrName === null || idOrName === undefined || idOrName === '') return null;
	const wanted = String(idOrName);
	return (
		doc.screens.find((s) => s.id === wanted) ??
		doc.screens.find((s) => s.name === wanted) ??
		doc.screens.find((s) => s.name.toLowerCase() === wanted.toLowerCase()) ??
		null
	);
}

/** @param {string} key @returns {HudDoc|null} */
export function hudDocOf(key) {
	const doc = get(hudDocs)[key];
	return doc ? normalizeHudDoc(doc) : null;
}

/**
 * 21-D5: WHICH documents are on screen right now.
 *
 * The scene HUD always, plus the document keyed by the camera you are LOOKING THROUGH —
 * which needs no new concept at all, because `hudDocs` was already keyed
 * `'scene' | objectUuid`. Attaching a HUD to a camera IS keying it by that camera's uuid,
 * so replication, undo, sessions and autosave came for free.
 * @param {string|null} [throughCamera] the camera object uuid being viewed, if any
 * @returns {string[]}
 */
export function activeHudKeys(throughCamera = null) {
	const all = get(hudDocs);
	/** @type {string[]} */
	const keys = [];
	if (all[HUD_SCENE_KEY]) keys.push(HUD_SCENE_KEY);
	if (throughCamera && all[throughCamera]) keys.push(throughCamera);
	return keys;
}

/** Every key that has a document, for the editor's own picker. @returns {string[]} */
export function hudDocKeys() {
	return Object.keys(get(hudDocs));
}

/** The screen a viewer is LOOKING at for one document — their local override first, the
 * document's own `active` otherwise. @param {string} key @returns {HudScreen|null} */
export function visibleScreen(key) {
	const doc = hudDocOf(key);
	if (!doc) return null;
	// 1. an explicit LOCAL choice always wins — that is the per-peer half.
	const override = get(hudScreenOverride)[key];
	if (override !== undefined && override !== null) return resolveScreen(doc, override);
	// 2. a screen bound to the current GAME STATE. No wiring, and it is what makes a late
	// joiner land on the right screen — it never saw the transition everyone else did.
	const state = get(gameState).state;
	const byState = doc.screens.find((s) => s.showWhile && s.showWhile === state);
	if (byState) return byState;
	// 3. otherwise the document's own default.
	return resolveScreen(doc, doc.active);
}

/** Show a screen, LOCALLY. A3's `hudscreen` node calls this on every peer from the
 * replicated flow graph, which is why it needs no message.
 * @param {string} key @param {string|null} screenId */
export function showHudScreen(key, screenId) {
	// resolve to an ID here, so nothing downstream has to know a name was given
	const resolved = screenId === null ? null : resolveScreen(hudDocOf(key), screenId)?.id ?? screenId;
	hudScreenOverride.update((all) => ({ ...all, [key]: resolved }));
}

/** @param {string} key @param {string} elementId @returns {HudElement|null} */
export function elementById(key, elementId) {
	const doc = hudDocOf(key);
	if (!doc) return null;
	for (const screen of doc.screens) {
		const found = screen.elements.find((el) => el.id === elementId);
		if (found) return found;
	}
	return null;
}

/** Every element in a document, so a picker can offer them. `label` rides along because
 * that is what a user recognises - an id is for the wire, a label is for a person.
 * @param {string} key
 * @returns {{id: string, kind: string, screen: string, label: string}[]} */
export function elementChoices(key) {
	const doc = hudDocOf(key);
	if (!doc) return [];
	return doc.screens.flatMap((screen) =>
		screen.elements.map((el) => ({ id: el.id, kind: el.kind, screen: screen.name, label: el.label }))
	);
}

/** Every screen of a document, as {id, name} — the picker's other half. @param {string} key */
export function screenChoices(key) {
	const doc = hudDocOf(key);
	return doc ? doc.screens.map((s) => ({ id: s.id, name: s.name })) : [];
}

/**
 * Resolve what a node's `element` field POINTS AT, for display.
 *
 * A field that shows the raw id cannot tell 'this names a real button' from 'this names
 * nothing' — which is precisely what made the old `<input list>` read as a filter. The
 * picker renders this instead, and paints the unresolved case amber.
 * @param {string} key @param {string|null|undefined} id
 * @returns {{id: string, kind: string, screen: string, label: string}|null}
 */
export function resolveElement(key, id) {
	const wanted = String(id ?? '').trim();
	if (!wanted) return null;
	return elementChoices(key).find((c) => c.id === wanted) ?? null;
}

// ---- 21-D3: the EYEDROPPER seam ------------------------------------------------
//
// 'arm this field, then click the element on the artboard'. Two write-once stores rather
// than a store holding a CALLBACK: the picker lives in the node editor and the artboard
// in the HUD editor, so the value has to survive the trip between two panels, and a
// token keeps a second armed field from consuming the first one's answer (the
// inspectorScrollTo shape, one seam wider).
/** @type {import('svelte/store').Writable<string|null>} */
export const hudPickArm = writable(null);
/** @type {import('svelte/store').Writable<{token: string, id: string}|null>} */
export const hudPickResult = writable(null);

/** @param {string} token */
export function armHudPick(token) {
	hudPickResult.set(null);
	hudPickArm.set(token);
}

/** The artboard answering an armed field. @param {string} id @returns {boolean} consumed */
export function deliverHudPick(id) {
	const token = get(hudPickArm);
	if (!token) return false;
	hudPickArm.set(null);
	hudPickResult.set({ token, id });
	return true;
}

// ---- the single write path -----------------------------------------------------

/** Seams hudSync fills, so this module keeps no cycles. */
/** @type {((key: string, doc: HudDoc|null) => void)|null} */
let broadcastHook = null;
/** @type {((key: string, before: any, after: any) => void)|null} */
let historyHook = null;

/** @param {(key: string, doc: HudDoc|null) => void} fn */
export function registerHudBroadcast(fn) {
	broadcastHook = fn;
	return () => {
		if (broadcastHook === fn) broadcastHook = null;
	};
}

/** @param {(key: string, before: any, after: any) => void} fn */
export function registerHudHistory(fn) {
	historyHook = fn;
	return () => {
		if (historyHook === fn) historyHook = null;
	};
}

/**
 * THE ONE way a HUD document changes — editor, applier, undo and restore all come through
 * here (the setShaderGraphFor / setPhysicsFor precedent), so the four never drift.
 * @param {string} key
 * @param {any} patch partial doc; `null` deletes
 * @param {{silent?: boolean, stamp?: number}} [opts] `silent` skips history + broadcast
 *   (the applier path: a receiver must never re-broadcast — golden rule 1)
 * @returns {HudDoc|null}
 */
export function setHudDocFor(key, patch, opts = {}) {
	const before = hudDocOf(key);
	/** @type {HudDoc|null} */
	let after = null;
	hudDocs.update((all) => {
		const next = { ...all };
		if (patch === null) delete next[key];
		else {
			after = normalizeHudDoc({
				...(all[key] ?? {}),
				...patch,
				// MONOTONIC per key. A drag writes several times inside one millisecond, so
				// those edits share a bare Date.now() and the receiver's latest-wins guard
				// drops every one after the first — measured in the shader round: the drag
				// AND the undo after it silently failed to replicate.
				changedAt: opts.stamp ?? Math.max(Date.now(), (all[key]?.changedAt ?? 0) + 1)
			});
			next[key] = after;
		}
		return next;
	});
	if (!opts.silent) {
		if (historyHook) historyHook(key, before, after);
		if (broadcastHook) broadcastHook(key, after);
	}
	return after;
}

// ---- element / screen editing (all through the write path) ---------------------

/** @param {string} key @param {string} screenId @param {(screen: HudScreen) => HudScreen} fn */
function editScreen(key, screenId, fn) {
	const doc = hudDocOf(key) ?? normalizeHudDoc({});
	const screens = doc.screens.map((s) => (s.id === screenId ? fn(s) : s));
	return setHudDocFor(key, { ...doc, screens });
}

/** @param {string} key @param {string} screenId @param {any} element @returns {HudElement} */
export function addHudElement(key, screenId, element) {
	const el = normalizeHudElement({ id: newElementId(element?.kind), ...element });
	editScreen(key, screenId, (screen) => ({ ...screen, elements: [...screen.elements, el] }));
	return el;
}

/** @param {string} key @param {string} screenId @param {string} elementId @param {any} patch */
export function updateHudElement(key, screenId, elementId, patch) {
	editScreen(key, screenId, (screen) => ({
		...screen,
		elements: screen.elements.map((el) =>
			el.id === elementId ? normalizeHudElement({ ...el, ...patch }) : el
		)
	}));
}

/** @param {string} key @param {string} screenId @param {string[]} elementIds */
export function removeHudElements(key, screenId, elementIds) {
	const drop = new Set(elementIds);
	editScreen(key, screenId, (screen) => ({
		...screen,
		elements: screen.elements.filter((el) => !drop.has(el.id))
	}));
}

/** @param {string} key @param {string} name @returns {string} the new screen's id */
export function addHudScreen(key, name) {
	const doc = hudDocOf(key) ?? normalizeHudDoc({});
	const id = 'screen-' + (doc.screens.length + 1) + '-' + Math.floor(Math.random() * 1e6).toString(36);
	setHudDocFor(key, {
		...doc,
		screens: [...doc.screens, normalizeHudScreen({ id, name: name || 'Screen ' + (doc.screens.length + 1) })]
	});
	return id;
}

/** @param {string} key @param {string} screenId */
export function removeHudScreen(key, screenId) {
	const doc = hudDocOf(key);
	if (!doc || doc.screens.length <= 1) return false; // a document always has one screen
	const screens = doc.screens.filter((s) => s.id !== screenId);
	setHudDocFor(key, {
		...doc,
		screens,
		active: doc.active === screenId ? screens[0].id : doc.active
	});
	return true;
}

/** The AUTHORED default screen — replicated document data, unlike the local override.
 * @param {string} key @param {string} screenId */
export function setActiveHudScreen(key, screenId) {
	const doc = hudDocOf(key);
	if (!doc || !doc.screens.some((s) => s.id === screenId)) return false;
	setHudDocFor(key, { ...doc, active: screenId });
	return true;
}

// ---- persistence (four paths, none sharing a serializer) ----------------------

/**
 * Every HUD document, for a save. `null` when there is nothing authored, so a default
 * scene saves BYTE-IDENTICAL and an older build reading the file sees no field at all
 * (the scenePostSnapshot precedent). Orphans are pruned from the OUTPUT only — the live
 * store keeps them, so undoing an object delete finds its HUD intact.
 * @param {{pruneMissing?: (uuid: string) => boolean}} [opts] @returns {Record<string, any>|null}
 */
export function hudDocsSnapshot(opts = {}) {
	const all = get(hudDocs);
	/** @type {Record<string, any>} */
	const out = {};
	for (const [key, doc] of Object.entries(all)) {
		if (key !== HUD_SCENE_KEY && opts.pruneMissing?.(key)) continue;
		out[key] = normalizeHudDoc(doc);
	}
	return Object.keys(out).length ? out : null;
}

/**
 * Reinstate saved documents. A restore is an AUTHORITATIVE LOCAL WRITE that must win over
 * the file's stale `changedAt`, so it stamps fresh — and it goes in silent, because a
 * restore is neither an undo step nor something to echo back.
 *
 * `replicate` exists because loading a scene into a LIVE room must bring its HUD with it.
 * @param {Record<string, any>|null} map @param {boolean} [replace] wipe first (a scene
 *   LOAD replaces the world; an autosave restore merges into it)
 * @param {boolean} [replicate] broadcast the result (a session load in a live room)
 */
export function hudDocsRestore(map, replace = false, replicate = false) {
	if (replace) {
		hudDocs.set({});
		hudScreenOverride.set({});
		hudSelection.set({});
		// 21-D4: input values are PLAY-TIME state, not scene data - a loaded scene starts
		// from its authored defaults rather than inheriting the last game's settings, which
		// is also why they are not in the snapshot.
		clearHudValues();
	}
	if (!map || typeof map !== 'object') return;
	const stamp = Date.now();
	let i = 0;
	for (const [key, doc] of Object.entries(map)) {
		if (!doc) continue;
		setHudDocFor(key, normalizeHudDoc(doc), {
			// monotonic even inside one restore: several keys land in the same millisecond
			silent: !replicate,
			stamp: stamp + i++
		});
	}
}

/** Test/serializer seam: drop everything (a scene load replaces all documents). */
export function clearHudDocs() {
	hudDocs.set({});
	hudScreenOverride.set({});
	hudSelection.set({});
	activeHudDoc.set(null);
}
