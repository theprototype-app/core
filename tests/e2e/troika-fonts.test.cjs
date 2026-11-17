// 49 J4 — the 3D labels' font data comes from this deployment, never a third-party CDN.
//
// troika-three-text (threlte's <Text>) resolved glyphs through unicode-font-resolver, fetching
// its index, font metadata and the font itself from cdn.jsdelivr.net at RUN TIME: labels broke
// offline or behind a blocker, and a failed fetch was an uncaught page error (48 G1). Now
// src/lib/troikaFonts.js points troika at static/fonts/unicode-font-resolver/.
//
// The network log is the proof: a ping draws a name label (Latin + an accented letter + the VR
// panels' ✓), and every font request it causes must be same-origin.
//
// Counterfactual: v1.39.0 — the requests go to cdn.jsdelivr.net, the same-origin premise is red.
// Run: e2e-slot --dev <lane> 5484 -- env APP_URL=https://localhost:5484/ npm run e2e -- troika-fonts
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const origin = new URL(h.URL).origin;
	/** @type {string[]} */
	const fontRequests = [];
	// the resolver runs in troika's worker: the CONTEXT sees worker requests too
	A.ctx.on('request', (req) => {
		const url = req.url();
		if (/unicode-font-resolver|\/font-files\/|\/font-meta\/|\/codepoint-index\//.test(url)) fontRequests.push(url);
	});
	await A.page.evaluate(() => {
		const s = window.__tp?.test.v1;
		s.username?.set?.('Zoë ✓');
		s.ping.sendPing([0, 1.2, 0]);
	});
	await h.eventually(
		async () => fontRequests.length,
		(n) => n >= 3,
		'premise: the ping label fetched its font data (index, font meta, font file)',
		20000
	);
	await A.page.waitForTimeout(2000);
	const foreign = fontRequests.filter((u) => !u.startsWith(origin + '/'));
	const own = fontRequests.filter((u) => u.startsWith(origin + '/fonts/unicode-font-resolver/'));
	console.log(`  font requests: ${fontRequests.length} (${own.length} same-origin)`);
	for (const u of fontRequests) console.log('    ' + u.replace(origin, ''));
	h.check(foreign.length === 0, `no font request leaves this origin (${foreign.length}: ${foreign.slice(0, 3).join(' ')})`);
	h.check(own.some((u) => /\/font-files\/latin\//.test(u)), 'the Latin font file came from this deployment');
	h.check(own.some((u) => /\/font-files\/symbols-2\//.test(u)), "and the VR panels' symbol font (the ✓) too");
	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).join(' | ')})`);
	await h.finish(browser);
});
