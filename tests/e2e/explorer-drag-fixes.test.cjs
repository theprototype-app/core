// R22 round 10 — three reported Explorer bugs, each of which read as a missing feature.
//
//  1. "when I ctrl click some selected files ... for now only the latest clicked is
//     moved". The drag ALREADY carried the whole selection — dragPayloadFor has attached
//     an `items` array since 21-H3, because the VIEWPORT drop needs it to place N
//     objects. `dropInto` simply never read it, so the feature existed on the wire and
//     was thrown away on arrival.
//  2. Scrolled to the bottom, the highlight for a file dragged in from the desktop stayed
//     at the TOP. It is an absolutely-positioned child of #explorer-grid, which is the
//     SCROLLER, so `inset-1` pins it to the top of the CONTENT. The marquee beside it is
//     absolute for the OPPOSITE reason (it must scroll with the cards it picks), so the
//     two cannot share a rule.
//  3. A kind filter left folders on screen with nothing in them to find.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.explorer, null, { timeout: 30000 });
	await page.evaluate(() => window.__stores.explorer.loadExplorer());
	await page.waitForTimeout(400);

	const seeded = await page.evaluate(async () => {
		const e = window.__stores.explorer;
		await e.clearLibrary();
		const dest = e.createFolder('Destination', null);
		const audio = e.createFolder('Only audio', null);
		const enc = (s) => new TextEncoder().encode(s).buffer;
		const ids = [];
		for (const n of ['m1.txt', 'm2.txt', 'm3.txt'])
			ids.push((await e.addItemFromBytes(enc('x' + n), n, null)).id);
		// a DIFFERENT kind, alone in its own folder, for the filter check
		await e.addItemFromBytes(enc('beep'), 'tone.mp3', audio.id);
		return { dest: dest.id, audio: audio.id, ids };
	});
	await page.waitForTimeout(400);
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(800);

	// ---- 1. one drag moves the whole SET -------------------------------------------
	await page.evaluate((ids) => {
		const click = (id, ctrl) =>
			document
				.querySelector('[data-card-id="' + id + '"]')
				?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: ctrl }));
		click(ids[0], false);
		click(ids[1], true);
		click(ids[2], true);
	}, seeded.ids);
	await page.waitForTimeout(300);
	const selCount = await page.evaluate(() => document.querySelectorAll('.explorer-selected').length);
	h.check(selCount === 3, 'premise: ctrl-click builds a set of three (' + selCount + ')');

	await page.evaluate((s) => {
		const card = document.querySelector('[data-card-id="' + s.ids[2] + '"]');
		const dt = new DataTransfer();
		card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
		const folder = document.querySelector('[data-card-id="' + s.dest + '"]');
		folder.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
		folder.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
	}, seeded);
	await page.waitForTimeout(700);
	const placed = await page.evaluate((s) => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		return items
			.filter((i) => i.folderId === s.dest)
			.map((i) => i.name)
			.sort();
	}, seeded);
	h.check(
		placed.length === 3,
		'dragging ONE member of the set moves the whole set (' + JSON.stringify(placed) + ')'
	);

	// ---- 2. the drop band follows the scroll ---------------------------------------
	await page.evaluate(async () => {
		const e = window.__stores.explorer;
		const enc = (s) => new TextEncoder().encode(s).buffer;
		for (let i = 0; i < 60; i++) await e.addItemFromBytes(enc('filler' + i), 'f' + i + '.txt', null);
	});
	await page.waitForTimeout(1400);
	await page.evaluate(() => {
		const g = document.querySelector('#explorer-grid');
		g.scrollTop = g.scrollHeight;
	});
	await page.waitForTimeout(300);
	const band = await page.evaluate(
		() =>
			new Promise((r) => {
				const g = document.querySelector('#explorer-grid');
				const dt = new DataTransfer();
				dt.items.add(new File(['x'], 'from-desktop.png', { type: 'image/png' }));
				g.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
				setTimeout(() => {
					const el = document.querySelector('#explorer-drop-band');
					const gr = g.getBoundingClientRect();
					const br = el ? el.getBoundingClientRect() : null;
					r({
						scrollTop: Math.round(g.scrollTop),
						gridTop: Math.round(gr.top),
						bandTop: br ? Math.round(br.top) : null,
						visible: br ? br.top >= gr.top - 2 && br.bottom <= gr.bottom + 2 : false
					});
				}, 150);
			})
	);
	h.check(band.scrollTop > 100, 'premise: the grid really is scrolled (' + band.scrollTop + 'px)');
	h.check(
		band.visible,
		'the drop band is in the VISIBLE area, not at the top of the content (' +
			JSON.stringify(band) +
			')'
	);

	// ---- 3. a filter hides a folder with nothing matching ---------------------------
	const folders = () =>
		page.evaluate(() =>
			[...document.querySelectorAll('.explorer-folder-card')].map((c) => c.innerText.trim())
		);
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(400);
	const before = await folders();
	h.check(before.length === 2, 'premise: two folders with no filter (' + JSON.stringify(before) + ')');
	await page.locator('#explorer-filter').click();
	await page.waitForTimeout(400);
	await page.getByRole('menuitem', { name: 'Audio' }).click();
	await page.waitForTimeout(600);
	const after = await folders();
	h.check(
		after.length === 1 && /Only audio/.test(after[0]),
		'a kind filter hides a folder with nothing matching in it (' + JSON.stringify(after) + ')'
	);

	h.check(
		(h.pageErrors(A) || []).length === 0,
		'no page errors (' + (h.pageErrors(A) || []).join(' | ') + ')'
	);
	await h.finish(browser);
});
