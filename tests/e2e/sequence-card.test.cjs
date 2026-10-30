// fix-batch-1 (docs-1): the Sequence card's four `wait` fields. At the standard 150 px card the two
// fixed labels left each field ~30 px and its values were clipped (they read as empty boxes). Every
// field must show its whole value, and the step label must fit while it is lit ("● step4").
// COUNTERFACTUAL (4cd3dafc): the inputs are narrower than their values.
// Run: APP_URL=https://theprototype.app:5591/ node tests/e2e/sequence-card.test.cjs
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', {
		context: { viewport: { width: 1440, height: 900 } }
	});
	const p = A.page;
	await p.locator('p[title="Node editor (N)"]').click();
	await p.waitForTimeout(1500);
	await p.evaluate(() =>
		window.__stores.restoreGraphs({
			scene: {
				nodes: [
					{
						id: 'src',
						type: 'onclick',
						position: { x: 0, y: 0 },
						data: { type: 'onclick', label: 'On Click' }
					},
					{
						id: 'seq',
						type: 'sequence',
						position: { x: 260, y: 0 },
						data: {
							type: 'sequence',
							label: 'Sequence',
							delay1: 0.25,
							delay2: 10.5,
							delay3: 2,
							delay4: 0.05
						},
						class: 'w-[150px]'
					}
				],
				edges: [{ id: 'e-src-seq.trigger', source: 'src', target: 'seq', targetHandle: 'trigger' }]
			}
		})
	);
	await p.waitForTimeout(900);
	/** every wait field of the card: its width, whether its value fits, what it shows */
	const fields = () =>
		p.evaluate(() =>
			[...document.querySelectorAll('.svelteFlow .svelte-flow__node[data-id="seq"] input')].map(
				(i) => {
					const el = /** @type {HTMLInputElement} */ (i);
					return { w: el.clientWidth, fits: el.scrollWidth <= el.clientWidth + 1, value: el.value };
				}
			)
		);
	// offsetWidth, not the rect: the rect includes the editor's ZOOM, and the claim is about the card's own width
	const card = await p.evaluate(
		() =>
			/** @type {HTMLElement | null} */ (
				document.querySelector('.svelteFlow .svelte-flow__node[data-id="seq"]')
			)?.offsetWidth ?? 0
	);
	const f = await fields();
	console.log('card', card, JSON.stringify(f));
	h.check(
		card >= 140 && card <= 170 && f.length === 4,
		`premise: one standard-width Sequence card with four wait fields (${card} px, ${f.length})`
	);
	h.check(
		f.every((x) => x.fits),
		`every wait field shows its whole value (${JSON.stringify(f.map((x) => x.value + (x.fits ? '' : ' CLIPPED')))})`
	);
	h.check(
		f.every((x) => x.w >= 40),
		`…in a field at least 40 px wide (${f.map((x) => x.w).join(', ')})`
	);

	// light a step: step1 fires 0.25 s after the pulse (the delays add up)
	await p.evaluate(() =>
		window.__stores.flowRuntime.applyNodeTrigger('src', (Date.now() % 86400000) / 1000, true)
	);
	await p.waitForTimeout(450);
	const lit = await p.evaluate(() =>
		[...document.querySelectorAll('.svelteFlow .svelte-flow__node[data-id="seq"] span')]
			.filter((s) => /step\d/.test(s.textContent ?? ''))
			.map((s) => ({ t: (s.textContent ?? '').trim(), fits: s.scrollWidth <= s.clientWidth + 1 }))
	);
	console.log('labels', JSON.stringify(lit));
	h.check(
		lit.length === 4 && lit.every((x) => x.fits),
		`the step labels fit, lit or not (${JSON.stringify(lit)})`
	);
	h.check(
		lit.some((x) => x.t.startsWith('●')),
		`premise: a step is lit after the pulse (${lit.map((x) => x.t).join(' | ')})`
	);
	await p
		.locator('.svelteFlow .svelte-flow__node[data-id="seq"]')
		.screenshot({ path: (process.env.EVIDENCE_DIR || '/tmp') + '/sequence-card.png' })
		.catch(() => {});

	h.check(
		h.pageErrors(A).length === 0,
		`no page errors (${JSON.stringify(h.pageErrors(A)).slice(0, 200)})`
	);
	await h.finish(browser);
});
