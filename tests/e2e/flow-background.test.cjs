// Phase 180: the Flow background pattern applies immediately on switch (no more
// none->lines round-trip) and the grid uses a soft low-alpha colour.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(700);
	await A.page.evaluate(() => document.querySelector('#flow-props-toggle').click()); // open props
	await A.page.waitForTimeout(300);

	const bgKind = () =>
		A.page.evaluate(() => {
			const bg = document.querySelector('.svelte-flow__background');
			if (!bg) return 'none';
			if (bg.querySelector('circle')) return 'dots';
			if (bg.querySelector('path')) return 'lines';
			return 'unknown';
		});
	const selectBg = async (name) => {
		await A.page.evaluate(() => document.querySelector('#flow-bg-pattern').click());
		await A.page.waitForTimeout(200);
		await A.page.evaluate((n) => {
			const opt = [...document.querySelectorAll('.ts-list .ts-opt')].find((o) => o.textContent.trim() === n);
			opt && opt.click();
		}, name);
		await A.page.waitForTimeout(300);
	};

	h.check((await bgKind()) === 'dots', 'default background is dots');

	// the key fix: switching directly between patterns applies at once
	await selectBg('Lines');
	h.check((await bgKind()) === 'lines', 'switching Dots -> Lines applies immediately (no none round-trip)');
	await selectBg('Dots');
	h.check((await bgKind()) === 'dots', 'switching Lines -> Dots applies immediately');

	// softer grid: the pattern uses our low-alpha grey (128), not a high-contrast default
	const patternColor = await A.page.evaluate(() => {
		const bg = document.querySelector('.svelte-flow__background');
		const el = bg?.querySelector('circle') || bg?.querySelector('path');
		return el ? el.getAttribute('fill') || el.getAttribute('stroke') || getComputedStyle(el).fill : '';
	});
	h.check(/128/.test(patternColor), `the grid uses a soft grey pattern colour (${patternColor})`);

	await selectBg('None');
	h.check((await bgKind()) === 'none', 'None removes the background');

	await h.finish(browser);
});
