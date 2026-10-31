// ROADMAP 56 C13 — THE SESSION VOLUME ON A THROTTLED PHONE.
//
// G is the Oppo Find N6 FOLDED (390x896, touch, DPR 2.9) on a slow link — Chrome's network
// emulation at ~1.5 Mbps / 150 ms — joining H, a desktop host that shares its whole library:
// a photo and three ~18 MB files (54 MB together).
//
//   1. the rows AND the thumbnails arrive within the ordinary join wait;
//   2. no bytes move until a file is opened — counted on both ends (G's pulls, H's answers);
//   3. Copy of the three big files together (> 50 MB) ASKS "Download 54 MB from H?" first;
//      Cancel moves nothing (no request leaves, G's Library unchanged);
//   4. a pull cancelled while running leaves nothing behind;
//   5. opening the photo pulls exactly that one file.
//
// HONEST LIMIT: CDP network emulation throttles HTTP and the signaling WebSocket, NOT the WebRTC
// data channel the rows and bytes ride on — so this measures the protocol's shape (what is sent,
// when, how often) on a phone-sized page, not wall-clock transfer times on a 1.5 Mbps link.
//
// Run: APP_URL='https://localhost:5482/' npm run e2e -- session-volume-phone
const h = require('./helpers.cjs');
const path = require('path');
const fs = require('fs');

const EVIDENCE = process.env.E2E_EVIDENCE_DIR || '';
const MB = 1024 * 1024;

const vols = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.sessionVolumes.sessionVolumes.subscribe((x) => (v = x))();
		return (v ?? []).map((x) => ({ id: x.id, host: x.host, items: x.items.map((i) => ({ id: i.id, name: i.name, size: i.size, thumb: !!i.thumbnail })) }));
	});
const debug = (p) => p.page.evaluate(() => window.__stores.sessionVolumes.volumeDebug());
const answers = async (H) => (await debug(H)).log.filter((l) => /^(answer|refused) volget/.test(l)).length;
const library = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return (v ?? []).map((i) => i.name + ':' + i.hash).sort();
	});

h.run(async () => {
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H', { context: { viewport: { width: 1440, height: 900 } } });
	const G = await h.setupPage(browser, 'G', { context: { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true } });
	for (const peer of [H, G]) {
		await peer.page.waitForFunction(() => !!window.__stores?.sessionVolumes && !!window.__stores?.explorer, null, { timeout: 90000 });
		await peer.page.evaluate(async () => {
			const s = window.__stores;
			await s.explorer.loadExplorer();
			await s.explorer.clearLibrary();
			s.levels.currentLevel.set(null);
		});
	}

	const made = await H.page.evaluate(async (size) => {
		const s = window.__stores;
		const c = document.createElement('canvas');
		c.width = c.height = 32;
		const g = c.getContext('2d');
		g.fillStyle = 'rgb(40, 120, 200)';
		g.fillRect(0, 0, 32, 32);
		const png = await new Promise((r) => c.toBlob(r, 'image/png'));
		const out = [await s.explorer.addItemFromBytes(await png.arrayBuffer(), 'photo.png', null)];
		for (let n = 1; n <= 3; n++) {
			const bytes = new Uint8Array(size);
			for (let i = 0; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(size, i + 65536)));
			out.push(await s.explorer.addItemFromBytes(bytes.buffer, 'take-' + n + '.txt', null));
		}
		s.sessionVolumes.setShareScope('library');
		return out.map((i) => i && { name: i.name, size: i.size, thumb: !!i.thumbnail });
	}, 18 * MB);
	h.check(made.every(Boolean) && made.filter((i) => i.size >= 18 * MB).length === 3, `premise: H holds photo.png and three 18 MB files (${made.map((i) => i && i.name + ' ' + i.size).join(', ')})`);

	const cdp = await G.page.context().newCDPSession(G.page);
	await cdp.send('Network.enable');
	await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.5 * 1e6) / 8, uploadThroughput: (1.5 * 1e6) / 8 });

	// ---- 1. rows + thumbnails within the join wait ----------------------------------------------
	// the folded phone keeps the Connect field inside a sheet, so dial through the same function the
	// pill calls (requestConnect), then approve on the host and wait the helper's ordinary 9 s settle
	await G.page.evaluate((id) => window.__stores.peerApproval.requestConnect(id), H.id);
	await h.approveButton(H.page).click({ timeout: 30000 });
	await G.page.waitForTimeout(9000);
	await h.eventually(() => vols(G), (x) => x.length === 1 && x[0].items.length === 4, 'premise: the volume arrived', 20000);
	const v = await vols(G);
	if (!v.length) {
		console.log('  H log:', JSON.stringify((await debug(H)).log.slice(-10)));
		console.log('  G log:', JSON.stringify((await debug(G)).log.slice(-10)));
	}
	h.check(v.length === 1 && v[0].items.length === 4, `within the join wait the phone has all four rows (${v[0]?.items.map((i) => i.name).join(', ')})`);
	h.check(v[0]?.items.find((i) => i.name === 'photo.png')?.thumb === true, "…and the photo's thumbnail");
	h.check(v[0]?.items.filter((i) => i.name.startsWith('take-')).every((i) => i.size >= 18 * MB), '…and every row its size');

	// ---- 2. no bytes until open -----------------------------------------------------------------
	h.check((await debug(G)).pullCount === 0 && (await answers(H)) === 0, 'no byte request left the phone, and H answered none');

	// the phone shell opens the Explorer from its own bar (#ps-explorer), docked at the bottom
	const psExplorer = G.page.locator('#ps-explorer');
	if ((await psExplorer.count()) === 1) await psExplorer.tap();
	else await G.page.locator('#explorer-slot').click();
	await G.page.waitForTimeout(1500);
	// the folded phone keeps the folder tree collapsed (as it does for mounted projects): open it
	if ((await G.page.locator('[data-session-banner]').count()) === 0) {
		const toggle = G.page.locator('[data-ws-primary-toggle]').first();
		h.check((await toggle.getAttribute('title')) === 'Show folder tree', `premise: the folded Explorer offers "Show folder tree" (${await toggle.getAttribute('title')})`);
		await toggle.click();
		await G.page.waitForTimeout(800);
	}
	const vol = G.page.locator('button[data-session-volume]');
	if ((await vol.count()) === 1) {
		await vol.click().catch(() => {});
		await G.page.waitForTimeout(800);
	}
	const fit = await G.page.evaluate(() => ({
		banner: !!document.querySelector('[data-session-banner]'),
		overflow: document.documentElement.scrollWidth > window.innerWidth + 1
	}));
	h.check(fit.banner && !fit.overflow, `folded N6: the session banner is on screen and the page does not scroll sideways (${JSON.stringify(fit)})`);
	if (EVIDENCE) {
		fs.mkdirSync(EVIDENCE, { recursive: true });
		await G.page.screenshot({ path: path.join(EVIDENCE, 'phone-folded-session-volume.png') });
	}

	// ---- 3. > 50 MB asks; Cancel moves nothing ---------------------------------------------------
	const before = await library(G);
	await G.page.evaluate((id) => {
		const s = window.__stores.sessionVolumes;
		let v;
		s.sessionVolumes.subscribe((x) => (v = x))();
		const ids = v[0].items.filter((i) => i.name.startsWith('take-')).map((i) => i.id);
		window.__copyResult = 'pending';
		s.copySessionItems(id, ids).then((n) => (window.__copyResult = n));
	}, v[0].id);
	const ask = G.page.locator('#confirm-dialog-go');
	await h.eventually(() => ask.count(), (n) => n === 1, 'copying the three (54 MB) asks first', 10000);
	const question = await G.page.evaluate(() => document.querySelector('#confirm-dialog-go')?.closest('[role=dialog], .modal, dialog')?.textContent ?? document.body.textContent);
	h.check(/Download 54 MB from .+\?/.test(question), `…"Download 54 MB from <host>?" (${(question.match(/Download [^?]+\?/) ?? [''])[0]})`);
	await G.page.locator('#confirm-dialog-cancel').click();
	await h.eventually(() => G.page.evaluate(() => window.__copyResult), (r) => r === 0, 'Cancel: nothing copied', 5000);
	await G.page.waitForTimeout(2500);
	h.check((await debug(G)).pullCount === 0 && (await answers(H)) === 0, '…not one byte request left the phone');
	h.check(JSON.stringify(await library(G)) === JSON.stringify(before), "…and the phone's Library is unchanged");

	// ---- 4. a pull cancelled while running leaves nothing ---------------------------------------
	const cancelled = await G.page.evaluate(async (id) => {
		const s = window.__stores.sessionVolumes;
		let v;
		s.sessionVolumes.subscribe((x) => (v = x))();
		const row = v[0].items.find((i) => i.name === 'take-1.txt');
		const copy = s.copySessionItems(id, [row.id]);
		let stopped = false;
		for (let n = 0; n < 400 && !stopped; n++) {
			stopped = !!s.cancelSessionPull(id, row.id);
			if (!stopped) await new Promise((r) => setTimeout(r, 10));
		}
		return { stopped, copied: await copy };
	}, v[0].id);
	h.check(cancelled.stopped && cancelled.copied === 0, `a running 18 MB pull can be cancelled, and nothing is copied (${JSON.stringify(cancelled)})`);
	await G.page.waitForTimeout(2000);
	h.check(JSON.stringify(await library(G)) === JSON.stringify(before), '…the Library holds no partial file');

	// ---- 5. Open pulls exactly the one file -------------------------------------------------------
	const pullsBefore = (await debug(G)).pullCount;
	const got = await G.page.evaluate(async (id) => {
		const s = window.__stores.sessionVolumes;
		let v;
		s.sessionVolumes.subscribe((x) => (v = x))();
		const row = v[0].items.find((i) => i.name === 'photo.png');
		const blob = await s.sessionVolumeBlob(id, row.id);
		return { size: blob ? blob.size : -1, want: row.size };
	}, v[0].id);
	h.check(got.size === got.want && got.size > 0, `opening the photo brings exactly its bytes (${got.size}/${got.want})`);
	h.check((await debug(G)).pullCount === pullsBefore + 1, '…in one pull');
	h.check(JSON.stringify(await library(G)) === JSON.stringify(before), '…and Open imports nothing');

	await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
	await h.finish(browser);
});
