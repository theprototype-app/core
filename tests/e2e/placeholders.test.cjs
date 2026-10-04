// 36 U9 — LOADING PLACEHOLDERS: modern look, edit while loading, stuck recovery.
//
// A kit piece whose pack file is still on its way is a STUB (packRefs.js) drawn as a
// placeholder box. This suite drives every state against a FAULT-INJECTING HTTPS server
// (faultServer.cjs — a real cross-origin server, so the CORS case is real):
//   1. the Loading settings section: rows, search, the style select through the real UI,
//      persisted
//   2. SLOW: per-object byte progress reaches the instance buffer and rises; the piece fills
//   3. EDIT WHILE LOADING (a held download): a real viewport click selects the placeholder,
//      the gizmo attaches, shift-click multi-selects, the Inspector shows the Loading panel and
//      its typed X moves the stub as an ordinary replicated `move`; the model then arrives
//      under the stub's CURRENT transform
//   4. 404: red at once, no auto-retry, the "!" icon, the Retry-all toast, the hover tooltip
//      (status + reason + URL), the right-click menu, and a real double-click = Retry once the
//      file exists
//   5. STALL mid-stream: amber after `stuck`, abandoned after 3x, retried, filled
//   6. 503 twice: auto-retried with backoff, filled, never red
//   7. CORS: three retries then red (status 0, reason names CORS); the toast's Retry all works
//   8. Replace model: same uuid, new file, filled; one undo restores the old placeholder
//   9. PERF: 500 placeholders cost <= 2 draw calls in both styles; the per-frame sync allocates
//      nothing (heap sampling over 2000 frames)
// Counterfactuals measured by breaking the code are listed in the lane handover.
//
//   APP_URL=https://theprototype.app:5324/ node tests/e2e/placeholders.test.cjs
const h = require('./helpers.cjs');
const { startFaultServer } = require('./faultServer.cjs');

const SHOTS = process.env.SHOTS_DIR || '';
const BOX = [-0.6, 0, -0.5, 0.6, 1.2, 0.5];

/** Poll until `predicate` holds and RETURN the last value. */
async function until(fn, predicate, label, timeout = 12000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (predicate(last)) {
			h.check(true, label);
			return last;
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	console.log('  last: ' + JSON.stringify(last)?.slice(0, 600));
	h.check(false, label);
	return last;
}

/** Add a stub the way a loaded scene / a peer's broadcast does (an empty Group + packRef). */
function addStub(peer, url, pos = [0, 0, 0], opts = {}) {
	return peer.page.evaluate(
		({ url, pos, box, name }) => {
			const s = window.__stores;
			/** @type {any} */ let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const stub = new g.constructor();
			stub.name = name;
			stub.position.set(pos[0], pos[1], pos[2]);
			stub.userData = { packRef: { pack: 'test', item: name, path: url, ...(box ? { box } : {}) }, packStub: true };
			g.add(stub);
			stub.updateMatrixWorld(true);
			s.pokeScene();
			return stub.uuid;
		},
		{ url, pos, box: opts.box === null ? null : opts.box ?? BOX, name: opts.name ?? 'Duck' }
	);
}

/** Facts about a stub/piece + its placeholder instance. */
function facts(peer, uuid) {
	return peer.page.evaluate((uuid) => {
		const s = window.__stores;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', uuid);
		if (!o) return null;
		const info = s.packRefs.stubLoadInfo(o);
		const inst = s.placeholders.placeholderInstances().find((i) => i.uuid === uuid) ?? null;
		return {
			stub: !!o.userData.packStub,
			children: o.children.length,
			pos: o.position.toArray().map((v) => Math.round(v * 1000) / 1000),
			path: o.userData.packRef?.path ?? null,
			phase: info?.load?.phase ?? (info ? 'pending' : 'done'),
			status: info?.load?.error?.status ?? null,
			reason: info?.load?.error?.reason ?? null,
			inst
		};
	}, uuid);
}

/** the stuck setting, live (a held download must not be abandoned mid-section) */
const setStuck = (peer, seconds) => peer.page.evaluate((v) => window.__stores.loadStates.placeholderStuckSeconds.set(v), seconds);

const stats = (peer) => peer.page.evaluate(() => window.__stores.placeholders.placeholderStats());

/** Clear the scene's objects (not the settings) between sections. */
const wipe = (peer) =>
	peer.page.evaluate(() => {
		const s = window.__stores;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		for (const c of [...g.children]) g.remove(c);
		s.objectActions.deselectObject();
		s.pokeScene();
	});

/** The screen point of a stub's box centre. */
async function boxPoint(peer, pos, box = BOX) {
	return h.projectPoint(peer.page, [pos[0] + (box[0] + box[3]) / 2, pos[1] + (box[1] + box[4]) / 2, pos[2] + (box[2] + box[5]) / 2]);
}

h.run(async () => {
	const fsrv = await startFaultServer({ tick: 150, chunk: 4000 });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { storage: { placeholderStuckSeconds: '2' } });
	const shot = async (name) => SHOTS && A.page.screenshot({ path: SHOTS + '/' + name });
	// record outgoing peer messages (send works with zero connections)
	await A.page.evaluate(async () => {
		window.__sent = [];
		const inst = await new Promise((r) => window.__stores.peers.subscribe(r)());
		const orig = inst.send.bind(inst);
		inst.send = (m) => {
			window.__sent.push(m);
			return orig(m);
		};
	});
	// a camera that frames the area the sections place boxes in
	await A.page.evaluate(() => window.__stores.objectActions.flyTo([0, 5, 9], [0, 0.5, 0], 0));
	await A.page.waitForTimeout(600);

	// ---- 1. the settings section -------------------------------------------------------
	console.log('-- 1. settings');
	await A.page.evaluate(() => {
		window.__stores.settingsSection.set('scene');
		window.__stores.settingsOpen.set(true);
	});
	await A.page.waitForSelector('#placeholder-style', { timeout: 10000 });
	for (const id of ['#placeholder-style', '#placeholder-grid-on', '#placeholder-grid-size', '#placeholder-grid-color', '#placeholder-grid-opacity', '#placeholder-anim-speed', '#placeholder-stuck-seconds'])
		h.check((await A.page.locator(id).count()) === 1, `settings row ${id} exists`);
	h.check((await A.page.locator('#placeholder-stuck-seconds').inputValue()) === '2', 'stuck seconds reads the stored 2');
	await A.page.locator('#settings-search').fill('placeholder');
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('#placeholder-style').isVisible(), 'searching "placeholder" keeps the Loading rows');
	await A.page.locator('#settings-search').fill('');
	h.check(await A.page.evaluate(() => window.__stores.loadStates.placeholderStyle && true), 'style store reachable');
	const defaultStyle = await A.page.evaluate(() => {
		let v;
		window.__stores.loadStates.placeholderStyle.subscribe((x) => (v = x))();
		return v;
	});
	h.check(defaultStyle === 'modern', `the default style is Modern (36 L1) (${defaultStyle})`);
	h.check((await A.page.evaluate(() => localStorage.getItem('placeholderStyle'))) === null, 'the default is not written until the person picks');
	await A.page.locator('#placeholder-style').click();
	await A.page.getByRole('option', { name: 'Colored boxes' }).click();
	await A.page.waitForTimeout(200);
	h.check((await A.page.evaluate(() => localStorage.getItem('placeholderStyleChosen'))) === '1', 'a pick is recorded as a choice');
	await A.page.locator('#placeholder-style').click();
	await A.page.getByRole('option', { name: 'Modern (default)' }).click();
	await A.page.waitForTimeout(200);
	const stored = await A.page.evaluate(() => localStorage.getItem('placeholderStyle'));
	h.check(stored === '"modern"', `choosing Modern in the UI persists it (${stored})`);
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));
	await A.page.waitForTimeout(300);

	// ---- 2. slow: per-object byte progress ------------------------------------------------
	console.log('-- 2. slow');
	const slow = await addStub(A, fsrv.url('slow'), [-2, 0, 0]);
	const f1 = await until(() => facts(A, slow), (f) => f?.inst && f.inst.progress > 0.05 && f.inst.progress < 0.9, 'a slow download shows partial progress on its instance');
	await A.page.waitForTimeout(1200);
	const f2 = await facts(A, slow);
	h.check(f2?.inst && f2.inst.progress > f1.inst.progress, `the fill rises as bytes arrive (${f1?.inst?.progress?.toFixed(2)} -> ${f2?.inst?.progress?.toFixed(2)})`);
	h.check(f2?.inst?.state === 0, 'a download that keeps moving is not stuck');
	await shot('03-modern-loading-dark.png');
	await until(() => facts(A, slow), (f) => f && !f.stub && f.children > 0, 'the slow piece arrives and fills the stub', 20000);
	await until(() => stats(A), (s) => s.count === 0, 'its placeholder is gone once the piece is here');
	await wipe(A);

	// ---- 3. edit while loading --------------------------------------------------------------
	console.log('-- 3. edit while loading');
	await setStuck(A, 120);
	const p1 = [1.5, 0, 0];
	const p2 = [-1.5, 0, 0];
	const held1 = await addStub(A, fsrv.url('hold', 'Held1'), p1);
	const held2 = await addStub(A, fsrv.url('hold', 'Held2'), p2);
	await until(() => stats(A), (s) => s.count === 2, 'two held downloads draw two placeholders');
	await A.page.waitForTimeout(400);
	const pt1 = await boxPoint(A, p1);
	await A.page.mouse.click(pt1.x, pt1.y);
	await A.page.waitForTimeout(400);
	const sel1 = await A.page.evaluate(() => {
		let v;
		window.__stores.selectedObjects.subscribe((x) => (v = x))();
		let tc;
		window.__stores.TControls.subscribe((x) => (tc = x))();
		return { set: v, gizmo: tc?.object?.uuid ?? null };
	});
	h.check(sel1.set.length === 1 && sel1.set[0] === held1, 'a real viewport click on a placeholder selects its stub');
	h.check(sel1.gizmo === held1, 'the transform gizmo attaches to the loading piece');
	const instSel = await facts(A, held1);
	h.check(instSel?.inst?.selected === 1, 'the selected placeholder is highlighted (instance flag)');
	const pt2 = await boxPoint(A, p2);
	await A.page.keyboard.down('Shift');
	await A.page.mouse.click(pt2.x, pt2.y);
	await A.page.keyboard.up('Shift');
	await A.page.waitForTimeout(300);
	const multi = await A.page.evaluate(() => {
		let v;
		window.__stores.selectedObjects.subscribe((x) => (v = x))();
		return v;
	});
	h.check(multi.length === 2 && multi.includes(held1) && multi.includes(held2), 'shift-click multi-selects two placeholders');
	// the Inspector, single selection
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), held1);
	await A.page.waitForSelector('#load-state-panel', { timeout: 8000 }).catch(() => {});
	h.check(await A.page.locator('#load-state-panel').isVisible(), 'the Inspector shows the Loading panel for a loading piece');
	const label = await A.page.locator('#load-state-label').textContent();
	h.check(/Loading|Waiting|Stuck/.test(label || ''), `the panel says what it is doing ("${label}")`);
	h.check((await A.page.locator('#load-state-url').textContent())?.includes('/hold/Held1.glb'), 'the panel names the file URL');
	await shot('05-inspector-loading-panel-dark.png');
	await A.page.evaluate(() => (window.__sent.length = 0));
	await A.page.locator('#inspector-position .dn-wrap').first().click();
	await A.page.locator('#inspector-position .dn-input').first().fill('3');
	await A.page.keyboard.press('Enter');
	await A.page.waitForTimeout(300);
	const moved = await facts(A, held1);
	h.check(moved?.pos[0] === 3 && moved.stub, `typing X in the Inspector moves the still-loading stub (x=${moved?.pos?.[0]})`);
	const moveMsg = await A.page.evaluate((u) => window.__sent.find((m) => m.type === 'move' && m.uuid === u) ?? null, held1);
	h.check(!!moveMsg && moveMsg.pos[0] === 3, 'the edit goes out as an ordinary replicated `move`');
	// a rotation + scale through the object itself (the gizmo's write path is the same object)
	await A.page.evaluate((u) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		o.rotation.y = 0.5;
		o.scale.set(1.5, 1.5, 1.5);
		o.updateMatrixWorld(true);
	}, held1);
	await A.page.waitForTimeout(200);
	// the placeholder follows the stub the frame it moves (the instance matrix)
	const followed = await A.page.evaluate((u) => {
		const s = window.__stores;
		let scene;
		s.globalScene.subscribe((v) => (scene = v))();
		const body = scene.getObjectByName('kit-placeholders');
		const i = s.placeholders.placeholderInstances().findIndex((x) => x.uuid === u);
		const e = body.instanceMatrix.array.slice(i * 16, i * 16 + 16);
		return { tx: Math.round(e[12] * 100) / 100 };
	}, held1);
	h.check(followed.tx === 3, `the placeholder box followed the moved stub (instance x=${followed.tx})`);
	fsrv.release('/hold/Held1.glb');
	const arrived = await until(() => facts(A, held1), (f) => f && !f.stub && f.children > 0, 'the held model arrives');
	h.check(arrived?.pos[0] === 3, `the model took the placeholder's CURRENT position (${arrived?.pos})`);
	const pose = await A.page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		return { ry: Math.round(o.rotation.y * 100) / 100, s: Math.round(o.scale.x * 100) / 100, pristine: window.__stores.packRefs.isPristinePackRef(o) };
	}, held1);
	h.check(pose.ry === 0.5 && pose.s === 1.5, `…and its current rotation and scale (${pose.ry}, ${pose.s})`);
	h.check(pose.pristine, 'the arrived piece is still a pristine reference (saves as a stub)');
	fsrv.release('/hold/Held2.glb');
	await wipe(A);

	// ---- 4. 404: red, icon, toast, tooltip, menu, double-click retry --------------------------
	console.log('-- 4. 404');
	const p404 = [0, 0, 0];
	const nf = await addStub(A, fsrv.url('404', 'Missing'), p404);
	const red = await until(() => facts(A, nf), (f) => f?.phase === 'failed', 'a 404 goes red');
	h.check(red?.status === 404 && /not found/.test(red?.reason || ''), `with its status and reason (${red?.status}, ${red?.reason})`);
	h.check(red?.inst?.state === 2, 'the instance is drawn red (state 2)');
	await A.page.waitForTimeout(1500);
	h.check(fsrv.counts['/404/Missing.glb'] === 1, `a 404 is not auto-retried (${fsrv.counts['/404/Missing.glb']} request)`);
	const st404 = await stats(A);
	h.check(st404.icons === 1 && st404.failed === 1, `the error icon is drawn (${JSON.stringify(st404)})`);
	const toast = A.page.locator('.tp-toast', { hasText: 'failed to load' });
	await until(() => toast.count(), (n) => n === 1, 'the scene toast says an object failed to load');
	h.check(await toast.getByText('Retry all').isVisible(), 'the toast offers Retry all');
	const c404 = await boxPoint(A, p404);
	await A.page.mouse.move(c404.x - 30, c404.y - 30);
	await A.page.mouse.move(c404.x, c404.y, { steps: 4 });
	await A.page.waitForTimeout(400);
	const tipText = (await A.page.locator('#placeholder-tooltip').textContent().catch(() => '')) || '';
	h.check(/404/.test(tipText) && /file not found/.test(tipText) && tipText.includes('/404/Missing.glb'), `hovering shows status + reason + URL ("${tipText.slice(0, 120)}")`);
	await shot('04-modern-failed-tooltip-dark.png');
	// The menu a right-click opens on this object: the store Scene's contextmenu handler writes
	// and Controls renders. (A headless right TAP opens no menu at all here — not even the
	// empty-space one — so the gesture itself is owed on device; the menu content is real.)
	await A.page.evaluate((u) => window.__stores.objectContextMenu.set({ x: 400, y: 300, uuid: u, point: [0, 0, 0], locked: false }), nf);
	await A.page.waitForTimeout(400);
	const menuText = (await A.page.locator('[role="menuitem"]').allTextContents()).join(' | ');
	h.check(/Retry loading/.test(menuText) && /Replace model/.test(menuText) && /Delete/.test(menuText), `right-click offers Retry loading / Replace model… / Delete (${menuText.slice(0, 160)})`);
	h.check(!/Ungroup/.test(menuText), 'a loading stub is not offered Ungroup (it is not a real group)');
	await shot('06-context-menu-dark.png');
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	fsrv.setMode('/404/Missing.glb', 'ok');
	await A.page.waitForTimeout(450); // past the double-click window of any earlier click
	await A.page.mouse.dblclick(c404.x, c404.y);
	await until(() => facts(A, nf), (f) => f && !f.stub && f.children > 0, 'a double-click on the red box retries it, and it loads');
	h.check(fsrv.counts['/404/Missing.glb'] === 2, 'exactly one new request');
	await until(() => toast.count(), (n) => n === 0, 'the failure toast goes away once nothing has failed');
	await wipe(A);

	// ---- 5. stall mid-stream -------------------------------------------------------------
	console.log('-- 5. stall');
	await setStuck(A, 2);
	const stall = await addStub(A, fsrv.url('stallonce', 'Stall'), [0, 0, 0]);
	await until(() => facts(A, stall), (f) => f?.inst?.state === 1, 'a stream that stops turns amber after `stuck` seconds', 8000);
	const fs5 = await facts(A, stall);
	h.check(fs5?.inst?.progress > 0.2 && fs5.inst.progress < 0.7, `amber keeps the progress it reached (${fs5?.inst?.progress?.toFixed(2)})`);
	await shot('07-modern-stuck-dark.png');
	await until(() => facts(A, stall), (f) => f && !f.stub && f.children > 0, 'after 3x `stuck` the stalled attempt is abandoned, retried and the piece fills', 20000);
	h.check(fsrv.counts['/stallonce/Stall.glb'] === 2, `one retry (${fsrv.counts['/stallonce/Stall.glb']} requests)`);
	await wipe(A);

	// ---- 6. 503 twice --------------------------------------------------------------------
	console.log('-- 6. 503');
	const flaky = await addStub(A, fsrv.url('fail2', 'Flaky'), [0, 0, 0]);
	let sawRed = false;
	await until(
		async () => {
			const f = await facts(A, flaky);
			if (f?.phase === 'failed') sawRed = true;
			return f;
		},
		(f) => f && !f.stub && f.children > 0,
		'two 503s are retried with backoff and the piece fills',
		15000
	);
	h.check(!sawRed, 'it never went red on the way');
	h.check(fsrv.counts['/fail2/Flaky.glb'] === 3, `three requests (${fsrv.counts['/fail2/Flaky.glb']})`);
	await wipe(A);

	// ---- 7. CORS ------------------------------------------------------------------------
	console.log('-- 7. CORS');
	const cors = await addStub(A, fsrv.url('cors', 'Cors'), [0, 0, 0]);
	const corsRed = await until(() => facts(A, cors), (f) => f?.phase === 'failed', 'a CORS refusal is retried three times, then red', 25000);
	h.check(corsRed?.status === 0 && /CORS/.test(corsRed?.reason || ''), `the reason names CORS (${corsRed?.reason})`);
	h.check(fsrv.counts['/cors/Cors.glb'] === 4, `1 + 3 auto-retries (${fsrv.counts['/cors/Cors.glb']} requests)`);
	fsrv.setMode('/cors/Cors.glb', 'ok');
	await A.page.locator('.tp-toast', { hasText: 'failed to load' }).getByText('Retry all').first().click();
	await until(() => facts(A, cors), (f) => f && !f.stub && f.children > 0, "the toast's Retry all brings it back");
	await wipe(A);

	// ---- 8. Replace model ------------------------------------------------------------------
	console.log('-- 8. replace');
	const rep = await addStub(A, fsrv.url('404', 'Gone'), [1, 0, 0]);
	await until(() => facts(A, rep), (f) => f?.phase === 'failed', 'the piece to replace is red');
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), rep);
	await A.page.locator('#load-replace').click();
	await until(() => A.page.locator('#replace-model').isVisible(), (v) => v === true, 'Replace model… opens the picker');
	await shot('08-replace-model-picker-dark.png');
	await A.page.keyboard.press('Escape');
	await A.page.evaluate(() => (window.__sent.length = 0));
	const okUrl = fsrv.url('ok', 'Replacement');
	// the picker's own call (a pack card), through the app's module instance
	await A.page.evaluate(({ u, url }) => window.__stores.replaceModel.replaceWithPackItem(u, { glbUrl: url, name: 'Replacement', packName: 'test' }), { u: rep, url: okUrl });
	const replaced = await until(() => facts(A, rep), (f) => f && !f.stub && f.children > 0, 'the replacement loads under the SAME uuid');
	h.check(replaced?.path === okUrl && replaced?.pos[0] === 1, `it points at the new file and kept its place (${replaced?.pos})`);
	const wire = await A.page.evaluate(() => window.__sent.map((m) => m.type));
	h.check(wire.includes('delete') && wire.includes('object'), `it replicates as the ordinary delete + object (${wire.join(',')})`);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(500);
	const undone = await facts(A, rep);
	h.check(undone?.stub && undone.path?.includes('/404/Gone.glb'), 'one undo puts the old placeholder back');
	await wipe(A);

	// ---- 9. perf: 500 placeholders ------------------------------------------------------------
	console.log('-- 9. perf');
	await setStuck(A, 120);
	const many = await A.page.evaluate(
		({ url, box }) => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			for (let i = 0; i < 500; i++) {
				const stub = new g.constructor();
				stub.position.set((i % 25) - 12, 0, Math.floor(i / 25) - 10);
				stub.userData = { packRef: { pack: 'test', item: 'P' + i, path: url, box }, packStub: true };
				g.add(stub);
			}
			s.pokeScene();
			return g.children.length;
		},
		{ url: fsrv.url('hold', 'Many'), box: [-0.3, 0, -0.3, 0.3, 0.6, 0.3] }
	);
	h.check(many === 500, '500 loading stubs placed');
	await until(() => stats(A), (s) => s.count === 500, '500 placeholders drawn');
	const calls = (style) =>
		A.page.evaluate((style) => {
			const s = window.__stores;
			s.loadStates.placeholderStyle.set(style);
			let scene, camera, renderer;
			s.globalScene.subscribe((v) => (scene = v))();
			s.globalCamera.subscribe((v) => (camera = v))();
			s.globalRenderer.subscribe((v) => (renderer = v))();
			const body = scene.getObjectByName('kit-placeholders');
			const icons = scene.getObjectByName('kit-placeholder-icons');
			const measure = () => {
				renderer.render(scene, camera);
				return renderer.info.render.calls;
			};
			measure();
			const withThem = measure();
			const was = [body.visible, icons.visible];
			body.visible = false;
			icons.visible = false;
			const without = measure();
			body.visible = was[0];
			icons.visible = was[1];
			return withThem - without;
		}, style);
	const cBoxes = await calls('boxes');
	const cModern = await calls('modern');
	h.check(cBoxes <= 2 && cBoxes >= 1, `500 colored boxes cost ${cBoxes} draw call(s) (<= 2)`);
	h.check(cModern <= 2 && cModern >= 1, `500 modern placeholders cost ${cModern} draw call(s) (<= 2)`);
	await shot('09-modern-500-dark.png');
	// per-frame allocations: heap sampling over 2000 synchronous frames of 500 instances
	const cdp = await A.page.context().newCDPSession(A.page);
	await cdp.send('HeapProfiler.enable');
	await A.page.evaluate(() => window.__stores.placeholders.placeholderFrameForTest());
	await cdp.send('HeapProfiler.startSampling', { samplingInterval: 128 });
	await A.page.evaluate(() => {
		for (let i = 0; i < 2000; i++) window.__stores.placeholders.placeholderFrameForTest();
	});
	const { profile } = await cdp.send('HeapProfiler.stopSampling');
	let inFrame = 0;
	/** @param {any} node @param {boolean} under */
	const walk = (node, under) => {
		const here = under || node.callFrame.functionName === 'syncFrame';
		if (here) inFrame += node.selfSize;
		for (const c of node.children) walk(c, here);
	};
	walk(profile.head, false);
	h.check(inFrame < 64 * 1024, `the per-frame sync allocates nothing measurable over 2000 frames x 500 (${inFrame} sampled bytes)`);
	await A.page.evaluate(() => window.__stores.loadStates.placeholderStyle.set('modern'));
	fsrv.release('/hold/Many.glb');
	await wipe(A);

	await fsrv.close();
	await h.finish(browser);
});
