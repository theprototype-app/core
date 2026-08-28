// Phase 5: the shortcut registry is REBINDABLE (the Unity Shortcut Manager model).
// Every entry carries a stable `id`, its authored combo survives as `defaultKeys`,
// and a user override in localStorage (`shortcutOverrides`) is written back onto
// `keys` — so the matcher, the Settings renderer and editorNavigation's Shift+<key>
// probe all keep reading `keys` and never learn that overrides exist.
//
// This suite drives the REAL UI: it clicks a row's key control in Settings and
// presses actual keys, then closes Settings and presses the rebound combo in the
// viewport to prove the binding is live (through panelToggles, the phase-2 tree).
const h = require('./helpers.cjs');

/** open Settings on the Shortcuts section, the way Ctrl+/ does */
async function openSettings(page) {
	await page.evaluate(() => {
		window.__stores.settingsSection.set('shortcuts');
		window.__stores.settingsOpen.set(true);
	});
	await page.waitForSelector('#shortcut-grid', { timeout: 15000 });
	await page.waitForTimeout(250);
}

async function closeSettings(page) {
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(400);
}

/** what the row for `id` currently DISPLAYS as its combo */
const keysOf = (page, id) =>
	page.evaluate((sid) => {
		const row = document.querySelector(`[data-shortcut="${sid}"]`);
		if (!row) return null;
		const el = row.querySelector('.shortcut-keys') || row.querySelector('kbd');
		return el ? el.textContent.trim() : null;
	}, id);

/** what the REGISTRY holds for `id` (keys + defaultKeys), independent of the DOM */
const regOf = (page, id) =>
	page.evaluate((sid) => {
		const s = window.__stores.shortcutsRegistry.shortcuts.find((x) => x.id === sid);
		return s ? { keys: s.keys, defaultKeys: s.defaultKeys, group: s.group } : null;
	}, id);

const overridesLs = (page) => page.evaluate(() => localStorage.getItem('shortcutOverrides'));

/** a real key press with nothing focused (never a text field — the registry
 * deliberately stands down for those) */
async function press(page, key) {
	await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
	await page.keyboard.press(key);
	await page.waitForTimeout(350);
}

/** park the object list CLOSED so every toggle assertion reads the same direction */
async function parkClosed(page) {
	await page.evaluate(() => window.__stores.objectListClose.set(true));
	await page.waitForTimeout(250);
}

const listClosed = (page) =>
	page.evaluate(() => {
		let v;
		window.__stores.objectListClose.subscribe((x) => (v = x))();
		return v;
	});

/** click a row's key control and record the next combo the way a user does */
async function capture(page, id, keyPresses) {
	await page.click(`[data-shortcut="${id}"] .shortcut-keys`);
	await page.waitForTimeout(250);
	const armed = await keysOf(page, id);
	await keyPresses();
	await page.waitForTimeout(350);
	return armed;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---------------------------------------------------------------- 1. premise
	const seed = await A.page.evaluate(() => {
		const r = window.__stores.shortcutsRegistry;
		const list = r.shortcuts;
		return {
			total: list.length,
			withoutId: list.filter((s) => !s.id).length,
			withoutDefault: list.filter((s) => s.defaultKeys === undefined).length,
			dupeIds: list.length - new Set(list.map((s) => s.id)).size,
			objectList: list.find((s) => s.id === 'panels.object-list')?.keys,
			play: list.find((s) => s.id === 'scene.play'),
			fixedCount: list.filter((s) => s.fixed).length,
			ls: localStorage.getItem('shortcutOverrides')
		};
	});
	h.check(seed.withoutId === 0 && seed.dupeIds === 0, `1.1 every entry has a UNIQUE stable id (${seed.total} entries, ${seed.withoutId} missing, ${seed.dupeIds} duplicated)`);
	h.check(seed.withoutDefault === 0, `1.2 every entry carries defaultKeys (${seed.withoutDefault} missing)`);
	h.check(seed.fixedCount >= 6, `1.3 the display-only rows are marked fixed (${seed.fixedCount} of them)`);
	h.check(seed.objectList === 'O', `1.4 premise: the Object list is on bare O (${seed.objectList})`);
	h.check(seed.ls === null, `1.5 premise: no overrides stored yet (${seed.ls})`);
	h.check(
		!!seed.play && seed.play.keys === 'Ctrl+Enter' && seed.play.group === 'Scene',
		`1.6 the play shortcut exists in the Scene group on Ctrl+Enter (${seed.play && seed.play.keys})`
	);

	// Ctrl+Enter had to be FREE — that is the whole reason it was chosen.
	const enterOwners = await A.page.evaluate(() =>
		window.__stores.shortcutsRegistry.shortcuts.filter((s) => s.keys === 'Ctrl+Enter').map((s) => s.id)
	);
	h.check(enterOwners.length === 1 && enterOwners[0] === 'scene.play', `1.7 nothing else answers to Ctrl+Enter (${enterOwners.join(',')})`);

	// comboOf can spell Alt now — it could not before this phase, so no default uses it
	const alt = await A.page.evaluate(() => {
		const r = window.__stores.shortcutsRegistry;
		const mk = (o) => r.comboOf(Object.assign({ key: 'k', code: 'KeyK', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, o));
		return {
			plain: mk({}),
			altOnly: mk({ altKey: true }),
			all: mk({ ctrlKey: true, altKey: true, shiftKey: true }),
			defaultsUsingAlt: r.shortcuts.filter((s) => String(s.defaultKeys).includes('Alt+')).length
		};
	});
	h.check(alt.plain === 'K' && alt.altOnly === 'Alt+K', `1.8 comboOf spells Alt (${alt.plain} / ${alt.altOnly})`);
	h.check(alt.all === 'Ctrl+Alt+Shift+K', `1.9 canonical modifier order is Ctrl+Alt+Shift (${alt.all})`);
	h.check(alt.defaultsUsingAlt === 0, '1.10 no shipped default uses Alt, so every existing combo is byte-identical');

	// ------------------------------------------------- 2. rebind through the UI
	await openSettings(A.page);
	let shown = await keysOf(A.page, 'panels.object-list');
	h.check(shown === 'O', `2.0 premise: the row renders its combo (${shown})`);

	const armedText = await capture(A.page, 'panels.object-list', async () => {
		await A.page.keyboard.down('Alt');
		await A.page.keyboard.press('o');
		await A.page.keyboard.up('Alt');
	});
	h.check(/Press keys/.test(armedText || ''), `2.1 clicking the keys arms capture ("${armedText}")`);

	shown = await keysOf(A.page, 'panels.object-list');
	h.check(shown === 'Alt+O', `2.2 a REAL Alt+O press rebinds the row (${shown})`);

	let reg = await regOf(A.page, 'panels.object-list');
	h.check(reg.keys === 'Alt+O' && reg.defaultKeys === 'O', `2.3 the registry moved keys and kept defaultKeys (${reg.keys} / default ${reg.defaultKeys})`);

	let ls = await overridesLs(A.page);
	h.check(ls === '{"panels.object-list":"Alt+O"}', `2.4 the override is stored by id, not by keys (${ls})`);

	const hasReset = await A.page.$('[data-shortcut="panels.object-list"] .shortcut-reset');
	h.check(!!hasReset, '2.5 a customised row offers a per-row reset');

	// ------------------------------------------------ 3. the new binding is LIVE
	await closeSettings(A.page);
	await parkClosed(A.page);
	await press(A.page, 'Alt+o');
	let closed = await listClosed(A.page);
	h.check(closed === false, `3.1 Alt+O opens the Object list through panelToggles (objectListClose=${closed})`);

	await parkClosed(A.page);
	await press(A.page, 'o');
	closed = await listClosed(A.page);
	h.check(closed === true, `3.2 bare O now does NOTHING — the default was vacated (objectListClose=${closed})`);

	// ------------------------------------------------------ 4. it survives reload
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.shortcutsRegistry, { timeout: 30000 });
	await A.page.waitForTimeout(1200);
	reg = await regOf(A.page, 'panels.object-list');
	h.check(reg && reg.keys === 'Alt+O', `4.1 the override is applied at boot (${reg && reg.keys})`);
	await openSettings(A.page);
	shown = await keysOf(A.page, 'panels.object-list');
	h.check(shown === 'Alt+O', `4.2 and the row still renders it after a reload (${shown})`);

	// ------------------------------------------------------- 5. conflict + swap
	await capture(A.page, 'panels.node-editor', async () => {
		await A.page.keyboard.down('Alt');
		await A.page.keyboard.press('o');
		await A.page.keyboard.up('Alt');
	});
	const conflict = await A.page.evaluate(() => {
		const row = document.querySelector('[data-shortcut="panels.node-editor"] .shortcut-conflict');
		return row ? row.textContent.replace(/\s+/g, ' ').trim() : null;
	});
	h.check(!!conflict && /Object list/.test(conflict), `5.1 a taken combo is REFUSED and named ("${conflict}")`);

	reg = await regOf(A.page, 'panels.node-editor');
	h.check(reg.keys === 'N', `5.2 nothing was clobbered while the conflict stands (${reg.keys})`);

	await A.page.click('[data-shortcut="panels.node-editor"] .shortcut-swap');
	await A.page.waitForTimeout(400);
	const swapped = await A.page.evaluate(() => {
		const r = window.__stores.shortcutsRegistry.shortcuts;
		const f = (id) => r.find((s) => s.id === id).keys;
		return { node: f('panels.node-editor'), objects: f('panels.object-list'), ls: localStorage.getItem('shortcutOverrides') };
	});
	h.check(swapped.node === 'Alt+O', `5.3 Swap gives the combo to the new owner (${swapped.node})`);
	h.check(swapped.objects === 'N', `5.4 ...and hands the loser this row's previous keys (${swapped.objects})`);
	h.check(
		(await keysOf(A.page, 'panels.node-editor')) === 'Alt+O' && (await keysOf(A.page, 'panels.object-list')) === 'N',
		'5.5 both rows re-render (the {#key} redraw signal — the registry array is not reactive)'
	);
	h.check(/"panels.node-editor":"Alt\+O"/.test(swapped.ls) && /"panels.object-list":"N"/.test(swapped.ls), `5.6 both overrides persisted (${swapped.ls})`);

	// the swap moved a REAL binding, not just a label
	await closeSettings(A.page);
	await parkClosed(A.page);
	await press(A.page, 'n');
	closed = await listClosed(A.page);
	h.check(closed === false, `5.7 N opens the OBJECT LIST after the swap (objectListClose=${closed})`);

	// --------------------------------------------------- 6. refusals and resets
	const refused = await A.page.evaluate(() => {
		const r = window.__stores.shortcutsRegistry;
		return {
			esc: r.rebindShortcut('camera.focus', 'Escape'),
			fixed: r.rebindShortcut('voice.push-to-talk', 'Alt+J'),
			modifier: r.rebindShortcut('camera.focus', 'Ctrl+Control'),
			unknown: r.rebindShortcut('nope.nope', 'Alt+J'),
			focusKeys: r.shortcuts.find((s) => s.id === 'camera.focus').keys
		};
	});
	h.check(refused.esc.ok === false, `6.1 nothing may be bound TO Escape (${refused.esc.reason})`);
	h.check(refused.fixed.ok === false, `6.2 a fixed row refuses a rebind (${refused.fixed.reason})`);
	h.check(refused.modifier.ok === false, `6.3 a bare modifier is not a shortcut (${refused.modifier.reason})`);
	h.check(refused.unknown.ok === false, '6.4 an unknown id is refused');
	h.check(refused.focusKeys === 'F', `6.5 none of the refusals touched the entry (${refused.focusKeys})`);

	await openSettings(A.page);
	await A.page.click('[data-shortcut="panels.node-editor"] .shortcut-reset');
	await A.page.waitForTimeout(400);
	const oneReset = await A.page.evaluate(() => {
		const r = window.__stores.shortcutsRegistry.shortcuts;
		return { node: r.find((s) => s.id === 'panels.node-editor').keys, ls: localStorage.getItem('shortcutOverrides') };
	});
	h.check(oneReset.node === 'N', `6.6 the per-row reset restores one default (${oneReset.node})`);
	h.check(!/panels.node-editor/.test(oneReset.ls || ''), `6.7 ...and drops only that override (${oneReset.ls})`);

	await A.page.click('#shortcut-reset-all');
	await A.page.waitForTimeout(400);
	const allReset = await A.page.evaluate(() => {
		const r = window.__stores.shortcutsRegistry.shortcuts;
		return {
			moved: r.filter((s) => !s.fixed && s.keys !== s.defaultKeys).map((s) => s.id),
			ls: localStorage.getItem('shortcutOverrides')
		};
	});
	h.check(allReset.moved.length === 0, `6.8 Reset all puts every combo back (still moved: ${allReset.moved.join(',') || 'none'})`);
	h.check(allReset.ls === null, `6.9 ...and clears the stored map entirely (${allReset.ls})`);

	await closeSettings(A.page);
	await parkClosed(A.page);
	await press(A.page, 'o');
	closed = await listClosed(A.page);
	h.check(closed === false, `6.10 bare O works again after Reset all (objectListClose=${closed})`);

	// ------------------------------------------- 7. the capture standdown itself
	// The registry must not ACT on the press Settings is recording. Proven here at
	// the registry level, so it holds for any capture surface, not just the modal
	// (where `anyModalOpen` already mutes almost everything).
	await A.page.evaluate(() => window.__stores.shortcutsRegistry.setShortcutCapture(true));
	await parkClosed(A.page);
	await press(A.page, 'o');
	closed = await listClosed(A.page);
	h.check(closed === true, `7.1 while capturing, O is RECORDED and not executed (objectListClose=${closed})`);

	await A.page.evaluate(() => window.__stores.shortcutsRegistry.setShortcutCapture(false));
	await press(A.page, 'o');
	closed = await listClosed(A.page);
	h.check(closed === false, `7.2 and the registry resumes the moment capture ends (objectListClose=${closed})`);

	// --------------------------------------------------------- 8. the play key
	// LAST: play mode owns the keyboard, so nothing else can be driven after it.
	await openSettings(A.page);
	const playRow = await A.page.evaluate(() => {
		const row = document.querySelector('[data-shortcut="scene.play"]');
		if (!row) return null;
		const el = row.querySelector('.shortcut-keys');
		return { keys: el ? el.textContent.trim() : null, label: row.textContent.replace(/\s+/g, ' ').trim() };
	});
	h.check(playRow && playRow.keys === 'Ctrl+Enter', `8.1 the Scene group lists the play row (${playRow && playRow.keys})`);
	h.check(!!playRow && /Play/.test(playRow.label), `8.2 ...and says what it does ("${(playRow && playRow.label || '').slice(0, 60)}")`);

	await closeSettings(A.page);
	const before = await A.page.evaluate(() => {
		let v;
		window.__stores.isLocked.subscribe((x) => (v = x))();
		return v;
	});
	h.check(before !== true, `8.3 premise: not playing yet (isLocked=${before})`);
	await press(A.page, 'Control+Enter');
	await A.page.waitForTimeout(600);
	const after = await A.page.evaluate(() => {
		let v;
		window.__stores.isLocked.subscribe((x) => (v = x))();
		return v;
	});
	h.check(after === true, `8.4 Ctrl+Enter presses the play button (isLocked=${after})`);

	await h.finish(browser);
});
