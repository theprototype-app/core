// uir-timeline — the Generate window (owner 2026-11-09: "Mesh generation: a dockable Generate window with prompt
// history and jobs"), against a MOCKED Meshy (no credits are spent: every Meshy URL is a page.route):
//   1. it opens as a window, not a modal: the viewport keeps its keys (anyModalOpen stays false)
//   2. it docks: a bottom-dock tab ('meshGen'), the window's element hosted in the dock
//   3. a prompt submitted: one job row RUNNING, the prompt in History; the window stays open for the next one
//   4. RELOAD while the job runs: the job list and the history come back; the job RESUMES by its saved task
//      (counterfactual: the provider saw exactly ONE submit — a resubmission would be a second charge); the
//      provider then finishes it and the model is placed once
//   5. Reopen: with the object gone, Reopen places the cached file from Explorer ▸ Generated again
//   6. a failed job (Meshy 402) shows Failed + the named reason + Retry; Retry sends the prompt again
//   7. a second reload keeps done + failed + the history; History refills the form
//   8. a phone (N6 folded / unfolded, emulated): the window is a sheet, no sideways overflow
// Run: APP_URL=https://localhost:7010/ npm run e2e -- mesh-gen-window   (SHOTS=<dir> keeps screenshots)
const h = require('./helpers.cjs');
const path = require('path');
const fs = require('fs');

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => {
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) });
};
const MESHY = '/mock-meshy';

const jobs = (page) =>
	page.evaluate(() => {
		let v = [];
		window.__stores.meshJobs.meshJobs.subscribe((x) => (v = x))();
		return v.map((j) => ({ id: j.id, prompt: j.prompt, status: j.status, error: j.error ?? '', uuid: j.uuid ?? null, hash: j.hash ?? null }));
	});
const history = (page) =>
	page.evaluate(() => {
		let v = [];
		window.__stores.meshJobs.meshPromptHistory.subscribe((x) => (v = x))();
		return v.map((e) => e.prompt);
	});
const objects = (page) =>
	page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children.filter((c) => c.userData?.aiGen).map((c) => ({ uuid: c.uuid, name: c.name, prompt: c.userData.aiGen.prompt }));
	});

async function openWindow(page) {
	await page.evaluate(() => window.__stores.meshGenModalOpen.set({}));
	await page.waitForSelector('#mesh-gen-window', { timeout: 10000 });
}

async function reload(peer) {
	await h.freshReload(peer);
	await h.answerRestore(peer).catch(() => {});
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1920, height: 1080 } } });
	const page = A.page;
	await page.evaluate((cfg) => {
		const mp = window.__stores.meshProviders;
		mp.addMeshProvider({ kind: 'meshy', label: 'MockMeshy', baseUrl: location.origin + cfg.MESHY, apiKey: 'k', mode: 'preview', assetProxy: '' });
		mp.setMeshGenEnabled(true);
	}, { MESHY });
	await reload(A);

	const glb = Buffer.from(
		await page.evaluate(async () => {
			const THREE = window.__stores.THREE;
			const { GLTFExporter } = window.__stores.GLTFExporterModule;
			const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xcc3322 }));
			const out = await new Promise((res, rej) => new GLTFExporter().parse(mesh, res, rej, { binary: true }));
			return Array.from(new Uint8Array(out));
		})
	);

	// the mock: a submit answers a task id; a poll says IN_PROGRESS until `release`, then SUCCEEDED; "broke" = 402
	/** @type {any[]} */
	const submits = [];
	let polls = 0;
	let release = false;
	await page.route('**/mock-meshy/openapi/v2/text-to-3d', (route) => {
		const body = route.request().postDataJSON();
		submits.push(body);
		if (/broke/.test(body?.prompt ?? '')) return route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ message: 'Insufficient funds' }) });
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: 'txt-' + submits.length }) });
	});
	await page.route('**/mock-meshy/openapi/v2/text-to-3d/**', (route) => {
		polls++;
		const origin = new URL(route.request().url()).origin;
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(release ? { status: 'SUCCEEDED', progress: 100, model_urls: { glb: origin + MESHY + '/out.glb' } } : { status: 'IN_PROGRESS', progress: 40 })
		});
	});
	await page.route('**/mock-meshy/out.glb', (route) => route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: glb }));

	// ---------- 1. a window, not a modal ----------
	console.log('\n=== 1. a window, not a modal ===');
	await openWindow(page);
	h.check(!(await page.evaluate(() => { let v; window.__stores.anyModalOpen.subscribe((x) => (v = x))(); return v; })), 'anyModalOpen stays false with the Generate window open');
	h.check((await page.locator('.mesh-gen-backdrop').count()) === 0, 'no backdrop covers the scene');

	// ---------- 2. it docks ----------
	console.log('\n=== 2. it docks ===');
	await page.evaluate(() => window.__stores.dockHost.setHostedDocked('meshGen', true));
	await h.eventually(
		() => page.evaluate(() => ({ hosted: document.querySelector('#mesh-gen-window')?.hasAttribute('data-pd-host') ?? false, tab: !!document.querySelector('[data-dock-tab="meshGen"], [data-tab-key="meshGen"]') })),
		(s) => s.hosted,
		'setHostedDocked: the window is hosted in the bottom dock'
	);
	await shot(page, '10-generate-docked-empty.png');

	// ---------- 3. submit ----------
	console.log('\n=== 3. submit ===');
	await page.fill('#mesh-gen-prompt', 'a red crate');
	await page.fill('#mesh-gen-name', 'Crate');
	await page.click('#mesh-gen-submit');
	await h.eventually(() => jobs(page), (l) => l.length === 1 && l[0].status === 'running', 'one job row, running');
	h.check(submits.length === 1, `the provider got one submit (${submits.length})`);
	h.check((await history(page))[0] === 'a red crate', 'the prompt is in History');
	h.check(await page.locator('#mesh-gen-window').isVisible(), 'the window stays open for the next prompt');
	h.check((await page.inputValue('#mesh-gen-prompt')) === '', 'the form is cleared');
	await h.eventually(() => Promise.resolve(polls), (n) => n >= 1, 'premise: the job polls the provider', 15000);
	await shot(page, '11-generate-docked-running.png');

	// ---------- 4. reload while it runs: it resumes, it is not sent again ----------
	console.log('\n=== 4. reload while running ===');
	await reload(A);
	h.check((await jobs(page)).some((j) => j.prompt === 'a red crate' && j.status === 'running'), 'after the reload the job is back, still running');
	h.check((await history(page)).includes('a red crate'), 'and the history is back');
	await openWindow(page);
	h.check(await page.evaluate(() => document.querySelector('#mesh-gen-window')?.hasAttribute('data-pd-host') ?? false), 'it opens docked again (the dock flag is this device’s)');
	h.check((await page.locator('#mesh-gen-jobs [data-job-status="running"]').count()) === 1, 'the Jobs tab lists the running job');
	const pollsBefore = polls;
	await h.eventually(() => Promise.resolve(polls), (n) => n > pollsBefore, 'the reloaded page takes the job over and polls the SAME task', 40000);
	release = true;
	await h.eventually(() => jobs(page), (l) => l[0]?.status === 'done', 'the provider finishes: the job is done', 40000);
	h.check(submits.length === 1, `counterfactual: still ONE submit after the reload (${submits.length}) — nothing was charged twice`);
	await h.eventually(() => objects(page), (o) => o.length === 1 && o[0].name === 'Crate', 'the model is placed once, under its name');
	await shot(page, '12-generate-docked-done.png');

	// ---------- 5. Reopen ----------
	console.log('\n=== 5. Reopen ===');
	const done = (await jobs(page))[0];
	h.check(!!done.hash, 'the done job remembers the cached file');
	await page.evaluate((uuid) => window.__stores.objectActions.deleteObjectsByUuid([uuid]), done.uuid);
	await h.eventually(() => objects(page), (o) => o.length === 0, 'premise: the model is deleted');
	await page.click(`[data-job-reopen="${done.id}"]`);
	await h.eventually(() => objects(page), (o) => o.length === 1 && o[0].prompt === 'a red crate', 'Reopen places it again from Explorer ▸ Generated, provenance kept', 20000);
	const before = (await objects(page)).length;
	await page.click(`[data-job-reopen="${done.id}"]`);
	await page.waitForTimeout(800);
	h.check((await objects(page)).length === before, 'a second Reopen selects the model in the scene instead of placing a copy');

	// ---------- 6. a failed job ----------
	console.log('\n=== 6. a failed job ===');
	await page.fill('#mesh-gen-prompt', 'broke table');
	await page.click('#mesh-gen-submit');
	await h.eventually(() => jobs(page), (l) => l.some((j) => j.prompt === 'broke table' && j.status === 'error'), 'Meshy 402: the job fails');
	const failed = (await jobs(page)).find((j) => j.prompt === 'broke table');
	h.check(/Meshy/i.test(failed.error), `the reason names the provider (${failed.error})`);
	h.check((await page.locator(`[data-job-retry="${failed.id}"]`).count()) === 1, 'a failed job offers Retry');
	const n = submits.length;
	await page.click(`[data-job-retry="${failed.id}"]`);
	await h.eventually(() => Promise.resolve(submits.length), (c) => c === n + 1, 'Retry sends the prompt again (a new job)');
	await h.eventually(() => jobs(page), (l) => l.filter((j) => j.prompt === 'broke table').length === 2, 'the retry is its own row');
	await shot(page, '13-generate-docked-failed.png');

	// ---------- 7. a second reload keeps it all ----------
	console.log('\n=== 7. a second reload ===');
	await page.evaluate(() => window.__stores.dockHost.setHostedDocked('meshGen', false));
	await reload(A);
	const after = await jobs(page);
	h.check(after.some((j) => j.status === 'done') && after.filter((j) => j.status === 'error').length === 2, `done + failed jobs survive (${after.map((j) => j.status).join(',')})`);
	h.check(JSON.stringify(await history(page)) === JSON.stringify(['broke table', 'a red crate']), 'History keeps both prompts, newest first');
	await openWindow(page);
	h.check(!(await page.evaluate(() => document.querySelector('#mesh-gen-window')?.hasAttribute('data-pd-host') ?? false)), 'floating again after Undock');
	await page.click('#mesh-gen-tab-history');
	await page.click('[data-history-use="a red crate"]');
	h.check((await page.inputValue('#mesh-gen-prompt')) === 'a red crate' && (await page.inputValue('#mesh-gen-name')) === 'Crate', 'a History row puts the prompt and name back in the form');
	await shot(page, '14-generate-floating-history.png');
	await page.evaluate(() => window.__stores.themes.theme.set('light'));
	await page.click('#mesh-gen-tab-jobs');
	await page.waitForTimeout(300);
	await shot(page, '15-generate-floating-jobs-light.png');
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));

	// ---------- 8. a phone ----------
	console.log('\n=== 8. phone ===');
	for (const [label, vp] of [
		['folded', { width: 412, height: 915 }],
		['unfolded', { width: 820, height: 900 }]
	]) {
		const C = await h.setupPage(browser, 'C-' + label, { context: { viewport: vp, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6 } });
		await openWindow(C.page);
		const g = await C.page.evaluate(() => {
			const el = document.querySelector('#mesh-gen-window');
			const r = el.getBoundingClientRect();
			return { left: r.left, right: r.right, w: window.innerWidth, scroll: el.scrollWidth - el.clientWidth, body: document.documentElement.scrollWidth - window.innerWidth };
		});
		h.check(g.left >= -1 && g.right <= g.w + 1 && g.scroll <= 1 && g.body <= 1, `${label}: on screen, no sideways overflow (${JSON.stringify(g)})`);
		await shot(C.page, `16-generate-phone-${label}.png`);
		await C.page.context().close();
	}
	await h.finish(browser);
});
