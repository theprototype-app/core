// 48 G1 (R40) — the phone "Failed to fetch" page errors of the deployed-build proofs were troika-three-text's
// runtime font lookup: every in-scene label (avatar name tag, VR panels, pins) names no font, so troika fetched
// glyph data from cdn.jsdelivr.net/gh/lojjic/unicode-font-resolver, and a failed fetch was an uncaught page error.
// 1.40 (49 J4b, troika-fonts) self-hosts that data under fonts/unicode-font-resolver/, so this suite now proves
// the CDN no longer matters:
//   1. with the third-party CDN aborted, the character card (proof F2's Customize character) asks only this
//      deployment for its font data and raises nothing — no app error, no external error
//   2. with the CDN open the same page raises nothing either
//   3. counterfactual: a real uncaught error in the same page is still an app error
//   (on v1.39.0 leg 1 is red: the requests go to cdn.jsdelivr.net and the abort raises "Failed to fetch")
// Run: APP_URL=https://localhost:5486/ node tests/e2e/external-font-cdn.test.cjs
const h = require('./helpers.cjs');

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 };

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	for (const blocked of [true, false]) {
		const P = await h.setupPage(browser, blocked ? 'blocked' : 'open', { context: PHONE });
		const asked = [];
		P.page.on('request', (r) => /unicode-font-resolver/.test(r.url()) && asked.push(r.url()));
		if (blocked) await P.ctx.route(/cdn\.jsdelivr\.net\/gh\/lojjic\/unicode-font-resolver/, (r) => r.abort('failed'));
		await P.page.evaluate(() => window.__tp.test.v1.characterModalOpen.set(true));
		await h.eventually(() => Promise.resolve(asked.length), (n) => n > 0, `${blocked ? 'blocked' : 'open'}: the character card asks for glyph data`, 15000);
		await P.page.waitForTimeout(3000);
		const origin = new URL(h.URL).origin;
		const foreign = asked.filter((u) => new URL(u).origin !== origin);
		h.check(foreign.length === 0, `${blocked ? 'blocked' : 'open'}: every font request is this deployment's own (${asked.length} asked, ${foreign.length} third-party${foreign[0] ? ': ' + foreign[0] : ''})`);
		if (blocked) {
			h.check(h.externalErrors(P).length === 0 && h.pageErrors(P).length === 0, `with the font CDN aborted nothing is raised (${[...h.externalErrors(P), ...h.pageErrors(P)].join(' | ') || 'none'})`);
			// 3. the classifier is narrow: a genuine uncaught error is still the app's
			await P.page.evaluate(() => setTimeout(() => { throw new TypeError('Failed to fetch (an app fetch, not the font CDN)'); }, 0));
			await P.page.waitForTimeout(300);
			h.check(h.pageErrors(P).some((e) => /an app fetch/.test(e)), 'counterfactual: an uncaught error of the app itself is still a page error');
		} else {
			h.check(h.externalErrors(P).length === 0 && h.pageErrors(P).length === 0, `with the CDN reachable nothing is raised (${asked.length} font requests)`);
		}
		await P.ctx.close();
	}
	await h.finish(browser);
});
