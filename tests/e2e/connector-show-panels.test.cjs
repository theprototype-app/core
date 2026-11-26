// 107-panels (roadmap 107, owner report 27 Nov) — the PANEL REGISTRY and `show` panel through a real connector tab,
// against the fake relay.
//   1. show {action: "panels"} reads with no question: every panel, the dock + sidebars, the refused surfaces
//   2. Animation opens the Animation editor and NOT the Timeline; UV / Shader / HUD editor, Statistics and Profiler open
//      (Profiler + Statistics are read-only and allowed)
//   3. an unknown name opens nothing and lists the valid names + the block list by reason (counterfactual: the same
//      call with the real name opens it); Settings / Profile are refused with their reason
//   4. focus is truthful: a covered dock tab answers changed:true front:true; again changed:false; a minimized dock
//      reads visible:false and focus brings it back
//   5. Dock / Left sidebar as targets: close hides (tabs stay open), Back reopens
//   6. move to the right sidebar and Back; maximize a docked panel and restore; collapse / expand the Explorer tree
//   7. layouts: save under a new name (an existing name is refused), apply, Back
// Run: APP_URL='https://theprototype.app:7240/' npm run e2e -- connector-show-panels
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
		const id = 'p' + ++seq;
		relay.call(id, tool, args, scope);
		return relay.answer(id, timeout);
	};
	const short = (x) => JSON.stringify(x).slice(0, 300);
	const reset = () => page.evaluate(() => window.__tp.test.v1.showTool.showToolResetForTest());
	const show = (args) => call('show', args);
	const panels = async () => (await show({ action: 'panels' }))?.result;
	const P = async (id) => (await panels())?.panels?.find((p) => p.id === id);
	const where = (key) => page.evaluate((k) => window.__tp.test.v1.dockMenu.windowWhere(k), key);
	const errOf = (r) => (r?.type === 'error' ? r.error?.message ?? '' : '');

	// ---- 1 ----------------------------------------------------------------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.safeStorage.removeItem('show:allow:panel'));
	const list = await panels();
	h.check(!list?.needsConfirm && Array.isArray(list?.panels), `panels reads with no question (${short(list)})`);
	const ids = (list?.panels ?? []).map((p) => p.id);
	for (const id of ['explorer', 'animation', 'timeline', 'uv', 'shader', 'hud', 'profiler', 'stats', 'preview']) h.check(ids.includes(id), `panels lists ${id}`);
	h.check((list?.panels ?? []).every((p) => typeof p.description === 'string' && 'open' in p && 'visible' in p && 'front' in p && 'where' in p), 'each panel has a description, open, where, visible, front');
	h.check((list?.panels ?? []).filter((p) => p.readOnly).map((p) => p.id).join() === 'profiler,stats', 'Profiler and Statistics are the read-only ones');
	h.check(list?.dock && list?.left && list?.right && Array.isArray(list?.blocked) && list.blocked.some((b) => b.reason === 'settings'), `the dock, both sidebars and the block list by reason (${short(list?.blocked)})`);
	h.check(list?.layouts && Array.isArray(list.layouts.names), 'the saved layouts are listed');
	await page.evaluate(() => window.__tp.test.v1.safeStorage.setItem('show:allow:panel', 'always'));

	// ---- 2 ----------------------------------------------------------------------------------------------------
	await page.evaluate(() => { const s = window.__tp.test.v1; s.animationClose?.set?.(true); s.timelineClose?.set?.(true); });
	await h.eventually(() => where('timeline'), (w) => w === null, 'the Timeline is closed to start', 5000);
	await reset();
	const anim = await show({ action: 'panel', name: 'Animation' });
	h.check(anim?.result?.panel === 'Animation' && anim.result.changed === true, `"Animation" opens the Animation editor (${short(anim)})`);
	await h.eventually(() => where('animation'), (w) => w !== null, 'the Animation editor is open', 5000);
	h.check((await where('timeline')) === null, 'and the Timeline stays closed (the substitution is gone)');
	h.check(anim?.result?.visible === true && anim.result.front === true, `the answer says visible + front (${short(anim?.result)})`);
	for (const [name, id] of [['UV Editor', 'uv'], ['Shader Editor', 'shader'], ['HUD Editor', 'hud'], ['Statistics', 'stats'], ['Profiler', 'profiler']]) {
		await reset();
		const r = await show({ action: 'panel', name });
		h.check(r?.result?.id === id && r.result.state === 'open', `"${name}" opens (${short(r)})`);
		if (id === 'profiler' || id === 'stats') h.check(r?.result?.readOnly === true, `${name} answers readOnly: true`);
	}

	// ---- 3 ----------------------------------------------------------------------------------------------------
	await reset();
	const openBefore = (await panels()).panels.filter((p) => p.open).map((p) => p.id).join();
	const unk = await show({ action: 'panel', name: 'Animations timeline' });
	h.check(/no panel "Animations timeline": nothing was opened/.test(errOf(unk)) && /Animation, Timeline/.test(errOf(unk)) && /settings \(Settings/.test(errOf(unk)), `an unknown name errors with the valid names and the block list (${errOf(unk).slice(0, 200)})`);
	h.check((await panels()).panels.filter((p) => p.open).map((p) => p.id).join() === openBefore, 'and nothing opened');
	for (const [name, reason] of [['Settings', 'settings'], ['Profile', 'sign-in and account'], ['Publish', 'publishing'], ['Export', 'publishing'], ['Generate 3D', 'connected apps']]) {
		const r = await show({ action: 'panel', name });
		h.check(new RegExp('not something show opens \\(' + reason + '\\)').test(errOf(r)), `"${name}" is refused: ${reason} (${errOf(r).slice(0, 120)})`);
	}
	h.check(/publishing and export stay refused/.test(errOf(await show({ action: 'panel', name: 'Export' }))), 'the publishing refusal says it stays refused');
	const notSub = await show({ action: 'panel', name: 'Explorer settings' });
	h.check(/^no panel "Explorer settings"/.test(errOf(notSub)), `no substring block: "Explorer settings" is unknown, not refused (${errOf(notSub).slice(0, 80)})`);
	await reset();
	const sceneSet = await show({ action: 'panel', name: 'Scene settings' });
	h.check(sceneSet?.result?.id === 'scene' && sceneSet.result.state === 'open', `"Scene settings" opens Configure Scene (scene content, not app settings) (${short(sceneSet)})`);
	await page.evaluate(() => window.__tp.test.v1.isLocked.set(true));
	const inPlay = await show({ action: 'panel', name: 'Timeline' });
	const inPlayDock = await show({ action: 'panel', name: 'Dock', state: 'open' });
	const readInPlay = await panels();
	await page.evaluate(() => window.__tp.test.v1.isLocked.set(false));
	h.check(/panels belong to Edit/.test(errOf(inPlay)) && inPlay?.error?.data?.playing !== false, `in Play a panel call is an error, never a success (${errOf(inPlay).slice(0, 100)})`);
	h.check(/panels belong to Edit/.test(errOf(inPlayDock)), 'and so is a dock call');
	h.check(readInPlay?.playing === true && readInPlay.panels.every((p) => !p.visible), 'panels still reads in Play: playing true, nothing visible');

	// ---- 4 ----------------------------------------------------------------------------------------------------
	await reset();
	await show({ action: 'panel', name: 'Explorer', to: 'dock' });
	await show({ action: 'panel', name: 'Timeline', to: 'dock' });
	await reset();
	const tl = await show({ action: 'panel', name: 'Timeline', state: 'focus' });
	h.check(tl?.result?.front === true && tl.result.where === 'dock', `the Timeline is the dock's front tab (${short(tl?.result)})`);
	const exBefore = await P('explorer');
	h.check(exBefore?.open === true && exBefore.where === 'dock' && exBefore.front === false, `the Explorer is open in the dock but covered (${short(exBefore)})`);
	const f1 = await show({ action: 'panel', name: 'Explorer', state: 'focus' });
	h.check(f1?.result?.changed === true && f1.result.front === true && f1.result.visible === true, `focus on a covered tab: changed:true, front:true (${short(f1?.result)})`);
	const f2 = await show({ action: 'panel', name: 'Explorer', state: 'focus' });
	h.check(f2?.result?.changed === false && f2.result.front === true, `focus again: changed:false, still front (${short(f2?.result)})`);
	await reset();
	const dc = await show({ action: 'panel', name: 'Dock', state: 'close' });
	h.check(dc?.result?.target === 'Dock' && dc.result.state === 'closed' && dc.result.changed === true, `Dock close hides the dock (${short(dc?.result)})`);
	const exMin = await P('explorer');
	h.check(exMin?.open === true && exMin.visible === false, `a minimized dock: the Explorer is open but not visible (${short(exMin)})`);
	const f3 = await show({ action: 'panel', name: 'Explorer', state: 'focus' });
	h.check(f3?.result?.changed === true && f3.result.visible === true, `focus brings the minimized dock back (${short(f3?.result)})`);

	// ---- 5 ----------------------------------------------------------------------------------------------------
	await reset();
	const d2 = await show({ action: 'panel', name: 'bottom dock', state: 'close' });
	h.check(d2?.result?.changed === true && d2.result.tabs?.includes('Explorer'), `close again: hidden, its tabs listed (${short(d2?.result)})`);
	const bk = await show({ action: 'back' });
	h.check(bk?.result?.back === true, `back (${short(bk)})`);
	h.check((await panels()).dock.open === true, 'Back reopens the dock');
	const ls = await show({ action: 'panel', name: 'Left sidebar', state: 'toggle' });
	h.check(ls?.result?.target === 'Left sidebar' && typeof ls.result.open === 'boolean', `Left sidebar toggles (${short(ls?.result)})`);
	await show({ action: 'back' });

	// ---- 6 ----------------------------------------------------------------------------------------------------
	await reset();
	const mv = await show({ action: 'panel', name: 'Explorer', state: 'move', to: 'right' });
	h.check(mv?.result?.where === 'right' && mv.result.changed === true, `move to the right sidebar (${short(mv?.result)})`);
	await h.eventually(() => where('explorer'), (w) => w === 'right', 'the Explorer is in the right sidebar', 5000);
	await show({ action: 'back' });
	await h.eventually(() => where('explorer'), (w) => w === 'dock', 'Back puts it in the dock again', 5000);
	const mx = await show({ action: 'panel', name: 'Explorer', state: 'maximize' });
	h.check(mx?.result?.maximized === true, `maximize a docked panel (${short(mx?.result)})`);
	h.check((await panels()).focusMode === 'dock', 'focus mode is the dock');
	const rs = await show({ action: 'panel', name: 'Explorer', state: 'restore' });
	h.check(rs?.result?.maximized === false && (await panels()).focusMode === null, `restore (${short(rs?.result)})`);
	await reset();
	const mxf = await show({ action: 'panel', name: 'Statistics', state: 'maximize' });
	h.check(/DOCKED panel/.test(errOf(mxf)) || mxf?.result?.maximized === true, `maximize on a non-docked panel says to dock it first (${errOf(mxf).slice(0, 120) || short(mxf?.result)})`);
	const col = await show({ action: 'panel', name: 'Explorer', state: 'collapse', pane: 'tree' });
	h.check(col?.result?.pane === 'tree' && col.result.paneState === 'closed', `collapse the Explorer's folder tree (${short(col?.result)})`);
	h.check((await P('explorer'))?.panes?.tree === false, 'panels reads the tree closed');
	const exp = await show({ action: 'panel', name: 'Explorer', state: 'expand', pane: 'left' });
	h.check(exp?.result?.paneState === 'open' && (await P('explorer'))?.panes?.tree === true, `expand it again by side (${short(exp?.result)})`);

	// ---- 7 ----------------------------------------------------------------------------------------------------
	await reset();
	const sv = await show({ action: 'layout', name: 'E2E panels', state: 'save' });
	h.check(sv?.result?.saved === true && sv.result.layouts.includes('E2E panels'), `save a layout (${short(sv)})`);
	const dup = await show({ action: 'layout', name: 'e2e panels', state: 'save' });
	h.check(/show never overwrites one/.test(errOf(dup)), `an existing name is refused (${errOf(dup).slice(0, 100)})`);
	await show({ action: 'panel', name: 'Explorer', state: 'close' });
	const ap = await show({ action: 'layout', name: 'E2E panels' });
	h.check(ap?.result?.applied === true, `apply it (${short(ap)})`);
	await h.eventually(() => where('explorer'), (w) => w !== null, 'the layout brought the Explorer back', 8000);
	const nl = await show({ action: 'layout', name: 'No such layout' });
	h.check(/no layout "No such layout": nothing changed/.test(errOf(nl)), 'an unknown layout changes nothing');

	await h.finish(browser);
});
