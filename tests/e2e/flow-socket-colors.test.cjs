// Roadmap #9 B4.2: typed socket colors — handles are painted by SOCKET TYPE
// (flowSockets.typeColor) instead of the node's group accent, and the ⚙ panel
// shows a type legend. Invalid-drag red cue is CSS-only (visual, manual).
// 53 A2: + the per-type SHAPE (::before clip-path) and the per-theme hue tokens.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => {
		const s = window.__tp?.test.v1;
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
	// 53 A2: the socket's fill and SHAPE are drawn by its ::before (the handle box is clear)
	const read = () =>
		A.page.evaluate(() => {
			const at = (sel) => {
				const el = document.querySelector(sel);
				if (!el) return null;
				const b = getComputedStyle(el, '::before');
				return { bg: b.backgroundColor, clip: b.clipPath, type: el.getAttribute('data-socket-type'), box: getComputedStyle(el).backgroundColor };
			};
			return {
				numberOut: at('[data-id="n1"] .svelte-flow__handle.socket-typed'),
				colorOut: at('[data-id="c1"] .svelte-flow__handle.socket-typed'),
				objectIn: at('[data-id="o1"] .svelte-flow__handle.socket-typed'),
				typed: document.querySelectorAll('.svelte-flow__handle.socket-typed').length
			};
		});
	const colors = await read();
	h.check(colors.typed >= 3, `sockets carry the typed class (${colors.typed})`);
	h.check(hex(colors.numberOut?.bg || '') === '#38bdf8', `number source is the number color (${hex(colors.numberOut?.bg || '')})`);
	h.check(hex(colors.colorOut?.bg || '') === '#fbbf24', `colorpicker source is the color color (${hex(colors.colorOut?.bg || '')})`);
	h.check(hex(colors.objectIn?.bg || '') === '#fb923c', `objectselector target is the effect color (${hex(colors.objectIn?.bg || '')})`);
	h.check(/rgba\(0, 0, 0, 0\)|transparent/.test(colors.numberOut?.box || ''), `the handle box itself is clear (${colors.numberOut?.box})`);
	// 53 A2: never colour alone — each type its own shape
	h.check(/^circle/.test(colors.numberOut?.clip || ''), `a number socket is a disc (${colors.numberOut?.clip})`);
	h.check(/^polygon/.test(colors.colorOut?.clip || '') && colors.colorOut?.clip !== colors.objectIn?.clip, `a color socket is a hexagon, unlike the effect star (${colors.colorOut?.clip} / ${colors.objectIn?.clip})`);
	h.check(colors.objectIn?.type === 'effect', `the target names its type (${colors.objectIn?.type})`);
	// light theme: the token hues change (the old pale yellow sat at 1.5:1 on a white card), shapes stay
	await A.page.evaluate(() => window.__tp.test.v1.themes.theme.set('light'));
	await A.page.waitForTimeout(200);
	const light = await read();
	h.check(hex(light.colorOut?.bg || '') === '#a16207', `light: the color socket takes the light token (${hex(light.colorOut?.bg || '')})`);
	h.check(light.colorOut?.clip === colors.colorOut?.clip, 'light: the shape is the same in every theme');
	await A.page.evaluate(() => window.__tp.test.v1.themes.theme.set('dark'));
	await A.page.waitForTimeout(200);

	// legend renders in the ⚙ panel (Graph view, no node selected)
	await A.page.evaluate(() => {
		const btn = document.querySelector('#flow-props-toggle');
		if (btn && !document.querySelector('#flow-props')) btn.click();
	});
	await A.page.waitForTimeout(300);
	const legend = await A.page.evaluate(() => document.querySelector('#socket-legend')?.textContent || '');
	h.check(/number/.test(legend) && /effect/.test(legend), 'the ⚙ panel shows the socket-type legend');
	const swatches = await A.page.evaluate(() => [...document.querySelectorAll('#socket-legend .socket-swatch')].map((e) => getComputedStyle(e).clipPath));
	h.check(swatches.length === 7 && new Set(swatches).size === 7, `53 A2: the legend shows seven distinct shapes (${new Set(swatches).size})`);

	await h.finish(browser);
});
