// 24-A A4 ACCEPTANCE — the Stars Room game (a zero-g room of stars you knock around;
// pure core, no module). Loaded from the REAL .tpscene: the sibling scenes checkout's
// games/stars-room/scene.tpscene, or STARS_ROOM_TPSCENE=<path> (a lane builds it into a
// scratch folder with `--only stars-room --out`). Skip-never-fail when neither exists —
// authored content, not core code, must keep a bare checkout green.
//
// What it proves: the physics block restored from the file (zero-g, ground off, the knock
// block ON, the damping), 27 dynamic bodies, the chime's bytes riding the file, free play
// (the sim runs on Play with no round), a probe pass on Star 1 leaving it at hand speed
// and damping bleeding it, the walls keeping a 10 m/s star inside, More stars spawning
// three and the room never holding more than 27 + maxAlive dynamic bodies (the spawner
// RECYCLES at the cap — it does not refuse), one touch banked in MY row, and the optional
// round: Start -> playing, every star swept -> "Lit: 24 / 24" -> over; P toggles the menu.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_REPO = [
	path.resolve(__dirname, '../../../theprototype.app-scenes'),
	path.resolve(__dirname, '../../../scenes')
].find((p) => fs.existsSync(p));
const TPSCENE =
	process.env.STARS_ROOM_TPSCENE ||
	(SCENES_REPO && path.join(SCENES_REPO, 'games/stars-room/scene.tpscene'));

h.run(async () => {
	if (!TPSCENE || !fs.existsSync(TPSCENE)) {
		console.log('SKIP: no games/stars-room/scene.tpscene in a sibling scenes checkout and no STARS_ROOM_TPSCENE');
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;

	const bytes = Array.from(fs.readFileSync(TPSCENE));
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, bytes);
	await page.waitForTimeout(2500);

	const snap = () =>
		page.evaluate(() => {
			const s = window.__stores;
			/** @param {any} st */
			const g = (st) => { let v; st.subscribe((/** @type {any} */ x) => (v = x))(); return v; };
			let group;
			s.objectsGroup.subscribe((/** @type {any} */ v) => (group = v))();
			const kids = group.children.map((/** @type {any} */ c) => ({
				name: c.name, uuid: c.uuid,
				dynamic: c.userData?.physics?.mode === 'dynamic',
				pos: c.position.toArray().map((/** @type {number} */ n) => +n.toFixed(2))
			}));
			const phys = g(s.scenePhysics.scenePhysicsDefaults);
			return {
				kids,
				sim: !!g(s.physics.simulating),
				state: g(s.gameState.gameState)?.state ?? null,
				play: g(s.scenePhysics.scenePlay),
				knock: g(s.scenePhysics.sceneKnock),
				gravity: g(s.scenePhysics.sceneGravity),
				ground: g(s.scenePhysics.scenePhysicsGround),
				damping: phys?.damping,
				screen: s.hudDocs.visibleScreen('scene')?.id ?? null
			};
		});
	const hud = async () => (await page.locator('#hud-layer').textContent()) ?? '';
	// EXACT text: `hasText` is a case-insensitive SUBSTRING, and "Restart round" contains
	// "start round" — a bare 'Start round' matched two buttons and died on strict mode.
	const clickBtn = (text) => page.getByRole('button', { name: text, exact: true }).click();
	const pressP = () =>
		page.evaluate(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', bubbles: true }));
			window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyP', bubbles: true }));
		});
	const bodyOf = (uuid) =>
		page.evaluate((uuid) => window.__stores.physics.physicsDebug().find((b) => b.uuid === uuid) ?? null, uuid);
	const speedOf = (b) => (b?.linvel ? Math.hypot(b.linvel.x, b.linvel.y, b.linvel.z) : 0);
	/** sweep a fresh probe along +x through a star's CURRENT centre at `speed` m/s; returns
	 * hits + the star's velocity read in the same evaluate (before rapier steps) */
	const knockStar = (name, speed, probe = 'p') =>
		page.evaluate(
			({ name, speed, probe }) => {
				const s = window.__stores;
				let group; s.objectsGroup.subscribe((/** @type {any} */ v) => (group = v))();
				const star = group.getObjectByName(name);
				if (!star) return { hits: 0, atHit: null, missing: true };
				const [cx, cy, cz] = star.position.toArray();
				s.knock.dropProbe(probe);
				const dt = 16;
				const step = (speed * dt) / 1000;
				let t = 1000 + Math.floor(Math.random() * 1e6);
				let hits = 0;
				let atHit = null;
				for (let x = cx - 1.2; x <= cx + 1e-9; x += step) {
					const r = s.knock.feedProbe(probe, [x, cy, cz], t);
					if (r.hits > 0 && !atHit) {
						const b = s.physics.physicsDebug().find((entry) => entry.uuid === star.uuid);
						atHit = b?.linvel ? [b.linvel.x, b.linvel.y, b.linvel.z] : null;
					}
					hits += r.hits;
					t += dt;
				}
				return { hits, atHit, uuid: star.uuid };
			},
			{ name, speed, probe }
		);
	const mag = (v) => (Array.isArray(v) ? Math.hypot(v[0], v[1], v[2]) : NaN);

	// 1 — the world arrived whole, with its physics block
	let st = await snap();
	const dyn = st.kids.filter((k) => k.dynamic);
	h.check(st.kids.length === 36, `36 objects arrived (${st.kids.length})`);
	h.check(dyn.length === 27, `27 dynamic bodies: 24 stars + 2 planets + the template (${dyn.length})`);
	h.check(st.kids.filter((k) => /^Star \d+$/.test(k.name)).length === 24, 'the 24 stars are named Star 1..24');
	h.check(st.gravity === 0 && st.ground?.enabled === false, `zero-g with the ground off (${st.gravity}, ground ${st.ground?.enabled})`);
	h.check(st.knock?.enabled === true && Math.abs(st.knock.maxSpeed - 10) < 1e-9 && Math.abs(st.knock.spin - 0.6) < 1e-9, `the knock block restored ON from the file (${JSON.stringify(st.knock)})`);
	h.check(Math.abs((st.damping?.linear ?? 0) - 0.35) < 1e-9, `damping 0.35 (${st.damping?.linear})`);
	h.check(st.play?.simOnPlay === true && st.play?.interaction === 'grab' && st.play?.grounded === false, 'play block: grab, flying, simOnPlay');
	h.check(st.state === 'menu' && st.screen === 'free', `starts in free play (${st.state}/${st.screen})`);
	const chime = await page.evaluate(() => {
		const s = window.__stores;
		const snd = s.allNodes().find((n) => n.type === 'sound');
		const hash = snd?.data?.hash ?? null;
		return { hash, held: hash ? !!s.explorer.itemByHash(hash) : false, nodes: s.allNodes().length };
	});
	h.check(!!chime.hash && /^[0-9a-f]{16,}$/.test(chime.hash) && chime.held, `the chime's hash was remapped and its bytes rode the file into the Explorer (${chime.hash?.slice(0, 8)}, held ${chime.held})`);
	h.check(chime.nodes > 200, `the graph is there (${chime.nodes} nodes)`);

	// 2 — entering play starts the sim (free play, no round)
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => snap().then((v) => v.sim), (v) => v === true, 'entering play starts the sim', 10000);
	await page.waitForTimeout(600);
	st = await snap();
	h.check(st.state === 'menu' && st.screen === 'free', 'free play: the sim runs while the game shell stays in menu');
	h.check(/STARS ROOM/.test(await hud()) && /free play/.test(await hud()), 'the free-play banner renders');

	// 3 — a hand knocks Star 1: it leaves at hand speed, and damping bleeds it
	const k1 = await knockStar('Star 1', 4);
	h.check(k1.hits === 1, `a 4 m/s pass knocks Star 1 once (${k1.hits})`);
	h.check(!!k1.atHit && Math.abs(mag(k1.atHit) - 4) < 0.4, `...and it leaves at ~4 m/s (${mag(k1.atHit).toFixed(2)})`);
	await page.waitForTimeout(500);
	const v05 = speedOf(await bodyOf(k1.uuid));
	await page.waitForTimeout(2500);
	const v3 = speedOf(await bodyOf(k1.uuid));
	h.check(v05 > 1 && v3 < 0.5 * v05, `damping: ${v05.toFixed(2)} m/s at +0.5 s -> ${v3.toFixed(2)} at +3 s (less than half)`);
	await h.eventually(async () => await hud(), (t) => /Your touches: 1/.test(t), 'my touch row reads 1 (who: me, banked once)', 6000);

	// 4 — the walls keep a fast star inside
	const star2 = st.kids.find((k) => k.name === 'Star 2');
	await page.evaluate((uuid) =>
		window.__stores.physics.applyThrow({ uuid, pos: [-5, 2, 0], rot: [0, 0, 0], linvel: [-10, 0, 0], angvel: [0, 0, 0] }), star2.uuid);
	await page.waitForTimeout(2000);
	const s2 = (await snap()).kids.find((k) => k.uuid === star2.uuid);
	h.check(!!s2 && Math.abs(s2.pos[0]) < 6 && Math.abs(s2.pos[2]) < 6 && s2.pos[1] > -0.5 && s2.pos[1] < 7.5, `a 10 m/s star at the west wall is inside the room 2 s later (${s2?.pos})`);

	// 5 — More stars (the P menu): +3 copies of the template, and the cap holds
	await pressP();
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'pause', 'P opens the menu', 6000);
	h.check(/More stars/.test(await hud()) && /Start round/.test(await hud()), 'the menu offers More stars and Start round');
	const before = (await snap()).kids.filter((k) => k.dynamic).length;
	await clickBtn('More stars');
	await h.eventually(() => snap().then((v) => v.kids.filter((k) => k.dynamic).length), (n) => n === before + 3, `More stars adds 3 dynamic bodies (${before} -> ${before + 3})`, 8000);
	for (let i = 0; i < 12; i++) {
		await page.waitForTimeout(600); // the node's own 0.5 s interval
		await clickBtn('More stars');
	}
	await page.waitForTimeout(1200);
	const alive = (await snap()).kids.filter((k) => k.dynamic).length;
	h.check(alive <= 27 + 32 && alive >= before + 3, `twelve more presses never exceed 27 + maxAlive 32 (${alive}) — the spawner recycles, it does not pile up`);

	// 6 — the round: Start -> playing; sweep every star -> Lit 24/24 -> over
	await clickBtn('Start round: light every star');
	await h.eventually(() => snap().then((v) => v.state), (v) => v === 'playing', 'Start flips to playing', 8000);
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'hud', 'the round HUD shows', 6000);
	await page.waitForTimeout(800);
	await knockStar('Star 3', 3, 'q');
	await h.eventually(async () => await hud(), (t) => /Lit: 1 \/ 24/.test(t), 'one hit lights one star (Lit: 1 / 24)', 8000);
	const lit3 = await page.evaluate(() => {
		let group; window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return '#' + group.getObjectByName('Star 3').material.color.getHexString();
	});
	h.check(lit3.toLowerCase() === '#ffe08a', `...and Star 3 is painted lit (${lit3})`);
	// the TRIGGER LOG, not the count: the instant the last star lights, `allplayers` flips
	// the round to `over`, and in `over` the round cutoff is Infinity, so every perRound
	// latch READS un-lit again and `sum24` drops to 0 — while flowValues publishes only
	// every 150ms, so a poll (or even a subscription) can miss the one window where the
	// count read 24. What a perRound latch reads as lit is its set-source stamp at or after
	// the round's startedAt, so assert THAT for all 24; the `over` check below is what
	// proves the count chain itself reached 24, and `Lit: 1 / 24` above its readout.
	const litThisRound = () => page.evaluate(() => {
		const st = /** @type {any} */ (window).__stores;
		let trig, gs; st.flowTriggers.subscribe((v) => (trig = v))(); st.gameState.gameState.subscribe((v) => (gs = v))();
		// startedAt is epoch ms; trigger stamps are the tick clock's seconds-of-day, so fold
		// it the way retiredByRound does (toSyncedStamp + the midnight-wrap guard)
		if (!gs?.startedAt) return -1;
		const start = (gs.startedAt % 86400000) / 1000;
		let n = 0;
		for (let i = 1; i <= 24; i++) {
			const t = trig['hit' + i]?.lastT;
			if (typeof t === 'number' && !(t < start && start - t < 43200)) n++;
		}
		return n;
	});
	const lit1 = await litThisRound();
	h.check(lit1 === 1, `the round's log counts only this round's hits (${lit1}; Star 1 was knocked before Start)`);
	// a star still flying AWAY faster than the sweep refuses the hit BY DESIGN (approach
	// <= minSpeed), so a star missed on the first pass is retried — with a FRESH probe id,
	// because the same probe's cooldown for that body is already spent — after damping has
	// had a moment to bleed it. Three attempts, then it counts as missed.
	let missing = [];
	for (let attempt = 0; attempt < 3; attempt++) {
		const todo = attempt === 0 ? Array.from({ length: 24 }, (_, n) => n + 1) : missing;
		missing = [];
		for (const i of todo) {
			const r = await knockStar('Star ' + i, 4, 'r' + i + '_' + attempt);
			if (r.missing || r.hits === 0) missing.push(i);
		}
		if (!missing.length) break;
		await page.waitForTimeout(1200); // let damping bleed the runaways
	}
	h.check(missing.length === 0, `every star took a knock (${24 - missing.length}/24${missing.length ? ', missed ' + missing.join(',') : ''})`);
	// the count node itself, for the NEW round below (playing, so its cutoff is finite)
	const litCount = () => page.evaluate(() => {
		let v; window.__stores.flowValues.subscribe((x) => (v = x))();
		return v['sum24'] ?? 0;
	});
	await h.eventually(litThisRound, (n) => n >= 24, 'all 24 latches were set this round (hit stamps at or after startedAt)', 10000);
	await h.eventually(() => snap().then((v) => v.state), (v) => v === 'over', 'every star lit ends the round (over)', 10000);
	h.check(/EVERY STAR LIT/.test(await hud()) && /Every star lit in \d+s/.test(await hud()), 'the over screen names the time');

	// 7 — a NEW round un-lights every star (the perRound reset, and the repaint that
	// proves the paint tracks the round rather than sticking). Material colour is NOT
	// base-managed — restoreBase carries pose and visibility only — so a star does not
	// revert to its authored palette colour when the round ends; it is repainted when the
	// next round starts, which is the behaviour worth asserting.
	await clickBtn('Back to free play');
	await h.eventually(() => snap().then((v) => v.state), (v) => v === 'menu', 'Back to free play returns to menu', 8000);
	await pressP();
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'pause', 'the menu opens again', 6000);
	await clickBtn('Start round: light every star');
	await h.eventually(() => snap().then((v) => v.state), (v) => v === 'playing', 'a new round starts', 8000);
	await h.eventually(litCount, (n) => n === 0, 'the new round un-lights every star (perRound)', 8000);
	await page.waitForTimeout(800);
	const dim3 = await page.evaluate(() => {
		let group; window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return '#' + group.getObjectByName('Star 3').material.color.getHexString();
	});
	h.check(dim3.toLowerCase() === '#3b3f66', `...and Star 3 is painted unlit again (${dim3})`);

	await page.evaluate(() => window.__stores.isLocked.set(false));
	await page.waitForTimeout(400);
	await h.finish(browser);
});
