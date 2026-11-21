// 80a-fix4-ui G14 (device-lab-2 F10, r1580-04 dry runs 4/4): on a JOINED phone, More ▸ Film did not open Film
// (alone it did). Proof: an N6 folded phone in a two-peer session opens Film from More 3/3 — the phone JOINED a
// desktop host (it dialled), and the other way round (the desktop joined the phone).
//   per try: More (#ps-more) -> the Film tile (#ps-tile-film) -> Film's camera picker (#film-root) -> Cancel
const path = require('path');
const h = require('./helpers.cjs');

const FOLDED = { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, userAgent: h.N6_UA };

/** @param {any} page */
const sheet = (page) => page.evaluate(() => {
	const st = /** @type {any} */ (window).__tp?.test.v1?.phoneShell;
	let v = null;
	st?.phoneSheet?.subscribe?.((/** @type {any} */ x) => (v = x))?.();
	return v;
});
/** @param {any} page */
const filmShown = (page) => page.evaluate(() => {
	const el = document.getElementById('film-root');
	return !!el && el.getBoundingClientRect().width > 0;
});

/** the live peer id @param {any} P */
const liveId = async (P) => {
	const id = await P.page.waitForFunction(() => {
		/** @type {any} */ let p;
		/** @type {any} */ (window).__tp.test.v1.peers.subscribe((/** @type {any} */ v) => (p = v))();
		return p?.peer?.open && p.peer.id ? p.peer.id : false;
	}, null, { timeout: 20000 }).then((/** @type {any} */ r) => r.jsonValue()).catch(() => null);
	if (id) P.id = id;
	return P.id;
};
/** both ends hold an open conn @param {any} a @param {any} b */
const linked = (a, b) => a.page.evaluate((/** @type {string} */ id) => new Promise((r) => /** @type {any} */ (window).__tp.test.v1.peers.subscribe((/** @type {any} */ p) => r(!!p?.connections?.[id]?.open))()), b.id).catch(() => false);

/** the folded phone dials from its own Connect sheet (the chip ▸ Join… ▸ the field ▸ Connect), the host approves
 * @param {any} P @param {any} host */
async function phoneDial(P, host) {
	await liveId(P);
	const to = await liveId(host);
	const page = P.page;
	const wrap = '.connect-wrap[data-ps-host]';
	await page.locator('#ps-connect-chip').tap();
	await page.locator(`${wrap} #connect-join`).tap({ timeout: 10000 }).catch(() => {});
	await page.locator(`${wrap} .cx-input`).fill(to, { timeout: 10000 });
	await page.locator(`${wrap} .cx-connect button`).first().tap();
	await h.approveButton(host.page).click({ timeout: 30000 });
	for (const until = Date.now() + 45000; Date.now() < until; await page.waitForTimeout(250)) if ((await linked(P, host)) && (await linked(host, P))) return true;
	return false;
}

/** three tries of More ▸ Film on the phone @param {any} P @param {string} label */
async function tries(P, label) {
	const page = P.page;
	let ok = 0;
	for (let i = 1; i <= 3; i++) {
		if ((await sheet(page)) !== 'more') await page.locator('#ps-more').tap();
		await page.waitForSelector('#ps-tile-film', { state: 'visible', timeout: 10000 }).catch(() => {});
		const at = await page.evaluate(() => {
			const t = document.getElementById('ps-tile-film');
			if (!t) return null;
			const r = t.getBoundingClientRect();
			const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
			return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: hit?.closest('#ps-tile-film') ? 'tile' : hit ? `${hit.tagName}#${hit.id}.${String(hit.className).slice(0, 60)}` : null };
		});
		console.log(`  ${label} try ${i}: tile ${JSON.stringify(at)}`);
		if (at) await page.touchscreen.tap(at.x, at.y);
		const shown = await page.waitForFunction(() => {
			const el = document.getElementById('film-root');
			return !!el && el.getBoundingClientRect().width > 0;
		}, null, { timeout: 15000 }).then(() => true, () => false);
		if (shown) ok++;
		else console.log(`  ${label} try ${i}: no Film (sheet ${await sheet(page)})`);
		await page.screenshot({ path: path.join(__dirname, '..', '..', 'test-results', `fix4-joined-film-${label.replace(/\W+/g, '-')}-${i}.png`) }).catch(() => {});
		if (await filmShown(page)) {
			await page.locator('#film-cancel').tap().catch(() => {});
			await page.waitForFunction(() => !document.getElementById('film-root'), null, { timeout: 10000 }).catch(() => {});
		}
	}
	return ok;
}

h.run(async () => {
	const browser = await h.launch();

	// 1. the phone JOINS a desktop host (the phone dials)
	{
		const A = await h.setupPage(browser, 'host', { context: { viewport: { width: 1280, height: 800 } } });
		const P = await h.setupPage(browser, 'phone', { context: FOLDED });
		const joined = await phoneDial(P, A);
		h.check(joined, 'premise: the phone dialled the host from its Connect sheet and both ends are linked');
		const ok = await tries(P, 'phone joined');
		h.check(ok === 3, `G14 a phone that JOINED a session opens Film from More ${ok}/3`);
		await P.ctx.close();
		await A.ctx.close();
	}
	// 2. a desktop joins the phone (the phone hosts)
	{
		const P = await h.setupPage(browser, 'phone2', { context: FOLDED });
		const A = await h.setupPage(browser, 'guest', { context: { viewport: { width: 1280, height: 800 } } });
		await h.connect(A, P);
		h.check((await linked(P, A)) && (await linked(A, P)), 'premise: the desktop joined the phone and both ends are linked');
		const ok = await tries(P, 'phone hosting');
		h.check(ok === 3, `G14 a phone HOSTING a session opens Film from More ${ok}/3`);
	}
	await h.finish(browser);
});
