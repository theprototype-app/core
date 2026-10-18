// 48 F2 — LARGE CC0 MATERIAL PRESETS REACH EVERY PEER. 47-cc0's known limit: a CC0 material carries its colour and
// normal maps as JPEG data-URLs (3-6 MB of JSON at 2k), and the library broadcast dropped presets from its end until
// the JSON fit 2 MB — so the swatch never appeared in a peer's "From A" row. Now every preset is listed; a big one
// travels by reference and is pulled once, in parts.
//
// What is asserted, two real peers (A saves, B joins):
//  1. premise: A's library holds two presets well over the 2 MB cap (real noise JPEGs at 2048²) beside small ones
//  2. B joining receives A's WHOLE library — the swatch list is equal on both, in the same order, and each big
//     preset's maps arrive byte-identical (the reassembled JSON is hash-checked)
//  3. a big preset saved AFTER B connected reaches B live
//  4. a later small save re-sends nothing big (B already holds the referenced bytes: zero parts sent)
//  5. B's Inspector row draws A's swatches in A's order
//  6. faster preset save: saving one more preset does not re-read the whole library from IndexedDB
//
// Counterfactual (base v1.38.0): 2 and 3 are red (the big presets never reach B), 4 has no parts to count, 6 is
// slower by the library's size (printed side by side in the evidence).
const h = require('./helpers.cjs');

const EVIDENCE = process.env.EVIDENCE || null;
const shot = async (page, name) => {
	if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/${name}.png` }).catch(() => {});
};
const waitVal = async (fn, ok, ms = 20000) => {
	const end = Date.now() + ms;
	let v;
	while (Date.now() < end) {
		v = await fn();
		if (ok(v)) return v;
		await new Promise((r) => setTimeout(r, 300));
	}
	return v;
};
/** a noise JPEG at 2048² — what a 2k CC0 texture weighs as a data-URL @param {any} page @param {number} seed */
const noiseJpeg = (page, seed) =>
	page.evaluate((s) => {
		const c = document.createElement('canvas');
		c.width = c.height = 2048;
		const g = c.getContext('2d');
		const img = g.createImageData(2048, 2048);
		let x = s * 2654435761;
		for (let i = 0; i < img.data.length; i += 4) {
			x = (x * 1103515245 + 12345) >>> 0;
			img.data[i] = x & 255;
			img.data[i + 1] = (x >>> 8) & 255;
			img.data[i + 2] = (x >>> 16) & 255;
			img.data[i + 3] = 255;
		}
		g.putImageData(img, 0, 0);
		return c.toDataURL('image/jpeg', 0.9);
	}, seed);
/** save through the app's own path; returns [name, ms] @param {any} page @param {any} payload */
const save = (page, payload) =>
	page.evaluate(async (p) => {
		const t0 = performance.now();
		const name = await window.__stores.materialPresets.saveMaterialPreset(p.label, p);
		return [name, performance.now() - t0];
	}, payload);
const mine = (page) =>
	page.evaluate(async () => {
		const list = await new Promise((r) => window.__stores.materialPresets.materialPresets.subscribe(r)());
		return list.map((p) => ({ label: p.name, map: p.payload.map?.length ?? 0, normal: p.payload.normalMap?.length ?? 0 }));
	});
const theirs = (page) =>
	page.evaluate(async () => {
		const map = await new Promise((r) => window.__stores.materialPresets.peerMaterialPresets.subscribe(r)());
		return Object.values(map)
			.flat()
			.map((p) => ({ label: p.label, map: p.map?.length ?? 0, normal: p.normalMap?.length ?? 0 }));
	});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { storage: { 'inspector:sec:Material': 'open' } });
	const P = A.page;

	// ---------- 1. a library with presets over the cap ----------
	const small = (label, color) => ({ version: 1, label, type: 'MeshStandardMaterial', color, roughness: 0.4 });
	const big = async (label, seed) => ({ version: 1, label, type: 'MeshStandardMaterial', color: '#ffffff', roughness: 0.7, map: await noiseJpeg(P, seed), normalMap: await noiseJpeg(P, seed + 1), normalScale: 1, source: { site: 'polyhaven', authors: 'Test', license: 'CC0', url: 'https://polyhaven.com/a/test' } });
	await save(P, small('Clay', '#cc8855'));
	await save(P, await big('Big bark', 11));
	await save(P, small('Slate', '#445566'));
	await save(P, await big('Big rock', 21));
	const a0 = await mine(P);
	const bigBytes = a0.filter((p) => p.map > 0).map((p) => p.map + p.normal);
	console.log('  A library: ' + JSON.stringify(a0));
	h.check(a0.length === 4 && bigBytes.length === 2 && bigBytes.every((n) => n > 2_000_000), `premise: two presets each over the 2 MB broadcast cap (${bigBytes.map((n) => (n / 1e6).toFixed(1) + ' MB').join(', ')})`);

	// ---------- 2. B joins: the whole library arrives, same order, same bytes ----------
	const B = await h.setupPage(browser, 'B', { storage: { 'inspector:sec:Material': 'open' } });
	await h.connect(B, A);
	const t0 = Date.now();
	const b1 = await waitVal(() => theirs(B.page), (v) => same(v, a0), 60000);
	console.log('  B sees: ' + JSON.stringify(b1) + ` after ${Date.now() - t0} ms`);
	h.check(same(b1.map((p) => p.label), a0.map((p) => p.label)), `F2: B's list of A's presets equals A's own, in order (${b1.map((p) => p.label).join(', ')})`);
	h.check(same(b1, a0), 'F2: …and every big preset arrived whole (map + normal map byte counts equal)');
	const exact = await (async () => {
		const pick = (page, src) =>
			page.evaluate(async (s) => {
				const st = window.__stores.materialPresets;
				const list = s === 'mine' ? (await new Promise((r) => st.materialPresets.subscribe(r)())).map((p) => p.payload) : Object.values(await new Promise((r) => st.peerMaterialPresets.subscribe(r)())).flat();
				const p = list.find((x) => x.label === 'Big rock');
				return p ? p.map.slice(-64) + p.normalMap.slice(1000, 1064) : null;
			}, src);
		return (await pick(P, 'mine')) === (await pick(B.page, 'theirs'));
	})();
	h.check(exact, 'F2: the reassembled maps are byte-identical (sampled at both ends of the data-URLs)');

	// ---------- 3. a big preset saved while connected reaches B live ----------
	await save(P, await big('Big moss', 31));
	const a1 = await mine(P);
	const b2 = await waitVal(() => theirs(B.page), (v) => same(v, a1), 60000);
	h.check(same(b2, a1), `F2: a big preset saved after B joined reaches B live (${b2.map((p) => p.label).join(', ')})`);

	// ---------- 4. a later small save re-sends nothing big ----------
	await P.evaluate(async () => {
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		window.__parts = 0;
		for (const conn of Object.values(peer.connections)) {
			if (conn.__f2) continue;
			const orig = conn.send.bind(conn);
			conn.send = (m) => {
				if (m?.type === 'matpresetpart') window.__parts++;
				return orig(m);
			};
			conn.__f2 = true;
		}
	});
	await save(P, small('Mint', '#66ddaa'));
	const a2 = await mine(P);
	const b3 = await waitVal(() => theirs(B.page), (v) => same(v, a2), 20000);
	await P.waitForTimeout(1500);
	const parts = await P.evaluate(() => window.__parts);
	h.check(same(b3, a2) && parts === 0, `F2: a small save reaches B and re-sends no big preset (${parts} parts sent)`);

	// ---------- 5. B's Inspector row: A's swatches in A's order ----------
	const uuid = await P.evaluate(async () => {
		const w = window.__stores;
		const g0 = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const before = new Set(g0.children.map((c) => c.uuid));
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 800));
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		return g.children.find((c) => !before.has(c.uuid))?.uuid;
	});
	await waitVal(() => B.page.evaluate(async (u) => !!(await new Promise((r) => window.__stores.objectsGroup.subscribe(r)())).getObjectByProperty('uuid', u), uuid), (v) => v, 20000);
	await B.page.evaluate(async (u) => window.__stores.objectActions.selectObject(u, true), uuid);
	await B.page.locator('#material-presets').waitFor({ timeout: 15000 }).catch(() => {});
	await B.page.waitForTimeout(800);
	const row = await B.page.evaluate(() => [...document.querySelectorAll('#material-presets .mp-swatch[data-preset-kind="peer"]')].map((b) => b.getAttribute('data-preset-name')));
	h.check(same(row, a2.map((p) => p.label)), `F2: B's Inspector draws A's swatches, in A's order (${row.join(', ')})`);
	await shot(B.page, '01-peer-row-big-presets');

	// ---------- 6. faster preset save ----------
	// IndexedDB is the floor here: once multi-MB records are in the store even a tiny put takes hundreds of ms on
	// this box. So the save is measured AGAINST a bare put made the same moment — the old save also re-read the
	// whole library (every key, then every record, a few MB each) after its put.
	const rounds = [];
	for (let i = 0; i < 3; i++) {
		const put = await P.evaluate(async (k) => {
			const idb = window.__stores.idb;
			const t = performance.now();
			await idb.idbPut('f2-probe:' + k, { k });
			const ms = performance.now() - t;
			await idb.idbDelete('f2-probe:' + k);
			return ms;
		}, i);
		const [, ms] = await save(P, small('Quick ' + i, '#88aa22'));
		rounds.push({ put: Math.round(put), save: Math.round(ms) });
	}
	console.log('  bare put vs save (ms): ' + JSON.stringify(rounds));
	const over = Math.min(...rounds.map((r) => r.save - r.put));
	h.check(over < 350, `F2: a save costs about one IndexedDB put — it no longer re-reads the library (best save − put = ${over} ms; ${JSON.stringify(rounds)})`);

	h.check(h.pageErrors(A).length === 0, 'no page errors on A: ' + h.pageErrors(A).slice(0, 2).join(' | '));
	h.check(h.pageErrors(B).length === 0, 'no page errors on B: ' + h.pageErrors(B).slice(0, 2).join(' | '));
	await h.finish(browser);
});
