// 104 B1 + B3 (lane 104-world) — PROBE and FLOATING THINGS through the Claude connector (fake relay, the
// connector-physics pattern).
//
//   B1: the scout's island (terrain size 24, height 2.5, edges island) + an ocean whose top is 0.4. probe over the
//       island centre answers the terrain (~2.25 m), not the water; over open sea it answers the water surface and
//       no floor; a ray finds the island; a READ-scoped grant may probe (it changes nothing).
//   B3: a calm pool 3 m deep; three 1 m boxes made to float by mass (set_physics float "mass") at 150, 850 and
//       2000 kg: the first rides high (~15 % under), the second low (~85 %), the third sinks to the pool floor.
//       (150 and 850, not 200 and 700: a cube between ~21 % and ~79 % of water tips onto an edge, as a real one does;
//       the answer says so with upright: false, checked on a 700 kg one.)
//       set_physics's answer predicts each waterline (restingBottomY) and the boxes settle there.
//   Counterfactual (STATUS): on v1.73.0 probe is an unknown tool and set_physics ignores float / density.
const h = require('./helpers.cjs');
const { installProvider, fakeRelay, connectorPhase } = require('./connectorFake.cjs');
const path = require('path');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	await A.page.evaluate(() => window.__tp.test.v1.aiAssistantHidden.set(''));
	await A.page.evaluate(() => window.__tp.test.v1.physics.warmup().catch(() => {}));
	const relay = await fakeRelay(A.page);
	await installProvider(A.page);
	await A.page.locator('#connect-claude-button').click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected', 'connected', 30000);
	let seq = 0;
	const ex = async (tool, args = {}, scope = 'edit') => {
		const id = 'c' + ++seq;
		relay.call(id, tool, args, scope);
		const a = await relay.answer(id, 120000);
		return a ? (a.type === 'result' ? a.result : { error: a.error }) : { error: 'no answer' };
	};
	const hello = relay.frames.find((x) => x.f.type === 'hello')?.f;
	h.check(hello?.tools?.includes('probe'), `the connector offers probe (${hello?.tools?.length} tools)`);

	// ---- B1: the island ------------------------------------------------------------------------------------
	const terr = await ex('terrain', { size: 24, height: 2.5, edges: 'island', name: 'Island' });
	const island = terr?.created?.[0]?.uuid;
	const ocean = (await ex('water', { kind: 'ocean', size: [80, 2, 80], position: [0, -1.6, 0], name: 'Ocean' }))?.created?.[0]?.uuid;
	h.check(!!island && !!ocean, 'the scout\'s island and ocean');
	const centre = await ex('probe', { at: [0, 0] }, 'read');
	h.check(centre?.uuid === island && centre?.surface === 'terrain' && centre.y > 2 && centre.y < 2.6 && !centre.water, `probe over the island centre: the terrain at ~2.25 m, no water (${JSON.stringify(centre).slice(0, 200)})`);
	const sea = await ex('probe', { at: [30, 30] }, 'read');
	h.check(sea?.water?.uuid === ocean && Math.abs(sea.water.surface - 0.4) < 0.01 && sea.y === null, `probe over open sea: water surface 0.4, no floor (${JSON.stringify(sea).slice(0, 240)})`);
	const many = await ex('probe', { points: [[0, 0], [11, 0], [30, 30]] }, 'read');
	h.check(many?.points?.length === 3 && many.points[0].surface === 'terrain', `probe points keep their order (${JSON.stringify(many?.points?.map((p) => [p.surface, p.y]))})`);
	const ray = await ex('probe', { ray: { from: [0, 10, -30], dir: [0, -0.3, 1] } }, 'read');
	h.check(ray?.hit?.uuid === island && ray.hit.distance > 0, `a ray from the sea toward the island hits the island (${JSON.stringify(ray).slice(0, 200)})`);
	const all = await ex('probe', { at: [30, 30], include: 'all' }, 'read');
	h.check(all?.hits?.some((x) => x.surface === 'water' && x.uuid === ocean), `include all lists the ocean surface (${JSON.stringify(all?.hits).slice(0, 200)})`);
	await ex('delete_objects', { uuids: [island, ocean] });

	// ---- B3: three boxes in a pool -------------------------------------------------------------------------
	const pool = (await ex('water', { kind: 'pool', size: [8, 3, 8], position: [0, 0, 0], name: 'Pool', waves: { height: 0 } }))?.created?.[0]?.uuid;
	h.check(!!pool, 'a calm pool, 3 m deep');
	const p0 = await ex('probe', { at: [0, 0] }, 'read');
	h.check(p0?.water?.uuid === pool && p0.water.depth > 2.5 && p0.water.depth < 3.1, `probe in the pool: its surface and ~3 m depth (${JSON.stringify(p0).slice(0, 240)})`);
	const mk = await ex('create_objects', {
		objects: [-2.5, 0, 2.5].map((x, i) => ({ kind: 'primitive', primitive: 'Box', name: ['Light', 'Heavy', 'Lead'][i], position: [x, 4.5, 0], scale: [0.5, 0.5, 0.5] }))
	});
	const ids = mk?.created?.map((c) => c.uuid) ?? [];
	h.check(ids.length === 3, 'three 1 m boxes over the pool (the default 2 m box at half scale)');
	const sp = await ex('set_physics', { updates: ids.map((uuid, i) => ({ uuid, mass: [150, 850, 2000][i], float: 'mass' })) });
	const w = sp?.updated?.map((u) => u.water) ?? [];
	h.check(w[0]?.under === 0.15 && w[1]?.under === 0.85 && w[2]?.sinks === true && w[0]?.upright === undefined && w[1]?.upright === undefined, `set_physics answers the waterline per box (${JSON.stringify(w).slice(0, 400)})`);
	h.check(w.every((x) => x?.in === 'Pool') && Number.isFinite(w[0]?.restingBottomY), 'and names the water under each with where its bottom rests');
	const go = await ex('control_simulation', { action: 'start' });
	h.check(go?.simulating === true, 'the simulation runs in the tab');
	const read = () =>
		A.page.evaluate((ids) => {
			const s = window.__tp.test.v1;
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			return ids.map((id) => {
				const o = g.getObjectByProperty('uuid', id);
				// the CENTRE, not the bounding box: a box rocking a few degrees drops its AABB corner ~0.1 m while
				// its centre stays put (the centre of a 1 m box sits 0.5 m above its upright bottom)
				return { bottom: o.getWorldPosition(new s.THREE.Vector3()).y - 0.5 };
			});
		}, ids);
	// settle, then average a second of samples
	await A.page.waitForTimeout(9000);
	const acc = [0, 0, 0];
	const N = 10;
	for (let k = 0; k < N; k++) {
		const r = await read();
		r.forEach((b, i) => (acc[i] += b.bottom / N));
		await A.page.waitForTimeout(100);
	}
	const surface = p0?.water?.surface ?? 3;
	const under = acc.map((bottom) => Math.min(1, Math.max(0, surface - bottom)));
	console.log('MEASURE ' + JSON.stringify({ suite: 'agent-probe-float', surface, bottoms: acc.map((v) => +v.toFixed(3)), under: under.map((v) => +v.toFixed(3)), predicted: w.map((x) => x?.restingBottomY ?? null) }));
	h.check(under[0] > 0.07 && under[0] < 0.27, `the 150 kg box rides high: ${(under[0] * 100).toFixed(0)} % under (predicted 15 %)`);
	h.check(under[1] > 0.75 && under[1] < 0.95, `the 850 kg box sits low: ${(under[1] * 100).toFixed(0)} % under (predicted 85 %)`);
	h.check(acc[2] < 0.3, `the 2000 kg box sank to the pool floor (bottom at ${acc[2].toFixed(2)} m)`);
	h.check(Math.abs(acc[0] - w[0].restingBottomY) < 0.12 && Math.abs(acc[1] - w[1].restingBottomY) < 0.12, `the boxes settle where set_physics said (${acc[0].toFixed(2)} vs ${w[0].restingBottomY}, ${acc[1].toFixed(2)} vs ${w[1].restingBottomY})`);
	await ex('control_simulation', { action: 'stop' });
	const tip = await ex('set_physics', { updates: [{ uuid: ids[0], mass: 700, float: 'mass' }] });
	const tw = tip?.updated?.[0]?.water;
	h.check(tw?.upright === false && /tips onto an edge/.test(tw?.note ?? ''), `a 700 kg cube: the answer says it tips over (${JSON.stringify(tw).slice(0, 240)})`);
	await ex('set_physics', { updates: [{ uuid: ids[0], mass: 150, float: 'mass' }] });

	// the Inspector shows the same numbers (the Floats hint)
	await A.page.evaluate((id) => {
		localStorage.setItem('inspector:sec:Physics', 'open');
		window.__tp.test.v1.objectActions.selectObject(id, true);
		window.__tp.test.v1.showSidebar('selection');
	}, ids[1]);
	const hintNow = () => A.page.evaluate(() => document.querySelector('#physics-floats-hint')?.textContent?.trim() ?? '');
	await h.eventually(hintNow, (t) => /85% under: 0\.85 m of its 1 m/.test(t), 'the Inspector hint', 15000);
	const hint = await hintNow();
	h.check(/85% under: 0\.85 m of its 1 m/.test(hint), `the Inspector shows the same waterline (${hint})`);
	const dragRow = await A.page.evaluate(() => !!document.querySelector('#physics-floats-drag'));
	h.check(dragRow, 'the Inspector has the Water drag row');
	await A.page.evaluate(() => document.querySelector('#physics-floats')?.scrollIntoView({ block: 'center' }));
	await A.page.screenshot({ path: path.join(h.outDir?.('104-world') ?? path.resolve(__dirname, '../../test-results/104-world'), '01-floats-inspector.png') }).catch(() => {});

	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).slice(0, 2).join(' | ')})`);
	await h.finish(browser);
});
