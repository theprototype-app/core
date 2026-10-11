// 41 G23 — "Move left/right in Controls, several times from the very right of the play button
// to the leftmost, then reload: some icons break and show incorrectly" (the user's 1.32 review).
//
// THE CAUSE (measured on feat/40-int): the page is prerendered with the DEFAULT bar, and svelte
// 5 hydrates a keyed {#each} positionally — it walks the client's (stored, custom) cells onto
// the server's default markup. Titles and tints were repaired by their effects, so every cell
// still SAID the right thing; its <svg> kept the paths of whichever button sat in that slot by
// default. Counterfactual on feat/40-int: "every cell draws its own icon after the reload" is
// red (Node editor drew a mix of two glyphs, Animation drew the Pivot crosshair, Pivot drew
// the Node editor graph).
//
// Driven the way the user drives it: REAL right-clicks on the cells and real clicks on the
// menu's "Move left" row, then a real page reload.
const h = require('./helpers.cjs');

/** every bar cell: its title, the lucide class its <svg> claims, and the svg's actual drawing */
const cells = (page) =>
	page.evaluate(() =>
		[...(document.querySelector('#controls-pill')?.firstElementChild?.children ?? [])].map((el) => {
			const svg = el.querySelector('svg');
			return {
				title: el.getAttribute('title') ?? '—',
				glyph: [...(svg?.classList ?? [])].find((c) => c.startsWith('lucide-') && c !== 'lucide-icon') ?? null,
				draw: svg ? svg.innerHTML.replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ') : null
			};
		})
	);

async function moveLeft(page, title) {
	await page.locator(`#controls-pill > div > [title="${title}"]`).click({ button: 'right' });
	await page.waitForTimeout(200);
	await page.getByRole('menuitem', { name: 'Move left', exact: true }).click();
	await page.waitForTimeout(200);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });

	// the reference: what each button's icon looks like, read off a DEFAULT bar
	const reference = Object.fromEntries((await cells(A.page)).map((c) => [c.title, c.draw]));
	h.check(Object.keys(reference).length === 10, `premise: the default bar has nine buttons and the well (${Object.keys(reference).length})`);

	// ---- walk the far-right button to the leftmost, four times over --------------------------
	for (let round = 0; round < 4; round++) {
		let row = await cells(A.page);
		const far = row[row.length - 1].title;
		for (let i = 0; i < 12 && (await cells(A.page))[0].title !== far; i++) await moveLeft(A.page, far);
		row = await cells(A.page);
		h.check(row[0].title === far, `round ${round + 1}: ${far} reached the leftmost slot`);
	}
	const before = await cells(A.page);
	h.check(
		before.map((c) => c.title).join(' | ').startsWith('Object list (O) | Node editor (N) | Explorer | Animation | Move (1)'),
		`premise: the four right-hand buttons now lead the bar (${before.map((c) => c.title).join(' | ')})`
	);
	h.check(
		before.every((c) => c.draw === reference[c.title]),
		'premise: before the reload every cell draws its own icon (a live reorder moves real nodes)'
	);
	await A.page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/g23-before-reload.png` : '/dev/null', clip: { x: 300, y: 780, width: 840, height: 120 } }).catch(() => {});

	// ---- reload ---------------------------------------------------------------------------
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 30000 });
	await A.page.waitForTimeout(1500);
	const after = await cells(A.page);
	await A.page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/g23-after-reload.png` : '/dev/null', clip: { x: 300, y: 780, width: 840, height: 120 } }).catch(() => {});
	h.check(
		after.map((c) => c.title).join('|') === before.map((c) => c.title).join('|'),
		`the order survives the reload (${after.map((c) => c.title).join(' | ')})`
	);
	const wrong = after.filter((c) => c.draw !== reference[c.title]);
	h.check(wrong.length === 0, `G23: every cell draws its OWN icon after the reload (wrong: ${wrong.map((c) => c.title).join(', ') || 'none'})`);
	const badClass = after.filter((c, i) => c.glyph !== before[i].glyph);
	h.check(badClass.length === 0, `and every svg claims the same glyph as before (${badClass.map((c) => c.title).join(', ') || 'none'})`);

	// ---- a stored record that is broken in every way still renders a sane bar ----------------
	await A.page.evaluate(() =>
		localStorage.setItem(
			'controlsLayout',
			JSON.stringify({ order: ['animation', 'animation', 'nope', 7, 'move', 'flow'], hidden: ['ghost', 'flow'], spacerIndex: 40, collapsed: 'yes', posX: 'left' })
		)
	);
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 30000 });
	await A.page.waitForTimeout(1500);
	const repaired = await cells(A.page);
	const titles = repaired.map((c) => c.title);
	h.check(new Set(titles).size === titles.length, `a duplicated id renders ONCE (${titles.join(' | ')})`);
	h.check(titles.filter((t) => t === '—').length === 1, 'exactly one play well, wherever spacerIndex pointed');
	h.check(!titles.includes('Node editor (N)'), 'the hidden entry stays hidden');
	h.check(repaired.every((c) => c.draw === reference[c.title]), 'and every repaired cell draws its own icon');
	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).join(' / ')})`);

	await h.finish(browser);
});
