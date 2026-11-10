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
	codeWorkspaceClose,
	hudEditorClose,
	timelineClose,
	profilerClose,
	chatHidden,
	aiAssistantHidden
} from '../stores/appStore';
import { bottomDockActive } from './bottomDock';
import { statsOpen } from './sceneBudget';
import { assetBrowserOpen } from './cc0/assetBrowserState.js';

// #20 P5: the WORKSPACE — which panels, windows and drawers were open.
//
// WHEN IT COMES BACK is the whole design, and it is the user's call (2026-08-18, revising
// the original fork): a plain page reload comes up in the DEFAULT state, everything
// closed. The layout is restored ONLY by an explicit act —
//
//   * clicking Restore on the session prompt,
//   * the auto-restore setting doing that for you,
//   * or loading a scene from a file.
//
// So the snapshot rides the SAVED PAYLOAD (autosave + sessions + .tpscene) next to the
// selection and the edit session, and there is deliberately NO localStorage copy and no
// boot-time apply. A reload is a clean slate unless you asked for your scene back — and
// if you did, you get the windows you had with it.
//
// This module is store-only: no THREE, no scene, no wire. It stays a leaf so `editResume`
// can reach it without pulling anything into sessions.js's import subtree.

/**
 * The panel stores, by the name they persist under. The `*Close` ones are INVERTED
 * (true = closed) — a bug factory if each site re-derives it, so the sense is recorded
 * ONCE here and `open` in the record always means open. `hidden` (78 PL3) marks the two
 * windows whose store holds a CLASS ('' open, 'hidden' closed): Chat and the AI assistant.
 * @type {{name: string, store: any, closed: boolean, hidden?: boolean, openOnly?: boolean}[]}
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
	{ name: 'code', store: codeWorkspaceClose, closed: true },
	// 21-H2: `library` retired with Library.svelte (an unreachable second home for
	// prefabs). A saved payload naming it is simply not in this table any more, and
	// `applyWorkspace` walks the TABLE — so an old record restores everything it still
	// recognises and ignores that key without so much as a warning. That is the
	// "restore less, never more" rule doing its job, not a special case for it.
	{ name: 'notes', store: notesDrawerOpen, closed: false },
	// 78 PL3 (the open / size audit): the windows a reload + Restore did NOT bring back — the HUD editor,
	// the Timeline, the Profiler, Statistics, Free assets, Chat and the AI assistant. An older record has
	// none of these names, so it leaves them alone ("restore less, never more").
	{ name: 'hud', store: hudEditorClose, closed: true },
	{ name: 'timeline', store: timelineClose, closed: true },
	{ name: 'profiler', store: profilerClose, closed: true },
	{ name: 'stats', store: statsOpen, closed: false },
	{ name: 'assets', store: assetBrowserOpen, closed: false },
	{ name: 'chat', store: chatHidden, closed: false, hidden: true },
	// uir-chat (1.65): the AI assistant is the Chat window's Assistant tab, and `aiAssistantHidden` an alias over chatHidden +
	// chatTab. `true` = Chat open with Assistant in front; `false` says nothing — `chat` above decides open or closed. An alias
	// that CLOSED on false would shut Chat itself whenever a record (a 1.64 one, or Chat open on Session) met Assistant in front.
	{ name: 'aiAssistant', store: aiAssistantHidden, closed: false, hidden: true, openOnly: true }
];

/** is this panel open right now @param {{store: any, closed: boolean, hidden?: boolean}} panel */
function isOpenNow(panel) {
	const v = get(panel.store);
	if (panel.hidden) return v === '';
	return panel.closed ? !v : !!v;
}
/** open / close one panel @param {{store: any, closed: boolean, hidden?: boolean, openOnly?: boolean}} panel @param {boolean} open */
function setOpen(panel, open) {
	if (panel.hidden) panel.store.set(open ? '' : 'hidden');
	else panel.store.set(panel.closed ? !open : open);
}

/**
 * Read the live workspace, for a save payload. `always` (a named layout) returns the record
 * even when nothing is open.
 * @param {{always?: boolean}} [opts]
 *
 * Returns NULL when nothing is open, and that is deliberate on two counts: a scene with
 * no windows open adds no field to its file (so an ordinary save stays as small and as
 * comparable as it was), and restoring such a scene does not go and CLOSE the panels you
 * happen to have open. "Restore less, never more" is this module's rule, and closing
 * somebody's windows because the author had none is the aggressive reading of it.
 * @returns {any|null}
 */
export function snapshotWorkspace({ always = false } = {}) {
	/** @type {any} */
	const open = {};
	let any = false;
	for (const panel of PANELS) {
		const isOpen = isOpenNow(panel);
		open[panel.name] = isOpen;
		if (isOpen) any = true;
	}
	// 37 R14: a named layout records "nothing open" too — applying it is asked for
	if (!any && !always) return null;
	return {
		open,
		dockTab: get(bottomDockActive),
		inspector: { kind: get(inspectorKind), pinned: get(inspectorPinned) }
	};
}

/**
 * Apply a workspace record.
 *
 * Unknown or missing fields are LEFT ALONE rather than defaulted, so a record written by
 * an older build (or a newer one) can only ever restore less — it can never close
 * something it has never heard of.
 * @param {any} record
 */
export function applyWorkspace(record) {
	if (!record || typeof record !== 'object') return false;
	const open = record.open && typeof record.open === 'object' ? record.open : {};
	for (const panel of PANELS) {
		const want = open[panel.name];
		if (typeof want !== 'boolean') continue;
		if (panel.openOnly && !want) continue;
		setOpen(panel, want);
	}
	if (typeof record.dockTab === 'string') bottomDockActive.set(record.dockTab);
	if (record.inspector && typeof record.inspector === 'object') {
		if (typeof record.inspector.kind === 'string') inspectorKind.set(record.inspector.kind);
		if (typeof record.inspector.pinned === 'boolean') inspectorPinned.set(record.inspector.pinned);
	}
	return true;
}

/** Close every panel this module knows about — the state a plain reload lands in, and
 *  what a restore of a scene that had nothing open should produce. */
export function closeWorkspace() {
	for (const panel of PANELS) setOpen(panel, false);
}
