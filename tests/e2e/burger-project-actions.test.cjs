// 41b H14 — the burger menu's PROJECT section (the user's FINAL burger decision, feedback-1.32b):
//   Compact  a strict two-column grid, icons beside labels, list-row height:
//              [ New from template…            ]
//              [ Load          ][ Save       ▾ ]
//              [ Import        ][ Export…      ]
//            Save = save now with the last-used options; ▾ = the "Save options" MODAL (format +
//            everything that used to sit behind the cog); Export… = the Publish / Export dialog
//   List     the 1.32 rows, its ⚙ opening the same modal
//   Settings ▸ Interface ▸ Project actions = Auto / Compact / List; Auto = List on the phone shell,
//   Compact on desktop and on an unfolded N6. Settings search finds the row by "burger".
// Devices: desktop 1440x900, the Oppo N6 unfolded (770x850) and folded (390x896), touch at DPR 2.9.
// Counterfactual (feat/41-int): there is no #project-actions grid, no #save-options-open, no
// Save options modal and no Project actions setting.
const h = require('./helpers.cjs');

const openMenu = async (page) => {
	await page.evaluate(() => window.__stores.closeMenu.set(false));
	await page.waitForSelector('#sidebar70', { timeout: 5000 });
	await page.waitForTimeout(350);
};
const closeMenu = async (page) => {
	await page.evaluate(() => window.__stores.closeMenu.set(true));
	await page.waitForTimeout(250);
};
const layoutOf = (page) =>
	page.evaluate(() => ({
		compact: !!document.querySelector('#sidebar70 #project-actions[data-layout="compact"]'),
		list: !!document.querySelector('#sidebar70 #format-row')
	}));

/** the compact grid's cells, as the user reads them */
const gridOf = (page) =>
	page.evaluate(() => {
		const grid = document.querySelector('#project-actions');
		if (!grid) return null;
		const r = (sel) => {
			const el = grid.querySelector(sel);
			if (!el) return null;
			const b = el.getBoundingClientRect();
			return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), text: el.textContent?.trim() ?? '' };
		};
		const g = grid.getBoundingClientRect();
		return {
			grid: { x: Math.round(g.left), w: Math.round(g.width) },
			templates: r('#open-templates'),
			load: r('#project-load'),
			save: r('.pa-split'),
			saveMain: r('#project-save'),
			more: r('#project-save-as'),
			imp: r('#project-import'),
			exp: r('#open-publish-export'),
			// showhide-v8 §6: Save as… carries its words with the chevron AFTER them, so it is not an icon-label cell
			icons: [...grid.querySelectorAll('button:not(#project-save-as)')].map((b) => {
				const svg = b.querySelector('svg')?.getBoundingClientRect();
				const label = b.querySelector('.pa-label')?.getBoundingClientRect();
				return !svg || !label ? 'n/a' : Math.abs(svg.top + svg.height / 2 - (label.top + label.height / 2)) < 3 && svg.right <= label.left ? 'beside' : 'not-beside';
			})
		};
	});

/** pick the Project actions setting through Settings ▸ Interface */
async function pickSetting(page, value) {
	await page.evaluate(() => {
		const s = window.__stores;
		s.settingsOpen.set(false);
		s.settingsSection.set('interface');
		s.settingsOpen.set(true);
	});
	await page.waitForSelector('#project-actions-' + value, { timeout: 15000 });
	await page.locator('#project-actions-' + value).click();
	await page.waitForTimeout(200);
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(300);
}

h.run(async () => {
	// =====================================================================
	// 1. DESKTOP: Compact by default, the grid exactly as decided
	// =====================================================================
	let browser = await h.launch();
	const D = await h.setupPage(browser, 'desktop', { context: { viewport: { width: 1440, height: 900 } } });
	let page = D.page;
	await openMenu(page);
	h.check((await layoutOf(page)).compact && !(await layoutOf(page)).list, 'desktop: Auto draws the COMPACT project actions (no format row)');
	const g = await gridOf(page);
	h.check(!!g, 'premise: the grid is there');
	if (g) {
		h.check(/New from template/.test(g.templates?.text ?? '') && Math.abs((g.templates?.w ?? 0) - g.grid.w) <= 1, `row 1: "New from template…" spans the full width (${g.templates?.w} of ${g.grid.w})`);
		const y2 = g.load?.y, y3 = g.imp?.y;
		h.check(g.load?.text === 'Open…' && g.save?.y === y2 && (g.save?.x ?? 0) > (g.load?.x ?? 0), `row 2: Open… | Save ▾ (${JSON.stringify([g.load, g.save])})`);
		h.check(g.imp?.text === 'Import' && g.exp?.y === y3 && /Export…/.test(g.exp?.text ?? '') && (y3 ?? 0) > (y2 ?? 0), `row 3: Import | Export… (${JSON.stringify([g.imp, g.exp])})`);
		h.check(Math.abs((g.load?.w ?? 0) - (g.save?.w ?? 0)) <= 2 && Math.abs((g.imp?.w ?? 0) - (g.exp?.w ?? 0)) <= 2 && Math.abs((g.load?.w ?? 0) - (g.imp?.w ?? 0)) <= 2, 'a strict two-column grid: every half cell is one width');
		const hs = [g.templates, g.load, g.saveMain, g.imp, g.exp].map((c) => c?.h ?? 0);
		const rowH = await page.evaluate(() => Math.round(document.querySelector('#sidebar70 #clear-scene')?.getBoundingClientRect().height ?? 0));
		h.check(hs.every((x) => Math.abs(x - rowH) <= 2), `list-row height: every cell is a menu row tall (${JSON.stringify(hs)} vs Clear Scene ${rowH})`);
		h.check(g.icons.every((i) => i !== 'not-beside'), `icons sit BESIDE their labels (${JSON.stringify(g.icons)})`);
		h.check((g.more?.x ?? 0) >= (g.saveMain?.x ?? 0) + (g.saveMain?.w ?? 0) - 1 && /Save as/.test(g.more?.text ?? ''), `Save carries "Save as… ▾" on its right (${JSON.stringify(g.more)})`);
	}
	const menuW = await page.evaluate(() => document.querySelector('#sidebar70')?.getBoundingClientRect().width ?? 0);
	h.check(menuW <= 272 + 1, `the menu keeps its width (${Math.round(menuW)} px ≤ 17rem)`);

	// Export… opens the Publish / Export dialog
	await page.locator('#open-publish-export').click();
	await page.waitForTimeout(400);
	const pe = await page.evaluate(() => {
		let v;
		window.__stores.exportStores.publishExportOpen.subscribe((x) => (v = x))();
		return v;
	});
	h.check(pe === true, 'Export… opens the existing Publish / Export dialog');
	await page.evaluate(() => window.__stores.exportStores.publishExportOpen.set(false));
	await page.waitForTimeout(300);

	// ▾ opens Save options; its Save remembers the options and saves with them
	await page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		window.__stores.objectActions.deselectObject();
	});
	await openMenu(page);
	// showhide-v8 §6: Save as… ▾ is a menu in the owner's order; its last item opens Save options
	await page.locator('#project-save-as').click();
	await page.waitForSelector('[role="menu"] [role="menuitem"]', { timeout: 5000 });
	// (the owner's order puts a separator before Save options; a separator row has no text)
	const saveAs = await page.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.textContent?.trim() || '|'));
	h.check(
		JSON.stringify(saveAs) === JSON.stringify(['Save scene as file…', 'Save project as file…', 'Save as copy…', '|', 'Save options…']),
		`Save as… lists scene file / project file / copy / options (${JSON.stringify(saveAs)})`
	);
	await page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Save options…' }).click();
	await page.waitForSelector('#save-options-modal', { state: 'visible', timeout: 5000 });
	const modal = await page.evaluate(() => ({
		formats: [...document.querySelectorAll('#save-format .seg-opt')].map((b) => b.textContent?.trim()),
		toggles: [...document.querySelectorAll('#save-options-modal .tg')].map((t) => t.id),
		menuStillOpen: !!document.querySelector('#sidebar70')
	}));
	h.check(JSON.stringify(modal.formats) === JSON.stringify(['Project', 'Scene']), `Save options: Project / Scene (${JSON.stringify(modal.formats)})`);
	h.check(['tpscene-assets', 'tpscene-packs', 'tpscene-flow', 'tp-project-versions', 'show-gltf-format', 'show-json-format'].every((id) => modal.toggles.includes(id)), `…and every setting the cog had (${JSON.stringify(modal.toggles)})`);
	h.check(modal.menuStillOpen, 'pressing inside Save options does not light-dismiss the menu behind it');
	await page.locator('#save-format-tpscene').click();
	await page.locator('#tpscene-packs').click();
	const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => null), page.locator('#save-options-save').click()]);
	h.check(!!dl && dl.suggestedFilename().endsWith('.tpscene'), `its Save saves with the chosen options (${dl?.suggestedFilename()})`);
	const stored = await page.evaluate(() => [localStorage.getItem('saveFormat'), localStorage.getItem('tpscenePacks')]);
	h.check(stored.join() === 'tpscene,true', `…and remembers them (${stored.join()})`);
	await page.waitForTimeout(300);
	await openMenu(page);
	h.check(/Scene/.test((await page.getAttribute('#project-save', 'title')) ?? ''), 'Save now says it saves a Scene (its tooltip)');
	const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => null), page.locator('#project-save').click()]);
	h.check(!!dl2 && dl2.suggestedFilename().endsWith('.tpscene'), `Save (one press) saves with the last-used options (${dl2?.suggestedFilename()})`);
	// showhide-v8 §6: Save greys until the next edit (the counterfactual: it was armed by the box above)
	await page.waitForTimeout(300);
	await openMenu(page);
	h.check(await page.locator('#project-save').isDisabled(), 'after a Save, Save is greyed (nothing changed since)');
	await page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
	});
	h.check(!(await page.locator('#project-save').isDisabled()), '...and an edit arms it again');
	await closeMenu(page);

	// the setting: List is an instant rollback, Auto comes back to Compact
	await pickSetting(page, 'list');
	await openMenu(page);
	h.check((await layoutOf(page)).list && !(await layoutOf(page)).compact, 'Settings ▸ Interface ▸ Project actions = List draws the 1.32 rows at once');
	h.check((await page.locator('#format-tpscene').getAttribute('class'))?.includes('on'), 'the List row shows the same remembered format (Scene)');
	await page.locator('#export-settings-cog').click();
	h.check(await page.locator('#save-options-modal').isVisible(), "List's ⚙ opens the same Save options");
	await page.locator('#save-options-cancel').click();
	await closeMenu(page);
	h.check((await page.evaluate(() => localStorage.getItem('ui:projectActions'))) === 'list', 'the choice is stored on this device');
	await pickSetting(page, 'auto');
	await openMenu(page);
	h.check((await layoutOf(page)).compact, 'Auto brings Compact back on a desktop');
	h.check((await page.evaluate(() => localStorage.getItem('ui:projectActions'))) === null, 'Auto is the absent key (a reset and a fresh device agree)');
	await closeMenu(page);

	// settings search
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.fill('#settings-search', 'burger');
	await page.waitForTimeout(400);
	h.check(await page.locator('#row-project-actions').isVisible(), 'the settings search finds Project actions by "burger"');
	await page.fill('#settings-search', 'compact grid');
	await page.waitForTimeout(400);
	h.check(await page.locator('#row-project-actions').isVisible(), '…and by "compact grid"');
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	h.check(h.pageErrors(D).length === 0, `desktop: no page errors (${JSON.stringify(h.pageErrors(D)).slice(0, 200)})`);
	await browser.close().catch(() => {});

	// =====================================================================
	// 2. THE N6: List folded (the phone shell), Compact unfolded
	// =====================================================================
	browser = await h.launch();
	const F = await h.setupPage(browser, 'folded', { context: { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true } });
	page = F.page;
	await openMenu(page);
	h.check((await layoutOf(page)).list && !(await layoutOf(page)).compact, 'folded N6: Auto draws the LIST (the phone default)');
	await closeMenu(page);
	await pickSetting(page, 'compact');
	await openMenu(page);
	const fg = await gridOf(page);
	h.check((await layoutOf(page)).compact && !!fg && fg.icons.every((i) => i !== 'not-beside'), 'folded N6: Compact can be chosen on the phone too, icons beside labels');
	const fit = await page.evaluate(() => {
		const m = document.querySelector('#sidebar70')?.getBoundingClientRect();
		return [...document.querySelectorAll('#project-actions button')].every((b) => {
			const r = b.getBoundingClientRect();
			// hitslop-fix: the cell's CONTENT (icon + label) inside its box — not b.scrollWidth, which on a touch screen
			// also counts the button's invisible tap area (an absolutely positioned ::after past its edges)
			const inside = [...b.children].every((c) => { const q = c.getBoundingClientRect(); return q.left >= r.left - 1 && q.right <= r.right + 1; });
			return m && r.left >= m.left - 1 && r.right <= m.right + 1 && inside;
		});
	});
	h.check(fit, 'folded N6: every compact cell fits the sheet, no label clipped out of its cell');
	await closeMenu(page);
	await page.setViewportSize({ width: 770, height: 850 });
	await page.waitForTimeout(800);
	await pickSetting(page, 'auto');
	await openMenu(page);
	h.check((await layoutOf(page)).compact && !(await layoutOf(page)).list, 'unfolded N6 (770 px): Auto draws Compact');
	await closeMenu(page);
	await page.setViewportSize({ width: 390, height: 896 });
	await page.waitForTimeout(800);
	await openMenu(page);
	h.check((await layoutOf(page)).list, 'folding back: Auto follows the posture to List');
	h.check(h.pageErrors(F).length === 0, `N6: no page errors (${JSON.stringify(h.pageErrors(F)).slice(0, 200)})`);
	await h.finish(browser);
});
