// Phase 82: palette collapse/side (notebook tabs), click-to-front for floating
// windows, and the delayed resize cue.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(600);
	h.check(await A.page.locator('#palette-filter').isVisible(), 'palette open by default');

	// collapse via the notebook tab, persisted
	await A.page.locator('#palette-toggle').click();
	await A.page.waitForTimeout(300);
	h.check(
		!(await A.page.locator('#palette-filter').isVisible().catch(() => false)),
		'palette collapses'
	);
	h.check(
		(await A.page.evaluate(() => localStorage.getItem('flowPaletteOpen'))) === 'false',
		'collapse persisted'
	);
	await A.page.locator('#palette-toggle').click();
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('#palette-filter').isVisible(), 'palette reopens');

	// side toggle flips the palette across the editor
	const beforeX = (await A.page.locator('#palette-filter').boundingBox()).x;
	await A.page.locator('#palette-side').click();
	await A.page.waitForTimeout(300);
	const afterX = (await A.page.locator('#palette-filter').boundingBox()).x;
	h.check(afterX > beforeX + 300, `palette sticks to the right (${beforeX} → ${afterX})`);
	await A.page.locator('#palette-side').click();
	await A.page.waitForTimeout(200);

	// click-to-front: open chat + object list, drag chat over the list, compare z
	// (close the flow drawer first — it covers the bottom-right chat button, 93)
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(300);
	await A.page.locator('p[title="Object list (O)"]').click();
	await A.page.locator('#chat-button').click();
	await A.page.waitForTimeout(500);
	// move chat onto the object list (header drag)
	const chat = await A.page.locator('#chat-window').boundingBox();
	const list = await A.page.locator('#object-list').boundingBox();
	await A.page.mouse.move(chat.x + 150, chat.y + 12);
	await A.page.mouse.down();
	await A.page.mouse.move(list.x + 150, list.y + 40, { steps: 8 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(200);
	const zOf = (sel) => A.page.evaluate((sel) => +getComputedStyle(document.querySelector(sel)).zIndex, sel);
	// chat was interacted with last -> on top
	h.check((await zOf('#chat-window')) > (await zOf('#object-list')), 'dragged chat sits on top');
	// clicking the list raises it
	await A.page.locator('#object-list .move-handle').click({ position: { x: 10, y: 5 } });
	await A.page.waitForTimeout(200);
	h.check((await zOf('#object-list')) > (await zOf('#chat-window')), 'clicking the list raises it');

	// delayed resize cue on the flow drawer's top edge (re-open the drawer —
	// it was closed for the chat-button block above)
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(400);
	const cue = A.page.locator('#flow-list .resize-cue').first();
	const box = await cue.boundingBox();
	await A.page.mouse.move(box.x + 300, box.y + 1);
	await A.page.waitForTimeout(120); // before the delay elapses
	const early = await A.page.evaluate(() =>
		getComputedStyle(document.querySelector('#flow-list .resize-cue')).backgroundColor
	);
	await A.page.waitForTimeout(900); // past the 600ms delay + transition
	const late = await A.page.evaluate(() =>
		getComputedStyle(document.querySelector('#flow-list .resize-cue')).backgroundColor
	);
	h.check(
		(early.includes('0, 0, 0, 0') || early === 'transparent') && !late.includes('0, 0, 0, 0') && late !== 'transparent',
		`resize cue waits for the hover delay (${early} → ${late})`
	);

	await h.finish(browser);
});
