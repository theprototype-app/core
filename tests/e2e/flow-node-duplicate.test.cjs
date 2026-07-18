// Phase 167: right-click a flow node > Duplicate clones it (fresh uuid, offset,
// same data; edges not copied) + replicates via nodecreate.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(500);
	await A.page.evaluate(() => {
		window.__stores.flowNodes.set([
			{ id: 'dup-a', type: 'number', position: { x: 140, y: 120 }, data: { type: 'number', value: 7 }, class: 'w-[150px]' }
		]);
	});
	await A.page.waitForTimeout(500);

	// right-click the node to open its context menu
	const box = await A.page.locator('.svelte-flow__node').first().boundingBox();
	await A.page.mouse.click(box.x + box.width / 2, box.y + 14, { button: 'right' });
	await A.page.waitForTimeout(300);
	await A.page.getByText('Duplicate', { exact: true }).click();
	await A.page.waitForTimeout(300);

	const res = await A.page.evaluate(() => {
		let ns; window.__stores.flowNodes.subscribe((v) => (ns = v))();
		const numbers = ns.filter((n) => n.type === 'number');
		return {
			count: numbers.length,
			uniqueIds: new Set(numbers.map((n) => n.id)).size,
			values: numbers.map((n) => n.data.value),
			offset: numbers.length === 2 ? Math.abs(numbers[1].position.x - numbers[0].position.x) : 0
		};
	});
	h.check(res.count === 2, `Duplicate adds a second node of the same type (${res.count})`);
	h.check(res.uniqueIds === 2, 'the copy gets a fresh uuid');
	h.check(res.values.every((v) => v === 7), 'the copy keeps the original data');
	h.check(res.offset > 0, 'the copy is offset from the original');

	await h.finish(browser);
});
