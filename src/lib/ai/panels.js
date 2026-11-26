// Roadmap 107 (107-panels) — THE PANEL REGISTRY, the live half (a lazy chunk: showTool.js and the UI-state read
// load it on first use). panelsCore.js is the list; this module asks the app where each panel is and whether the
// person can see it, and opens, closes, brings forward, moves and maximizes through the app's OWN seams
// (panelToggles, dockMenu, dockHost, sidebars, focusMode, the WindowShell panes) so a panel lands where the
// person keeps it and every gesture is one the person could have made.
//
// THE STATE WORDS (owner 2026-11-27: "show panel focus answers changed:false while the panel is not in front"):
//   open     it is open somewhere: a dock tab, a sidebar tab, a floating window or a pop-out window
//   where    'dock' | 'left' | 'right' | 'floating' | 'window' | null (closed)
//   visible  the person can see it now: its dock tab is the one showing and the dock is not minimized, its
//            sidebar tab is in front and the column is on screen, its floating window is its group's tab;
//            never while focus mode hides it or Play mode hides the editor
//   front    visible AND nothing covers it: a floating window is the top window; a dock / sidebar tab in
//            front is front

import { get } from 'svelte/store';
import { PANELS, PANEL_BY_ID, TARGETS, blockedList, paneOf } from './panelsCore.js';
import { inspectorClose, inspectorKind, chatHidden, chatTab, showSidebar, closeSelectionInspector } from '../../stores/appStore';
import { isLocked } from '../../stores/sceneStore';

/** @typedef {import('./panelsCore.js').PanelDef} PanelDef */
/** @typedef {'dock'|'left'|'right'|'floating'|'window'|null} Where */

/** @param {number} frames */
export const waitFrames = (frames) =>
	new Promise((resolve) => {
		let n = 0;
		const step = () => (++n >= frames || typeof requestAnimationFrame === 'undefined' ? resolve(undefined) : requestAnimationFrame(step));
		if (typeof requestAnimationFrame === 'undefined') setTimeout(resolve, frames * 16);
		else requestAnimationFrame(step);
	});

/** the app's modules, loaded once (all already in the editor's chunks) */
async function mods() {
	const [dockMenu, bottomDock, sidebars, focusMode, windowTabs, windowFocus, phone] = await Promise.all([
		import('../dockMenu'),
		import('../bottomDock'),
		import('../sidebars'),
		import('../focusMode'),
		import('../windowTabs'),
		import('../windowFocus'),
		import('../ui/phoneShell.js')
	]);
	return { dockMenu, bottomDock, sidebars, focusMode, windowTabs, windowFocus, phone };
}

/** @typedef {Awaited<ReturnType<typeof mods>>} Mods */

/** where one panel is open @param {PanelDef} p @param {Mods} m @returns {Promise<Where>} */
async function whereOf(p, m) {
	if (p.via === 'debugger') {
		const { debugOpen } = await import('../flowDebug');
		if (!get(debugOpen)) return null;
		const w = m.dockMenu.windowWhere('debugger');
		return w ?? 'floating';
	}
	if (p.via === 'inspector' || p.via === 'scene') {
		const tab = p.via === 'scene' ? 'scene' : 'inspector';
		const tabs = get(m.sidebars.sidebarTabs);
		if (tabs.left.includes(tab)) return 'left';
		if (tabs.right.includes(tab)) return 'right';
		const kind = get(inspectorKind);
		const showing = !get(inspectorClose) && (p.via === 'scene' ? kind === 'scene' : kind !== 'scene');
		if (!showing) return null;
		return get(m.phone.phoneShell) ? 'dock' : 'floating';
	}
	return m.dockMenu.windowWhere(p.key);
}

/**
 * One panel's state, read now.
 * @param {PanelDef} p @param {Mods} m
 * @returns {Promise<{open: boolean, where: Where, visible: boolean, front: boolean, tab?: string}>}
 */
async function stateOf(p, m) {
	const where = await whereOf(p, m);
	if (!where) return { open: false, where: null, visible: false, front: false };
	const playing = get(isLocked) === true;
	const focus = get(m.focusMode.focusMode);
	const key = p.via === 'scene' ? 'scene' : p.key;
	let visible = false;
	let front = false;
	if (where === 'window') {
		visible = true;
		front = true;
	} else if (where === 'dock') {
		visible = !get(m.bottomDock.dockMinimized) && get(m.bottomDock.dockShownKeys).includes(key) && focus !== 'viewport';
		if (get(m.phone.phoneShell) && (p.via === 'inspector' || p.via === 'scene')) visible = true;
		front = visible;
	} else if (where === 'left' || where === 'right') {
		visible = !!get(m.sidebars.sidebarVisible)[where] && !m.sidebars.sidebarTabCovered(key) && !focus;
		front = visible;
	} else {
		const group = m.windowTabs.groupOfKey(key);
		visible = (!group || group.active === key) && !focus;
		front = visible && (m.windowFocus.isTopVisibleWindow(key) || p.via === 'inspector' || p.via === 'scene');
	}
	if (playing) visible = front = false;
	// the Chat window holds two panels: the one on its other tab is open but not showing
	if (p.via === 'chat') {
		const tab = get(chatTab);
		const mine = p.id === 'assistant' ? 'assistant' : 'session';
		if (tab !== mine) visible = front = false;
		return { open: true, where, visible, front, tab };
	}
	return { open: true, where, visible, front };
}

/** the dock and the two sidebar columns, read now @param {Mods} m */
function targetsState(m) {
	const b = m.bottomDock;
	const showing = get(b.visibleDockKey);
	const minimized = get(b.dockMinimized);
	const vis = get(m.sidebars.sidebarVisible);
	const tabs = get(m.sidebars.sidebarTabs);
	const shown = get(m.sidebars.sidebarShown);
	const title = (/** @type {string} */ k) => PANELS.find((p) => p.key === k || (p.via === 'scene' && k === 'scene'))?.title ?? b.DOCK_TITLES[k] ?? k;
	return {
		dock: {
			open: (!!showing && !minimized) || get(b.dockEmptyShown),
			minimized: !!showing && minimized,
			front: showing ? title(showing) : null,
			tabs: get(b.dockTabs).map((t) => title(t.key))
		},
		left: { open: !!vis.left, front: shown.left ? title(shown.left) : null, tabs: tabs.left.map(title) },
		right: { open: !!vis.right, front: shown.right ? title(shown.right) : null, tabs: tabs.right.map(title) }
	};
}

/** a panel's own sidebars (panes), when it has any and they are mounted @param {PanelDef} p */
async function panesState(p) {
	if (!p.panes) return undefined;
	const out = /** @type {Record<string, boolean | null>} */ ({});
	const names = Object.keys(p.panes);
	if (p.id === 'code') {
		const { codeLeftOpen, codeRightOpen } = await import('../codeSidebars');
		out[names[0]] = !!get(codeLeftOpen);
		out[names[1]] = !!get(codeRightOpen);
		return out;
	}
	const { panesOf } = await import('../windowPanes.js');
	const api = panesOf(p.key);
	if (!api) return undefined;
	const s = api.status();
	out[names[0]] = s.primary.available ? s.primary.open : null;
	if (names[1]) out[names[1]] = s.secondary.available ? s.secondary.open : null;
	return out;
}

/** one panel's read @param {string} id */
export async function readPanel(id) {
	const p = PANEL_BY_ID[id];
	if (!p) return null;
	const m = await mods();
	const s = await stateOf(p, m);
	const panes = s.open ? await panesState(p) : undefined;
	return { id: p.id, title: p.title, ...s, ...(panes ? { panes } : {}) };
}

/**
 * THE READ every surface shares (show {action: "panels"}, the connector's UI-state panels field): every
 * panel with what it contains and its state now, the refused surfaces by reason, the dock and sidebars,
 * focus mode, and the named layouts.
 */
export async function readPanels() {
	const m = await mods();
	const panels = [];
	for (const p of PANELS) {
		const s = await stateOf(p, m);
		const panes = s.open ? await panesState(p) : undefined;
		panels.push({
			id: p.id,
			title: p.title,
			description: p.description,
			readOnly: !!p.readOnly,
			...s,
			...(p.panes ? { paneNames: Object.keys(p.panes) } : {}),
			...(panes ? { panes } : {})
		});
	}
	const { uiLayouts, activeLayoutId } = await import('../uiLayouts');
	const layouts = /** @type {any[]} */ (get(uiLayouts)).map((l) => l.name);
	const activeId = get(activeLayoutId);
	const active = /** @type {any[]} */ (get(uiLayouts)).find((l) => l.id === activeId)?.name ?? null;
	return {
		panels,
		blocked: blockedList(),
		...targetsState(m),
		focusMode: get(m.focusMode.focusMode),
		playing: get(isLocked) === true,
		phone: !!get(m.phone.phoneShell),
		layouts: { names: layouts, active },
		targets: Object.values(TARGETS).map((t) => ({ id: t.id, title: t.title, description: t.description }))
	};
}

// ---------------------------------------------------------------- acting

/** open a panel where it lives (or brings it forward when it is open) @param {PanelDef} p */
export async function openPanel(p) {
	if (p.via === 'inspector') return showSidebar('properties', { focus: true });
	const { focusWindow } = await import('../dockMenu');
	if (p.via === 'scene') {
		if (focusWindow('scene')) return;
		if (!get(inspectorClose) && get(inspectorKind) === 'scene') return;
		return showSidebar('scene', { focus: true });
	}
	if (p.via === 'chat') {
		const { openChatTab } = await import('../chat/chatWindow.js');
		return openChatTab(p.id === 'assistant' ? 'assistant' : 'session');
	}
	if (p.via === 'debugger') {
		const { setDebugOpen } = await import('../flowDebug');
		if (focusWindow('debugger')) return;
		setDebugOpen(true);
		const { raiseWindow } = await import('../windowFocus');
		await waitFrames(2);
		raiseWindow('debugger');
		return;
	}
	if (focusWindow(p.key)) return;
	if (p.via === 'toggle') {
		const { togglePanel } = await import('../panelToggles');
		return togglePanel(p.key);
	}
	const { HOSTED } = await import('../dockHost');
	HOSTED[p.key]?.open();
}

/** close a panel @param {PanelDef} p */
export async function closePanel(p) {
	if (p.via === 'inspector') {
		const { closeInspectorTab, inspectorTabs } = await import('../sidebars');
		if (get(inspectorTabs).inspector) return closeInspectorTab('inspector');
		return closeSelectionInspector();
	}
	if (p.via === 'scene') {
		const { closeInspectorTab, inspectorTabs } = await import('../sidebars');
		if (get(inspectorTabs).scene) return closeInspectorTab('scene');
		if (get(inspectorKind) === 'scene') inspectorClose.set(true);
		return;
	}
	if (p.via === 'chat') return chatHidden.set('hidden');
	if (p.via === 'debugger') {
		const { setDebugOpen } = await import('../flowDebug');
		return setDebugOpen(false);
	}
	if (p.via === 'hosted') {
		const { HOSTED } = await import('../dockHost');
		return HOSTED[p.key]?.close();
	}
	const { closeDockView } = await import('../dockMenu');
	closeDockView(p.key);
}

/**
 * Bring an open panel to the front where it is: its dock tab (un-minimizing the dock), its sidebar tab (showing
 * a hidden column), its floating window (its group's tab, raised and pulled back on screen). Leaves focus mode
 * when focus mode hides it. Returns what it had to undo for Back.
 * @param {PanelDef} p
 * @returns {Promise<{exitedFocus: string | null}>}
 */
export async function bringForward(p) {
	const m = await mods();
	const focus = get(m.focusMode.focusMode);
	const where = await whereOf(p, m);
	const maximized = focus === 'dock' && where === 'dock' && get(m.bottomDock.visibleDockKey) === p.key;
	let exitedFocus = null;
	if (focus && !maximized) {
		m.focusMode.exitFocus();
		exitedFocus = focus;
	}
	await openPanel(p);
	if (where === 'floating' && p.via !== 'inspector' && p.via !== 'scene') {
		// a floating window: raise it whatever the open path did (focusWindow raises only one it can find)
		if (!m.windowFocus.raiseWindow(p.key)) m.windowFocus.raiseWindowNode(m.windowTabs.nodeOf(p.key));
	}
	return { exitedFocus };
}

/**
 * Move an open panel to the dock, a sidebar or a floating window — the "+" menus' and the tab menus' own moves.
 * @param {PanelDef} p @param {'dock'|'left'|'right'|'floating'} to
 * @returns {Promise<{ok: true, from: Where} | {error: string}>}
 */
export async function movePanel(p, to) {
	const m = await mods();
	const from = await whereOf(p, m);
	if (!from) return { error: p.title + ' is not open: open it first (state: "open"), then move it' };
	if (from === to) return { ok: true, from };
	if (from === 'window') return { error: p.title + ' is in its own pop-out window: the person brings it back with its window\'s Dock button' };
	if (p.via === 'inspector' || p.via === 'scene') {
		if (to !== 'left' && to !== 'right') return { error: p.title + ' lives only in a sidebar: to: "left" or "right"' };
		const ok = m.sidebars.moveSidebarTab(p.via === 'scene' ? 'scene' : 'inspector', to);
		return ok ? { ok: true, from } : { error: p.title + ' cannot move there on this screen' };
	}
	if (get(m.phone.phoneShell)) return { error: 'on a phone the panels live in the bottom sheet: moving them is for a wider screen' };
	const key = p.key;
	if (to === 'floating') {
		if (from === 'dock') {
			if (!m.dockMenu.canUndockTab(key)) return { error: p.title + ' has no floating window' };
			m.bottomDock.armDockMode(key, false);
			return { ok: true, from };
		}
		const { floatSidebarTab } = await import('../sidebarMenu');
		return floatSidebarTab(key) ? { ok: true, from } : { error: p.title + ' cannot float' };
	}
	if (to === 'dock' && !m.dockMenu.canDockHere(key)) return { error: p.title + ' cannot be docked' };
	return m.dockMenu.moveWindowTo(key, to) ? { ok: true, from } : { error: p.title + ' cannot move to the ' + (to === 'dock' ? 'dock' : to + ' sidebar') + ' on this screen' };
}

/**
 * Maximize a DOCKED panel (the dock tab menu's "Maximize (focus mode)": it fills the window, everything else
 * hidden, nothing closed) or restore.
 * @param {PanelDef} p @param {boolean} on
 * @returns {Promise<{ok: true, was: string | null} | {error: string}>}
 */
export async function maximizePanel(p, on) {
	const m = await mods();
	const was = get(m.focusMode.focusMode);
	if (!on) {
		m.focusMode.exitFocus();
		return { ok: true, was };
	}
	if (get(isLocked) === true) return { error: 'the person is playing: maximize is for the editor' };
	const where = await whereOf(p, m);
	if (where !== 'dock') return { error: 'maximize fills the window with a DOCKED panel; ' + p.title + ' is ' + (where ? (where === 'floating' ? 'floating' : where === 'window' ? 'in a pop-out window' : 'in the ' + where + ' sidebar') : 'closed') + ': move it first (to: "dock")' };
	m.focusMode.maximizeDockTab(p.key);
	return { ok: true, was };
}

/**
 * Open or close one of a panel's OWN sidebars (panes): the Explorer's folder tree, the Code workspace's files /
 * tools sidebars, the UV / HUD / Timeline / Profiler side panes.
 * @param {PanelDef} p @param {string} paneName @param {boolean} open
 * @returns {Promise<{ok: true, pane: string, was: boolean} | {error: string}>}
 */
export async function setPane(p, paneName, open) {
	if (!p.panes) return { error: p.title + ' has no sidebars of its own to collapse' };
	const pane = paneOf(p, paneName);
	if (!pane) return { error: p.title + '\'s sidebars are ' + Object.entries(p.panes).map(([k, v]) => k + ' (' + v + ')').join(', ') };
	const index = Object.keys(p.panes).indexOf(pane);
	if (p.id === 'code') {
		const { codeLeftOpen, codeRightOpen } = await import('../codeSidebars');
		const store = index === 0 ? codeLeftOpen : codeRightOpen;
		const was = !!get(store);
		store.set(open);
		return { ok: true, pane, was };
	}
	const { panesOf } = await import('../windowPanes.js');
	const api = panesOf(p.key);
	if (!api) return { error: p.title + ' is not on screen: open it first' };
	const s = api.status();
	const side = index === 0 ? s.primary : s.secondary;
	if (!side.available) return { error: p.title + ' shows no ' + pane + ' sidebar here' };
	if (s.locked) return { error: 'the person locked ' + p.title + '\'s sidebars (its handle menu): they unlock it' };
	const was = !!side.open;
	if (index === 0) api.setPrimary(open);
	else api.setSecondary(open);
	return { ok: true, pane, was };
}

/**
 * The dock / a sidebar column as a named target: open, close or toggle. Closing hides; every tab stays open.
 * @param {'dock'|'left'|'right'} id @param {'open'|'close'|'toggle'} state
 * @returns {Promise<{changed: boolean, open: boolean, undo: () => void} | {error: string}>}
 */
export async function setTarget(id, state) {
	const m = await mods();
	if (id === 'dock') {
		const b = m.bottomDock;
		const isOpen = () => (!!get(b.visibleDockKey) && !get(b.dockMinimized)) || get(b.dockEmptyShown);
		const was = isOpen();
		const want = state === 'toggle' ? !was : state === 'open';
		if (want === was) return { changed: false, open: was, undo: () => {} };
		const minBefore = get(b.dockMinimized);
		const emptyBefore = get(b.dockEmptyOpen);
		if (get(m.phone.phoneShell)) {
			const { toggleDock } = await import('../panelToggles');
			toggleDock();
		} else if (get(b.visibleDockKey)) b.dockMinimized.set(!want);
		else b.setDockEmptyOpen(want);
		await waitFrames(1);
		return {
			changed: isOpen() !== was,
			open: isOpen(),
			undo: () => {
				b.dockMinimized.set(minBefore);
				b.dockEmptyOpen.set(emptyBefore);
			}
		};
	}
	if (get(m.phone.phoneShell)) return { error: 'a phone has no sidebar columns: its panels live in the bottom sheet (the dock)' };
	const s = m.sidebars;
	const was = !!get(s.sidebarVisible)[id];
	const want = state === 'toggle' ? !was : state === 'open';
	if (want === was) return { changed: false, open: was, undo: () => {} };
	s.toggleSidebar(id, want);
	await waitFrames(1);
	const now = !!get(s.sidebarVisible)[id];
	return { changed: now !== was, open: now, undo: () => s.toggleSidebar(id, was) };
}
