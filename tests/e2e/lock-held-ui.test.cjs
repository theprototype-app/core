// 80a K1 + K4: what the OTHER peer sees of an object somebody holds. Two peers: H hosts and views,
// E holds the box X (which has a flow of its own).
//
// K1  Properties of X on H: the "<E> is editing this" banner (avatar, Request control, a status line
//     for a screen reader), every control aria-disabled, typing into the name changes nothing,
//     a section header still opens and closes; the viewport carries E's avatar over X (a helper,
//     gone in Play). Request -> E approves -> H holds X and the banner is gone.
// K4  viewing X opens X's flow in the node editor VIEW-ONLY: the flow banner, no node added by a
//     shortcut or the Add path, cards not draggable, and a code save of that flow is refused.
const h = require('./helpers.cjs');

const W = 1600;
const HGT = 1000;

const read = (page, name) => page.evaluate((n) => { let v; window.__tp.test.v1[n].subscribe((x) => (v = x))(); return v; }, name);
const toasts = (page) =>
	page.evaluate(() => new Promise((r) => window.__tp.test.v1.toastStore.subscribe((t) => r(t.map((x) => (typeof x === 'string' ? x : x.text))))()));
const nameOf = (page, uuid) =>
	page.evaluate((u) => new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe((g) => r(g?.getObjectByProperty('uuid', u)?.name ?? null))()), uuid);
const avatarOf = (page, uuid) =>
	page.evaluate(() => {
		let scene;
		window.__tp.test.v1.globalScene.subscribe((s) => (scene = s))();
		const g = scene?.getObjectByName('lock-highlights');
		const a = g?.children.filter((c) => c.name === 'lock-avatar') ?? [];
		return { group: !!g, visible: !!g?.visible, avatars: a.map((s) => s.userData.lockAvatar) };
	}, uuid);
const flowNodeCount = (page, graphId) =>
	page.evaluate((g) => { let v; window.__tp.test.v1.flowGraphs.subscribe((x) => (v = x))(); return v?.[g]?.nodes?.length ?? 0; }, graphId);
const editorOpen = (page) => page.evaluate(() => !!document.querySelector('.svelteFlow .svelte-flow__pane'));

const shownName = (page, id) => page.evaluate((i) => window.__tp.test.v1.lockHeld.nameOf(i), id);

h.run(async () => {
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H', { context: { viewport: { width: W, height: HGT } } });
	const E = await h.setupPageQuiet(browser, 'E', [H]);
	await h.connect(E, H);

	// X with a flow of its own (one number node), made on H and replicated
	const X = await H.page.evaluate(async () => {
		const s = window.__tp.test.v1;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		s.objectActions.deselectObject();
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		box.name = 'Crate';
		s.peers.subscribe((p) => p.send({ type: 'name', uuid: box.uuid, name: 'Crate' }))();
		s.flowGraphsCtl.createObjectGraph(box.uuid);
		const node = { id: 'k4n', type: 'number', position: { x: 0, y: 0 }, data: { type: 'number', value: 1 }, class: 'w-[150px]' };
		s.flowGraphs.update((all) => ({ ...all, [box.uuid]: { nodes: [node], edges: [] } }));
		s.peers.subscribe((p) => p.send({ type: 'nodecreate', node, graphId: box.uuid }))();
		return box.uuid;
	});
	await h.eventually(() => nameOf(E.page, X), (n) => n === 'Crate', 'E has the box');
	await h.eventually(() => flowNodeCount(E.page, X), (n) => n === 1, "E has the box's flow");

	// E holds X
	await E.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u), X);
	await h.eventually(() => H.page.evaluate((u) => window.__tp.test.v1.lockHeld.holderNow(u), X), (v) => v === E.id, 'H sees E holding the box');

	// ---- K1: the viewport avatar --------------------------------------------------------------
	await h.eventually(() => avatarOf(H.page, X), (a) => a.visible && a.avatars.length === 1 && a.avatars[0] === E.id, "H's viewport shows E's avatar over the box");
	h.check((await avatarOf(E.page, X)).avatars.length === 0, 'the holder sees no avatar on its own object');

	// ---- K1: Properties, read-only -----------------------------------------------------------
	await H.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u, true), X);
	await h.eventually(() => H.page.evaluate(() => !!document.querySelector('#held-banner')), (v) => v, 'Properties shows the held banner');
	{
		const b = await H.page.evaluate(() => {
			const el = document.querySelector('#held-banner');
			return {
				text: el?.querySelector('.held-title')?.textContent?.trim() ?? '',
				by: el?.getAttribute('data-held-by'),
				sr: el?.querySelector('[role=status]')?.textContent?.trim() ?? '',
				request: !!el?.querySelector('#held-banner-request'),
				emoji: /\p{Extended_Pictographic}/u.test(el?.textContent ?? '')
			};
		});
		const eName = await shownName(H.page, E.id);
		h.check(!!eName && b.text === eName + ' is editing this', `the banner names the holder ("${b.text}")`);
		h.check(b.by === E.id, 'and carries their id');
		h.check(b.sr === 'Crate, being edited by ' + eName, `a screen reader hears "${b.sr}"`);
		h.check(b.request, 'with a Request control');
		h.check(!b.emoji, 'and no emoji');
	}
	const ro = await H.page.evaluate(() => {
		const body = document.querySelector('[data-held-ro]');
		const name = /** @type {HTMLInputElement|null} */ (document.querySelector('#name'));
		const heads = body ? [...body.querySelectorAll('.sec-panel-head')] : [];
		return { body: !!body, name: name?.getAttribute('aria-disabled'), heads: heads.length, headsLive: heads.every((x) => x.getAttribute('aria-disabled') !== 'true') };
	});
	h.check(ro.body, 'the Properties body is read-only');
	h.check(ro.name === 'true', 'the name field says it is disabled');
	h.check(ro.heads > 0 && ro.headsLive, `section headers stay live (${ro.heads})`);
	await H.page.locator('#name').click({ force: true }).catch(() => {});
	await H.page.keyboard.type('Stolen');
	await H.page.keyboard.press('Enter');
	await H.page.waitForTimeout(600);
	h.check((await nameOf(H.page, X)) === 'Crate', 'typing into the name changes nothing here');
	h.check((await nameOf(E.page, X)) === 'Crate', 'or on the holder');
	{
		const head = H.page.locator('[data-held-ro] button.sec-panel-head').first();
		const before = await head.getAttribute('aria-expanded');
		await head.click();
		await h.eventually(() => head.getAttribute('aria-expanded'), (v) => v !== before, 'a section still opens and closes');
		await head.click();
	}

	// ---- K4: the flow opens view-only --------------------------------------------------------
	if (!(await editorOpen(H.page))) await H.page.locator('p[title="Node editor (N)"]').click();
	await h.eventually(() => editorOpen(H.page), (v) => v, 'the node editor is open');
	await h.eventually(() => read(H.page, 'activeGraphId'), (g) => g === X, "viewing the held box shows ITS flow");
	await h.eventually(() => H.page.evaluate(() => !!document.querySelector('#flow-held-banner')), (v) => v, 'with the held banner');
	h.check(await H.page.evaluate(() => document.querySelector('.svelteFlow')?.hasAttribute('data-flow-view-only')), 'the pane is view-only');
	h.check(
		await H.page.evaluate(() => [...document.querySelectorAll('.svelteFlow .svelte-flow__node')].every((n) => !n.classList.contains('draggable'))),
		'cards are not draggable'
	);
	// a note by shortcut and a duplicate are refused, with the holder named
	await H.page.locator('.svelteFlow .svelte-flow__pane').click({ position: { x: 40, y: 40 } });
	await H.page.evaluate(() => window.__tp.test.v1.nodeEditorActions.runNodeAction?.('addNote'));
	await H.page.evaluate(() => window.__tp.test.v1.nodeEditorActions.runNodeAction?.('selectAll'));
	await H.page.evaluate(() => window.__tp.test.v1.nodeEditorActions.runNodeAction?.('duplicate'));
	await H.page.waitForTimeout(500);
	h.check((await flowNodeCount(H.page, X)) === 1, 'no node was added to the held flow');
	const eShown = await shownName(H.page, E.id);
	await h.eventually(() => toasts(H.page), (t) => t.some((x) => x.includes(eShown + ' is editing this flow')), 'and H is told why');
	// a code save of that flow is refused too
	const saved = await H.page.evaluate(async (u) => {
		const cw = window.__tp.test.v1.codeWorkspace;
		if (!cw) return 'no-hook';
		await cw.openCode({ source: 'graph', ref: { graphId: u } });
		let tabs = [];
		cw.codeTabs.subscribe((v) => (tabs = v))();
		const tab = tabs.find((t) => t.kind === 'graph' && t.graphId === u);
		if (!tab) return 'no-tab';
		cw.setTabCode(tab.id, String(tab.code).replace(/\b1\b/, '7'));
		return (await cw.saveCodeTab(tab.id, { quiet: true })).ok;
	}, X);
	h.check(saved === false, `a code save of the held flow is refused (${saved})`);
	h.check(
		await E.page.evaluate((u) => { let v; window.__tp.test.v1.flowGraphs.subscribe((x) => (v = x))(); return v[u].nodes[0].data.value; }, X) === 1,
		'and the holder\'s flow is untouched'
	);

	// ---- K1: Request -> Approve hands it over -------------------------------------------------
	await H.page.locator('#held-banner-request').click();
	await h.eventually(() => H.page.evaluate(() => document.querySelector('#held-banner-request')?.textContent?.trim()), (t) => t === 'Asked…', 'the button says it asked');
	await h.eventually(() => toasts(E.page), (t) => t.some((x) => x.includes('asks to control')), 'the holder is asked');
	await h.approveButton(E.page).click();
	await h.eventually(() => H.page.evaluate((u) => window.__tp.test.v1.lockHeld.heldByMe(u), X), (v) => v, 'approve hands the box to H');
	await h.eventually(() => H.page.evaluate(() => !document.querySelector('#held-banner') && !document.querySelector('[data-held-ro]')), (v) => v, 'the banner is gone and Properties are editable');
	await h.eventually(() => H.page.evaluate(() => !document.querySelector('#flow-held-banner')), (v) => v, 'the flow is editable again');
	await h.eventually(() => avatarOf(E.page, X), (a) => a.avatars.length === 1 && a.avatars[0] === H.id, "E now sees H's avatar");

	await h.finish(browser);
});
