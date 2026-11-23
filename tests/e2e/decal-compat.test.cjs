// 102 M3 — DECALS CHANGE NOTHING THEY ARE NOT IN, AND A DECAL FILE OPENS IN AN OLDER RELEASE.
//
// Run on THIS build and on the newest release (the integrator's union, or the v1.70.0 tree with this file run
// against its server); the two halves of the save-file rule:
//   §1 an OLD scene (tests/fixtures/schema-1.65/capture.tpscene) loads unchanged: its scene signature
//      (levels.sceneSignature, the volatile-free payload, uuids renumbered) is printed as SIG and, with DECALS_BASE_SIG set
//      (the value a release build printed), must match it. On a decal build the decal runtime never loads and
//      the save carries no `decal` key (feature unused = zero change).
//   §2 a file SAVED BY THIS BUILD (tests/fixtures/decals-102/decal-wall.tpscene, written by decals §8) opens:
//      no page errors, the wall is there, and the decal is either rebuilt (a decal build) or an invisible
//      placeholder mesh (an older release: opacity 0, no colour or depth writes — nothing drawn, nothing lost).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OLD = path.join(__dirname, '../fixtures/schema-1.65/capture.tpscene');
const MINE = process.env.DECAL_FILE || path.join(__dirname, '../fixtures/decals-102/decal-wall.tpscene');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const load = (file) =>
		A.page.evaluate(async (b64) => {
			const bin = atob(b64);
			const u = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
			const s = await window.__tp.test.v1.sessions;
			const payload = await s.importSessionZip(u.buffer);
			await s.applySession(payload, { backup: false, quiet: true });
			return true;
		}, fs.readFileSync(file).toString('base64'));

	// ---- §1 -------------------------------------------------------------------------------
	await load(OLD);
	await A.page.waitForTimeout(3000);
	const r1 = await A.page.evaluate(async () => {
		const s = await window.__tp.test.v1.sessions;
		const lv = await window.__tp.test.v1.levels;
		const payload = s.buildSessionPayload('compat');
		const sig = String(lv.sceneSignature(payload));
		let loaded = null;
		try {
			const t = await window.__tp.test.v1.decalTick;
			loaded = t?.decalRuntimeLoaded ? t.decalRuntimeLoaded() : null;
		} catch {
			loaded = null;
		}
		const chunks = performance
			.getEntriesByType('resource')
			.map((e) => e.name)
			.filter((n) => /decal(Runtime|Project|Edit|Object|Stamp|Core)|DecalSection/.test(n));
		let objects = 0;
		window.__tp.test.v1.objectsGroup.subscribe((g) => (objects = g?.children?.length ?? 0))();
		return { sig, loaded, chunks, objects, decalKey: JSON.stringify(payload).includes('"decal"') };
	});
	// three mints fresh uuids for some images and geometries on every load: renumber every uuid by first
	// appearance (measured: two loads on ONE build differ only there; after this, v1.70.0 and this lane agree)
	const ids = new Map();
	const canon = r1.sig.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => {
		if (!ids.has(u)) ids.set(u, 'u' + ids.size);
		return ids.get(u);
	});
	const sig = crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
	console.log(`SIG ${sig} (${r1.objects} objects)`);
	if (process.env.DECALS_SIG_OUT) fs.writeFileSync(process.env.DECALS_SIG_OUT, r1.sig);
	h.check(r1.objects > 0, `§1 the old scene loaded (${r1.objects} objects)`);
	if (process.env.DECALS_BASE_SIG) h.check(sig === process.env.DECALS_BASE_SIG, `§1 its signature matches the release build's (${sig} vs ${process.env.DECALS_BASE_SIG})`);
	h.check(!r1.decalKey, '§1 its save carries no decal key');
	if (r1.loaded !== null) {
		h.check(r1.loaded === false, '§1 a scene without decals never loads the decal runtime');
		h.check(r1.chunks.length === 0, `§1 ...nor any decal chunk (${r1.chunks.join(', ')})`);
	} else console.log('  §1 (no decalTick hook: an older release, the zero-change checks are for a decal build)');

	// ---- §2 -------------------------------------------------------------------------------
	await load(MINE);
	await A.page.waitForTimeout(3000);
	const r2 = await A.page.evaluate(async () => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const wall = g.getObjectByName('Wall');
		/** @type {any[]} */
		const decals = [];
		g.traverse((o) => {
			if (!o.isMesh || !o.userData?.decal) return;
			const m = o.material;
			decals.push({
				parent: o.parent?.name ?? '',
				verts: o.geometry?.attributes?.position?.count ?? 0,
				opacity: m?.opacity,
				colorWrite: m?.colorWrite,
				depthWrite: m?.depthWrite,
				image: o.userData.decal.image ?? ''
			});
		});
		let built = null;
		try {
			const t = await window.__tp.test.v1.decalTick;
			if (t?.decalRuntimeLoaded) built = (await window.__tp.test.v1.decal).decalDebug().carriers.map((d) => d.tris);
		} catch {
			built = null;
		}
		return { wall: !!wall, decals, built };
	});
	console.log('  §2', JSON.stringify(r2));
	h.check(r2.wall, '§2 the decal file opened: the wall is there');
	h.check(r2.decals.length >= 1 && r2.decals.every((d) => d.parent === 'Wall'), `§2 ...and its decal, still on the wall (${r2.decals.length})`);
	h.check(
		r2.decals.every((d) => d.opacity === 0 && d.colorWrite === false && d.depthWrite === false),
		'§2 the carrier draws nothing by itself (an older release shows no stray box)'
	);
	if (r2.built) h.check(r2.built.length >= 1 && r2.built.every((t) => t > 0), `§2 a decal build rebuilds the surface (${r2.built})`);
	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).join(' | ')})`);
	await h.finish(browser);
});
