// 102 — GAUSSIAN SPLATS, the SAVE FILE across versions (the integrator's battery rule for a lane that
// touches the save file and sync). Two servers: this build (APP_URL) and the newest release
// (COMPAT_URL, a battery snapshot of the tag).
//
//   §1 an OLD scene loads unchanged: a scene saved by the release (a box, a light, a text) opens here
//      and re-saves with the same scene signature, and no splat runtime or Spark chunk loads for it
//   §2 a file saved HERE opens in the release: a .tpscene holding a splat object (bytes bundled)
//      loads there without an error, the carrier is present (an invisible box) and keeps its record
//   §3 ...and that release's re-save still opens here and draws the splats (the record survived)
//
// Run: e2e-slot --dev <lane> 7076 -- env APP_URL=https://theprototype.app:7076/ COMPAT_URL=https://theprototype.app:7077/
//      npm run e2e -- splats-compat     (the release served from scripts/ci/battery-snapshot.sh on 7077)
const h = require('./helpers.cjs');

const COMPAT_URL = process.env.COMPAT_URL;

/** a tiny .splat (32 bytes per splat): a ring of 300 @returns {Buffer} */
function ringSplat() {
	const n = 300;
	const buf = Buffer.alloc(n * 32);
	for (let i = 0; i < n; i++) {
		const t = (i / n) * Math.PI * 2;
		const o = i * 32;
		buf.writeFloatLE(Math.cos(t) * 0.5, o);
		buf.writeFloatLE(0.5 + Math.sin(t * 3) * 0.1, o + 4);
		buf.writeFloatLE(Math.sin(t) * 0.5, o + 8);
		for (let k = 0; k < 3; k++) buf.writeFloatLE(0.04, o + 12 + k * 4);
		buf.set([40, 160, 230, 255, 255, 128, 128, 128], o + 24);
	}
	return buf;
}

/** the page's scene as a .tpscene (base64) + its signature @param {any} page @param {string} name */
const saveZip = (page, name) =>
	page.evaluate(async (n) => {
		const v1 = window.__tp.test.v1;
		const payload = v1.sessions.buildSessionPayload(n);
		const { sceneSignature } = await import('/src/lib/levels.js');
		const zip = await v1.sessions.exportSessionZip(payload, { assets: true, packs: false, flow: true });
		const bytes = new Uint8Array(await new Blob([zip]).arrayBuffer());
		let s = '';
		for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return { b64: btoa(s), sig: sceneSignature(payload), size: bytes.length };
	}, name);
/** open a .tpscene (base64) the way the Explorer's Open does @param {any} page @param {string} b64 */
const openZip = (page, b64) =>
	page.evaluate(async (b) => {
		const v1 = window.__tp.test.v1;
		const bin = atob(b);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const payload = await v1.sessions.readSessionZip(bytes.buffer);
		if (!payload) return { ok: false };
		await v1.sessions.applySession(payload, { backup: false });
		return { ok: true };
	}, b64);
/** @param {any} page */
const sceneFacts = (page) =>
	page.evaluate(async () => {
		const v1 = window.__tp.test.v1;
		let g;
		v1.objectsGroup.subscribe((x) => (g = x))();
		const splats = [];
		let meshes = 0;
		g.traverse((o) => {
			if (o.isMesh) meshes++;
			if (o.userData?.splat) splats.push({ uuid: o.uuid, rec: JSON.parse(JSON.stringify(o.userData.splat)), opacity: o.material?.opacity, visible: o.visible });
		});
		const { sceneSignature } = await import('/src/lib/levels.js');
		// geometry / material uuids are minted fresh by any rebuild (3D text lays itself out again on every load,
		// in the release too): masked, while object uuids, names, transforms and every value still compare
		const sig = sceneSignature(v1.sessions.buildSessionPayload('facts'));
		const masked = sig.replace(/"(geometry|material|uuid)":"[0-9A-Fa-f-]{36}"/g, (m, k) => `"${k}":"-"`);
		const objects = [];
		g.traverse((o) => o !== g && objects.push(o.uuid + ':' + o.name)); // the root is each page's own
		return { meshes, splats, sig: masked + '|' + objects.sort().join(',') };
	});
/** a real viewport drop of one file (App.svelte handleDrop) @param {any} page @param {string} name @param {Buffer} buffer */
const dropFile = (page, name, buffer) =>
	page.evaluate(
		([n, b]) => {
			const bin = atob(b);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			const dt = new DataTransfer();
			dt.items.add(new File([bytes], n, { type: 'application/octet-stream' }));
			const canvas = document.querySelector('canvas');
			const r = canvas.getBoundingClientRect();
			canvas.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
		},
		[name, buffer.toString('base64')]
	);
/** @param {any} peer @param {string} url */
async function onServer(peer, url) {
	await peer.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
	await peer.page.waitForFunction(() => window.__tp?.test.v1 && !!window.__tp.test.v1.moduleSDK, null, { timeout: 90000 });
	await peer.page.waitForTimeout(1500);
}

h.run(async () => {
	if (!COMPAT_URL) {
		console.log('SKIP: set COMPAT_URL to the newest release (a battery snapshot of the tag)');
		process.exit(0);
	}
	const browser = await h.launch();
	const L = await h.setupPage(browser, 'lane');
	const R = await h.setupPage(browser, 'release');
	await onServer(R, COMPAT_URL);
	const version = await R.page.evaluate(() => window.__tp?.version ?? document.querySelector('meta[name="app-version"]')?.getAttribute('content') ?? '?');
	console.log(`  release page: ${COMPAT_URL} (${version})`);
	/** @type {string[]} */
	const sparkOnLane = [];
	L.page.on('request', (/** @type {any} */ r) => {
		if (/spark/i.test(r.url())) sparkOnLane.push(r.url());
	});

	// ---- §1 an old scene loads unchanged -----------------------------------------------------
	await R.page.evaluate(() => {
		const add = window.__tp.test.v1.addObjects;
		add.spawnAtPoint('/create Box', [0, 0.5, 0]);
		add.spawnAtPoint('/create Sphere', [2, 0.5, 0]);
		add.spawnAtPoint('/create Text path', [0, 1.5, -2]);
	});
	await R.page.waitForTimeout(2500);
	const old = await saveZip(R.page, 'old scene');
	const oldFacts = await sceneFacts(R.page);
	console.log(`  old scene: ${old.size} bytes, ${oldFacts.meshes} meshes`);
	h.check((await openZip(L.page, old.b64)).ok, '§1 the release\'s .tpscene opens here');
	// the A/B: the release opening its OWN file is the reference (a load re-stamps what any load re-stamps)
	h.check((await openZip(R.page, old.b64)).ok, '§1 premise: the release reopens its own file');
	await L.page.waitForTimeout(2500);
	await R.page.waitForTimeout(500);
	const oldHere = await sceneFacts(L.page);
	const oldThere = await sceneFacts(R.page);
	console.log(`  meshes: release ${oldFacts.meshes}, release reopened ${oldThere.meshes}, lane ${oldHere.meshes}`);
	h.check(oldHere.sig === oldThere.sig, `§1 ...and holds the same scene as the release opening it (signature ${oldHere.sig === oldThere.sig ? 'equal' : 'DIFFERENT'})`);
	if (oldHere.sig !== oldThere.sig) {
		let i = 0;
		while (i < oldHere.sig.length && oldHere.sig[i] === oldThere.sig[i]) i++;
		console.log(`  first difference at ${i}:\n  release ...${oldThere.sig.slice(Math.max(0, i - 120), i + 200)}\n  lane    ...${oldHere.sig.slice(Math.max(0, i - 120), i + 200)}`);
	}
	const d1 = await L.page.evaluate(() => window.__tp.test.v1.splatTick.splatDebug());
	h.check(!d1.runtimeLoaded && sparkOnLane.length === 0 && oldHere.splats.length === 0, '§1 no splat runtime and no Spark chunk for a scene without splats');

	// ---- §2 a lane file opens in the release -------------------------------------------------
	await dropFile(L.page, 'ring.splat', ringSplat());
	await h.eventually(() => sceneFacts(L.page), (f) => f.splats.length >= 1, '§2 premise: the lane scene holds a splat object', 90000);
	await h.eventually(
		() => L.page.evaluate(() => window.__tp.test.v1.splatTick.splatDebug().entries.some((e) => e.state === 'ready')),
		(v) => v === true,
		'§2 premise: the lane draws it',
		30000
	);
	const laneFacts = await sceneFacts(L.page);
	const laneSplat = laneFacts.splats[0];
	const lane = await saveZip(L.page, 'splat scene');
	console.log(`  lane .tpscene ${lane.size} bytes`);
	const errorsBefore = (R.page.__errors ?? []).length;
	h.check((await openZip(R.page, lane.b64)).ok, '§2 the lane\'s .tpscene opens in the release');
	await R.page.waitForTimeout(3000);
	const there = await sceneFacts(R.page);
	const rel = there.splats.find((s) => s.uuid === laneSplat.uuid);
	h.check(!!rel && rel.rec.hash === laneSplat.rec.hash && rel.rec.count === 300, `§2 ...the carrier is there with its record (${rel ? rel.rec.count + ' splats' : 'missing'})`);
	h.check(!!rel && rel.opacity === 0, `§2 ...as an invisible box (material opacity ${rel?.opacity})`);
	const newErrors = (R.page.__errors ?? []).slice(errorsBefore).filter((/** @type {string} */ e) => !/favicon|ResizeObserver/i.test(e));
	h.check(newErrors.length === 0, `§2 ...without a page error (${newErrors.slice(0, 2).join(' | ')})`);

	// ---- §3 the release's re-save still draws here -------------------------------------------
	const back = await saveZip(R.page, 'resaved by the release');
	h.check((await openZip(L.page, back.b64)).ok, '§3 the release\'s re-save opens here');
	await h.eventually(
		() => L.page.evaluate((u) => window.__tp.test.v1.splatTick.splatDebug().entries.find((e) => e.uuid === u) ?? null, laneSplat.uuid),
		(e) => !!e && e.state === 'ready' && e.numSplats === 300,
		'§3 ...and draws all 300 splats (the record and the bytes survived the release)',
		30000
	);

	await h.finish(browser);
});
