// 107 (lane 107-ui-state) — ui_state, scene_stats and the combined first-use prompt through a real connector tab,
// against the fake relay.
//   1. the tab advertises ui_state + scene_stats; a read-scoped grant may call both (scene_stats target excepted)
//   2. ui_state: the selection, the Inspector's object, the Flow editor's graph (an object's, then the Scene flow), the
//      Timeline's open sequence, the camera pose = the editor camera, the device, Quality (preset + what it lowered)
//      — and nothing on screen changed (no toast, the selection and the camera are where they were)
//   3. scene_stats read: the Budget rows by the panel's names, the Profiler frame figures, Quality; compare = three rows
//   4. snapshot "before" -> 12 more boxes -> snapshot "after" -> diff says Objects and Triangles went up
//   5. target: refused under a read grant; with edit it switches Statistics ▸ Budget to Phone, the person gets a line
//      with Back, Back puts it back (counterfactual: the store really moved)
//   6. permissions: the first show call asks ONE question naming panels, view and code; This time grants all three for
//      this page (a camera move then runs without asking); ui_state lists them; Settings ▸ Privacy shows each with
//      Revoke; Revoke takes camera back, and the next camera move asks again
// Run: APP_URL='https://theprototype.app:7255/' npm run e2e -- connector-ui-state
const h = require('./helpers.cjs');
const { installProvider, fakeRelay, connectorPhase } = require('./connectorFake.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.evaluate(() => window.__tp.test.v1.aiAssistantHidden.set(''));
	const relay = await fakeRelay(page);
	await installProvider(page);
	await page.locator('#connect-claude-button').click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected', 'connected', 15000);
	let seq = 0;
	const call = async (tool, args = {}, scope = 'edit', timeout = 60000) => {
		const id = 'u' + ++seq;
		relay.call(id, tool, args, scope);
		return relay.answer(id, timeout);
	};
	const short = (x) => JSON.stringify(x).slice(0, 320);
	const toasts = () => page.evaluate(() => { let t = []; window.__tp.test.v1.toastStore.subscribe((v) => (t = v))(); return t.map((e) => (typeof e === 'string' ? e : e.text)); });

	// ---- 1 ----------------------------------------------------------------------------------------------------
	const hello = relay.frames.find((x) => x.f.type === 'hello')?.f;
	h.check(['ui_state', 'scene_stats'].every((n) => hello?.tools?.includes(n)), 'the connector tab advertises ui_state and scene_stats');

	// ---- 2 ----------------------------------------------------------------------------------------------------
	const made = await call('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Lamp post', position: [2, 0.5, -1] }] });
	const boxId = made?.result?.created?.[0]?.uuid;
	h.check(!!boxId, `a box (${short(made)})`);
	await page.evaluate(async (u) => {
		const s = window.__tp.test.v1;
		s.objectActions.applySelectionSet([u], false);
		s.setActiveGraph?.(u) ?? s.activeGraphId.set(u);
		const id = s.sequences.createSequence('Intro shot');
		s.sequences.activeSequence.set(id);
	}, boxId);
	const toastsBefore = (await toasts()).length;
	const camBefore = await page.evaluate(() => { let c; window.__tp.test.v1.globalCamera.subscribe((v) => (c = v))(); return c.position.toArray().map((n) => +n.toFixed(2)); });
	const ui = await call('ui_state', {}, 'read');
	const u = ui?.result ?? {};
	h.check(ui?.type === 'result', `ui_state answers under a read grant (${short(ui)})`);
	h.check(u.selection?.count === 1 && u.selection.objects?.[0]?.uuid === boxId && u.selection.objects[0].name === 'Lamp post', `selection: the box (${short(u.selection)})`);
	h.check(u.flow?.graph === boxId && u.flow.object?.name === 'Lamp post', `flow: the Flow editor shows the box's graph (${short(u.flow)})`);
	h.check(u.timeline?.name === 'Intro shot', `timeline: the open sequence (${short(u.timeline)})`);
	h.check(Array.isArray(u.camera?.position) && u.camera.position.every((n, i) => Math.abs(n - camBefore[i]) < 0.05) && Array.isArray(u.camera.target), `camera: the editor camera's pose (${short(u.camera)} vs ${camBefore})`);
	h.check(['desktop', 'phone', 'quest'].includes(u.device?.kind) && u.device.inHeadset === false, `device (${short(u.device)})`);
	h.check(typeof u.quality?.preset === 'string' && typeof u.quality.level === 'number' && typeof u.quality.say === 'string', `quality: preset, level, what it lowered (${short(u.quality)})`);
	h.check('panels' in u, 'a panels field for 107-int');
	h.check(['quest', 'phone', 'desktop'].includes(u.statisticsJudgesFor?.target), `which device Statistics judges for (${short(u.statisticsJudgesFor)})`);
	h.check((await toasts()).length === toastsBefore, 'ui_state left no line on the screen (it changed nothing)');
	await page.evaluate(() => window.__tp.test.v1.activeGraphId.set('scene'));
	const ui2 = await call('ui_state', {}, 'read');
	h.check(ui2?.result?.flow?.graph === 'scene' && ui2.result.flow.name === 'Scene flow', `flow: the Scene flow (${short(ui2?.result?.flow)})`);

	// ---- 3 ----------------------------------------------------------------------------------------------------
	await page.waitForTimeout(1500); // a few frames for the Profiler's ring
	const st = await call('scene_stats', {}, 'read');
	const s = st?.result ?? {};
	h.check(st?.type === 'result' && s.budget?.panel === 'Statistics ▸ Budget', `scene_stats answers under a read grant (${short(st)})`);
	const names = (s.budget?.rows ?? []).map((r) => r.name);
	h.check(['Draw calls', 'Triangles', 'Texture memory', 'Lights'].every((n) => names.includes(n)), `the Budget rows by the panel's names (${names})`);
	h.check((s.statistics?.rows ?? []).some((r) => r.name === 'Frame time p95'), 'the Statistics rows by the overlay\'s names');
	h.check(s.profiler?.panel === 'Profiler' && (typeof s.profiler.frameAvgMs === 'number' || !!s.profiler.note), `the Profiler's frame figures (${short(s.profiler)})`);
	h.check(typeof s.quality?.preset === 'string' && typeof s.say === 'string' && s.say.length > 5, `quality + a spoken line (${s.say})`);
	const cmp = await call('scene_stats', { action: 'compare' }, 'read');
	h.check((cmp?.result?.rows ?? []).map((r) => r.target).join() === 'quest,phone,desktop' && cmp.result.rows.every((r) => ['green', 'amber', 'red'].includes(r.tier)), `compare: one row per device (${short(cmp)})`);

	// ---- 4 ----------------------------------------------------------------------------------------------------
	const s1 = await call('scene_stats', { action: 'snapshot', name: 'before' }, 'read');
	h.check(s1?.result?.saved === 'before', `snapshot "before" (${short(s1)})`);
	await call('create_objects', { objects: Array.from({ length: 12 }, (_, i) => ({ kind: 'primitive', primitive: 'Sphere', name: 'Ball ' + i, position: [i - 6, 1, 4] })) });
	await call('scene_stats', { action: 'snapshot', name: 'after' }, 'read');
	const d = await call('scene_stats', { action: 'diff', from: 'before', to: 'after' }, 'read');
	const changed = (d?.result?.changes ?? []).map((c) => c.figure);
	h.check(changed.includes('Objects') && changed.includes('Triangles'), `diff: Objects and Triangles changed (${short(d)})`);
	h.check((d?.result?.changes ?? []).find((c) => c.figure === 'Objects')?.by === 12, 'diff: exactly 12 more objects');
	h.check(/^From "before" to "after":/.test(d?.result?.say ?? ''), `diff says it (${d?.result?.say})`);
	const missing = await call('scene_stats', { action: 'diff', from: 'nope' }, 'read');
	h.check(/no snapshot "nope"/.test(missing?.result?.error ?? missing?.error?.message ?? ''), `an unknown snapshot names the real ones (${short(missing)})`);

	// ---- 5 ----------------------------------------------------------------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.budgetMeter.setBudgetTarget('quest'));
	const nowTarget = () => page.evaluate(() => { let v; window.__tp.test.v1.budgetMeter.budgetTarget.subscribe((x) => (v = x))(); return v; });
	const roT = await call('scene_stats', { action: 'target', target: 'phone' }, 'read');
	h.check(roT?.type === 'error' && roT.error?.code === 'refused', `target is refused under a read grant (${short(roT)})`);
	h.check((await nowTarget()) === 'quest', 'counterfactual: still Quest');
	const t = await call('scene_stats', { action: 'target', target: 'phone' });
	h.check(t?.result?.changed === true && t.result.target === 'phone' && (await nowTarget()) === 'phone', `target: Statistics judges for Phone (${short(t)})`);
	h.check((await toasts()).some((x) => /^Claude set Statistics to judge this scene for Phone\./.test(x)), 'the person sees the line with Back');
	await page.locator('button', { hasText: /^\s*Back\s*$/ }).last().click();
	await h.eventually(nowTarget, (v) => v === 'quest', 'Back puts Quest back', 5000);

	// ---- 6 ----------------------------------------------------------------------------------------------------
	await page.evaluate(() => { const s = window.__tp.test.v1; s.showTool.showToolResetForTest(); for (const k of ['panel', 'camera', 'code']) s.safeStorage.removeItem('show:allow:' + k); });
	const p1 = await call('show', { action: 'panel', name: 'Objects' });
	h.check(p1?.result?.needsConfirm === true && p1.result.summary === 'open and close your panels, move your view and open code for you', `ONE question names all three kinds (${short(p1)})`);
	h.check(JSON.stringify(p1?.result?.choices) === JSON.stringify(['Always', 'This time', 'Only this', 'No']), `its buttons (${p1?.result?.choices})`);
	const askText = (await toasts()).find((x) => /^Let Claude open and close your panels/.test(x)) ?? '';
	h.check(/Never sign-in, account, settings, consent, publishing, connected apps or payment/.test(askText), `the question says what it never includes (${askText})`);
	await page.locator('button', { hasText: /^\s*This time\s*$/ }).last().click();
	const p1b = await call('show', { action: 'panel', name: 'Objects', confirmId: p1?.result?.confirmId, wait: 10 });
	h.check(p1b?.result?.panel === 'Objects' && (p1b.result.granted ?? []).length === 3, `This time: Objects opens, three kinds granted for this page (${short(p1b)})`);
	h.check((await page.evaluate(() => ['panel', 'camera', 'code'].map((k) => window.__tp.test.v1.safeStorage.getItem('show:allow:' + k)))).every((v) => v !== 'always'), 'This time is not stored on the device');
	await page.waitForTimeout(2100);
	const cam = await call('show', { action: 'camera', position: [6, 4, 6], target: [0, 0, 0] });
	h.check(cam?.result?.moved === true, `a camera move now runs without asking (${short(cam)})`);
	const ui3 = await call('ui_state', {}, 'read');
	const perms = (ui3?.result?.permissions ?? []).map((g) => g.kind + ':' + g.answer);
	h.check(['panel:this time', 'camera:this time', 'code:this time'].every((x) => perms.includes(x)), `ui_state lists the grants (${perms})`);
	await page.evaluate(() => { const s = window.__tp.test.v1; s.settingsSection.set('privacy'); s.settingsOpen.set(true); });
	await h.eventually(() => page.locator('#row-show-grant-camera').count(), (n) => n === 1, 'Settings ▸ Privacy lists camera with Revoke', 15000);
	h.check((await page.locator('#row-show-grant-panel').count()) === 1 && (await page.locator('#row-show-grant-code').count()) === 1 && (await page.locator('#show-grant-revoke-all').count()) === 1, 'each kind has its row, and Revoke all is there');
	await page.locator('#show-grant-revoke-camera').click();
	await h.eventually(() => page.locator('#row-show-grant-camera').count(), (n) => n === 0, 'Revoke took camera away', 5000);
	await page.evaluate(() => window.__tp.test.v1.settingsOpen.set(false));
	const perms2 = ((await call('ui_state', {}, 'read'))?.result?.permissions ?? []).map((g) => g.kind + ':' + g.answer);
	h.check(!perms2.includes('camera:this time') && perms2.includes('panel:this time'), `ui_state agrees (${perms2})`);
	await page.waitForTimeout(2100);
	const cam2 = await call('show', { action: 'camera', position: [5, 5, 5], target: [0, 0, 0] });
	h.check(cam2?.result?.needsConfirm === true && cam2.result.summary === 'move your view', `after Revoke the next camera move asks again (${short(cam2)})`);

	await browser.close();
});
