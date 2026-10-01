// 33 E4 ACCEPTANCE — "For some reason not all objects positions can be moved in edit mode when
// in game". The SEVEN Games-tab games, loaded from their REAL .tpscene files with their REAL
// module zips. Every top-level object and its direct children are moved with the gizmo path
// (TControls' own dragging-changed events, a frame between press and release) and must STAY
// where they were put 1.5 s later:
//   §A on a fresh load (nothing running) — this was already true, kept as the baseline
//   §B with the GAME RUNNING (Interact, state playing, the sim on when the scene asks for it)
//      and then Edit — what the user did. MEASURED before the fix: Towers 10/44 pieces flung
//      ~47 m, Stars Room 26/49 drifting off, the football rolling away — a game's sim keeps
//      running in Edit and the gizmo release handed every dynamic body back to it with a
//      throw velocity. physics.js now PARKS a body released in Edit (hold 'edit') until the
//      editor leaves Edit.
//   §C leaving Edit releases every parked body, and a release in Interact still throws
//      (the counterfactual: the park is an Edit rule, not "releases never move")
// Waves' enemies WALKING during a wave are positioned by the module as a pure function of
// time (determinism is its netcode) — module-owned while a wave runs, listed as a NOTE (filed
// for the modules lane), never counted as a pass.
//
// Scenes: SHELL_SCENES_DIR=<dir with <slug>/scene.tpscene>, else the sibling scenes checkout's
// games/<slug>/scene.tpscene. A game whose scene or zip is missing is SKIPPED (named).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_REPO = [path.resolve(__dirname, '../../../theprototype.app-scenes'), path.resolve(__dirname, '../../../scenes')].find((p) => fs.existsSync(p));
const sceneOf = (slug) => {
	const dir = process.env.SHELL_SCENES_DIR;
	const p = dir ? path.join(dir, slug, 'scene.tpscene') : SCENES_REPO && path.join(SCENES_REPO, 'games', slug, 'scene.tpscene');
	return p && fs.existsSync(p) ? p : null;
};
const GAMES = [
	{ slug: 'towers', modules: [] },
	{ slug: 'stars-room', modules: [] },
	{ slug: 'football', modules: ['football'] },
	{ slug: 'jam-room', modules: ['music-lab', 'music-fx'] },
	{ slug: 'dungeon-realms', modules: ['dungeon', 'dungeon-realms'] },
	{ slug: 'untangle', modules: ['untangle'] },
	{ slug: 'waves', modules: ['health', 'waves'] }
].filter((g) => !process.env.ONLY || process.env.ONLY.split(',').includes(g.slug));
/** objects a module positions itself while its game runs (see the header) */
const MODULE_OWNED_RUNNING = { waves: /^Enemy / };

/** drag every top-level object (and its direct children) +0.5 x / +0.25 z through the gizmo
 * events, wait, report what stayed. Runs in the page. */
const moveAll = (page) =>
	page.evaluate(async () => {
		const s = window.__stores;
		const g = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const group = g(s.objectsGroup);
		const targets = [];
		for (const o of group.children) {
			targets.push(o);
			for (const c of o.children) if (c.isMesh || c.isGroup) targets.push(c);
		}
		// an object a flow/module effect animates (Waves' Goal core bobs and spins) is judged by
		// its BASE pose — the gizmo edits the base, the effect then plays about it
		const fr = s.flowRuntime;
		const poseOf = (o) => {
			if (!fr.isAnimatedTarget(o.uuid)) return o.position.clone();
			fr.suspendAnimation(o.uuid);
			const p = o.position.clone();
			fr.resumeAnimation(o.uuid);
			return p;
		};
		const rows = [];
		for (const o of targets.slice(0, 60)) {
			s.objectActions.selectObject(o.uuid);
			const tc = g(s.TControls);
			const attached = tc?.object === o;
			const before = poseOf(o);
			if (attached) {
				tc.dispatchEvent({ type: 'dragging-changed', value: true });
				o.position.x += 0.5;
				o.position.z += 0.25;
				o.updateMatrixWorld(true);
				tc.dispatchEvent({ type: 'objectChange' });
				await new Promise((r) => requestAnimationFrame(() => r()));
				tc.dispatchEvent({ type: 'dragging-changed', value: false });
			}
			rows.push({ o, attached, before, phys: o.userData?.physics?.mode ?? null });
		}
		s.objectActions.applySelectionSet([]);
		await new Promise((r) => setTimeout(r, 1500));
		return rows.map((r) => {
			const now = poseOf(r.o);
			return {
				uuid: r.o.uuid,
				name: r.o.name || r.o.type,
				attached: r.attached,
				phys: r.phys,
				animated: fr.isAnimatedTarget(r.o.uuid),
				dx: Math.round((now.x - r.before.x) * 100) / 100,
				dy: Math.round((now.y - r.before.y) * 100) / 100,
				dz: Math.round((now.z - r.before.z) * 100) / 100
			};
		});
	});
const stayed = (r) => r.attached && Math.abs(r.dx - 0.5) <= 0.02 && Math.abs(r.dz - 0.25) <= 0.02 && Math.abs(r.dy) <= 0.02;

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	const installed = new Set();
	for (const id of [...new Set(GAMES.flatMap((g) => g.modules))]) if (await h.installModule(A, id)) installed.add(id);
	await page.evaluate(() => window.__stores.modulesOpen.set(false));
	const read = (p) =>
		page.evaluate((p) => {
			let o = window.__stores;
			for (const k of p.split('.')) o = o[k];
			let v;
			o.subscribe((x) => (v = x))();
			return v;
		}, p);
	const load = async (file) => {
		const bytes = Array.from(fs.readFileSync(file));
		await page.evaluate(async (arr) => {
			const s = window.__stores;
			s.templatesModalOpen.set(false);
			s.objectActions.setEditorMode('edit');
			const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
			await s.sessions.applySession(payload, { backup: false });
		}, bytes);
		await page.waitForTimeout(3500);
	};

	let parkedSeen = 0;
	for (const game of GAMES) {
		const file = sceneOf(game.slug);
		const missing = game.modules.filter((m) => !installed.has(m));
		if (!file || missing.length) {
			console.log('SKIP ' + game.slug + ': ' + (file ? 'no ' + missing.join(', ') + '.zip' : 'no scene.tpscene'));
			continue;
		}
		console.log('\n=== ' + game.slug + ' ===');

		// ---- §A fresh load, Edit
		await load(file);
		let rows = await moveAll(page);
		let bad = rows.filter((r) => !stayed(r));
		h.check(rows.length > 0 && bad.length === 0, `${game.slug} A: fresh load, all ${rows.length} objects move and stay (${bad.map((r) => `${r.name} dx${r.dx} dy${r.dy}`).slice(0, 6).join(', ') || 'none'} failed)`);

		// ---- §B the game RUNNING, then Edit
		await load(file);
		const run = await page.evaluate(async () => {
			const s = window.__stores;
			const g = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
			s.objectActions.setEditorMode('interact');
			s.gameState.setGameState('playing');
			if (g(s.scenePhysics.scenePlay)?.simOnPlay && !g(s.physics.simulating)) await s.physics.toggleSimulation();
			return { sim: g(s.physics.simulating) };
		});
		await page.waitForTimeout(3000);
		await page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
		await page.waitForTimeout(300);
		h.check((await read('editorMode')) === 'edit' && (await read('gameState.gameState'))?.state === 'playing', `premise ${game.slug} B: Edit while the game plays (sim ${run.sim})`);
		rows = await moveAll(page);
		const owned = MODULE_OWNED_RUNNING[game.slug];
		const moduleOwned = rows.filter((r) => owned && owned.test(r.name) && !stayed(r));
		const judged = rows.filter((r) => !moduleOwned.includes(r));
		bad = judged.filter((r) => !stayed(r));
		h.check(
			judged.length > 0 && bad.length === 0,
			`${game.slug} B: game running -> Edit, all ${judged.length} objects move and stay (${bad.map((r) => `${r.name} dx${r.dx} dy${r.dy}`).slice(0, 6).join(', ') || 'none'} failed)`
		);
		if (moduleOwned.length) console.log(`NOTE ${game.slug}: ${moduleOwned.length} walking enemies are module-positioned during a wave (modules lane) — ${moduleOwned.map((r) => r.name).slice(0, 4).join(', ')}`);
		const dynamicMoved = judged.filter((r) => r.phys === 'dynamic');
		if (run.sim && dynamicMoved.length) {
			const parked = await page.evaluate(() => window.__stores.physics.parkedBodies());
			parkedSeen += parked.length;
			h.check(dynamicMoved.every((r) => parked.includes(r.uuid)), `${game.slug} B: every moved dynamic body is PARKED in Edit (${parked.length}/${dynamicMoved.length})`);

			// ---- §C leaving Edit hands them back to physics; Interact still throws
			const back = await page.evaluate(async (uuid) => {
				const s = window.__stores;
				s.objectActions.setEditorMode('interact');
				await new Promise((r) => setTimeout(r, 50));
				const afterLeave = s.physics.parkedBodies().length;
				// the counterfactual: a hold released in INTERACT is not parked
				const held = s.physics.holdBody(uuid);
				const released = s.physics.releaseBody(uuid, { linvel: [0, 0, 0], angvel: [0, 0, 0] });
				const parkedInInteract = s.physics.parkedBodies().includes(uuid);
				s.objectActions.setEditorMode('edit');
				return { afterLeave, held, released, parkedInInteract };
			}, dynamicMoved[0].uuid);
			h.check(back.afterLeave === 0, `${game.slug} C: leaving Edit releases every parked body (${back.afterLeave} left)`);
			h.check(back.held && back.released && !back.parkedInInteract, `${game.slug} C: a release in Interact is NOT parked (the rule is Edit's)`);
		}
		await page.evaluate(() => {
			const s = window.__stores;
			let sim;
			s.physics.simulating.subscribe((v) => (sim = v))();
			if (sim) s.physics.stopSimulation({ reset: true });
			s.gameState.resetGame?.();
		});
		await page.waitForTimeout(400);
	}
	if (GAMES.length > 1) h.check(parkedSeen > 0, `the park was exercised (${parkedSeen} bodies parked across the games)`);
	await h.finish(browser);
});
