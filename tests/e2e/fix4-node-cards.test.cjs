// 80a-fix4-ui D2 + D3 (83-batch3): node cards that say what they are.
//   D2  every HUD node input socket sits BESIDE ITS ROW (it sat at 34 + 38 * i px and drifted off the rows) and is
//       named (title + accessible name)
//   D3  the Behaviour card's buttons stay on one line ("Open view" wrapped); the Character Controller card's title is
//       not cut
// Screenshot: test-results/fix4-node-cards.png
const path = require('path');
const h = require('./helpers.cjs');

const NODES = [
	{ id: 'bar', type: 'hudbar', position: { x: 40, y: 40 }, data: { type: 'hudbar', element: 'health', min: 0, max: 60 } },
	{ id: 'txt', type: 'hudtext', position: { x: 300, y: 40 }, data: { type: 'hudtext', element: 'score' } },
	{ id: 'tmr', type: 'hudtimer', position: { x: 560, y: 40 }, data: { type: 'hudtimer', element: 'clock' } },
	{ id: 'set', type: 'hudset', position: { x: 820, y: 40 }, data: { type: 'hudset', element: 'speed' } },
	{ id: 'bhv', type: 'behaviour', position: { x: 40, y: 420 }, data: { type: 'behaviour', label: 'Behaviour', name: 'Waves', code: '' } },
	{ id: 'cc', type: 'charcontroller', position: { x: 380, y: 420 }, data: { type: 'charcontroller', label: 'Character Controller' } }
];

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'cards', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await page.locator('p[title="Node editor (N)"]').click();
	await page.waitForTimeout(800);
	await page.evaluate((nodes) => {
		const s = /** @type {any} */ (window).__tp.test.v1;
		s.flowNodes.set(nodes);
		s.flowEdges.set([]);
	}, NODES);
	await page.waitForTimeout(1500);

	// D2: each target socket's centre lies inside its row, and it has a name
	const hud = await page.evaluate((ids) => {
		/** @type {any[]} */
		const out = [];
		for (const id of ids) {
			const node = document.querySelector(`.svelte-flow__node[data-id="${id}"]`);
			if (!node) {
				out.push({ id, missing: true });
				continue;
			}
			for (const hd of node.querySelectorAll('.svelte-flow__handle.target')) {
				const key = hd.getAttribute('data-handleid');
				const row = node.querySelector(`[data-socket="${key}"]`);
				const r = hd.getBoundingClientRect();
				const cy = r.top + r.height / 2;
				const rr = row?.getBoundingClientRect();
				out.push({ id, key, beside: !!rr && cy >= rr.top - 1 && cy <= rr.bottom + 1, named: !!hd.getAttribute('title') && !!hd.getAttribute('aria-label'), cy: Math.round(cy), row: rr ? [Math.round(rr.top), Math.round(rr.bottom)] : null });
			}
		}
		return out;
	}, ['bar', 'txt', 'tmr', 'set']);
	console.log('  sockets: ' + JSON.stringify(hud));
	h.check(hud.length >= 9 && !hud.some((x) => x.missing), `D2 the four HUD cards draw their input sockets (${hud.length})`);
	h.check(hud.every((x) => x.beside), `D2 every HUD input socket sits beside its own row (${hud.filter((x) => !x.beside).map((x) => x.id + '.' + x.key).join(', ') || 'all'})`);
	h.check(hud.every((x) => x.named), 'D2 every HUD input socket has a name (title + accessible name)');

	// D3
	const cards = await page.evaluate(() => {
		const btn = document.querySelector('.svelte-flow__node[data-id="bhv"] .behaviour-open');
		const lines = btn ? (() => {
			const r = document.createRange();
			r.selectNodeContents(btn);
			return new Set([...r.getClientRects()].map((c) => Math.round(c.top))).size;
		})() : 0;
		const title = document.querySelector('.svelte-flow__node[data-id="cc"] .node-card > div:first-child span[title]');
		return { lines, title: title?.textContent, cut: title ? title.scrollWidth > title.clientWidth + 1 : null };
	});
	console.log('  cards: ' + JSON.stringify(cards));
	h.check(cards.lines === 1, `D3 the Behaviour card's "Open view" stays on one line (${cards.lines})`);
	h.check(cards.title === 'Character Controller' && cards.cut === false, `D3 the Character Controller card shows its whole title (${JSON.stringify(cards)})`);

	await page.screenshot({ path: path.join(__dirname, '..', '..', 'test-results', 'fix4-node-cards.png') }).catch(() => {});
	await h.finish(browser);
});
