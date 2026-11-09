// showhide-v8 §2 — THE EXPLORER'S RIGHT SIDEBAR: ONE ARROW, THREE TABS (Properties / File history / Settings), and an
// image's history viewable there.
//
//   1. the right side has ONE pane handle and three tabs, in that order
//   2. an image with saved versions: File history lists them (newest first, the current one marked) and Restore puts an
//      older one back; the counterfactual: an image with no versions shows the empty note, no rows
//   3. a file with no history (a text file) says so instead of showing an empty list
//   4. the item menu's "Version history" on a scene lands on the File history tab, with the scene's Version history in it
//
// Run: APP_URL=https://theprototype.app:6995/ npm run e2e -- explorer-file-history
const h = require('./helpers.cjs');

const S = (page, fn, arg) => page.evaluate(fn, arg);
/** a solid-colour PNG as bytes the page can store */
const pngIn = (page, colour, name) =>
	S(
		page,
		async ({ colour, name }) => {
			const c = document.createElement('canvas');
			c.width = 32;
			c.height = 24;
			const ctx = c.getContext('2d');
			ctx.fillStyle = colour;
			ctx.fillRect(0, 0, 32, 24);
			const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
			const rec = await window.__stores.explorer.addItemFromBytes(await blob.arrayBuffer(), name, null, { imported: true });
			return { id: rec.id, hash: rec.hash };
		},
		{ colour, name }
	);

h.run(async () => {
	const browser = await h.launch();
	const { page } = await h.setupPage(browser, 'A', { context: { viewport: { width: 1600, height: 950 } } });
	await S(page, () => window.__stores.explorerClose.set(false));
	await page.waitForSelector('#explorer-window, [data-panel="explorer"]', { timeout: 20000 });
	await page.waitForTimeout(800);

	// --- 1: one handle, three tabs ---
	const shell = await S(page, () => {
		const root = document.getElementById('explorer-window') ?? document.querySelector('[data-panel="explorer"]');
		return {
			handles: root?.querySelectorAll('[data-ws-secondary-toggle]').length ?? -1,
			tabs: [...(root?.querySelectorAll('[data-ws-mode]') ?? [])].map((b) => b.getAttribute('data-ws-mode'))
		};
	});
	h.check(shell.handles === 1, `1.1 the right side has one pane handle (${shell.handles})`);
	h.check(JSON.stringify(shell.tabs) === JSON.stringify(['props', 'history', 'settings']), `1.2 three tabs: Properties / File history / Settings (${JSON.stringify(shell.tabs)})`);

	// --- 2: an image's versions ---
	const red = await pngIn(page, '#c03030', 'history-red.png');
	const plain = await pngIn(page, '#3030c0', 'history-plain.png');
	// two saves through the editor's own path: the original is kept, then the replaced bytes
	const after = await S(
		page,
		async ({ id }) => {
			const s = window.__stores;
			const c = document.createElement('canvas');
			c.width = 32;
			c.height = 24;
			const ctx = c.getContext('2d');
			ctx.fillStyle = '#30c030';
			ctx.fillRect(0, 0, 32, 24);
			const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
			const res = await s.imageEditor.saveImage(id, blob);
			return { saved: !!res, list: (await s.imageVersions.listImageVersions(id)).map((v) => v.label) };
		},
		{ id: red.id }
	);
	console.log('after save', JSON.stringify(after));
	const pickCard = async (id) => {
		await page.locator(`[data-card-id="${id}"]`).first().click({ button: 'right' });
		await page.locator('[role="menu"] [role="menuitem"]').filter({ hasText: /^Properties/ }).first().click();
		await page.waitForTimeout(300);
		await page.locator('[data-ws-mode="history"]').first().click();
		await page.waitForTimeout(600);
	};
	await pickCard(red.id);
	const rows = await S(page, () =>
		[...document.querySelectorAll('#explorer-file-history #image-history .ih-row')].map((r) => ({
			label: r.querySelector('.ih-label')?.textContent?.trim(),
			restore: !!r.querySelector('[data-ih-restore]')
		}))
	);
	h.check(after.list.length >= 2 && rows.length === after.list.length, `2.1 File history lists the image's versions (${JSON.stringify(rows)})`);
	h.check(rows[0]?.label?.includes('current') && !rows[0]?.restore && rows.slice(1).every((r) => r.restore), '2.2 newest first, the current one marked, the rest restorable');
	const hashBefore = await S(page, (id) => window.__stores.explorer.itemById?.(id)?.hash ?? null, red.id);
	await page.locator('#explorer-file-history [data-ih-restore]').last().click();
	await page.waitForTimeout(1200);
	const hashAfter = await S(page, (id) => window.__stores.explorer.itemById?.(id)?.hash ?? null, red.id);
	h.check(hashAfter === red.hash && hashAfter !== hashBefore, `2.3 Restore puts the original back (${hashBefore} -> ${hashAfter}, original ${red.hash})`);
	await pickCard(plain.id);
	const empty = await S(page, () => ({
		rows: document.querySelectorAll('#explorer-file-history .ih-row').length,
		note: document.querySelector('#explorer-file-history .ih-note')?.textContent ?? ''
	}));
	h.check(empty.rows === 0 && /No saved versions yet/.test(empty.note), `2.4 (counterfactual) an image never saved shows the empty note, no rows (${JSON.stringify(empty)})`);

	// --- 3: a kind with no history ---
	const text = await S(page, async () => {
		const rec = await window.__stores.explorer.addItemFromBytes(new TextEncoder().encode('hello').buffer, 'notes.txt', null, { imported: true });
		return { id: rec.id };
	});
	await pickCard(text.id);
	const none = await S(page, () => document.querySelector('#explorer-file-history')?.textContent ?? '');
	h.check(/has none yet/.test(none), '3.1 a text file says it keeps no history');

	// --- 4: a scene's Version history lands on the tab ---
	await S(page, async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await s.levels.saveSceneAsLevel('History scene');
	});
	await page.waitForTimeout(1500);
	const sceneId = await S(page, () => window.__stores.levels.levelItems().find((i) => i.name.startsWith('History scene'))?.id ?? null);
	h.check(!!sceneId, '4.0 (premise) the scene was saved into the library');
	if (sceneId) {
		await page.locator('[data-ws-mode="props"]').first().click();
		await page.locator(`[data-card-id="${sceneId}"]`).first().click({ button: 'right' });
		await page.locator('[role="menu"] [role="menuitem"]').filter({ hasText: 'Version history' }).first().click();
		await page.waitForTimeout(800);
		const landed = await S(page, () => ({
			active: document.querySelector('[data-ws-mode][aria-selected="true"], [data-ws-mode].active, [data-ws-mode][aria-pressed="true"]')?.getAttribute('data-ws-mode') ?? null,
			panel: !!document.querySelector('#explorer-file-history #version-history')
		}));
		h.check(landed.panel, `4.1 "Version history" opens the File history tab with the scene's history (${JSON.stringify(landed)})`);
	}

	await h.finish(browser);
});
