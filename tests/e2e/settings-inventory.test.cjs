// 37-settings (R21) — THE INVENTORY WALK. The redesign may change every label, control and section
// of Settings, and nothing a setting STORES (docs/settings-inventory.md; the 1.25.0 key map is
// docs/settings-storage-keys.md). For every setting row: drive the NEW control through the real UI
// to a non-default value and read localStorage — the key and the string must be exactly what
// 1.25.0 wrote. Then press the category's footer "Reset <Category> to defaults", confirm, and check
// every row of that page is back at its default (the key absent, or the default string).
// Run: APP_URL=https://theprototype.app:5364/ npm run e2e -- settings-inventory
const h = require('./helpers.cjs');

/**
 * kind: toggle (a kit Toggle — click flips it) · seg (click `#<id>-<value>`) · range (set + input)
 *       num / text (fill + change) · color (set + input + change) · select (ThemedSelect: open, pick)
 *       native (a <select>: selectOption)
 * want: the stored string, or a function (raw) => boolean for JSON keys.
 * def:  after the category reset — `null` = the key is absent or holds the default string `defStr`.
 * @typedef {{id: string, kind: string, set?: string, key: string, want: string | ((raw: string | null) => boolean), def?: string | null | ((raw: string | null) => boolean), note?: string}} Row
 */
const json = (/** @type {string | null} */ raw) => {
	try {
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
};
/** @param {string} field @param {any} value */
const field = (field, value) => (/** @type {string | null} */ raw) => json(raw)?.[field] === value;
/** absent, or the default string @param {string} d */
const absentOr = (d) => (/** @type {string | null} */ raw) => raw === null || raw === d;

/** @type {Record<string, Row[]>} page key → rows (order matters where one row gates another) */
const PAGES = {
	interface: [
		{ id: 'allow-text-select', kind: 'toggle', key: 'allowTextSelection', want: 'true', def: absentOr('false') },
		{ id: 'avatars-peers-classic', kind: 'toggle', key: 'avatars:peersClassic', want: '1', def: absentOr('0') },
		{ id: 'theme-select', kind: 'select', set: 'Light', key: 'theme', want: 'light', def: 'dark' },
		{ id: 'density', kind: 'seg', set: 'compact', key: 'ui:density', want: 'compact', def: null },
		{ id: 'setting-game-sound-volume', kind: 'range', set: '0.5', key: 'game:soundVolume', want: '0.5', def: absentOr('0.8') },
		{ id: 'setting-game-music-volume', kind: 'range', set: '0.25', key: 'game:musicVolume', want: '0.25', def: absentOr('0.6') },
		{ id: 'welcome-on-start', kind: 'toggle', key: 'showWelcomeOnStart', want: 'true', def: absentOr('false') },
		{ id: 'announce-versions', kind: 'toggle', key: 'showWhatsNewNotice', want: 'false', def: absentOr('true') },
		{ id: 'toasts-in-drawer', kind: 'toggle', key: 'toastsInDrawerOnly', want: 'true', def: absentOr('false') },
		{ id: 'setting-tours-auto', kind: 'toggle', key: 'toursAutoStart', want: 'false', def: null },
		{ id: 'setting-xr-offer', kind: 'toggle', key: 'xrOfferSession', want: 'false', def: absentOr('true') },
		{ id: 'floating-toolbar', kind: 'toggle', key: 'floatingToolbar', want: 'false', def: absentOr('true') },
		{ id: 'toolbar-on-top', kind: 'toggle', key: 'toolbarOnTop', want: 'true', def: absentOr('false') },
		{ id: 'touch-tools', kind: 'toggle', key: 'touchTools', want: 'true', def: absentOr('false'), note: 'desktop default is off' },
		{ id: 'mobile-undock', kind: 'toggle', key: 'mobileUndockAllowed', want: 'true', def: absentOr('false') },
		{ id: 'advanced-mode', kind: 'toggle', key: 'advancedMode', want: 'true', def: absentOr('false') },
		{ id: 'env-in-list', kind: 'toggle', key: 'showEnvInList', want: 'true', def: absentOr('false') },
		{ id: 'object-search', kind: 'toggle', key: 'objectSearchEnabled', want: 'true', def: absentOr('false') },
		{ id: 'show-perf-stats', kind: 'toggle', key: 'perfStats:show', want: 'true', def: absentOr('false') },
		{ id: 'dock-pushes-viewport', kind: 'toggle', key: 'viewPrefs', want: field('dockPushesViewport', false), def: (raw) => raw === null || json(raw)?.dockPushesViewport === true }
	],
	controls: [
		{ id: 'shift-add', kind: 'toggle', key: 'enableShiftAdd', want: 'true', def: absentOr('false') },
		{ id: 'helpers-in-play', kind: 'toggle', key: 'helpersInPlay', want: 'true', def: absentOr('false') },
		{ id: 'note-dblclick', kind: 'toggle', key: 'noteDoubleClickToOpen', want: 'true', def: absentOr('false') },
		{ id: 'trackpad-mode', kind: 'seg', set: 'off', key: 'trackpadMode', want: 'off', def: absentOr('auto') },
		{ id: 'trackpad-pan', kind: 'toggle', key: 'trackpadPanEnabled', want: 'false', def: absentOr('true') },
		{ id: 'trackpad-reverse', kind: 'toggle', key: 'trackpadReversePan', want: 'true', def: absentOr('false') },
		{ id: 'trackpad-pinch', kind: 'toggle', key: 'trackpadPinchZoom', want: 'false', def: absentOr('true') },
		{ id: 'browser-zoom', kind: 'toggle', key: 'allowBrowserZoom', want: 'true', def: absentOr('false') }
	],
	input: [
		{ id: 'gamepad-enabled', kind: 'toggle', key: 'gamepadPrefs', want: field('enabled', false), def: (raw) => raw === null || json(raw)?.enabled === true },
		{ id: 'gamepad-swap', kind: 'toggle', key: 'gamepadPrefs', want: field('swapSticks', true), def: (raw) => raw === null || json(raw)?.swapSticks === false },
		{ id: 'gamepad-invert-y', kind: 'toggle', key: 'gamepadPrefs', want: field('invertY', true), def: (raw) => raw === null || json(raw)?.invertY === false },
		{ id: 'gamepad-deadzone', kind: 'range', set: '0.25', key: 'gamepadPrefs', want: field('deadzone', 0.25), def: (raw) => raw === null || json(raw)?.deadzone === 0.15 },
		{ id: 'gamepad-sensitivity', kind: 'range', set: '2', key: 'gamepadPrefs', want: field('lookSensitivity', 2), def: (raw) => raw === null || json(raw)?.lookSensitivity === 1 },
		{ id: 'flow-mouse-bindings', kind: 'seg', set: 'select', key: 'flow:mouseBindings', want: 'select', def: absentOr('classic') },
		{ id: 'flow-opens', kind: 'seg', set: 'framed', key: 'flow:opens', want: 'framed', def: absentOr('left') }
	],
	touch: [
		{ id: 'touch-visibility', kind: 'seg', set: 'never', key: 'touchControlsPrefs', want: field('visibility', 'never'), def: (raw) => raw === null || json(raw)?.visibility === 'auto' },
		{ id: 'touch-show-in-edit', kind: 'toggle', key: 'touchControlsPrefs', want: field('showInEdit', true), def: (raw) => raw === null || json(raw)?.showInEdit === false },
		{ id: 'touch-haptics', kind: 'toggle', key: 'touchControlsPrefs', want: field('haptics', false), def: (raw) => raw === null || json(raw)?.haptics === true },
		{ id: 'touch-look-speed', kind: 'range', set: '1.5', key: 'touchLookSpeed', want: '1.5', def: absentOr('1') }
	],
	scene: [
		{ id: 'show-grid', kind: 'toggle', key: 'showGrid', want: 'false', def: null },
		{ id: 'light-helper-length', kind: 'num', set: '5', key: 'lightHelperLength', want: '5', def: absentOr('2') },
		{ id: 'show-sim-controls', kind: 'toggle', key: 'showSimControls', want: 'true', def: absentOr('false') },
		{ id: 'shadow-quality', kind: 'seg', set: 'low', key: 'shadowQuality', want: 'low', def: absentOr('high') },
		{ id: 'auto-quality', kind: 'toggle', key: 'autoQuality', want: 'false', def: absentOr('true') },
		{ id: 'lod-enabled', kind: 'toggle', key: 'lodEnabled', want: 'false', def: absentOr('true') },
		{ id: 'kit-instancing', kind: 'toggle', key: 'kitInstancing', want: 'false', def: absentOr('true') },
		{ id: 'water-quality', kind: 'seg', set: 'low', key: 'water:quality', want: 'low', def: absentOr('auto') },
		{ id: 'synced-animations', kind: 'toggle', key: 'syncedAnimations', want: 'false', def: absentOr('true') },
		{ id: 'spatial-voice', kind: 'toggle', key: 'spatialVoice', want: 'false', def: absentOr('true') },
		{ id: 'ping-color', kind: 'color', set: '#ff0000', key: 'pingColor', want: '#ff0000', def: absentOr('') },
		{ id: 'ping-sound', kind: 'select', set: 'Chime', key: 'pingSound', want: 'chime', def: absentOr('ding') },
		{ id: 'autosave', kind: 'toggle', key: 'autosave', want: 'false', def: absentOr('true') },
		{ id: 'auto-restore', kind: 'toggle', key: 'autoRestore', want: 'true', def: absentOr('false') },
		{ id: 'checkpoints-auto', kind: 'toggle', key: 'checkpoints:auto', want: 'false', def: absentOr('true') },
		{ id: 'checkpoints-every', kind: 'seg', set: '30', key: 'checkpoints:every', want: '30', def: absentOr('10') },
		{ id: 'checkpoints-cap', kind: 'seg', set: '500', key: 'checkpoints:capMb', want: '500', def: absentOr('250') },
		{ id: 'modules-on-open', kind: 'seg', set: 'keep', key: 'scenes:modulesOnOpen', want: 'keep', def: null },
		{ id: 'double-click-action', kind: 'seg', set: 'isolate', key: 'doubleClickAction', want: 'isolate', def: absentOr('properties') },
		{ id: 'length-unit', kind: 'select', set: 'cm', key: 'lengthUnit', want: 'cm', def: absentOr('m') },
		{ id: 'angle-unit', kind: 'seg', set: 'rad', key: 'angleUnit', want: 'rad', def: absentOr('deg') },
		{ id: 'dup-carry-animation', kind: 'toggle', key: 'duplicateCarriesAnimation', want: 'false', def: absentOr('true') },
		{ id: 'dup-carry-flow', kind: 'toggle', key: 'duplicateCarriesFlow', want: 'false', def: absentOr('true') },
		{ id: 'dup-carry-shader', kind: 'toggle', key: 'duplicateCarriesShader', want: 'false', def: absentOr('true') },
		{ id: 'share-materials', kind: 'toggle', key: 'shareDuplicatedMaterials', want: 'true', def: absentOr('false') },
		{ id: 'wire-color', kind: 'color', set: '#112233', key: 'viewPrefs', want: field('wireColor', '#112233'), def: (raw) => raw === null || json(raw)?.wireColor === '#9aa4b0' },
		{ id: 'outline-color', kind: 'color', set: '#445566', key: 'viewPrefs', want: field('outlineColor', '#445566'), def: (raw) => raw === null || json(raw)?.outlineColor === '#353535' },
		{ id: 'edit-wire-mode', kind: 'seg', set: 'custom', key: 'viewPrefs', want: field('editWireColor', '#2f81f7'), def: (raw) => raw === null || json(raw)?.editWireColor === 'auto' },
		// the grid rows are gated on the modern style + grid on: drive them before those two
		{ id: 'placeholder-grid-size', kind: 'num', set: '1', key: 'placeholderGrid', want: field('size', 1), def: (raw) => raw === null || json(raw)?.size === 0.5 },
		{ id: 'placeholder-grid-color', kind: 'color', set: '#00ff00', key: 'placeholderGrid', want: field('color', '#00ff00'), def: (raw) => raw === null || json(raw)?.color === '#bfe6ff' },
		{ id: 'placeholder-grid-opacity', kind: 'range', set: '0.8', key: 'placeholderGrid', want: field('opacity', 0.8), def: (raw) => raw === null || json(raw)?.opacity === 0.45 },
		{ id: 'placeholder-anim-speed', kind: 'range', set: '2', key: 'placeholderGrid', want: field('speed', 2), def: (raw) => raw === null || json(raw)?.speed === 1 },
		{ id: 'placeholder-grid-on', kind: 'toggle', key: 'placeholderGrid', want: field('on', false), def: (raw) => raw === null || json(raw)?.on === true },
		{ id: 'placeholder-style', kind: 'seg', set: 'boxes', key: 'placeholderStyle', want: '"boxes"', def: (raw) => raw === null || raw === '"modern"' },
		{ id: 'placeholder-stuck-seconds', kind: 'num', set: '20', key: 'placeholderStuckSeconds', want: '20', def: absentOr('10') }
	],
	explorer: [
		{ id: 'share-new-files', kind: 'seg', set: 'never', key: 'shared:shareNewFiles', want: 'never', def: absentOr('ask') },
		{ id: 'auto-download', kind: 'toggle', key: 'shared:autoDownload', want: 'false', def: absentOr('true') },
		{ id: 'merge-on-connect', kind: 'toggle', key: 'connect:mergeOnConnect', want: 'true', def: absentOr('false') },
		{ id: 'unshare-authority', kind: 'seg', set: 'owner', key: 'shared:unshareAuthority', want: 'owner', def: absentOr('anyone') },
		{ id: 'keep-versions', kind: 'num', set: '5', key: 'project:keepVersions', want: '5', def: absentOr('10') },
		{ id: 'import-duplicate-mode', kind: 'seg', set: 'skip', key: 'importDuplicateMode', want: 'skip', def: absentOr('ask') },
		{ id: 'save-name-template', kind: 'text', set: '[name]-[YY]', key: 'saveNameTemplate', want: '[name]-[YY]', def: absentOr('[name]') },
		{ id: 'recycle-bin', kind: 'toggle', key: 'shared:recycleBin', want: 'false', def: absentOr('true') },
		{ id: 'delete-no-confirm', kind: 'toggle', key: 'shared:deleteNoConfirm', want: 'true', def: absentOr('false') },
		{ id: 'keep-recycle-bin', kind: 'toggle', key: 'shared:keepRecycleBin', want: 'true', def: absentOr('false') },
		{ id: 'deleted-log', kind: 'toggle', key: 'shared:deletedLog', want: 'false', def: absentOr('true') }
	],
	export: [
		{ id: 'export-start-fullscreen', kind: 'toggle', key: 'export:prefs', want: field('startFullscreen', true), def: (raw) => raw === null || json(raw)?.startFullscreen === false },
		{ id: 'export-show-fps', kind: 'toggle', key: 'export:prefs', want: field('showFps', true), def: (raw) => raw === null || json(raw)?.showFps === false },
		{ id: 'export-quality', kind: 'seg', set: 'low', key: 'export:prefs', want: field('quality', 'low'), def: (raw) => raw === null || json(raw)?.quality === 'auto' },
		{ id: 'export-vr-button', kind: 'toggle', key: 'export:prefs', want: field('vrButton', false), def: (raw) => raw === null || json(raw)?.vrButton === true },
		{ id: 'export-cdn-packs', kind: 'toggle', key: 'export:prefs', want: field('useCdnForPacks', true), def: (raw) => raw === null || json(raw)?.useCdnForPacks === false }
	],
	vr: [
		{ id: 'vr-override', kind: 'toggle', key: 'vrOverride', want: 'true', def: null },
		{ id: 'vr-set-snapAngle', kind: 'seg', set: '30', key: 'vrSnapAngleLast', want: '30', def: absentOr('45') },
		{ id: 'vr-set-turning', kind: 'seg', set: 'smooth', key: 'vrSmoothTurn', want: 'true', def: absentOr('false') },
		{ id: 'vr-set-smoothSpeed', kind: 'seg', set: '135', key: 'vrSmoothTurnSpeed', want: '135', def: absentOr('90') },
		{ id: 'vr-set-mirror', kind: 'toggle', key: 'vrMirrorSnapTurn', want: 'true', def: absentOr('false') },
		{ id: 'vr-set-vignette', kind: 'toggle', key: 'vrComfortVignette', want: 'true', def: absentOr('false') },
		{ id: 'vr-set-teleport', kind: 'toggle', key: 'vrTeleportEnabled', want: 'false', def: absentOr('true') },
		{ id: 'vr-set-flying', kind: 'toggle', key: 'vrFlying', want: 'true', def: absentOr('false') },
		{ id: 'vr-set-stance', kind: 'seg', set: 'seated', key: 'vrStance', want: 'seated', def: absentOr('standing') },
		{ id: 'vr-set-height', kind: 'range', set: '0.1', key: 'vrHeightOffset', want: '0.1', def: absentOr('0') },
		{ id: 'vr-set-menuHand', kind: 'seg', set: 'left', key: 'vrMenuHand', want: 'left', def: absentOr('right') },
		{ id: 'vr-set-menuHold', kind: 'toggle', key: 'vrMenuHold', want: 'true', def: absentOr('false') },
		{ id: 'vr-set-grabStyle', kind: 'seg', set: 'move', key: 'vrGrabStyle', want: 'move', def: absentOr('rigid') },
		{ id: 'vr-set-refresh', kind: 'seg', set: '90', key: 'vrTargetHz', want: '90', def: absentOr('auto') },
		{ id: 'vr-set-stats', kind: 'toggle', key: 'vrStats', want: 'true', def: absentOr('false') },
		{ id: 'vr-set-peerHands', kind: 'seg', set: 'spheres', key: 'peerHandStyle', want: 'spheres', def: absentOr('hands') },
		{ id: 'passthrough-toggle', kind: 'toggle', key: 'vrPassthrough', want: 'true', def: absentOr('false') },
		{ id: 'vr-set-wireframe', kind: 'toggle', key: 'vrWireframe', want: 'false', def: absentOr('true') },
		{ id: 'vr-set-gameHud', kind: 'seg', set: 'world', key: 'vr:hudPlacement', want: 'world', def: absentOr('head') },
		{ id: 'vr-set-gameHudSize', kind: 'seg', set: 'large', key: 'vr:hudSize', want: 'large', def: absentOr('medium') },
		{ id: 'vr-set-gameHudHints', kind: 'toggle', key: 'vr:hudHints', want: 'false', def: absentOr('true') },
		{ id: 'vr-set-vertexHold', kind: 'toggle', key: 'vrVertexHold', want: 'false', def: absentOr('true') },
		{ id: 'vr-set-sleeve', kind: 'toggle', key: 'vrSleeveEnabled', want: 'true', def: absentOr('false') },
		{ id: 'vr-set-faceCap', kind: 'num', set: '1200', key: 'vrFaceCap', want: '1200', def: absentOr('2500') },
		{ id: 'vr-set-vertexCap', kind: 'num', set: '900', key: 'vrVertexCap', want: '900', def: absentOr('800') },
		{ id: 'colocated-ghost-hands', kind: 'toggle', key: 'colocatedGhostHands', want: 'false', def: absentOr('true') }
	],
	ai: [
		{ id: 'ai-enabled', kind: 'toggle', key: 'aiEnabled', want: 'true', def: absentOr('false') },
		{ id: 'mesh-gen-enabled', kind: 'toggle', key: 'meshGenEnabled', want: 'true', def: absentOr('false') },
		{ id: 'ai-stt-preset', kind: 'seg', set: 'groq', key: 'aiStt', want: field('preset', 'groq'), def: (raw) => raw === null || json(raw)?.preset === 'openai' }
	],
	connection: [
		{ id: 'soft-peer-cap', kind: 'num', set: '4', key: 'connect:softPeerCap', want: '4', def: absentOr('8') },
		{ id: 'peer-server-mode', kind: 'seg', set: 'public', key: 'peerServerConfig', want: field('mode', 'public'), def: (raw) => raw === null || json(raw)?.mode === 'default' }
	]
};

/** @param {any} page @param {string} key */
async function openPage(page, key) {
	await page.evaluate((k) => {
		const s = /** @type {any} */ (window).__stores;
		s.settingsOpen.set(false);
		s.settingsSection.set(k);
		s.settingsOpen.set(true);
	}, key);
	await page.waitForSelector('dialog.settings-dialog .ss-page', { timeout: 15000 });
	await page.waitForTimeout(300);
}

/** drive one row's control through the real UI @param {any} page @param {Row} row */
async function drive(page, row) {
	const sel = '#' + row.id;
	if (row.kind === 'toggle') {
		await page.locator(sel).scrollIntoViewIfNeeded();
		await page.locator(sel).click();
	} else if (row.kind === 'seg') {
		const opt = `${sel}-${row.set}`;
		await page.locator(opt).scrollIntoViewIfNeeded();
		await page.locator(opt).click();
	} else if (row.kind === 'select') {
		await page.locator(sel).scrollIntoViewIfNeeded();
		await page.locator(sel).click();
		await page.locator('.ts-list [role=option]', { hasText: row.set }).first().click();
	} else if (row.kind === 'native') {
		await page.selectOption(sel, row.set);
	} else if (row.kind === 'num' || row.kind === 'text') {
		await page.locator(sel).scrollIntoViewIfNeeded();
		await page.locator(sel).fill(String(row.set));
		await page.locator(sel).dispatchEvent('change');
	} else {
		// range and color: set the value, then the events the control listens to
		await page.locator(sel).scrollIntoViewIfNeeded();
		await page.evaluate(
			([s, v]) => {
				const el = /** @type {HTMLInputElement} */ (document.querySelector(s));
				el.value = v;
				el.dispatchEvent(new Event('input', { bubbles: true }));
				el.dispatchEvent(new Event('change', { bubbles: true }));
			},
			[sel, String(row.set)]
		);
	}
	await page.waitForTimeout(120);
}

/** @param {Row['want'] | Row['def']} want @param {string | null} raw @param {string} [defStr] */
function okValue(want, raw) {
	if (typeof want === 'function') return want(raw);
	if (want === null) return raw === null || raw === undefined;
	return raw === want;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const { page } = A;
	const read = (/** @type {string} */ key) => page.evaluate((k) => localStorage.getItem(k), key);

	let rows = 0;
	for (const [pageKey, list] of Object.entries(PAGES)) {
		await openPage(page, pageKey);
		for (const row of list) {
			const present = (await page.locator('#' + row.id).count()) + (await page.locator(`#${row.id}-${row.set}`).count());
			if (!present) {
				h.check(false, `${pageKey}: the control #${row.id} exists`);
				continue;
			}
			await drive(page, row);
			const raw = await read(row.key);
			h.check(okValue(row.want, raw), `${pageKey}: #${row.id} writes ${row.key} the 1.25.0 way (${raw})`);
			rows++;
		}
		// the footer reset of this category: asks, then puts every row of THIS page back
		const before = await page.evaluate(() => Object.keys(localStorage).length);
		await page.locator('#settings-reset-category').click();
		await page.locator('#confirm-dialog-ok').waitFor({ state: 'visible', timeout: 5000 });
		const asked = await page.locator('#confirm-dialog-ok').textContent();
		h.check(/Reset/.test(asked || ''), `${pageKey}: the reset asks first ("${(asked || '').trim()}")`);
		await page.locator('#confirm-dialog-ok').click();
		await page.waitForTimeout(400);
		for (const row of list) {
			if (row.def === undefined) continue;
			const raw = await read(row.key);
			h.check(okValue(row.def, raw), `${pageKey} reset: ${row.key} is back at its default (${raw})`);
		}
		const after = await page.evaluate(() => Object.keys(localStorage).length);
		h.check(after >= before - list.length - 4, `${pageKey} reset: other categories' keys stay (${before} → ${after})`);
	}
	h.check(rows >= 120, `the walk drove ${rows} setting rows`);

	// Node types: a type switched off in its group's sub-page lands in disabledNodeTypes
	await openPage(page, 'nodetypes');
	await page.locator('#node-types-section .tp-ui.nr').first().click();
	await page.waitForSelector('[data-nt="type-toggle"]', { timeout: 5000 });
	const type = await page.locator('[data-node-type]').first().getAttribute('data-node-type');
	await page.locator('[data-node-type] [data-nt="type-toggle"]').first().click();
	const off = JSON.parse((await read('disabledNodeTypes')) || '[]');
	h.check(off.includes(type), `node types: switching "${type}" off writes disabledNodeTypes (${JSON.stringify(off)})`);

	// a reset of one category leaves another alone: set Controls, reset Interface, Controls stays
	await openPage(page, 'controls');
	await page.locator('#shift-add').click();
	await openPage(page, 'interface');
	await page.locator('#settings-reset-category').click();
	await page.locator('#confirm-dialog-ok').click();
	await page.waitForTimeout(300);
	h.check((await read('enableShiftAdd')) === 'true', 'resetting Interface leaves a Controls setting alone');
	// and Cancel resets nothing
	await openPage(page, 'controls');
	await page.locator('#settings-reset-category').click();
	await page.locator('#confirm-dialog-cancel').click();
	await page.waitForTimeout(200);
	h.check((await read('enableShiftAdd')) === 'true', 'Cancel on the reset question changes nothing');

	await page.evaluate(() => /** @type {any} */ (window).__stores.settingsOpen.set(false));
	await h.finish(browser);
});
