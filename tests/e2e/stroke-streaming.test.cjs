// Phase 43: peers see strokes live while drawing; temp line replaced by the final mesh.
const h = require('./helpers.cjs');

const liveLineCount = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					let lines = 0;
					scene?.traverse((o) => {
						if (o.name === 'draw-live') lines++;
					});
					resolve(lines);
				})();
			})
	);

const strokeCount = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					resolve(g?.children.filter((c) => c.name === 'Stroke').length ?? 0);
				})();
			})
	);

async function drag(page, hold) {
	await page.mouse.move(500, 520);
	await page.mouse.down();
	for (let i = 1; i <= 8; i++) {
		await page.mouse.move(500 + i * 22, 520 + Math.sin(i) * 20);
		await page.waitForTimeout(90);
	}
	if (hold) await hold();
	await page.mouse.up();
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	await A.page.evaluate(() => window.__stores.drawMode.toggleDrawMode());
	await A.page.waitForTimeout(300);

	// mid-stroke: B already shows a temp line
	let midLine = 0;
	await drag(A.page, async () => {
		midLine = await liveLineCount(B.page);
	});
	h.check(midLine >= 1, `B saw the stroke while drawing (lines mid-drag: ${midLine})`);

	// after release: temp line gone, final mesh replicated
	await h.eventually(() => strokeCount(B.page), (n) => n === 1, 'final stroke mesh replicated to B');
	await h.eventually(() => liveLineCount(B.page), (n) => n === 0, 'temp line removed after the stroke lands');

	// live toggle off -> no temp line mid-drag, mesh still lands
	await A.page.evaluate(() => window.__stores.drawMode.liveStreaming.set(false));
	let midLineOff = -1;
	await drag(A.page, async () => {
		midLineOff = await liveLineCount(B.page);
	});
	h.check(midLineOff === 0, `no live line when streaming is off (${midLineOff})`);
	await h.eventually(() => strokeCount(B.page), (n) => n === 2, 'second stroke still replicates on release');

	await h.finish(browser);
});
