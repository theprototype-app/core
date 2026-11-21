// 80a K3 probe (not in the battery): three crossed races between E and F with H watching, every
// lock-related message each page sends and receives logged, so a race that ends with no holder
// says who let go and why.
const h = require('./helpers.cjs');

// everything but the streams and presence chatter
const SKIP = ['position', 'cursor', 'camera', 'pose', 'ping', 'pong', 'clock', 'clockreply', 'peerpos', 'avatar', 'presence', 'atscene', 'playmode', 'stats'];
const trace = (p) =>
	p.page.evaluate((skip) => {
		/** @type {any} */ let pc;
		window.__tp.test.v1.peers.subscribe((v) => (pc = v))();
		const w = /** @type {any} */ (window);
		w.__trace = w.__trace || [];
		const t0 = performance.now();
		const brief = (d) => ({ t: d.type, u: String(d.uuid ?? d.key ?? d.graphId ?? '').slice(0, 5), us: (d.uuids ?? []).map((x) => String(x).slice(0, 5)), ats: d.ats, items: Array.isArray(d.items) ? d.items.map((x) => x?.type + ':' + String(x?.uuid ?? x?.graphId ?? '').slice(0, 5)) : undefined });
		for (const [id, c] of Object.entries(pc.connections)) {
			if (!c || c.__traced) continue;
			c.__traced = true;
			c.on('data', (d) => d && !skip.includes(d.type) && w.__trace.push(['in', id.slice(0, 5), Math.round(performance.now() - t0), brief(d)]));
			const send = c.send.bind(c);
			c.send = (d, ...rest) => {
				if (d && !skip.includes(d.type)) w.__trace.push(['out', id.slice(0, 5), Math.round(performance.now() - t0), brief(d)]);
				return send(d, ...rest);
			};
		}
	}, SKIP);

h.run(async () => {
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H');
	const E = await h.setupPageQuiet(browser, 'E', [H]);
	await h.connect(E, H);
	const F = await h.setupPageQuiet(browser, 'F', [H, E]);
	await h.connect(F, H);
	const made = await H.page.evaluate(async () => {
		const s = window.__tp.test.v1;
		for (let i = 0; i < 3; i++) s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		s.objectActions.deselectObject();
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		return g.children.slice(-3).map((o) => o.uuid);
	});
	const has = (p, u) => p.page.evaluate((uu) => new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe((g) => r(!!g?.getObjectByProperty('uuid', uu)))()), u);
	await h.eventually(() => has(F, made[2]), (v) => v, 'F has the boxes', 90000);
	await h.eventually(() => F.page.evaluate((id) => { let p; window.__tp.test.v1.peers.subscribe((v) => (p = v))(); return !!p.connections[id]?.open; }, E.id), (v) => v, 'F-E link');
	await E.page.waitForTimeout(2000);
	console.log('ids H', H.id.slice(0, 5), 'E', E.id.slice(0, 5), 'F', F.id.slice(0, 5));
	for (const p of [H, E, F]) await trace(p);
	const clocks = await Promise.all([H, E, F].map((p) => p.page.evaluate(() => { const s = window.__tp.test.v1; return { now: Date.now(), session: s.sessionClock?.sessionNow?.() ?? null }; })));
	console.log('clocks', JSON.stringify(clocks.map((c) => c.session === null ? null : c.session - c.now)));

	for (let i = 0; i < 2; i++) {
		const u = made[i];
		const at = Date.now() + 400;
		const fire = (p) =>
			p.page.evaluate(
				([uu, t]) =>
					new Promise((r) =>
						setTimeout(() => {
							const s = window.__tp.test.v1;
							s.objectActions.selectObject(uu);
							r(s.lockHeld.myClaim(uu)?.at ?? false);
						}, Math.max(0, t - Date.now()))
					),
				[u, at]
			);
		const [e, f] = await Promise.all([fire(E), fire(F)]);
		console.log(`[race ${i}] u ${u.slice(0, 5)} claim E ${e} F ${f} (F-E ${e && f ? f - e : '-'} ms)`);
		await E.page.waitForTimeout(3000);
		for (const [n, p] of [['H', H], ['E', E], ['F', F]]) {
			const st = await p.page.evaluate((uu) => {
				const s = window.__tp.test.v1;
				let l, m, sel, notes;
				s.lockedObjects.subscribe((x) => (l = x))();
				s.lockHeld.myLocks.subscribe((x) => (m = x))();
				s.selectedObjects.subscribe((x) => (sel = x))();
				s.notifications?.subscribe((x) => (notes = x))();
				const tr = (window.__trace || []).splice(0);
				return {
					rows: l.filter((r) => r[1] === uu).map((r) => [String(r[0]).slice(0, 5), r[2]]),
					mine: m.has(uu) ? m.get(uu) : null,
					sel: sel.includes(uu),
					holder: s.lockHeld.holderNow(uu)?.slice?.(0, 5) ?? null,
					notes: (notes ?? []).slice(-4).map((x) => x?.text ?? x?.message ?? JSON.stringify(x).slice(0, 120)),
					trace: tr
				};
			}, u);
			console.log(`[race ${i}] ${n}`, JSON.stringify(st));
		}
		h.check(true, 'race ' + i + ' traced');
		await E.page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());
		await F.page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());
		await E.page.waitForTimeout(1500);
		for (const p of [H, E, F]) await p.page.evaluate(() => (window.__trace || []).splice(0));
	}
	await h.finish(browser);
});
