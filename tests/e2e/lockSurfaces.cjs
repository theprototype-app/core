// 38 R1 — EVERY SURFACE OF THE APP, opened and closed the way the app does it. One registry
// shared by `lock-panels` (each surface opens, shows, closes through its own control) and the
// baseline screenshot tool (tests/e2e/tools/lock-baselines.cjs: every surface at 1440×900 and
// 390×844 in dark, light and a custom .theme.json theme).
//
// `open` drives the debug-hook stores the app's own buttons drive (the sanctioned test API);
// `shown` is what must be on screen once it is open; `closer` is the surface's own close
// control where it has one. A redesign that renames a root id updates `shown` here — the
// list of surfaces is the lock.
const fs = require('fs');
const path = require('path');

const CUSTOM_THEME = path.join(__dirname, 'fixtures', 'lock', 'lock-custom.theme.json');

/** @param {any} page @param {string} name @param {any} value */
const setStore = (page, name, value) =>
	page.evaluate(
		({ name, value }) => {
			const s = name.split('.').reduce((o, k) => o?.[k], /** @type {any} */ (window).__stores);
			s?.set?.(value);
		},
		{ name, value }
	);

/** A small deterministic scene: a box (selected, parked), a sphere, a directional light, and
 * an animation track on the box so the Animation window has rows. @param {any} page */
async function seedScene(page) {
	await page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create sphere');
		s.commandsHandler.sceneCommand('/light directional');
	});
	await page.waitForTimeout(1500);
	return page.evaluate(async () => {
		const s = window.__stores;
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const box = g.children.find((c) => c.name === 'Box');
		const sphere = g.children.find((c) => c.name === 'Sphere');
		const light = g.children.find((c) => c.type === 'DirectionalLight');
		box.position.set(-0.8, 0.5, 0);
		sphere.position.set(0.9, 0.5, 0.3);
		for (const o of [box, sphere]) {
			o.updateMatrix();
			o.userData.physics = { ...(o.userData.physics ?? {}), mode: 'static' };
		}
		const tid = s.animationPreview.addTrack(box.uuid, 'pos.y', box);
		s.animationPreview.updateTrack(box.uuid, tid, { from: 0.5, to: 1.5 });
		s.animationPreview.updateAnim(box.uuid, { duration: 2, loop: 'loop' });
		s.objectActions.flyTo(new s.THREE.Vector3(3.2, 2.4, 4.2), new s.THREE.Vector3(0, 0.5, 0), 0);
		s.objectActions.selectObject(box.uuid);
		return { box: box.uuid, sphere: sphere.uuid, light: light?.uuid };
	});
}

/** Close every surface this registry knows how to open. @param {any} page */
async function closeAll(page) {
	await page.evaluate(() => {
		const s = window.__stores;
		const set = (/** @type {any} */ st, /** @type {any} */ v) => st?.set?.(v);
		set(s.settingsOpen, false);
		for (const k of ['modulesOpen', 'sessionsOpen', 'checkpointsOpen', 'templatesModalOpen', 'characterModalOpen', 'profileSettingsOpen', 'notesDrawerOpen', 'notificationCenterOpen', 'connectDrawerOpen', 'aiPromptBarOpen']) set(s[k], false);
		set(s.meshGenModalOpen, null);
		set(s.storageUsage?.storageModalOpen, false);
		set(s.shortcutsRegistry?.cheatSheetOpen, false);
		set(s.chatHidden, 'hidden');
		set(s.aiAssistantHidden, 'hidden');
		set(s.addMenu, null);
		set(s.viewportMenu, null);
		set(s.closeMenu, true);
		set(s.connectDrawerOpen, false);
		for (const k of ['flowGraphClose', 'flowCodeClose', 'animationClose', 'uvEditorClose', 'shaderEditorClose', 'hudEditorClose', 'profilerClose', 'codeWorkspaceClose', 'explorerClose', 'objectListClose', 'inspectorClose']) set(s[k], true);
	});
	await page.waitForTimeout(350);
}

/** @param {any} page @param {string} key @param {string} closeStore */
async function openDock(page, key, closeStore) {
	await page.evaluate(
		({ key, closeStore }) => {
			const s = window.__stores;
			s[closeStore]?.set?.(false);
			s.bottomDock.dockMinimized?.set?.(false);
			s.bottomDock.activateDock(key);
		},
		{ key, closeStore }
	);
}

/**
 * @typedef {{
 *   name: string,
 *   kind: 'hud'|'menu'|'modal'|'window'|'dock'|'drawer'|'inspector'|'settings',
 *   open: (page: any, ctx: any) => Promise<any>,
 *   shown: string,                 // visible once open
 *   closer?: string,               // the surface's own close control
 *   escapeCloses?: boolean,        // Escape closes it today (locked)
 *   needs?: string                 // a precondition worth naming
 * }} Surface
 */

/** @type {Surface[]} */
const SURFACES = [
	{ name: 'main', kind: 'hud', open: async () => {}, shown: '#controls-pill' },
	{ name: 'logo-menu', kind: 'menu', open: (p) => p.locator('#logo-menu').click(), shown: '#open-templates', closer: '#logo-menu' },
	{ name: 'connect-drawer', kind: 'drawer', open: (p) => p.locator('#connect-info-button').click(), shown: '[data-testid="connect-info-drawer"]', closer: '#connect-info-button' },
	{ name: 'notifications', kind: 'drawer', open: (p) => setStore(p, 'notificationCenterOpen', true), shown: '#notif-panel' },
	{ name: 'notes', kind: 'drawer', open: (p) => setStore(p, 'notesDrawerOpen', true), shown: '#notes-drawer', closer: '#notes-drawer button[aria-label="Close notes"]' },
	{ name: 'chat', kind: 'window', open: (p) => setStore(p, 'chatHidden', ''), shown: '#chat-window' },
	{ name: 'ai', kind: 'window', open: (p) => setStore(p, 'aiAssistantHidden', ''), shown: '#ai-assistant-window' },
	{ name: 'objects', kind: 'window', open: (p) => setStore(p, 'objectListClose', false), shown: '#object-list' },
	{ name: 'addmenu', kind: 'menu', open: (p) => setStore(p, 'addMenu', { x: 560, y: 220, point: null }), shown: '#add-search-box, [role=menu]' },
	{ name: 'viewportmenu', kind: 'menu', open: (p) => setStore(p, 'viewportMenu', { x: 560, y: 220, point: [0, 0, 0] }), shown: '[role=menu]' },
	{ name: 'shortcut-sheet', kind: 'modal', open: (p) => setStore(p, 'shortcutsRegistry.cheatSheetOpen', true), shown: '#shortcut-sheet', closer: '#shortcut-sheet-close', escapeCloses: true },
	{ name: 'inspector-object', kind: 'inspector', open: (p, ctx) => p.evaluate((u) => window.__stores.objectActions.selectObject(u, true), ctx.box), shown: '#inspector-position' },
	{ name: 'inspector-light', kind: 'inspector', open: (p, ctx) => p.evaluate((u) => window.__stores.objectActions.selectObject(u, true), ctx.light), shown: '#inspector-intensity' },
	{ name: 'inspector-scene', kind: 'inspector', open: (p) => p.evaluate(() => window.__stores.showSidebar('scene')), shown: '#environment-presets' },
	{ name: 'explorer', kind: 'dock', open: (p) => openDock(p, 'explorer', 'explorerClose'), shown: '#explorer-filter' },
	{ name: 'flow', kind: 'dock', open: (p) => openDock(p, 'flow', 'flowGraphClose'), shown: '[data-key-scope="nodes"]' },
	{ name: 'flowcode', kind: 'dock', open: (p) => openDock(p, 'flowcode', 'flowCodeClose'), shown: '.cm-editor, #flow-code' },
	{ name: 'animation', kind: 'dock', open: (p) => openDock(p, 'animation', 'animationClose'), shown: '#animation-speed' },
	{ name: 'uv', kind: 'dock', open: (p) => openDock(p, 'uv', 'uvEditorClose'), shown: '[data-key-scope="uv"]' },
	{ name: 'shader', kind: 'dock', open: (p) => openDock(p, 'shader', 'shaderEditorClose'), shown: '#shader-editor' },
	{ name: 'hud', kind: 'dock', open: (p) => openDock(p, 'hud', 'hudEditorClose'), shown: '[data-key-scope="hud"]' },
	{ name: 'profiler', kind: 'dock', open: (p) => openDock(p, 'profiler', 'profilerClose'), shown: '#profiler-record, #profiler-stop' },
	{ name: 'code', kind: 'dock', open: (p) => openDock(p, 'code', 'codeWorkspaceClose'), shown: '#code-ws-toolbar, #code-ws-tabs' },
	{ name: 'modules', kind: 'modal', open: (p) => setStore(p, 'modulesOpen', true), shown: '#module-card-hello', escapeCloses: true },
	{ name: 'sessions', kind: 'modal', open: (p) => setStore(p, 'sessionsOpen', true), shown: '#session-save', escapeCloses: true },
	{ name: 'checkpoints', kind: 'modal', open: (p) => setStore(p, 'checkpointsOpen', true), shown: 'dialog[open]', escapeCloses: true },
	{ name: 'templates', kind: 'modal', open: (p) => setStore(p, 'templatesModalOpen', true), shown: '#templates-modal', escapeCloses: true },
	{ name: 'character', kind: 'modal', open: (p) => setStore(p, 'characterModalOpen', true), shown: '#character-panel', closer: '#character-close', escapeCloses: true },
	{ name: 'profile', kind: 'modal', open: (p) => setStore(p, 'profileSettingsOpen', true), shown: 'dialog[open]', escapeCloses: true },
	{ name: 'storage', kind: 'modal', open: (p) => setStore(p, 'storageUsage.storageModalOpen', true), shown: '#storage-modal', escapeCloses: true },
	{ name: 'meshgen', kind: 'modal', open: (p) => setStore(p, 'meshGenModalOpen', { position: [0, 0, 0] }), shown: 'div[role=dialog]', escapeCloses: true },
	{ name: 'toasts', kind: 'hud', open: (p) => p.evaluate(() => {
		const s = window.__stores;
		s.showToast('Saved "Lock scene"');
		s.showToast('Element snapping on', [{ label: 'Undo', action: () => {} }]);
		s.showInfoToast?.('lock-info', 'This scene uses modules you do not have.', [{ label: 'Modules', action: () => {} }]);
	}), shown: '.tp-toast' }
];

/** the Settings window, one shot per section (labels as the sidebar shows them) */
const SETTINGS_SECTIONS = ['interface', 'controls', 'input', 'touchcontrols', 'scene', 'explorer', 'vr', 'ai', 'export', 'nodetypes', 'connection', 'shortcuts', 'about'];
for (const key of SETTINGS_SECTIONS) {
	SURFACES.push({
		name: 'settings-' + key,
		kind: 'settings',
		open: (p) => p.evaluate((k) => {
			window.__stores.settingsSection.set(k);
			window.__stores.settingsOpen.set(true);
		}, key),
		shown: '#settings-main',
		escapeCloses: true
	});
}

/** Theme switching for the baselines: dark, light, or the committed custom .theme.json.
 * @param {any} page @param {'dark'|'light'|'custom'} which */
async function applyTheme(page, which) {
	if (which === 'custom') {
		const json = fs.readFileSync(CUSTOM_THEME, 'utf8');
		await page.evaluate(async (text) => {
			const T = window.__stores.themes;
			const existing = (await new Promise((r) => T.customThemes.subscribe(r)())).find((/** @type {any} */ t) => t.name === 'Lock plum');
			if (existing) T.theme.set(existing.id);
			else await T.importThemeFile(new File([text], 'lock-custom.theme.json', { type: 'application/json' }));
		}, json);
	} else await page.evaluate((id) => window.__stores.themes.theme.set(id), which);
	await page.waitForTimeout(250);
}

module.exports = { SURFACES, SETTINGS_SECTIONS, seedScene, closeAll, applyTheme, setStore, CUSTOM_THEME };
