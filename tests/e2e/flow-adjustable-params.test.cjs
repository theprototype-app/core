// Roadmap #9 B4.3/4.4: the Flow ⓘ/⚙ panel tabs and adjustable node params —
// slider min/max (runtime-clamped), switcher items list + number-source output,
// number step. Params replicate via setNodeData (capture-stub broadcast assert).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// runtime semantics (pure evalNode)
	const rt = await A.page.evaluate(() => {
		const f = window.__stores.flowRuntime.evalNode;
		const n = (type, data) => ({ id: 't', type, data });
		return {
			clamped: f(n('slider', { value: 100, min: 0, max: 10 }), [], [], 0),
			inRange: f(n('slider', { value: 7, min: 0, max: 10 }), [], [], 0),
			swIndex: f(n('switcher', { items: ['a', 'b', 'c'], index: 2 }), [], [], 0),
			swLegacy: f(n('switcher', { shape: 'pyramid' }), [], [], 0)
		};
	});
	h.check(rt.clamped === 10 && rt.inRange === 7, `slider clamps to its adjustable range (${rt.clamped}/${rt.inRange})`);
	h.check(rt.swIndex === 2, `switcher outputs its selected index (${rt.swIndex})`);
	h.check(rt.swLegacy === 1, `legacy shape-only switcher still resolves (pyramid=1)`);

	// ⓘ tab editors + replication broadcast
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowNodes.set([
			{ id: 's1', type: 'slider', position: { x: 0, y: 0 }, data: { type: 'slider', label: 'Slider', value: 20, min: 0, max: 40 }, selected: true },
			{ id: 'w1', type: 'switcher', position: { x: 0, y: 140 }, data: { type: 'switcher', label: 'Switcher', items: ['cube', 'pyramid'], index: 0, shape: 'cube' } }
		]);
		s.flowEdges.set([]);
	});
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(1200);
	// open the props panel + ⓘ tab
	await A.page.evaluate(() => {
		if (!document.querySelector('#flow-props')) document.querySelector('#flow-props-toggle')?.click();
	});
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => document.querySelector('#flow-tab-info')?.click());
	await A.page.waitForTimeout(200);
	// select the slider node (click its card)
	await A.page.evaluate(() => document.querySelector('[data-id="s1"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
	await A.page.waitForTimeout(300);
	h.check((await A.page.locator('#param-slider-min').count()) === 1, 'ⓘ tab shows the slider min/max editors');

	// change max via the ⓘ editor with a capture stub on peers.send
	const sent = await A.page.evaluate(async () => {
		const s = window.__stores;
		let original;
		s.peers.subscribe((p) => (original = p))();
		const captured = [];
		s.peers.set({ ...(original ?? {}), peer: original?.peer ?? { id: 'me' }, send: (m) => captured.push(m) });
		const el = document.querySelector('#param-slider-max');
		el.value = '10';
		el.dispatchEvent(new Event('change'));
		await new Promise((r) => setTimeout(r, 200));
		s.peers.set(original);
		let nodes;
		s.flowNodes.subscribe((x) => (nodes = x))();
		return { max: nodes.find((n) => n.id === 's1').data.max, msg: captured.find((m) => m.type === 'nodedata') };
	});
	h.check(sent.max === 10, `ⓘ max editor writes node data (${sent.max})`);
	h.check(!!sent.msg && sent.msg.data?.max === 10, 'the param change BROADCASTS via nodedata');

	// switcher items add via ⓘ
	await A.page.evaluate(() => document.querySelector('[data-id="w1"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => document.querySelector('#param-switcher-add')?.click());
	await A.page.waitForTimeout(200);
	const items = await A.page.evaluate(() => {
		let nodes;
		window.__stores.flowNodes.subscribe((x) => (nodes = x))();
		return nodes.find((n) => n.id === 'w1').data.items;
	});
	h.check(items.length === 3, `ⓘ add-item grows the switcher list (${items.length})`);
	const radios = await A.page.locator('[data-id="w1"] input[type="radio"]').count();
	h.check(radios === 3, `the switcher card re-renders the grown list (${radios} radios)`);

	await h.finish(browser);
});
