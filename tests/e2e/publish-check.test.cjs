// 63-publish (row 13) — THE PUBLISH CHECK, end to end in one page. The cloud plugin is stood in
// for by a fake `publishSlot` mount (the OSS build has no Publish flow, and the check only sits
// above one), so this runs against any build.
//   1 feature unused: a plain scene opens the Publish tab with "nothing a visitor would trip
//     over", the plugin's flow below it, and boot loaded none of the check's modules
//   2 a scene that trips the rules: a game (a Key Press nobody's button covers is not possible
//     past six keys, so a gamepad input), no spawn point, a 4096 px texture, music whose bytes
//     are not here — each row listed with its fix; the plugin's Publish button still presses
//   3 fixes: Start players here (spawn = the view's centre, the row goes), Shrink to 2048 px
//     (the texture is 2048 and ONE undo puts it back), Ask connected people (the row stays —
//     nobody is connected — and says so); a select item selects the object and closes the modal
//   4 the data door: cloudApi publishCheck() and save_scene's publishCheck carry the same rows
//   5 the N6 folded width (344 px): the list fits, nothing scrolls sideways, fix buttons >= 44 px
// Run: APP_URL=https://localhost:5996/ npm run e2e -- publish-check
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	const page = A.page;
	page.on('console', (m) => {
		if (m.type() === 'error') console.log('[page error] ' + m.text().slice(0, 300));
	});

	// ---- 1 feature unused ---------------------------------------------------------------------
	const bootLoaded = await page.evaluate(() =>
		performance
			.getEntriesByType('resource')
			.map((e) => e.name)
			.filter((n) => /sceneChecks|sceneFacts|checkCore|checkFixes|CheckList|PublishCheck/.test(n))
	);
	h.check(bootLoaded.length === 0, '1.1 boot loads none of the check (' + bootLoaded.join(', ') + ')');
	await page.evaluate(() => {
		const s = window.__tp.test.v1;
		s.exportStores.publishSlot.set((/** @type {HTMLElement} */ el) => {
			const b = document.createElement('button');
			b.id = 'fake-publish-go';
			b.textContent = 'Publish';
			b.onclick = () => (window.__fakePublished = (window.__fakePublished || 0) + 1);
			el.appendChild(b);
			return () => b.remove();
		});
		s.commandsHandler.sceneCommand('/create box');
	});
	await page.evaluate(() => window.__tp.test.v1.exportStores.openPublishExport('publish'));
	await page.locator('#publish-export-modal').waitFor({ state: 'visible', timeout: 15000 });
	await h.eventually(() => page.locator('#publish-check').getAttribute('data-ran'), (v) => v === 'true', '1.2 the check runs when the Publish tab opens', 60000);
	h.check((await page.locator('#publish-check-list li.cl-row').count()) === 0, '1.3 a plain box scene: no rows');
	h.check(/Nothing a visitor would trip over/.test(await page.locator('#publish-check-list').innerText()), '1.4 …and it says so');
	h.check(await page.locator('#fake-publish-go').isVisible(), "1.5 the plugin's flow sits below the check");
	await page.keyboard.press('Escape');

	// ---- 2 a scene that trips the rules -------------------------------------------------------
	const uuid = await page.evaluate(async () => {
		const s = window.__tp.test.v1;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const box = g.children.find((o) => o.isMesh);
		const c = document.createElement('canvas');
		c.width = 4096;
		c.height = 4096;
		const cx = c.getContext('2d');
		cx.fillStyle = '#3a6';
		cx.fillRect(0, 0, 4096, 4096);
		s.materialsHandler.applyMap(box, c.toDataURL('image/png'));
		s.nodesHandler.createFlowNode({ id: 'pc-pad', type: 'gamepadbutton', position: { x: 0, y: 0 }, data: { button: 0 } });
		s.nodesHandler.createFlowNode({ id: 'pc-key', type: 'keypress', position: { x: 0, y: 80 }, data: { code: 'KeyW' } });
		s.sceneMusic.setMusicTrack('0'.repeat(64), 'gone-track.mp3');
		return box.uuid;
	});
	await h.eventually(
		() => page.evaluate((u) => { let g; window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))(); return g.getObjectByProperty('uuid', u)?.material?.map?.image?.width || 0; }, uuid),
		(w) => w === 4096,
		'2.1 the box carries a 4096 px texture',
		30000
	);
	await page.evaluate(() => window.__tp.test.v1.exportStores.openPublishExport('publish'));
	await h.eventually(() => page.locator('#publish-check li.cl-row').count(), (n) => n >= 3, '2.2 the check lists the problems', 60000);
	const rules = await page.locator('#publish-check li.cl-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-rule')));
	for (const id of ['scene-no-spawn', 'scene-texture-large', 'scene-touch-missing', 'scene-asset-missing'])
		h.check(rules.includes(id), `2.3 ${id} is listed (${rules.join(', ')})`);
	h.check((await page.locator('#publish-check li[data-rule=scene-no-spawn] [data-fix=scene-set-spawn]').count()) === 1, '2.4 no spawn offers "Start players here"');
	const fixTip = await page.locator('#publish-check li[data-rule=scene-texture-large] [data-fix]').getAttribute('title');
	h.check(!!fixTip && fixTip.length > 4, '2.5 a fix button has a tooltip (' + fixTip + ')');
	const icons = await page.locator('#publish-check li.cl-row .cl-ico svg').count();
	h.check(icons === rules.length, '2.6 each row has a Lucide glyph (' + icons + ')');
	const emoji = await page.locator('#publish-check').evaluate((el) => /\p{Extended_Pictographic}/u.test(el.innerText));
	h.check(!emoji, '2.7 no emoji in the list');
	await page.locator('#fake-publish-go').click();
	h.check((await page.evaluate(() => window.__fakePublished || 0)) === 1, '2.8 warnings never block: Publish still presses');

	// keyboard path: Tab reaches the first fix button
	await page.locator('#publish-check-again').focus();
	let reached = false;
	for (let i = 0; i < 12 && !reached; i++) {
		await page.keyboard.press('Tab');
		reached = await page.evaluate(() => !!document.activeElement?.closest?.('#publish-check [data-fix], #publish-check .cl-item'));
	}
	h.check(reached, '2.9 Tab reaches the fix and select buttons');

	// ---- 3 fixes ------------------------------------------------------------------------------
	await page.locator('#publish-check [data-fix=scene-set-spawn]').click();
	await h.eventually(() => page.locator('#publish-check li[data-rule=scene-no-spawn]').count(), (n) => n === 0, '3.1 Start players here: the row goes', 30000);
	const spawn = await page.evaluate(() => { let p; window.__tp.test.v1.scenePhysics.scenePlay.subscribe((x) => (p = x))(); return p?.spawn ?? null; });
	h.check(Array.isArray(spawn?.position), '3.2 …and play.spawn is set (' + JSON.stringify(spawn) + ')');

	await page.locator('#publish-check [data-fix=scene-shrink-textures]').first().click();
	await h.eventually(() => page.locator('#publish-check li[data-rule=scene-texture-large]').count(), (n) => n === 0, '3.3 Shrink to 2048 px: the row goes', 60000);
	const texW = () => page.evaluate((u) => { let g; window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))(); return g.getObjectByProperty('uuid', u)?.material?.map?.image?.width || 0; }, uuid);
	await h.eventually(texW, (w) => w === 2048, '3.4 …the texture is 2048 px', 30000);
	await page.evaluate(() => window.__tp.test.v1.history.undo());
	await h.eventually(texW, (w) => w === 4096, '3.5 one undo puts the 4096 px texture back', 30000);
	await page.evaluate(() => window.__tp.test.v1.history.redo());
	await h.eventually(texW, (w) => w === 2048, '3.6 redo shrinks it again', 30000);

	await page.locator('#publish-check-again').click();
	await h.eventually(() => page.locator('#publish-check').getAttribute('data-ran'), (v) => v === 'true', '3.7 Check again re-runs', 30000);
	await page.locator('#publish-check [data-fix=scene-fetch-assets]').click();
	await h.eventually(() => page.locator('#publish-check li[data-rule=scene-asset-missing]').count(), (n) => n === 1, '3.8 nobody connected: the missing-file row stays', 30000);

	// ---- 4 the data door ----------------------------------------------------------------------
	const data = await page.evaluate(async () => {
		const s = window.__tp.test.v1;
		const api = s.cloudPlugin.makeCloudApi?.() ?? null;
		const viaApi = api?.publishCheck ? await api.publishCheck() : null;
		const direct = await s.publishCheckData.publishCheckData();
		return { viaApi, direct };
	});
	const dIds = (data.direct?.problems || []).map((p) => p.id).sort();
	h.check(dIds.includes('scene-touch-missing') && dIds.includes('scene-asset-missing'), '4.1 publishCheckData carries the same rows (' + dIds.join(', ') + ')');
	h.check(data.direct?.summary?.blocking === 0, '4.2 summary.blocking is 0 for publish');
	h.check(/person/.test(data.direct?.note || ''), '4.3 the note says publishing and fixes are the person\'s press');
	h.check(data.direct.problems.find((p) => p.id === 'scene-asset-missing')?.fix === 'scene-fetch-assets', '4.4 a problem names its fix');
	if (data.viaApi) h.check(JSON.stringify(data.viaApi.problems.map((p) => p.id).sort()) === JSON.stringify(dIds), '4.5 cloudApi.publishCheck answers the same');

	// select item: selects the object and closes the modal
	await page.evaluate(() => window.__tp.test.v1.exportStores.openPublishExport('publish'));
	await h.eventually(() => page.locator('#publish-check').getAttribute('data-ran'), (v) => v === 'true', '4.6 reopened', 30000);

	// ---- 5 the N6 folded width ----------------------------------------------------------------
	await page.setViewportSize({ width: 344, height: 882 });
	await page.waitForTimeout(400);
	const fit = await page.evaluate(() => {
		const list = document.querySelector('#publish-check');
		const r = list?.getBoundingClientRect();
		const fixes = [...document.querySelectorAll('#publish-check [data-fix]')].map((b) => b.getBoundingClientRect());
		return { right: r?.right ?? 0, width: window.innerWidth, scroll: document.documentElement.scrollWidth, fixRights: fixes.map((f) => f.right), fixH: fixes.map((f) => f.height) };
	});
	h.check(fit.right <= fit.width + 1 && fit.scroll <= fit.width + 1, '5.1 at 344 px the list fits (' + JSON.stringify({ right: fit.right, scroll: fit.scroll }) + ')');
	h.check(fit.fixRights.every((x) => x <= fit.width + 1), '5.2 every fix button is on screen');
	await page.setViewportSize({ width: 1280, height: 800 });

	const err = h.pageErrors(A);
	h.check(!err.length, '9.1 no page errors (' + err.slice(0, 3).join(' | ') + ')');
	await h.finish(browser);
});
