// uir-timeline — the Timeline on a touch handheld: the N6 folded (cover screen) and unfolded postures, emulated
// (the real-device rows run on the HONOR). Both are handhelds, so WindowShell starts both side panes put away
// (handheldPanels): the bar keeps a sequence picker, nothing overflows sideways, and the edge tab brings the
// Sequences list back. Split out of timeline-panes (four page boots in one suite ran past the 480 s cap).
// Run: APP_URL=https://localhost:7010/ npm run e2e -- timeline-phone   (SHOTS=<dir> keeps screenshots)
const h = require('./helpers.cjs');
const path = require('path');
const fs = require('fs');

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => {
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) });
};

/** no element of the timeline pokes out sideways */
const overflow = (page) =>
	page.evaluate(() => {
		const root = document.querySelector('.tl-root');
		if (!root) return { root: false };
		const r = root.getBoundingClientRect();
		return { root: true, scroll: root.scrollWidth - root.clientWidth, right: r.right - window.innerWidth, w: r.width };
	});

h.run(async () => {
	const browser = await h.launch();
	for (const [label, vp] of [
		['folded', { width: 412, height: 915 }],
		['unfolded', { width: 820, height: 900 }]
	]) {
		const C = await h.setupPage(browser, 'C-' + label, { context: { viewport: vp, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6 } });
		await C.page.evaluate(() => {
			const q = window.__stores.sequences;
			const s = q.createSequence('Phone cut');
			q.addItem(s, q.addTrack(s, 'event'), { t: 0.5, name: 'beat' });
		});
		await C.page.evaluate(() => window.__stores.timelineClose.set(false));
		await C.page.waitForSelector('.tl-root', { timeout: 15000 }); // a phone starts with the side panes put away
		await C.page.waitForTimeout(500);
		const phone = await C.page.evaluate(() => document.documentElement.classList.contains('phone-shell'));
		const o = await overflow(C.page);
		h.check(o.root && o.scroll <= 1 && o.right <= 1, `${label}: no sideways overflow (${JSON.stringify(o)})`);
		// both postures are a touch handheld: the side panes start put away (handheldPanels), so the bar keeps a picker
		h.check(await C.page.locator('#timeline-seq-select').isVisible(), `${label}: the bar keeps a sequence picker (the side panes start hidden${phone ? ', phone shell' : ''})`);
		await C.page.locator('.tl-root [data-ws-primary-toggle]').first().click();
		await C.page.waitForTimeout(400);
		h.check(await C.page.locator('#timeline-sequences').isVisible(), `${label}: the edge tab brings the Sequences list back`);
		await shot(C.page, `06-phone-${label}.png`);
		await C.page.context().close();
	}
	await h.finish(browser);
});
