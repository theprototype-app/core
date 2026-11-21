// 102b-arrange — SAVE-FILE COMPATIBILITY, run twice: once against the OLDER release's tree
// (ARRANGE_COMPAT=base: v1.71.0) and once against this lane (ARRANGE_COMPAT=lane, the default).
//   base: 1. the files this lane saved (lane-saved-array / lane-saved-layers .tpscene, from the
//            array-tool and tidy-layers suites) OPEN with no page error, every object arrives and
//            the new keys (userData.array, userData.layer, physics.layers) are KEPT when the old
//            release saves the scene again (it simply does not draw them);
//         2. a scene MADE in the old release (boxes, a group, physics, a look) is saved as
//            old-base.tpscene with its content signature, loaded back twice = the same signature
//            (the measurement is stable).
//   lane: 3. old-base.tpscene loads here with the SAME signature the old release computed:
//            an old scene loads unchanged, and nothing new is written for it.
// Files live in test-results/102b-arrange/ (copy them between the trees for the base run).
// Run: ARRANGE_COMPAT=base APP_URL=https://localhost:<base port>/ npm run e2e -- arrange-compat
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODE = process.env.ARRANGE_COMPAT === 'base' ? 'base' : 'lane';
const DIR = path.resolve(__dirname, '../../test-results/102b-arrange');

/** open a .tpscene's bytes on the page and return what the scene now holds + its signature */
async function openBytes(page, bytes) {
	return page.evaluate(async (arr) => {
		const s = window.__tp.test.v1;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		if (!payload) return { error: 'readSessionZip refused the file' };
		await s.sessions.applySession(payload, { backup: false });
		await new Promise((r) => setTimeout(r, 1500));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const objects = [];
		g.traverse((o) => {
			if (o !== g && (o.userData?.array || o.userData?.layer)) objects.push({ name: o.name, array: o.userData.array ?? null, layer: o.userData.layer ?? null });
		});
		const again = s.sessions.buildSessionPayload('compat');
		return {
			count: g.children.length,
			marked: objects,
			layers: again.physics?.layers ?? null,
			resavedArray: JSON.stringify(again.objects ?? []).includes('"array"'),
			resavedLayer: JSON.stringify(again.objects ?? []).includes('"layer"'),
			signature: s.levels.sceneSignature(again)
		};
	}, Array.from(bytes));
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	fs.mkdirSync(DIR, { recursive: true });
	console.log(`mode: ${MODE}`);

	if (MODE === 'base') {
		console.log('\n=== 1. the files this lane saved open in the older release ===');
		for (const [file, want] of [
			['lane-saved-array.tpscene', 'array'],
			['lane-saved-layers.tpscene', 'layer']
		]) {
			const p = path.join(DIR, file);
			if (!fs.existsSync(p)) {
				h.check(false, `${file} exists (run array-tool and tidy-layers on the lane first)`);
				continue;
			}
			const r = await openBytes(A.page, fs.readFileSync(p));
			h.check(!r.error && r.count >= 1, `${file}: opens, objects arrive | ` + JSON.stringify({ error: r.error, count: r.count }));
			h.check(r.marked.some((m) => m[want]), `${file}: the ${want} key rides along on the object | ` + JSON.stringify(r.marked).slice(0, 300));
			h.check(want === 'array' ? r.resavedArray : r.resavedLayer, `${file}: the older release saves it again with the key kept`);
			if (want === 'layer') h.check(Array.isArray(r.layers) && r.layers.length >= 1, `${file}: the layer table is kept in the scene physics block | ` + JSON.stringify(r.layers));
		}
		h.check(h.pageErrors(A).length === 0, 'no page error opening the lane files | ' + h.pageErrors(A).join(' / ').slice(0, 300));

		console.log('\n=== 2. a scene made in the older release (the "old scene") ===');
		const bytes = await A.page.evaluate(async () => {
			const s = window.__tp.test.v1;
			s.commandsHandler.sceneCommand('/clear all');
			await new Promise((r) => setTimeout(r, 600));
			for (const cmd of ['/create Box 1 1 1', '/create Sphere', '/create Cylinder', '/create Box 2 0.2 2']) {
				s.commandsHandler.sceneCommand(cmd);
				await new Promise((r) => setTimeout(r, 400));
			}
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			g.children.forEach((o, i) => {
				o.position.set(i * 1.5, 0.5, 0);
				o.updateMatrixWorld(true);
			});
			s.scenePhysics.setScenePhysics({ gravity: -7 });
			const zip = await s.sessions.exportSessionZip(s.sessions.buildSessionPayload('old-base'), { assets: true, packs: false, flow: true });
			return Array.from(zip);
		});
		fs.writeFileSync(path.join(DIR, 'old-base.tpscene'), Buffer.from(bytes));
		const r1 = await openBytes(A.page, bytes);
		const r2 = await openBytes(A.page, bytes);
		h.check(r1.count >= 4 && r1.signature === r2.signature, `old-base: opens with 4 objects and the same signature twice (${sha(r1.signature)})`);
		h.check(!r1.layers && !r1.resavedArray && !r1.resavedLayer, 'old-base: carries no array, layer or layer table');
		fs.writeFileSync(path.join(DIR, 'old-base.signature.txt'), r1.signature);
	} else {
		console.log('\n=== 3. the old scene loads unchanged in this lane ===');
		const p = path.join(DIR, 'old-base.tpscene');
		const sigFile = path.join(DIR, 'old-base.signature.txt');
		if (!fs.existsSync(p) || !fs.existsSync(sigFile)) h.check(false, 'old-base.tpscene + signature exist (run the base mode first)');
		else {
			const base = fs.readFileSync(sigFile, 'utf8');
			const r = await openBytes(A.page, fs.readFileSync(p));
			h.check(r.count >= 4, 'old-base opens with its objects | ' + r.count);
			h.check(r.signature === base, `the content signature equals the older release's (${sha(r.signature)} vs ${sha(base)})`);
			h.check(!r.layers && !r.resavedArray && !r.resavedLayer, 'nothing new is written for an old scene (no array, layer or layer table)');
			if (r.signature !== base) {
				fs.writeFileSync(path.join(DIR, 'old-base.lane-signature.txt'), r.signature);
				console.log('signatures differ: see old-base.lane-signature.txt');
			}
		}
		h.check(h.pageErrors(A).length === 0, 'no page error | ' + h.pageErrors(A).join(' / ').slice(0, 300));
	}

	await h.finish(browser);
});
