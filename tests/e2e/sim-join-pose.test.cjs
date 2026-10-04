// 36-sim B2: a peer joining MID-ANIMATION must capture the true animation base — no
// constant pose offset (backlog "Animated-object base offset on join"). Plan 88 made the
// sender park animated objects for sendObjects; this proves it across every effect path a
// scene uses today, plus jiggle (36-sim), which must add none at all:
//   · a scene-graph Spin wired through an Object Selector
//   · an OBJECT-graph Bounce (H1 implicit owner, no selector)
//   · a Jiggle node (visual only: the transform is never written)
// Method: both peers PARK (the serializer ritual) and read the base pose of every object;
// bases must be identical, and the live poses must agree at the same synced moment.
const h = require('./helpers.cjs');

/** read {uuid: [pos, rot, scale]} at base (parked) and live @param {any} page @param {string[]} uuids */
const poses = (page, uuids) =>
	page.evaluate(
		(uuids) =>
			new Promise((resolve) =>
				requestAnimationFrame(() => {
					let g;
					window.__stores.objectsGroup.subscribe((v) => (g = v))();
					const read = () =>
						Object.fromEntries(
							uuids.map((u) => {
								const o = g.getObjectByProperty('uuid', u);
								return [u, o ? [...o.position.toArray(), o.rotation.x, o.rotation.y, o.rotation.z, ...o.scale.toArray()] : null];
							})
						);
					const live = read();
					const restore = window.__stores.flowRuntime.parkAnimatedAtBase();
					const base = read();
					restore();
					resolve({ live, base, t: Date.now() });
				})
			),
		uuids
	);

/** max abs component difference @param {number[] | null} a @param {number[] | null} b */
const diff = (a, b) => (a && b ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : Infinity);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const uuids = await A.page.evaluate(() => {
		const st = window.__stores;
		let g;
		st.objectsGroup.subscribe((v) => (g = v))();
		const last = () => g.children[g.children.length - 1];
		st.commandsHandler.sceneCommand('/create Box 1 1 1');
		const spinner = last();
		spinner.position.set(-3, 1, 0);
		st.commandsHandler.sceneCommand('/create Box 1 1 1');
		const bouncer = last();
		bouncer.position.set(0, 1, 0);
		st.commandsHandler.sceneCommand('/create Box 1 1.6 1');
		const jelly = last();
		jelly.position.set(3, 0.8, 0);
		for (const o of [spinner, bouncer, jelly]) delete o.userData.physics; // no sim here
		st.flowGraphs.update((graphs) => ({
			...graphs,
			scene: {
				nodes: [
					...(graphs.scene?.nodes ?? []),
					{ id: 'spin1', type: 'spin', position: { x: 0, y: 0 }, data: { speed: 2, axis: 'y' } },
					{ id: 'sel1', type: 'objectselector', position: { x: 200, y: 0 }, data: { selected: spinner.uuid } }
				],
				edges: [...(graphs.scene?.edges ?? []), { id: 'e-spin', source: 'spin1', target: 'sel1' }]
			},
			[bouncer.uuid]: { nodes: [{ id: 'b1', type: 'bounce', position: { x: 0, y: 0 }, data: { amplitude: 0.8, speed: 2 } }], edges: [] },
			[jelly.uuid]: { nodes: [{ id: 'j1', type: 'jiggle', position: { x: 0, y: 0 }, data: { wind: 8 } }], edges: [] }
		}));
		return [spinner.uuid, bouncer.uuid, jelly.uuid];
	});
	await A.page.waitForTimeout(1500);
	const a0 = await poses(A.page, uuids);
	await A.page.waitForTimeout(300);
	const a1 = await poses(A.page, uuids);
	h.check(diff(a0.live[uuids[0]], a1.live[uuids[0]]) > 1e-3, 'the spin animates on A');
	h.check(diff(a0.live[uuids[1]], a1.live[uuids[1]]) > 1e-3, 'the object-graph bounce animates on A');
	h.check(diff(a0.base[uuids[2]], a1.live[uuids[2]]) < 1e-9, 'jiggle never moves the transform on A');

	// B joins while everything is mid-swing
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A, 14000);
	// objects arrive one GLTF parse at a time: wait for all three before comparing
	await h.eventually(
		() =>
			B.page.evaluate((uuids) => {
				let g;
				window.__stores.objectsGroup.subscribe((v) => (g = v))();
				return uuids.filter((u) => g.getObjectByProperty('uuid', u)).length;
			}, uuids),
		(n) => n === 3,
		'all three objects reached B',
		30000
	);
	const [pa, pb] = await Promise.all([poses(A.page, uuids), poses(B.page, uuids)]);
	for (const [i, label] of ['scene-graph Spin', 'object-graph Bounce', 'Jiggle'].entries()) {
		const u = uuids[i];
		h.check(pb.base[u] !== null, `${label}: object synced to B`);
		const d = diff(pa.base[u], pb.base[u]);
		h.check(d < 1e-3, `${label}: B captured the TRUE base — no join offset (max |Δ| ${d.toExponential(2)})`);
	}
	// GRAPH DRIFT HEALS (the nodesync path, dead since 27-A: graphHash() is a number and the
	// validator wanted a string). B silently loses the Bounce node; within a nodesync round
	// (10 s) + a resync it is back, so a joiner whose graph diverged does not stay diverged.
	await B.page.evaluate((u) => window.__stores.flowGraphs.update((g) => ({ ...g, [u]: { nodes: [], edges: [] } })), uuids[1]);
	await h.eventually(
		() => B.page.evaluate((u) => (window.__stores.flowGraphs ? new Promise((r) => window.__stores.flowGraphs.subscribe((g) => r(g[u]?.nodes?.length ?? 0))()) : 0), uuids[1]),
		(n) => n === 1,
		'a drifted graph on B heals from A through nodesync',
		45000
	);
	const invalid = B.page.__console.filter((m) => /invalid:nodesync/.test(m.text)).length;
	h.check(invalid === 0, `no nodesync message is rejected by the wire validator (${invalid})`);
	await h.finish(browser);
});
