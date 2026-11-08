// 98 P1 — BAKED LIGHT end to end (two real peers).
//
//   1. a small room built through the agent tools (floor, walls, boxes, a sun, one physics box)
//   2. Cancel mid-bake changes nothing
//   3. the agent bakes (set_look {bake} → bake_light): materials get the atlas, the moving box is left out
//   4. the peer sees the same lightmaps (record + bytes + materials)
//   5. ONE undo step takes the whole bake off, redo puts it back
//   6. the stale chip after a baked object moves (UI, dark + light shots)
//   7. the save guard: toJSON never carries the bake (with the guard removed it WOULD — the counterfactual)
//   8. .tpscene payload + autosave → real reload → identical record, same meshes baked
//   9. an old (1.62) scene loads with no bake and saves with no `bake` key
//
// Bake time on this machine is printed as `BAKE_MS=` for STATUS (the int measures the device lab).

const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SHOTS = process.env.BAKE_SHOTS || '';

/** @param {any} page @param {string} name @param {any} args */
function tool(page, name, args) {
	return page.evaluate(([n, a]) => window.__stores.aiTools.executeAiTool(n, a), [name, args]);
}

/** h.eventually that hands back the last value it read @param {() => Promise<any>} fn @param {(v: any) => boolean} ok @param {string} label @param {number} [timeout] */
async function until(fn, ok, label, timeout = 10000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (ok(last)) break;
		await new Promise((r) => setTimeout(r, 400));
	}
	const pass = ok(last);
	if (!pass) console.log('  last: ' + JSON.stringify(last)?.slice(0, 600));
	h.check(pass, label);
	return last;
}

/** the bake debug view of a page */
function bakeState(page) {
	return page.evaluate(() => {
		const d = window.__stores.sceneBake.sceneBakeDebug();
		const a = window.__stores.bakeApply.bakeApplyDebug();
		/** @type {any} */ let group;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const lit = [];
		group.traverse((o) => {
			if (!o.isMesh) return;
			const m = Array.isArray(o.material) ? o.material[0] : o.material;
			if (m?.lightMap?.userData?.bake) lit.push(o.uuid);
		});
		const strip = (r) => (r ? JSON.stringify({ ...r, changedAt: 0 }) : null);
		return { record: d.record, rec: strip(d.record), job: d.job, stale: d.stale, shown: d.shown, apply: a, lit: lit.sort() };
	});
}

// a hung bake must FAIL the suite, never hold an e2e slot (a headless software-GL box is slow)
setTimeout(() => {
	console.log('SCRIPT FAILED: bake-light watchdog — the suite ran over 480 s');
	process.exit(1);
}, 480000).unref();

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);

	// ---------------------------------------------------------------- 1. the room
	console.log('\n=== 1. a room to bake ===');
	const made = await A.page.evaluate(async () => {
		const t = window.__stores.aiTools;
		const box = (name, params, position) => ({ kind: 'primitive', primitive: 'Box', name, params, position });
		const r = await t.executeAiTool('create_objects', {
			objects: [
				box('Floor', [8, 0.2, 8], [0, -0.1, 0]),
				box('WallBack', [8, 3, 0.2], [0, 1.5, -4]),
				box('WallLeft', [0.2, 3, 8], [-4, 1.5, 0]),
				box('Crate', [1, 1, 1], [-1, 0.5, -1]),
				box('Pillar', [0.6, 2.4, 0.6], [1.5, 1.2, -2]),
				box('Ball', [0.5, 0.5, 0.5], [2, 3, 2]),
				{ kind: 'light', light: 'directional', name: 'Sun', position: [3, 6, 2] }
			]
		});
		return (r.created ?? []).map((c) => ({ name: c.name, uuid: c.uuid }));
	});
	const uuidOf = (name) => made.find((m) => m.name === name)?.uuid;
	h.check(made.length === 7, '1.1 premise: seven objects created (' + made.map((m) => m.name).join(', ') + ')');
	// one object MOVES: the bake must leave it out (local mark on A, where the bake runs)
	await A.page.evaluate((uuid) => {
		/** @type {any} */ let group;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		group.getObjectByProperty('uuid', uuid).userData.physics = { mode: 'dynamic' };
	}, uuidOf('Ball'));
	await h.eventually(
		() => B.page.evaluate((u) => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); return !!g.getObjectByProperty('uuid', u); }, uuidOf('Pillar')),
		(ok) => ok === true,
		'1.2 premise: B has the room',
		20000
	);

	// ---------------------------------------------------------------- 2. cancel
	console.log('\n=== 2. Cancel mid-bake ===');
	// bounded for a headless box: a small atlas and a time cap (the device lab measures real bakes)
	const cancelled = await A.page.evaluate(async () => {
		const runner = window.__stores.bakeRunner;
		runner.setBakeTestLimits({ atlas: 512, ms: 20000 });
		const depth = () => { let n = 0; window.__stores.history.undoStack.subscribe((s) => (n = s.length))(); return n; };
		const undoBefore = depth();
		const sb = window.__stores.sceneBake;
		const run = runner.runBake({ quality: 'high' });
		const t0 = performance.now();
		// wait until the tracers are running, then cancel
		while (performance.now() - t0 < 20000) {
			const d = sb.sceneBakeDebug();
			if (d.job.phase === 'Baking light') break;
			if (!d.job.running) break;
			await new Promise((r) => setTimeout(r, 20));
		}
		const phaseAtCancel = sb.sceneBakeDebug().job.phase;
		const did = runner.cancelBake();
		// a terminated worker never answers: without the pending-ask settle in cancelBake this never resolves
		const result = await Promise.race([run, new Promise((r) => setTimeout(() => r({ hung: true }), 15000))]);
		const d = sb.sceneBakeDebug();
		return { phaseAtCancel, did, result, record: d.record, running: d.job.running, notes: d.job.notes, undoAdded: depth() - undoBefore };
	});
	h.check(cancelled.phaseAtCancel === 'Baking light' && cancelled.did === true, '2.1 premise: cancelled while tracing (' + cancelled.phaseAtCancel + ')');
	h.check(cancelled.result?.ok === false && cancelled.result?.cancelled === true, '2.2 the run reports cancelled (' + JSON.stringify(cancelled.result) + ')');
	h.check(cancelled.record === null && cancelled.running === false, '2.3 nothing changed: no bake record, nothing running');
	h.check(cancelled.notes?.[0]?.includes('cancelled'), '2.4 the panel says so: ' + JSON.stringify(cancelled.notes));
	h.check(cancelled.undoAdded === 0, '2.5 a cancelled bake leaves no Undo step (' + cancelled.undoAdded + ')');

	// ---------------------------------------------------------------- 3. bake (through the agent tool)
	console.log('\n=== 3. bake ===');
	await A.page.evaluate(() => window.__stores.bakeRunner.setBakeTestLimits({ atlas: 256, rays: 8, ms: 45000 }));
	const status0 = await tool(A.page, 'bake_light', { do: 'status' });
	h.check(status0.baked === false, '3.1 premise: the agent sees no bake yet');
	// A is not the host: a scene-wide change asks the host (B) first, and nothing runs until Allow
	const asked = await tool(A.page, 'bake_light', { do: 'bake', quality: 'normal' });
	h.check(asked.needsConfirm === true && !!asked.confirmId, '3.1b the bake asks the host first (' + JSON.stringify(asked).slice(0, 200) + ')');
	h.check((await bakeState(A.page)).job.running === false, '3.1c ...and nothing runs before the answer');
	const toast = B.page.locator('.tp-toast').filter({ hasText: /bake the light/ }).last();
	await toast.waitFor({ timeout: 30000 });
	await toast.getByRole('button', { name: 'Allow', exact: true }).click({ timeout: 30000 });
	const baked = await tool(A.page, 'bake_light', { confirmId: asked.confirmId, wait: 90 });
	console.log('[bake] ' + JSON.stringify(baked).slice(0, 600));
	if (baked.stats) console.log('BAKE_MS=' + baked.stats.ms + ' samples=' + baked.stats.samples + ' side=' + baked.stats.side + ' workers=' + baked.stats.workers + ' tier=' + baked.stats.tier);
	h.check(baked.baked === true && !baked.error, '3.2 the agent bake finished (' + (baked.error || baked.ms + ' ms') + ')');
	h.check(baked.shownHere === 'full', '3.2c the agent hears that this screen shows it (' + baked.shownHere + ')');
	// the record lands at once; the atlas is decoded and put on the materials just after (async)
	const a1 = await until(() => bakeState(A.page), (s) => !!s.record && s.shown.applied === s.record.objects.length, '3.2d A applied the bake to its meshes', 15000);
	const bakedUuids = a1.record.objects.map((o) => o.uuid).sort();
	h.check(bakedUuids.length >= 5, '3.3 the static meshes are baked (' + bakedUuids.length + ')');
	h.check(!bakedUuids.includes(uuidOf('Ball')), '3.4 the physics box is left out');
	h.check(a1.job.notes.some((n) => n.includes('left out') && n.includes('physics')), '3.5 ...and the notes say why: ' + JSON.stringify(a1.job.notes));
	h.check(JSON.stringify(a1.lit) === JSON.stringify(bakedUuids), '3.6 every baked mesh shows the lightmap on A');
	h.check(a1.shown.map === 'full' && a1.shown.applied === bakedUuids.length, '3.7 A shows the full map (' + JSON.stringify(a1.shown) + ')');
	const pixels = await A.page.evaluate(async (hash) => {
		// the atlas is a real image: light half not all black, AO half darker somewhere than white
		const item = window.__stores.explorer.itemByHash(hash);
		const blob = item ? await window.__stores.explorer.itemBlob(item.id) : null;
		if (!blob) return { found: !!item };
		const bmp = await createImageBitmap(blob);
		const c = new OffscreenCanvas(bmp.width, bmp.height);
		const g = c.getContext('2d');
		g.drawImage(bmp, 0, 0);
		const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
		const half = (bmp.width - 2) / 2;
		let lightMax = 0, aoMin = 255;
		for (let y = 0; y < bmp.height; y += 2)
			for (let x = 0; x < bmp.width; x += 2) {
				const i = (y * bmp.width + x) * 4;
				if (x < half) lightMax = Math.max(lightMax, d[i], d[i + 1], d[i + 2]);
				else if (x >= half + 2) aoMin = Math.min(aoMin, d[i]);
			}
		return { found: true, w: bmp.width, h: bmp.height, lightMax, aoMin };
	}, a1.record.full.hash);
	h.check(pixels.found && pixels.lightMax > 20 && pixels.aoMin < 200, '3.8 the atlas holds light and AO (' + JSON.stringify(pixels) + ')');

	// ---------------------------------------------------------------- 4. the peer
	console.log('\n=== 4. the peer sees it ===');
	const b1 = await until(
		() => bakeState(B.page),
		(s) => s.rec === a1.rec && s.shown.applied === bakedUuids.length,
		'4.1 B holds the same record and applied it to every baked mesh',
		30000
	);
	h.check(JSON.stringify(b1?.lit) === JSON.stringify(bakedUuids), '4.2 B\'s meshes carry the lightmap');
	h.check(b1?.apply?.textureHash === a1.apply.textureHash, '4.3 ...from the same atlas bytes (' + b1?.apply?.textureHash + ')');

	// ---------------------------------------------------------------- 5. one undo step
	console.log('\n=== 5. undo ===');
	await A.page.evaluate(() => window.__stores.history.undo());
	const a2 = await until(() => bakeState(A.page), (s) => s.record === null && s.lit.length === 0, '5.1 ONE undo takes the whole bake off A', 10000);
	await h.eventually(() => bakeState(B.page), (s) => s.record === null && s.lit.length === 0, '5.2 ...and off B', 15000);
	h.check(a2 && a2.apply.materials === 0, '5.3 every material is back to its own maps');
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => bakeState(A.page), (s) => s.rec === a1.rec && s.lit.length === bakedUuids.length, '5.4 redo puts it back', 10000);
	await h.eventually(() => bakeState(B.page), (s) => s.rec === a1.rec && s.lit.length === bakedUuids.length, '5.5 ...for B too', 15000);

	// ---------------------------------------------------------------- 6. stale chip
	console.log('\n=== 6. out of date ===');
	await A.page.evaluate(() => window.__stores.openSceneSection('Scene look'));
	await A.page.locator('#bake-light-button').waitFor({ state: 'visible', timeout: 15000 });
	h.check((await A.page.locator('#bake-stale-chip').count()) === 0, '6.1 premise: no stale chip right after the bake');
	const label = await A.page.locator('#bake-light-button').innerText();
	h.check(label.includes('Bake again'), '6.2 the button offers Bake again (' + label.trim() + ')');
	await tool(A.page, 'update_objects', { updates: [{ uuid: uuidOf('Crate'), position: [0.5, 0.5, 1] }] });
	await A.page.locator('#bake-stale-chip').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
	h.check(await A.page.locator('#bake-stale-chip').isVisible(), '6.3 moving a baked object shows "Out of date"');
	await h.eventually(() => bakeState(B.page), (s) => s.stale.stale === true && s.stale.moved >= 1, '6.4 B sees it out of date too (derived, no message)', 10000);
	if (SHOTS) {
		fs.mkdirSync(SHOTS, { recursive: true });
		const panel = A.page.locator('#bake-hint').locator('xpath=..');
		for (const theme of ['dark', 'light']) {
			await A.page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
			await A.page.waitForTimeout(300);
			await panel.screenshot({ path: path.join(SHOTS, (theme === 'dark' ? '01' : '02') + '-baked-light-' + theme + '.png') });
		}
		await A.page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
	}
	// put it back: the chip goes away (the signature matches the bake again)
	await tool(A.page, 'update_objects', { updates: [{ uuid: uuidOf('Crate'), position: [-1, 0.5, -1] }] });
	await A.page.locator('#bake-stale-chip').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
	h.check((await A.page.locator('#bake-stale-chip').count()) === 0, '6.5 moving it back clears the chip');

	// ---------------------------------------------------------------- 7. the save guard
	console.log('\n=== 7. the bake never leaks into object JSON ===');
	const guard = await A.page.evaluate((uuid) => {
		/** @type {any} */ let group;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const mesh = group.getObjectByProperty('uuid', uuid);
		const scan = () => {
			const j = JSON.stringify(mesh.toJSON());
			return { uv: /"uv[23]"/.test(j), lightMap: /"lightMap"/.test(j) };
		};
		const guarded = scan();
		const live = { lightMap: !!mesh.material.lightMap, attr: Object.keys(mesh.geometry.attributes) };
		// COUNTERFACTUAL: drop the guards and the same call carries the bake
		const own = { m: mesh.material.toJSON, g: mesh.geometry.toJSON };
		delete mesh.material.toJSON;
		delete mesh.geometry.toJSON;
		const unguarded = scan();
		mesh.material.toJSON = own.m;
		mesh.geometry.toJSON = own.g;
		const payload = JSON.stringify(window.__stores.sessions.buildSessionPayload('guard').objects ?? '');
		return { guarded, unguarded, live, payloadUv: /"uv[23]"/.test(payload), after: scan() };
	}, uuidOf('Floor'));
	h.check(guard.live.lightMap && guard.live.attr.some((k) => k === 'uv2' || k === 'uv3'), '7.1 premise: the live floor carries the bake (' + guard.live.attr.join(',') + ')');
	h.check(!guard.guarded.uv && !guard.guarded.lightMap, '7.2 its toJSON carries neither the bake UVs nor the lightmap');
	h.check(guard.unguarded.uv || guard.unguarded.lightMap, '7.3 COUNTERFACTUAL: without the guard it would (' + JSON.stringify(guard.unguarded) + ')');
	h.check(!guard.payloadUv, '7.4 the session payload\'s objects carry no bake UVs');
	h.check(!guard.after.uv && !guard.after.lightMap, '7.5 the guard is back after the counterfactual');

	// ---------------------------------------------------------------- 8. save → reload identical
	console.log('\n=== 8. save and reload ===');
	const saved = await A.page.evaluate(async () => {
		const payload = window.__stores.sessions.buildSessionPayload('bake test');
		window.__stores.autosave.autosaveEnabled.set(true);
		await window.__stores.autosave.saveNow();
		return { bake: payload.bake ? { ...payload.bake, changedAt: 0 } : null };
	});
	h.check(saved.bake && JSON.stringify(saved.bake) === a1.rec, '8.1 the .tpscene payload carries the record verbatim');
	await A.page.waitForTimeout(1200);
	await h.closePeer(B); // a reload must not be refilled by the peer: the file alone has to do it
	await h.freshReload(A);
	await h.answerRestore(A, 'restore', 30000);
	const a3 = await until(
		() => bakeState(A.page),
		(s) => s.rec === a1.rec && s.lit.length === bakedUuids.length,
		'8.2 after a real reload the restored scene has the identical record, applied to the same meshes',
		30000
	);
	h.check(JSON.stringify(a3?.lit) === JSON.stringify(bakedUuids), '8.3 the same mesh set is lit (' + a3?.lit.length + ')');
	h.check(a3?.apply?.textureHash === a1.apply.textureHash, '8.4 from the same atlas bytes');
	const appliedSession = await A.page.evaluate(async () => {
		// the .tpscene path: apply a payload WITH a bake over a cleared one
		const sessions = window.__stores.sessions;
		const payload = sessions.buildSessionPayload('bake reopen');
		window.__stores.sceneBake.sceneBakeRestore(null);
		await sessions.applySession(payload, { backup: false });
		await new Promise((r) => setTimeout(r, 1500));
		const d = window.__stores.sceneBake.sceneBakeDebug();
		return d.record ? JSON.stringify({ ...d.record, changedAt: 0 }) : null;
	});
	h.check(appliedSession === a1.rec, '8.5 opening the .tpscene payload brings the same record back');

	// ---------------------------------------------------------------- 9. old scenes
	console.log('\n=== 9. an old scene ===');
	const old = await A.page.evaluate(async () => {
		const sessions = window.__stores.sessions;
		const payload = sessions.buildSessionPayload('old');
		delete payload.bake; // what 1.62 wrote
		await sessions.applySession(payload, { backup: false });
		await new Promise((r) => setTimeout(r, 1500));
		const d = window.__stores.sceneBake.sceneBakeDebug();
		const again = sessions.buildSessionPayload('old again');
		return { record: d.record, hasKey: Object.prototype.hasOwnProperty.call(again, 'bake') };
	});
	h.check(old.record === null, '9.1 a 1.62 scene (no `bake`) loads with no bake — the old bake is cleared, not kept');
	h.check(old.hasKey === false, '9.2 ...and saves with no `bake` key (byte-identical to 1.62)');
	const oldLit = await bakeState(A.page);
	h.check(oldLit.lit.length === 0, '9.3 no mesh keeps a lightmap');

	await h.finish(browser);
});
