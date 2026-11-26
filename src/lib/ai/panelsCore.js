// Roadmap 107 (connector round 3, 107-panels) — THE PANEL REGISTRY, the pure half (a LEAF: imports nothing).
// Every real editor panel / window / dock tab the assistant may name, in one list: its id, the title the
// person sees on its tab, one line on what is inside it, whether it is read-only, and how the app opens it.
// `show` (showTool.js) acts on it and `readPanels` (panels.js) reports it; the connector's UI-state read
// (107-ui-state) takes its panels field from the same read, so the three never disagree.
//
// THE NAME RULE (owner 2026-11-27, "show panel Animation silently opens the Timeline"): a name is a panel's
// id, its title, or one of its aliases — the words people use for THAT panel. Nothing is guessed: an unknown
// name is an error that lists every valid name and every refused surface with its reason.
//
// THE BLOCK RULE (rule 2 of show, unchanged): sign-in, account, consent, publishing, connected apps, payment
// and settings stay the person's own to open. It is matched on WHOLE WORDS, so "Profiler" is not "profile"
// and "Statistics" is not refused — the read-only views (Profiler, Statistics) are not settings.

/**
 * @typedef {'toggle' | 'hosted' | 'inspector' | 'scene' | 'chat' | 'debugger'} PanelVia
 *   toggle     panelToggles.togglePanel / dockMenu.focusWindow / closeDockView (the dockable editors)
 *   hosted     dockHost.HOSTED[key] (floating windows the dock can host)
 *   inspector  the selection's Properties (showSidebar 'properties')
 *   scene      Configure Scene, the Inspector's other tab (showSidebar 'scene')
 *   chat       the Chat window on its Session or Assistant tab
 *   debugger   the flow Debugger (flowDebug.setDebugOpen)
 * @typedef {{
 *   id: string,
 *   key: string,
 *   title: string,
 *   description: string,
 *   via: PanelVia,
 *   readOnly?: boolean,
 *   aliases?: string[],
 *   panes?: Record<string, string>
 * }} PanelDef
 */

/**
 * Every panel, in the order the person meets them. `key` is the app's own window key (dockMenu.windowWhere,
 * the dock, the sidebars); `panes` names a panel's own sidebars that show {state: collapse | expand, pane}
 * opens and closes (the WindowShell primary / secondary panes, the Code workspace's two sidebars).
 * @type {PanelDef[]}
 */
export const PANELS = [
	{ id: 'explorer', key: 'explorer', title: 'Explorer', via: 'toggle', description: 'The Library: the person\'s files and folders as a folder tree and a file list', aliases: ['library', 'files', 'file explorer', 'file browser'], panes: { tree: 'the folder tree (left)', details: 'the file details and settings sidebar (right)' } },
	{ id: 'objects', key: 'objects', title: 'Objects', via: 'toggle', description: 'Every object in the scene as a tree (the outliner)', aliases: ['outliner', 'object list', 'hierarchy', 'scene tree'] },
	{ id: 'inspector', key: 'inspector', title: 'Inspector', via: 'inspector', description: 'The selected object\'s properties (the Properties tab: transform, look, physics, lights, cameras)', aliases: ['properties', 'properties panel', 'object properties'] },
	{ id: 'scene', key: 'scene', title: 'Configure Scene', via: 'scene', description: 'The scene\'s own setup: sky, light, fog, physics, grid (the Inspector\'s other tab)', aliases: ['configure scene', 'scene setup', 'environment', 'sky'] },
	{ id: 'flow', key: 'flow', title: 'Flow editor', via: 'toggle', description: 'The node editor: an object\'s or the scene\'s behaviour as a node graph', aliases: ['node editor', 'flow', 'nodes', 'flow graph', 'behaviours', 'graph editor'] },
	{ id: 'animation', key: 'animation', title: 'Animation', via: 'toggle', description: 'The Animation editor: keyframes and clips for the selected object (its own moves, not the Timeline\'s shots)', aliases: ['animation editor', 'animator', 'keyframes', 'dope sheet'] },
	{ id: 'timeline', key: 'timeline', title: 'Timeline', via: 'toggle', description: 'The Timeline: cutscene sequences of camera shots, clips, audio and events', aliases: ['sequencer', 'sequences', 'cutscenes'], panes: { sequences: 'the sequences list (left)', details: 'the selected track\'s details (right)' } },
	{ id: 'uv', key: 'uv', title: 'UV editor', via: 'toggle', description: 'The selected mesh\'s UV map over its texture, with paint and UV tools', aliases: ['uv', 'uvs', 'uv map', 'texture editor'], panes: { materials: 'the materials list (left)', tools: 'the Tool and Settings sidebar (right)' } },
	{ id: 'shader', key: 'shader', title: 'Shader editor', via: 'toggle', description: 'A material\'s shader as a node graph', aliases: ['shader', 'shader graph', 'shaders', 'material graph'] },
	{ id: 'hud', key: 'hud', title: 'HUD editor', via: 'toggle', description: 'The on-screen HUD (buttons, text, bars) the scene shows while it plays, screen by screen', aliases: ['hud', 'ui editor', 'hud screens'], panes: { screens: 'the screens list (left)', properties: 'the selected element\'s properties (right)' } },
	{ id: 'code', key: 'code', title: 'Code', via: 'toggle', description: 'The Code workspace: scripts, behaviours, flow code and graph JSON in tabs', aliases: ['code editor', 'code workspace', 'scripts', 'script editor'], panes: { files: 'Open editors and Project (left)', tools: 'Outline, Problems, Bound nodes, Find in files (right)' } },
	{ id: 'profiler', key: 'profiler', title: 'Profiler', via: 'toggle', readOnly: true, description: 'Read-only: frame time and draw calls over time, recordings, and what draws most', aliases: ['performance', 'frame profiler', 'live profiler'], panes: { recordings: 'the recordings list (left)', details: 'the selected frame\'s details (right)' } },
	{ id: 'stats', key: 'stats', title: 'Statistics', via: 'hosted', readOnly: true, description: 'Read-only: the scene budget (draw calls, triangles, textures, memory) against the device profile', aliases: ['stats', 'scene budget', 'scene statistics', 'budget'] },
	{ id: 'assets', key: 'assets', title: 'Free assets', via: 'hosted', description: 'The free CC0 asset browser (Poly Haven, ambientCG): models, skies and materials to add', aliases: ['assets', 'asset browser', 'cc0 assets', 'free models'] },
	{ id: 'preview', key: 'preview', title: 'Preview', via: 'hosted', description: 'A preview of the file selected in the Explorer (an image, model, sound or video); empty until a file is selected', aliases: ['file preview', 'image preview', 'model preview'] },
	{ id: 'debugger', key: 'debugger', title: 'Debugger', via: 'debugger', description: 'The flow Debugger: breakpoints and the values flowing through nodes while the scene plays', aliases: ['flow debugger', 'debug'] },
	{ id: 'chat', key: 'chat', title: 'Chat', via: 'chat', description: 'The session Chat: messages with the people in this session', aliases: ['session chat', 'messages'] },
	{ id: 'assistant', key: 'chat', title: 'Assistant', via: 'chat', description: 'The in-app AI assistant (the Chat window\'s Assistant tab)', aliases: ['ai assistant', 'ai'] }
];

/** id -> definition */
export const PANEL_BY_ID = /** @type {Record<string, PanelDef>} */ (Object.fromEntries(PANELS.map((p) => [p.id, p])));

/**
 * The layout TARGETS show {action: "panel"} also takes by name: the bottom dock and the two sidebar columns.
 * @type {Record<string, {id: string, title: string, description: string, aliases: string[]}>}
 */
export const TARGETS = {
	dock: { id: 'dock', title: 'Dock', description: 'The bottom dock: a strip of tabs under the 3D view (close = minimize, every tab stays open)', aliases: ['bottom dock', 'bottom panel', 'the dock'] },
	left: { id: 'left', title: 'Left sidebar', description: 'The left sidebar column and its tabs (close = hide it, every tab stays open)', aliases: ['left sidebar', 'left panel', 'left column'] },
	right: { id: 'right', title: 'Right sidebar', description: 'The right sidebar column and its tabs (close = hide it, every tab stays open)', aliases: ['right sidebar', 'right panel', 'right column'] }
};

/**
 * Surfaces show never opens (rule 2), grouped by the reason it gives. `words` are matched as whole words.
 * @type {{reason: string, names: string[], words: string[]}[]}
 */
export const BLOCKED = [
	{ reason: 'sign-in and account', names: ['Sign in', 'Account', 'Profile'], words: ['sign in', 'signin', 'log in', 'login', 'log out', 'logout', 'sign out', 'account', 'profile', 'password'] },
	{ reason: 'consent and privacy', names: ['Consent', 'Privacy'], words: ['consent', 'privacy', 'cookies'] },
	{ reason: 'publishing and export', names: ['Publish', 'Export', 'Share'], words: ['publish', 'publishing', 'export', 'share'] },
	{ reason: 'connected apps', names: ['Connected apps', 'Connect Claude', 'Generate 3D'], words: ['connected apps', 'connected app', 'connect claude', 'connector', 'generate 3d', 'mesh generator', 'meshy'] },
	{ reason: 'payment', names: ['Payment', 'Billing', 'Subscription'], words: ['payment', 'payments', 'billing', 'subscription', 'credits'] },
	{ reason: 'settings', names: ['Settings', 'Preferences'], words: ['settings', 'preferences', 'options'] },
	{ reason: 'session access', names: ['Roles', 'Permissions', 'Invite'], words: ['roles', 'permissions', 'invite', 'approve'] }
];

/** @param {string} name @returns {string} lower-case, single-spaced, no "panel"/"window"/"tab"/"view"/"the"/"editor" noise */
export function normalName(name) {
	return String(name ?? '')
		.toLowerCase()
		.replace(/[_\-./]+/g, ' ')
		.replace(/\b(panel|window|tab|view|pane|the|open|show)\b/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** every spelling a panel answers to, normalised @param {PanelDef | {id: string, title: string, aliases?: string[]}} p */
const spellings = (p) => [p.id, p.title, ...(p.aliases ?? [])].map(normalName);

/** normalised spelling -> panel id (built once; a unit test keeps it free of collisions) */
const NAME_TO_ID = /** @type {Map<string, string>} */ (new Map());
for (const p of PANELS) for (const s of spellings(p)) if (!NAME_TO_ID.has(s)) NAME_TO_ID.set(s, p.id);
const NAME_TO_TARGET = /** @type {Map<string, string>} */ (new Map());
for (const t of Object.values(TARGETS)) for (const s of spellings(t)) if (!NAME_TO_TARGET.has(s)) NAME_TO_TARGET.set(s, t.id);

/** the panel a name means — exactly, never a near guess — or null @param {string} name */
export function panelOf(name) {
	const n = normalName(name);
	if (!n) return null;
	return NAME_TO_ID.get(n) ?? NAME_TO_ID.get(n.replace(/ editor$/, '')) ?? null;
}

/** the layout target ('dock' | 'left' | 'right') a name means, or null @param {string} name */
export function targetOf(name) {
	const n = normalName(name);
	if (!n) return null;
	return NAME_TO_TARGET.get(n) ?? null;
}

/** @param {string} hay @param {string} word */
const hasWord = (hay, word) => (' ' + hay + ' ').includes(' ' + word + ' ');

/** the reason a name is refused (rule 2), or null. A real panel's own name is never refused. @param {string} name */
export function blockedReason(name) {
	if (panelOf(name) || targetOf(name)) return null;
	const n = normalName(name);
	if (!n) return null;
	for (const b of BLOCKED) if (b.words.some((w) => hasWord(n, normalName(w)))) return b.reason;
	return null;
}

/** is this a surface rule 2 keeps closed @param {string} name */
export function deniedPanel(name) {
	return blockedReason(name) !== null;
}

/** the valid names, for an error: every panel title, then the targets */
export function validNames() {
	return [...PANELS.map((p) => p.title), ...Object.values(TARGETS).map((t) => t.title)];
}

/** the refused surfaces, by reason, for an error and the panels list */
export function blockedList() {
	return BLOCKED.map((b) => ({ reason: b.reason, names: b.names }));
}

/** one line naming the refused surfaces by reason */
export function blockedLine() {
	return BLOCKED.map((b) => b.reason + ' (' + b.names.join(', ') + ')').join('; ');
}

/** the error for a name that is neither a panel, a target nor a refused surface @param {string} asked */
export function unknownPanelError(asked) {
	return {
		error: 'no panel "' + String(asked).slice(0, 60) + '": nothing was opened. The panels are ' + validNames().join(', ') + '. Never opened (the person\'s own): ' + blockedLine() + '. show {action: "panels"} lists each one with what it contains and whether it is open.',
		valid: validNames(),
		blocked: blockedList()
	};
}

/** the pane a panel's own sidebar name means, or null @param {PanelDef} p @param {string} pane */
export function paneOf(p, pane) {
	if (!p.panes) return null;
	const n = normalName(pane);
	if (Object.hasOwn(p.panes, n)) return n;
	const keys = Object.keys(p.panes);
	// left / right / sidebar words: the first pane is the left one, the second the right one
	if (/^(left|primary|first)( sidebar)?$/.test(n)) return keys[0] ?? null;
	if (/^(right|secondary|second)( sidebar)?$/.test(n) && keys[1]) return keys[1];
	return null;
}
