// Phase 136: the AI-readable project map. /llms.txt is a curated markdown map;
// /llms-full.txt inlines the whole module SDK guide so an assistant without
// repo/link access still gets the real API.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(async () => {
		const map = await fetch('/llms.txt');
		const mapText = await map.text();
		const full = await fetch('/llms-full.txt');
		const fullText = await full.text();
		return {
			mapStatus: map.status,
			mapStarts: mapText.startsWith('# theprototype.app'),
			mapLinksFull: mapText.includes('/llms-full.txt'),
			fullStatus: full.status,
			fullStarts: fullText.startsWith('# theprototype.app'),
			fullHasAnchor: fullText.includes('registerEffect'),
			fullHasRule: fullText.includes('runs on every peer')
		};
	});
	h.check(res.mapStatus === 200, 'GET /llms.txt returns 200');
	h.check(res.mapStarts, 'llms.txt starts with the "# theprototype.app" H1');
	h.check(res.mapLinksFull, 'llms.txt links the inlined SDK guide (/llms-full.txt)');
	h.check(res.fullStatus === 200 && res.fullStarts, 'llms-full.txt serves + shares the map header');
	h.check(res.fullHasAnchor, 'llms-full.txt inlines the real SDK API (registerEffect anchor)');
	h.check(res.fullHasRule, 'llms-full.txt carries the one-rule-that-matters (runs on every peer)');

	await h.finish(browser);
});
