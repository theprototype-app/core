// Roadmap 67 P1 VR — an agent panel in a headset. A wears an IWER Quest 3 (the app's own WebXR path), B is
// an agent's page (safeStorage `agentApi`, what the bridge sets) that opens a Pixling panel for A. In VR the
// focused panel is a board in front of the person (agentPanelsVR.js, mounted only in VR); the right
// controller's laser + trigger press its controls like the window's buttons.
//   0  the boot graph: a plain page (no debug hook) loads none of the panel modules
//   1  B opens the panel for A (A hosts); A enters VR: the board mounts, shows the panel, follows the head
//   2  aim at Render, pull the trigger → B's inbox gets the press (kind panel)
//   3  aim along the slider's track (a VR slider is set where the laser points) → a change event; the board redraws
//   4  B's update_panel (a new status) redraws the board; close_panel takes it down
//
// Run: APP_URL='https://theprototype.app:5498/' npm run e2e -- agent-panels-vr
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const SPEC = {
	v: 1,
	title: 'Pixling',
	toolId: 'pixling',
	controls: [
		{ type: 'slider', id: 'scale', label: 'Scale', min: 1, max: 8, step: 1, value: 2 },
		{ type: 'button', id: 'render', label: 'Render', variant: 'primary' },
		{ type: 'status', id: 'status', text: 'Ready' }
	]
};

const vr = (page) => page.evaluate(() => {
	const d = window.__stores.agentPanelsVR.agentPanelsVRDebug();
	return { mounted: d.mounted, visible: d.visible, position: d.position, hits: d.hits, hover: d.hover, draws: d.draws, presses: d.presses, lastPress: d.lastPress, shown: d.shown };
});
const pointOf = (page, id, u = 0.5) => page.evaluate(([id, u]) => window.__stores.agentPanelsVR.agentPanelsVRDebug().point(id, u), [id, u]);

/** aim the right controller from where it stands at a world point; returns the hover the board reports */
async function aimAt(page, target) {
	await iwer.pose(page, 'right', [0.2, 1.3, -0.1]);
	await iwer.frames(page, 3);
	const at = (await iwer.controllerWorld(page)).right.pos;
	const d = [target[0] - at[0], target[1] - at[1], target[2] - at[2]];
	const yaw = Math.atan2(-d[0], -d[2]);
	const pitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
	await iwer.pose(page, 'right', [0.2, 1.3, -0.1], { yaw, pitch });
	await iwer.frames(page, 4);
	return (await vr(page)).hover;
}

/** the next panel event in B's inbox (or null) */
const nextEvent = (B, ms = 8000) => B.page.evaluate((ms) => window.tpAgent.nextMessage(ms).then((m) => (m ? JSON.parse(JSON.stringify(m)) : null)), ms);

h.run(async () => {
	const browser = await h.launch();
	// ---- 0. the boot graph: a plain page (no debug hook, so nothing preloads the hook rows) loads no panel module
	{
		const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
		await ctx.addInitScript(() => {
			localStorage.setItem('hasSeenDisclaimer', 'true');
			localStorage.setItem('hasSeenWelcome', 'true');
		});
		const page = await ctx.newPage();
		await page.goto(h.URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
		await page.waitForSelector('#play-button', { timeout: 90000 }).catch(() => {});
		await page.waitForTimeout(4000);
		const loaded = await page.evaluate(() =>
			performance
				.getEntriesByType('resource')
				.map((r) => r.name)
				.filter((n) => /agentPanels|AgentPanels|agentPanelCore|agentPanelVRDraw|agentPanelsVR|panelHost/.test(n))
		);
		const any = await page.evaluate(() => performance.getEntriesByType('resource').length);
		h.check(any > 20, `premise: the plain page booted (${any} resources)`);
		h.check(loaded.length === 0, `no panel module is in the boot graph (${JSON.stringify(loaded)})`);
		await ctx.close();
	}

	const A = await h.setupPage(browser, 'A', { init: iwer.initScript() });
	const B = await h.setupPage(browser, 'B', { storage: { agentApi: '1' } });
	await B.page.waitForFunction(() => !!window.tpAgent, null, { timeout: 30000 });
	await h.connect(B, A);
	await h.eventually(() => B.page.evaluate(() => Promise.resolve(window.tpAgent.status()).then((s) => s.joined)), (j) => j === true, 'B joined A', 20000);

	// ---- 1. the panel, then the headset -------------------------------------------------------------
	const opened = await B.page.evaluate((spec) => window.tpAgent.exec('open_panel', { spec }), SPEC);
	h.check(opened?.ok === true && opened.owner === A.id.toLowerCase(), `B opened the panel for A, the host (${JSON.stringify(opened).slice(0, 120)})`);
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.agentPanels.agentPanels.subscribe((l) => r(l.length))())),
		(n) => n === 1,
		'A shows the panel on the desktop first',
		20000
	);
	await iwer.enter(A.page);
	await iwer.pose(A.page, 'head', [0, 1.6, 0]);
	const st = await h
		.eventually(() => vr(A.page), (s) => s.mounted && s.visible && s.hits.includes('c:render'), 'the board mounted in VR, showing the panel', 20000)
		.then(() => vr(A.page));
	h.check(st.hits.includes('c:scale') && st.hits.includes('close'), `its hits: the slider's track, Render, Close (${st.hits.join(' ')})`);
	const head = (await iwer.controllerWorld(A.page)).head.pos;
	const dist = Math.hypot(st.position[0] - head[0], st.position[2] - head[2]);
	h.check(dist > 0.3 && dist < 1.5 && st.position[2] < head[2], `the board stands in front of the head (${dist.toFixed(2)} m, at ${st.position.map((v) => v.toFixed(2)).join(',')})`);

	// ---- 2. Render with the laser -----------------------------------------------------------------
	const render = await pointOf(A.page, 'c:render');
	const hov = await aimAt(A.page, render);
	h.check(hov.includes('c:render'), `the laser hovers Render (${JSON.stringify(hov)})`);
	await nextEvent(B, 300); // anything queued before (none expected)
	await iwer.tap(A.page, 'right', 'trigger');
	const press = await nextEvent(B);
	h.check(press?.kind === 'panel' && press.event === 'press' && press.control === 'render' && press.from === A.id.toLowerCase(), `the trigger pressed Render on the agent's side (${JSON.stringify(press && { kind: press.kind, event: press.event, control: press.control })})`);

	// ---- 3. the slider's track: 5 of 1..8 sits at u = 4/7 ---------------------------------------
	const draws0 = (await vr(A.page)).draws;
	const at5 = await pointOf(A.page, 'c:scale', 4 / 7);
	const hov2 = await aimAt(A.page, at5);
	h.check(hov2.includes('c:scale'), `the laser hovers the slider (${JSON.stringify(hov2)})`);
	await iwer.tap(A.page, 'right', 'trigger');
	const change = await nextEvent(B);
	h.check(change?.event === 'change' && change.control === 'scale' && change.value === 5, `the trigger set the slider where the laser points: a change to 5 (${JSON.stringify(change && { event: change.event, value: change.value })})`);
	h.check((await vr(A.page)).draws > draws0, 'the board redrew');

	// ---- 4. the agent updates, then closes -------------------------------------------------------
	const d1 = (await vr(A.page)).draws;
	const up = await B.page.evaluate((id) => window.tpAgent.exec('update_panel', { panelId: id, controls: { status: { text: 'Rendered', tone: 'ok' } } }), opened.panelId);
	h.check(up?.ok === true, 'update_panel');
	await h.eventually(() => vr(A.page), (s) => s.draws > d1, 'the board redrew with the agent\'s update', 10000);
	await B.page.evaluate((id) => window.tpAgent.exec('close_panel', { panelId: id }), opened.panelId);
	await h.eventually(() => vr(A.page), (s) => !s.visible, 'close_panel took the board down', 10000);

	await iwer.exit(A.page);
	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, `no page errors (${JSON.stringify([...h.pageErrors(A), ...h.pageErrors(B)])})`);
	await h.finish(browser);
});
