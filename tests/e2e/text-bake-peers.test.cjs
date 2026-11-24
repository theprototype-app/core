// fix-batch-4 G5 — A BAKE LANDS ON EVERY PEER. 88-int (QUESTIONS-88 Q1, 1 of 6 built-preview runs): after A's
// single Bake message, B's solid was built and its RECORD stayed for 20 s — B kept the text while A held the
// mesh. The receiving half (`applyRemoteBake`) now notes every arrival and every exit (`textPathEdit.bakeTrace()`)
// and a bake that throws still drops the record. This suite bakes TEN times on two peers, in three shapes that
// race the receiver differently, and undoes between them:
//   quiet   both solids built, then Bake
//   edit    A changes the solid (depth) and bakes as soon as ITS build is done — B is usually still building
//   parked  B runs the save ritual (park: its solid becomes the placeholder) right before A's Bake, so B has
//           to build before it can bake (the autosave-export case in applyRemoteBake's JSDoc)
// Each: B holds a mesh (no record, A's vertex count) within 20 s; one undo on A brings the text back on B.
// A red prints B's probe rows for that bake. Proof: 10/10.
const h = require('./helpers.cjs');

const ROUNDS = Number(process.env.BAKE_ROUNDS || 10);

/** @param {any} page */
const dbg = (page) => page.evaluate(() => window.__tp.test.v1.textPath.textPathDebug());
/** @param {any} page @param {string} uuid */
const one = async (page, uuid) => (await dbg(page)).find((/** @type {any} */ d) => d.uuid === uuid);
/** @param {any} page @param {string} uuid @param {any} patch */
const set = (page, uuid, patch) => page.evaluate(([u, p]) => !!window.__tp.test.v1.textPathEdit.setTextPathFor(u, p), [uuid, patch]);
/** @param {any} page @param {string} uuid */
const carrier = (page, uuid) =>
	page.evaluate((u) => {
		/** @type {any} */ let g;
		window.__tp.test.v1.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		if (!o) return null;
		return { verts: o.geometry?.getAttribute?.('position')?.count ?? 0, text: !!o.userData.textPath, name: o.name };
	}, uuid);
const solidBuilt = (/** @type {any} */ d) => !!d && d.mode === 'extruded' && !!d.solid && !d.solid.building && d.solid.triangles > 0;
/** @param {any} page @param {string} uuid @param {string} label */
const untilBuilt = (page, uuid, label, timeout = 30000) =>
	h.eventually(async () => (await one(page, uuid)) ?? null, solidBuilt, label, timeout).then(() => one(page, uuid));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const uuid = await A.page.evaluate(() => window.__tp.test.v1.addObjects.spawnAtPoint('/create Text', [0, 1, 0]).uuid);
	await h.eventually(() => carrier(B.page, uuid), (c) => !!c && c.text, 'premise: B has the text object', 20000);
	await set(A.page, uuid, { text: 'HELLO', mode: 'extruded' });
	await untilBuilt(A.page, uuid, 'premise: A builds the solid');
	await untilBuilt(B.page, uuid, 'premise: B builds the solid');

	let good = 0;
	/** @type {string[]} */
	const reds = [];
	for (let i = 0; i < ROUNDS; i++) {
		const shape = ['quiet', 'edit', 'parked'][i % 3];
		const tag = `bake ${i + 1}/${ROUNDS} (${shape})`;
		if (shape === 'edit') {
			await set(A.page, uuid, { depth: 0.12 + 0.02 * i });
			await untilBuilt(A.page, uuid, `${tag}: A rebuilds after the edit`);
		} else if (shape === 'parked') {
			// B's save ritual: park every text solid (the placeholder stays until B's runtime rebuilds)
			await B.page.evaluate(() => {
				window.__tp.test.v1.flowRuntime.parkAnimatedAtBase();
			});
		} else await untilBuilt(B.page, uuid, `${tag}: B's solid is built`);
		const a = await one(A.page, uuid);
		const tri = a.solid.triangles;
		const t0 = Date.now();
		const baked = await A.page.evaluate((u) => window.__tp.test.v1.textPathEdit.bakeTextToMesh(u), uuid);
		h.check(baked.ok, `${tag}: Bake succeeds on A (${baked.error ?? 'ok'})`);
		let c = null;
		for (const until = Date.now() + 20000; Date.now() < until; await B.page.waitForTimeout(250)) {
			c = await carrier(B.page, uuid);
			if (c && !c.text && c.verts === tri * 3) break;
		}
		const ok = !!c && !c.text && c.verts === tri * 3;
		h.check(ok, `${tag}: B holds the baked mesh in ${Date.now() - t0} ms (record ${c?.text ? 'STILL THERE' : 'gone'}, ${c?.verts} verts vs ${tri * 3})`);
		if (ok) good++;
		else {
			const trace = await B.page.evaluate(() => window.__tp.test.v1.textPathEdit.bakeTrace?.() ?? []);
			const rows = trace.filter((/** @type {any} */ r) => r.at >= t0 - 500).map((/** @type {any} */ r) => `+${r.at - t0}ms ${r.step} ${JSON.stringify({ ...r, at: undefined, step: undefined, uuid: undefined })}`);
			reds.push(`${tag}: ${rows.join(' ; ') || 'no probe row: the bake never reached applyRemoteBake'}`);
			console.log(`  ${tag} B probe:\n    ` + (rows.join('\n    ') || '(none)'));
		}
		// undo brings the text back on both peers
		await A.page.evaluate(() => window.__tp.test.v1.history.undo());
		await h.eventually(() => carrier(B.page, uuid), (x) => !!x && x.text, `${tag}: one undo brings the text back on B`, 20000);
		await untilBuilt(A.page, uuid, `${tag}: A's solid again`);
	}
	h.check(good === ROUNDS, `G5: ${good}/${ROUNDS} bakes landed on B${reds.length ? ' — ' + reds.join(' | ') : ''}`);
	await h.finish(browser);
});
