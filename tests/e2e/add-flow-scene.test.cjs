// fix-batch-2 (1.45.1, C2): "Add flow to Scene graph" on an object with NO flow used to stop
// at a toast ("select it in the Flow editor and click Create flow"). It now creates the flow
// (seeded Flow Input + Flow Output, so the embed has sockets) and embeds it — one undo step,
// replicated — and the row is disabled with "Locked by X" while a peer holds the object.
// Counterfactual: §1 is red on 1.45.0 (no graph is created; the toast is the old dead end).
const h = require('./helpers.cjs');

const graphs = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.flowGraphs.subscribe((g) => r(JSON.parse(JSON.stringify(g))))()));
const summary = async (page, uuid) => {
	const g = await graphs(page);
	return {
		has: !!g[uuid],
		own: (g[uuid]?.nodes ?? []).map((n) => n.type).sort().join(','),
		embeds: (g.scene?.nodes ?? []).filter((n) => n.type === 'objectflow' && n.data?.flowUuid === uuid).length
	};
};
const menuRow = (page, uuid, locked) =>
	page.evaluate(
		({ uuid, locked }) => {
			const items = window.__stores.objectMenu.flattenMenuItems(
				window.__stores.objectMenu.buildObjectMenuItems(uuid, locked ? { locked: true } : {})
			);
			const row = items.find((i) => i.label === 'Add flow to Scene graph');
			return row ? { disabled: !!row.disabled, tooltip: row.tooltip || '' } : null;
		},
		{ uuid, locked }
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const bId = await B.page.evaluate(() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.peer?.id))()));
	await A.page.evaluate((id) => (window.__bId = id), bId);

	const uuid = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		return g.children[g.children.length - 1].uuid;
	});
	await h.eventually(
		() => B.page.evaluate((u) => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(!!g.getObjectByProperty('uuid', u)))()), uuid),
		(v) => v === true,
		'the box reached B'
	);
	h.check(!(await summary(A.page, uuid)).has, '§0 the box starts with no flow');

	// §1 the menu row creates + seeds + embeds
	const row = await menuRow(A.page, uuid, false);
	h.check(row && !row.disabled, '§1 the row is enabled on an unlocked object');
	await A.page.evaluate(async (uuid) => {
		const items = window.__stores.objectMenu.flattenMenuItems(window.__stores.objectMenu.buildObjectMenuItems(uuid));
		await items.find((i) => i.label === 'Add flow to Scene graph').action();
	}, uuid);
	await h.eventually(() => summary(A.page, uuid), (s) => s.has && s.embeds === 1, '§1 the flow is created and embedded on A');
	const a1 = await summary(A.page, uuid);
	h.check(a1.own === 'flowinput,flowoutput', `§1 the new flow is seeded with Flow Input + Flow Output (${a1.own})`);
	const toast = await A.page.evaluate(
		() => new Promise((r) => window.__stores.toastStore.subscribe((list) => r(list.map((t) => (typeof t === 'string' ? t : t.text + ' [' + (t.actions ?? []).map((a) => a.label).join('|') + ']'))))())
	);
	h.check(toast.some((t) => /Flow created and added/.test(t) && /Open flow/.test(t)), `§1 toast "Flow created and added … Open flow" (${toast.slice(-1)})`);
	await h.eventually(() => summary(B.page, uuid), (s) => s.has && s.embeds === 1 && s.own === 'flowinput,flowoutput', '§1 B receives the flow, its seed and the embed');

	// §2 the embed has the seeded sockets
	const sockets = await A.page.evaluate(
		(uuid) => {
			const iface = window.__stores.objectFlow.interfaceOf(uuid);
			return { ins: (iface?.inputs ?? []).length, outs: (iface?.outputs ?? []).length };
		},
		uuid
	);
	h.check(sockets.ins === 1 && sockets.outs === 1, `§2 the embed shows one input and one output (${JSON.stringify(sockets)})`);

	// §3 ONE undo takes all of it back, on both peers; redo restores it
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => summary(A.page, uuid), (s) => !s.has && s.embeds === 0, '§3 one undo removes the flow and the embed on A');
	await h.eventually(() => summary(B.page, uuid), (s) => !s.has && s.embeds === 0, '§3 ... and on B');
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => summary(A.page, uuid), (s) => s.has && s.embeds === 1 && s.own === 'flowinput,flowoutput', '§3 redo restores flow + seed + embed');

	// §4 a second press says it is already there (no second embed)
	await A.page.evaluate(async (uuid) => {
		const items = window.__stores.objectMenu.flattenMenuItems(window.__stores.objectMenu.buildObjectMenuItems(uuid));
		await items.find((i) => i.label === 'Add flow to Scene graph').action();
	}, uuid);
	await A.page.waitForTimeout(300);
	h.check((await summary(A.page, uuid)).embeds === 1, '§4 a second press embeds nothing more');

	// §5 a peer holds the object -> the row is disabled with the holder's name (a lock row
	// injected the way deselect-unlock / convert-to-mesh do: selection alone takes no lock)
	await A.page.evaluate((u) => window.__stores.lockedObjects.update((l) => [...l, [window.__bId, u]]), uuid);
	const lockedRow = await menuRow(A.page, uuid, false);
	h.check(lockedRow?.disabled === true && /^Locked by /.test(lockedRow.tooltip), `§5 the row is disabled: "${lockedRow?.tooltip}"`);

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, 'no page errors');
	await h.finish(browser);
});
