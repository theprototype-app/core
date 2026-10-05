// 36 B8: the keymap EDITOR on the scoped registry — the mesh-edit keys are real, rebindable
// rows now (they were two display rows), conflicts are scope-aware and warned, and Reset
// puts everything back. Rebinding happens through the real Settings ▸ Shortcuts UI.
//
// Counterfactual (broken by hand once, the named check went red):
//   · MeshEditPopup matching hard-coded letters again -> "the rebound key arms Extrude"
const h = require('./helpers.cjs');

const op = (page) => page.evaluate(() => new Promise((r) => window.__stores.faceEdit.faceEditOp.subscribe(r)()));
async function openShortcuts(page) {
	await page.evaluate(() => {
		window.__stores.settingsSection.set('shortcuts');
		window.__stores.settingsOpen.set(true);
	});
	await page.waitForTimeout(700);
}
async function rebind(page, id, key) {
	await page.locator(`[data-shortcut="${id}"] button.shortcut-keys`).click();
	await page.waitForTimeout(150);
	await page.keyboard.press(key);
	await page.waitForTimeout(300);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const p = A.page;

	// --- 1. the mesh-edit commands are listed one per row, each rebindable ---------------
	await openShortcuts(p);
	const rows = await p.evaluate(() =>
		['mesh.extrude', 'mesh.inset', 'mesh.move', 'mesh.weld', 'mesh.loop', 'mesh.mode-next', 'mesh.select-all'].map((id) => ({
			id,
			button: !!document.querySelector(`[data-shortcut="${id}"] button.shortcut-keys`)
		}))
	);
	h.check(rows.every((r) => r.button), `every mesh-edit command is its own rebindable row (${JSON.stringify(rows.filter((r) => !r.button).map((r) => r.id))})`);
	h.check(!(await p.locator('[data-shortcut="mesh-edit.ops"]').count()), 'the old bundled display row is gone');

	// (K, not J: 19-A P6 gave J to Connect in the mesh scope — 36-int-124)
	// --- 2. rebind Extrude from E to K in the UI ----------------------------------------
	await rebind(p, 'mesh.extrude', 'k');
	h.check((await p.evaluate(() => window.__stores.shortcutsRegistry.bindingOf('mesh.extrude'))) === 'K', 'clicking the keys and pressing K rebinds Extrude');

	// --- 3. a conflict INSIDE a scope is warned and can be swapped; across scopes is fine --
	await rebind(p, 'mesh.inset', 'g'); // G is Move in the same (mesh) scope
	h.check(await p.locator('[data-shortcut="mesh.inset"] .shortcut-conflict').isVisible(), 'binding a key another mesh command uses is refused with a warning');
	h.check((await p.locator('[data-shortcut="mesh.inset"] .shortcut-conflict').textContent()).includes('Move'), 'the warning names the command that has it');
	await p.locator('[data-shortcut="mesh.inset"] .shortcut-cancel').click();
	await rebind(p, 'nodes.mute', 'f'); // F frames nodes in the SAME (node editor) scope
	h.check(await p.locator('[data-shortcut="nodes.mute"] .shortcut-conflict').isVisible(), 'a node-editor key clash is warned too');
	await p.locator('[data-shortcut="nodes.mute"] .shortcut-swap').click();
	await p.waitForTimeout(200);
	const swapped = await p.evaluate(() => ({
		mute: window.__stores.shortcutsRegistry.bindingOf('nodes.mute'),
		frame: window.__stores.shortcutsRegistry.bindingOf('nodes.frame-selected')
	}));
	h.check(swapped.mute === 'F' && swapped.frame === 'M', `Swap trades the two keys (${JSON.stringify(swapped)})`);
	const across = await p.evaluate(() => window.__stores.shortcutsRegistry.conflictOf('C', 'nodes.mute').shortcut?.id ?? null);
	h.check(across === null, 'C in the node editor does not clash with C (chat) in the viewport');
	const global = await p.evaluate(() => window.__stores.shortcutsRegistry.conflictOf('Ctrl+S', 'nodes.mute').shortcut?.id ?? null);
	h.check(global === 'scene.save', 'a node key onto a GLOBAL combo (Ctrl+S) is a clash — it would shadow Save there');
	await p.evaluate(() => window.__stores.settingsOpen.set(false));
	await p.waitForTimeout(400);

	// --- 4. the session obeys the rebind: K arms Extrude, E no longer does ---------------
	await p.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		window.__box = group.children[group.children.length - 1];
		window.__stores.objectActions.selectObject(window.__box.uuid);
	});
	await p.waitForTimeout(400);
	await p.evaluate(() => window.__stores.faceEdit.enterFaceEdit(window.__box.uuid));
	await p.waitForTimeout(400);
	await p.keyboard.press('g');
	await p.waitForTimeout(150);
	h.check((await op(p)) === 'move', 'G still arms Move');
	await p.keyboard.press('k');
	await p.waitForTimeout(150);
	h.check((await op(p)) === 'extrude', 'the rebound key (K) arms Extrude');
	await p.keyboard.press('g');
	await p.keyboard.press('e');
	await p.waitForTimeout(150);
	h.check((await op(p)) === 'move', 'E no longer arms Extrude');
	// the session's own key sheet shows the new key
	await p.evaluate(() => document.querySelector('#mesh-keys-help')?.click());
	await p.waitForTimeout(250);
	h.check(
		(await p.evaluate(() => document.querySelector('#mesh-keys-popover')?.textContent ?? '')).includes('K / I / G'),
		'the mesh key sheet is generated from the keymap (shows K)'
	);
	// the registry's stand-down follows the rebind: a viewport row on K would be shadowed
	const stand = await p.evaluate(() => window.__stores.shortcutsRegistry.conflictOf('K', 'scene.physics').meshEdit);
	h.check(stand === true, 'a viewport key moved onto K is warned that a mesh session owns K');
	await p.evaluate(() => window.__stores.faceEdit.exitFaceEdit());

	// --- 5. Reset all ------------------------------------------------------------------
	await openShortcuts(p);
	await p.locator('#shortcut-reset-all').click();
	await p.waitForTimeout(300);
	const reset = await p.evaluate(() => ({
		extrude: window.__stores.shortcutsRegistry.bindingOf('mesh.extrude'),
		mute: window.__stores.shortcutsRegistry.bindingOf('nodes.mute'),
		stored: localStorage.getItem('shortcutOverrides')
	}));
	h.check(reset.extrude === 'E' && reset.mute === 'M' && !reset.stored, `Reset all restores every default (${JSON.stringify(reset)})`);
	await p.screenshot({ path: '/home/deck/.code/lanes-30/after-36/36-node-ux/04-keymap-settings.png' });
	await p.evaluate(() => window.__stores.settingsOpen.set(false));

	await h.finish(browser);
});
