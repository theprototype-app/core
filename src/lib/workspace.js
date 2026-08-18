import { get } from 'svelte/store';
import {
	inspectorClose,
	inspectorKind,
	inspectorPinned,
	flowGraphClose,
	flowCodeClose,
	animationClose,
	uvEditorClose,
	shaderEditorClose,
	explorerClose,
	objectListClose,
	notesDrawerOpen,
	libraryClose
} from '../stores/appStore';
import { bottomDockActive } from './bottomDock';

// #20 P5: the WORKSPACE — which panels are open, restored across a reload.
//
// Two halves with deliberately different scopes, and the split is the whole design:
//
//   LAYOUT is personal and LOCAL. Which panels you keep open is a preference, like a
//   theme, so it lives in localStorage and never rides a scene. Opening somebody
//   else's .tpscene must not rearrange your screen.
//
//   SELECTION and the EDIT SESSION are part of "where the author left off", so those
//   DO ride a .tpscene — see sessions.js. Re-picking eleven quads to resume a bevel is
//   the annoying part; re-opening a panel is not.
//
// Everything here is store-only: no THREE, no scene, no wire. One localStorage record
// rather than a key per panel, so a partial write cannot leave half a workspace.

const KEY = 'workspaceLayout';
const ls = typeof localStorage !== 'undefined' ? localStorage : null;

/**
 * The panel stores, by the name they persist under. Note the `*Close` ones are
 * INVERTED (true = closed) — a bug factory if each site re-derives it, so the sense is
 * recorded ONCE here and `open` in the record always means open.
 * @type {{name: string, store: any, closed: boolean}[]}
 */
const PANELS = [
	{ name: 'inspector', store: inspectorClose, closed: true },
	{ name: 'flow', store: flowGraphClose, closed: true },
	{ name: 'flowcode', store: flowCodeClose, closed: true },
	{ name: 'animation', store: animationClose, closed: true },
	{ name: 'uv', store: uvEditorClose, closed: true },
	{ name: 'shader', store: shaderEditorClose, closed: true },
	{ name: 'explorer', store: explorerClose, closed: true },
	{ name: 'objectList', store: objectListClose, closed: true },
	{ name: 'library', store: libraryClose, closed: true },
	{ name: 'notes', store: notesDrawerOpen, closed: false }
];

/** Read the live workspace. @returns {any} */
export function snapshotWorkspace() {
	/** @type {any} */
	const open = {};
	for (const panel of PANELS) open[panel.name] = panel.closed ? !get(panel.store) : !!get(panel.store);
	return {
		open,
		dockTab: get(bottomDockActive),
		inspector: { kind: get(inspectorKind), pinned: get(inspectorPinned) }
	};
}

/**
 * Apply a workspace record. Unknown or missing fields are LEFT ALONE rather than
 * defaulted, so a record written by an older build (or a newer one) can only ever
 * restore less, never close something it has never heard of.
 * @param {any} record
 */
export function applyWorkspace(record) {
	if (!record || typeof record !== 'object') return false;
	const open = record.open && typeof record.open === 'object' ? record.open : {};
	for (const panel of PANELS) {
		const want = open[panel.name];
		if (typeof want !== 'boolean') continue;
		panel.store.set(panel.closed ? !want : want);
	}
	if (typeof record.dockTab === 'string') bottomDockActive.set(record.dockTab);
	if (record.inspector && typeof record.inspector === 'object') {
		if (typeof record.inspector.kind === 'string') inspectorKind.set(record.inspector.kind);
		if (typeof record.inspector.pinned === 'boolean') inspectorPinned.set(record.inspector.pinned);
	}
	return true;
}

/** @returns {any|null} */
export function storedWorkspace() {
	if (!ls) return null;
	try {
		const raw = ls.getItem(KEY);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

export function saveWorkspace() {
	if (!ls) return;
	try {
		ls.setItem(KEY, JSON.stringify(snapshotWorkspace()));
	} catch {
		// a full quota must never break the editor over a layout preference
	}
}

/** @type {any} */
let saveTimer = null;
/** @type {(() => void)[]} */
let unsubscribes = [];
let restored = false;

/**
 * Start persisting, and restore what was stored.
 *
 * The RESTORE runs first and synchronously, before any subscription is wired, for two
 * reasons: a panel bound to the selection would otherwise mount against nothing, and
 * subscribing first means every `set` below re-triggers the save with a half-applied
 * record.
 */
export function startWorkspace() {
	if (restored) return;
	restored = true;
	applyWorkspace(storedWorkspace());

	const schedule = () => {
		if (saveTimer) clearTimeout(saveTimer);
		// debounced: opening a dock tab writes several of these stores in one flush
		saveTimer = setTimeout(saveWorkspace, 400);
	};
	for (const panel of PANELS) unsubscribes.push(panel.store.subscribe(schedule));
	unsubscribes.push(bottomDockActive.subscribe(schedule));
	unsubscribes.push(inspectorKind.subscribe(schedule));
	unsubscribes.push(inspectorPinned.subscribe(schedule));
}

/** Test/teardown seam. */
export function stopWorkspace() {
	for (const off of unsubscribes) off();
	unsubscribes = [];
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = null;
	restored = false;
}
