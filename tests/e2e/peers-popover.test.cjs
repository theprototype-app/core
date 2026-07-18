// Phase 130: peers popover — the top-right overflow lists EVERY connected
// peer (none hidden by stacking, including the first two), each with a labeled
// Watch affordance; clicking Watch spectates that peer.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// inject self + four fake peers into userdata
	await A.page.evaluate(() => {
		const selfId = window.__stores.peers && (() => { let p; window.__stores.peers.subscribe((x) => (p = x))(); return p?.peer?.id; })();
		window.__self = selfId || 'self';
		window.__stores.userdata.set([
			[window.__self, 'Me', null, null, null, {}],
			['p1', 'Ann', null, null, null, {}],
			['p2', 'Bo', null, null, null, {}],
			['p3', 'Cy', null, null, null, {}],
			['p4', 'Di', null, null, null, {}]
		]);
	});
	await A.page.waitForTimeout(400);

	// --- compact trigger shows the peer count ---
	const trigger = await A.page.evaluate(() => {
		const el = document.querySelector('#peers-trigger');
		return { present: !!el, text: el?.textContent.trim() };
	});
	h.check(trigger.present && trigger.text.includes('4'), `compact trigger shows the peer count (${trigger.text})`);

	// --- opening lists ALL peers (5 rows incl. self + the first two) ---
	await A.page.evaluate(() => document.querySelector('#peers-trigger').click());
	await A.page.waitForTimeout(300);
	const popover = await A.page.evaluate(() => {
		const box = document.querySelector('#peers-popover');
		const rows = box ? [...box.querySelectorAll('.peers-row')] : [];
		const names = rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim());
		return {
			open: !!box,
			rowCount: rows.length,
			watchButtons: box ? box.querySelectorAll('.peer-watch').length : 0,
			hasAnn: names.some((n) => n.includes('Ann')),
			hasBo: names.some((n) => n.includes('Bo')),
			youMarked: names.some((n) => n.includes('Me') && n.includes('you'))
		};
	});
	h.check(popover.open, 'clicking the trigger opens the popover');
	h.check(popover.rowCount === 5, `every peer is listed (${popover.rowCount} rows incl. self)`);
	h.check(popover.hasAnn && popover.hasBo, 'the first two peers (previously stacked) are visible');
	h.check(popover.watchButtons === 4, `each peer has a Watch button, self does not (${popover.watchButtons})`);
	h.check(popover.youMarked, 'own row is marked (you)');

	// --- clicking Watch spectates that peer ---
	const watched = await A.page.evaluate(() => {
		const btn = document.querySelector('#peers-popover .peer-watch');
		btn.click();
		let spec;
		window.__stores.specatorMode.subscribe((v) => (spec = v))();
		return spec;
	});
	h.check(watched === 'p1', `Watch spectates the peer (${watched})`);

	// reset spectator so teardown is clean
	await A.page.evaluate(() => window.__stores.specatorMode.set(false));

	await h.finish(browser);
});
