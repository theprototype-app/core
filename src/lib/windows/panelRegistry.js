// 70 W2 — THE PANELS THAT CAN POP OUT, as data: what each is called, its icon, how its component
// loads, and the store that says (and sets) whether it is open. $lib/windows/panelHost mounts a
// registered panel in a pop-out window with `popped: true`; every component listed here takes that
// prop (it forces the floating layout and skips the main window's chrome duties: the dock slot,
// layout restore, the dock-mode arm, sidebar membership).
//
// Not here, on purpose: the Objects list (it lives inside the toolbar's Controls component), the
// phone content tabs, file previews and the Image editor (one per opened file) — they stay in the
// main window.
import { derived, get } from 'svelte/store';
import {
	flowGraphClose,
	flowCodeClose,
	animationClose,
	uvEditorClose,
	shaderEditorClose,
	hudEditorClose,
	timelineClose,
	explorerClose,
	profilerClose,
	codeWorkspaceClose,
	inspectorClose,
	chatHidden,
	aiAssistantHidden
} from '../../stores/appStore';
import { debugOpen, setDebugOpen } from '../flowDebug';
import { DOCK_TITLES, DOCK_ICONS } from '../bottomDock';
import { inspectorTabTitle } from '../sidebars';

/**
 * @typedef {{
 *   key: string,
 *   title: () => string,
 *   icon: string,
 *   load: () => Promise<any>,
 *   wrap?: 'flow',
 *   isOpen: import('svelte/store').Readable<boolean>,
 *   open: () => void,
 *   close: () => void
 * }} PanelEntry
 */

/** a panel whose open state is an inverted `…Close` store @param {import('svelte/store').Writable<boolean>} store */
const closeStore = (store) => ({ isOpen: derived(store, (v) => !v), open: () => store.set(false), close: () => store.set(true) });
/** a panel whose open state is a `''|'hidden'` class @param {import('svelte/store').Writable<string>} store */
const hiddenClass = (store) => ({ isOpen: derived(store, (v) => v === ''), open: () => store.set(''), close: () => store.set('hidden') });
/** @param {string} key */
const dockTitle = (key) => () => DOCK_TITLES[key] ?? key;

/** @type {PanelEntry[]} */
const ENTRIES = [
	{ key: 'flow', title: dockTitle('flow'), icon: DOCK_ICONS.flow, load: () => import('../../components/Flow.svelte'), ...closeStore(flowGraphClose) },
	{ key: 'flowcode', title: dockTitle('flowcode'), icon: DOCK_ICONS.flowcode, load: () => import('../../components/editors/FlowCode.svelte'), ...closeStore(flowCodeClose) },
	{ key: 'animation', title: dockTitle('animation'), icon: DOCK_ICONS.animation, load: () => import('../../components/editors/AnimationWindow.svelte'), ...closeStore(animationClose) },
	{ key: 'uv', title: dockTitle('uv'), icon: DOCK_ICONS.uv, load: () => import('../../components/editors/UvEditor.svelte'), ...closeStore(uvEditorClose) },
	{ key: 'shader', title: dockTitle('shader'), icon: DOCK_ICONS.shader, load: () => import('../../components/editors/ShaderEditor.svelte'), wrap: 'flow', ...closeStore(shaderEditorClose) },
	{ key: 'hud', title: dockTitle('hud'), icon: DOCK_ICONS.hud, load: () => import('../../components/editors/HudEditor.svelte'), ...closeStore(hudEditorClose) },
	{ key: 'timeline', title: dockTitle('timeline'), icon: DOCK_ICONS.timeline, load: () => import('../../components/editors/TimelineEditor.svelte'), ...closeStore(timelineClose) },
	{ key: 'explorer', title: dockTitle('explorer'), icon: DOCK_ICONS.explorer, load: () => import('../../components/editors/Explorer.svelte'), ...closeStore(explorerClose) },
	{ key: 'profiler', title: dockTitle('profiler'), icon: DOCK_ICONS.profiler, load: () => import('../../components/editors/Profiler.svelte'), ...closeStore(profilerClose) },
	{ key: 'code', title: dockTitle('code'), icon: DOCK_ICONS.code, load: () => import('../../components/editors/CodeWorkspace.svelte'), ...closeStore(codeWorkspaceClose) },
	{ key: 'inspector', title: () => get(inspectorTabTitle), icon: 'sliders-horizontal', load: () => import('../../components/menu/Inspector.svelte'), ...closeStore(inspectorClose) },
	{
		key: 'debugger',
		title: () => 'Debugger',
		icon: 'bug',
		load: () => import('../../components/editors/FlowDebugger.svelte'),
		isOpen: debugOpen,
		open: () => setDebugOpen(true),
		close: () => setDebugOpen(false)
	},
	{ key: 'aiAssistant', title: dockTitle('aiAssistant'), icon: DOCK_ICONS.aiAssistant, load: () => import('../../components/menu/AiAssistant.svelte'), ...hiddenClass(aiAssistantHidden) },
	{ key: 'chat', title: dockTitle('chat'), icon: DOCK_ICONS.chat, load: () => import('../../components/menu/Chat.svelte'), ...hiddenClass(chatHidden) }
];

/** key -> entry */
export const PANELS = /** @type {Record<string, PanelEntry>} */ (Object.fromEntries(ENTRIES.map((e) => [e.key, e])));
/** every poppable key, in menu order */
export const POPPABLE = ENTRIES.map((e) => e.key);

/** @param {string} key */
export function isPoppable(key) {
	return Object.hasOwn(PANELS, key);
}

/** every panel's name, live (the Inspector's is Properties / Configure Scene / File): the window chrome
 * and the popups' document titles follow it */
export const panelTitles = derived(inspectorTabTitle, () => /** @type {Record<string, string>} */ (Object.fromEntries(ENTRIES.map((e) => [e.key, e.title()]))));

/** the panel's name (a tab label, a window title) @param {string} key */
export function panelTitle(key) {
	return PANELS[key]?.title() ?? DOCK_TITLES[key] ?? key;
}

/** is the panel open (anywhere)? @param {string} key */
export function panelIsOpen(key) {
	const e = PANELS[key];
	return !!e && get(e.isOpen);
}
