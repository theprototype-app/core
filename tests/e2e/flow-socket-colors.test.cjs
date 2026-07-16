// Roadmap #9 B4.2: typed socket colors — handles are painted by SOCKET TYPE
// (flowSockets.typeColor) instead of the node's group accent, and the ⚙ panel
// shows a type legend. Invalid-drag red cue is CSS-only (visual, manual).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowNodes.set([
			{ id: 'n1', type: 'number', position: { x: 0, y: 0 }, data: { type: 'number', label: 'Number', value: 1 } },
			{ id: 'c1', type: 'colorpicker', position: { x: 0, y: 120 }, data: { type: 'colorpicker', label: 'Color', color: '#ff4000' } },
			{ id: 'o1', type: 'objectselector', position: { x: 240, y: 0 }, data: { type: 'objectselector', label: 'Object', selected: '-None-' } }
		]);
		s.flowEdges.set([]);
	});
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(1200);

	const hex = (rgb) => '#' + (rgb.match(/\d+/g) || []).slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('');
	const colors = await A.page.evaluate(() => {
		const bg = (sel) => {
			const el = document.querySelector(sel);
			return el ? getComputedStyle(el).backgroundColor : null;
		};
		return {
			numberOut: bg('[data-id="n1"] .svelte-flow__handle.socket-typed'),
			colorOut: bg('[data-id="c1"] .svelte-flow__handle.socket-typed'),
			objectIn: bg('[data-id="o1"] .svelte-flow__handle.socket-typed'),
			typed: document.querySelectorAll('.svelte-flow__handle.socket-typed').length
		};
	});
	h.check(colors.typed >= 3, `sockets carry the typed class (${colors.typed})`);
	h.check(hex(colors.numberOut || '') === '#38bdf8', `number source is the number color (${hex(colors.numberOut || '')})`);
	h.check(hex(colors.colorOut || '') === '#fbbf24', `colorpicker source is the color color (${hex(colors.colorOut || '')})`);
	h.check(hex(colors.objectIn || '') === '#fb923c', `objectselector target is the effect color (${hex(colors.objectIn || '')})`);

	// legend renders in the ⚙ panel (Graph view, no node selected)
	await A.page.evaluate(() => {
		const btn = document.querySelector('#flow-props-toggle');
		if (btn && !document.querySelector('#flow-props')) btn.click();
	});
	await A.page.waitForTimeout(300);
	const legend = await A.page.evaluate(() => document.querySelector('#socket-legend')?.textContent || '');
	h.check(/number/.test(legend) && /effect/.test(legend), 'the ⚙ panel shows the socket-type legend');

	await h.finish(browser);
});
