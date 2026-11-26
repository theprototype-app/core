// 64-int probe: does a peer on an OLDER release (OLD_APP_URL, e.g. the v1.78.0 build) that reloads come back into a
// session HOSTED by this build? vector-old-peer §4 went red on the 64 union (based on v1.78.1, whose host-reload relink
// added the `rj` rejoin proof) while it was green on the 64 lanes (based on v1.78.0). This suite has nothing of 64 in it,
// so running it with APP_URL = the plain v1.78.1 tree says whether 1.78.1 or the union owns the red.
//   1 the old peer dials this build's host and is let in
//   2 the old peer reloads: within 90 s it holds an open link to the host again, and the host lists it
//   3 the host reloads (the 1.78.1 case): within 90 s the old peer is linked again
// SKIPs without OLD_APP_URL.
const h = require('./helpers.cjs');

const OLD_URL = process.env.OLD_APP_URL;
const linked = (page) =>
	page.evaluate(() => {
		let p;
		window.__tp.test.v1.peers.subscribe((v) => (p = v))();
		return Object.values(p?.connections ?? {}).filter((c) => c?.open).map((c) => c.peer);
	});

h.run(async () => {
	if (!OLD_URL) {
		console.log('SKIP old-peer-rejoin: OLD_APP_URL is not set');
		return;
	}
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H'); // this build hosts
	const O = await h.setupPage(browser, 'O', { url: OLD_URL }); // the older release joins
	await h.connect(O, H);
	h.check((await linked(O.page)).length === 1, '1. the older peer joined the host');

	await O.page.reload({ waitUntil: 'domcontentloaded' });
	await O.page.waitForFunction(() => !!window.__tp?.test?.v1?.peers, null, { timeout: 150000 });
	await h.eventually(() => linked(O.page), (l) => l.length >= 1, '2. the older peer, reloaded, is linked to the host again', 90000);
	await h.eventually(() => linked(H.page), (l) => l.length >= 1, '2. ...and the host holds the link', 30000);

	await H.page.reload({ waitUntil: 'domcontentloaded' });
	await H.page.waitForFunction(() => !!window.__tp?.test?.v1?.peers, null, { timeout: 150000 });
	await h.eventually(() => linked(O.page), (l) => l.length >= 1, '3. after the HOST reloads, the older peer is linked again', 90000);

	console.log(`  page errors: H ${JSON.stringify(H.page.__errors ?? [])} O ${JSON.stringify(O.page.__errors ?? [])}`);
	await h.finish(browser);
});
