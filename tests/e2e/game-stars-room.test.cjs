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
//
// 30 visuals-core: a START screen (Start round / Free play — free play is a game state of
// its own, `free`), a two-minute round, Round over written from STORED values (every
// perRound latch reads un-lit the instant the round ends), the best round saved on this
// device, glass walls that clicks pass through, a starfield, and ONE pooled burst emitter a
// Script node moves onto the star just hit — the fix for the emitter-cap toast on load.
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
	// 30: 36 -> 50 (floor/ceiling rings, 8 frame pieces, starfield, burst anchor, deck light, card camera)
	// 30b: -> 49, the burst anchor retired (the core's pooled Effect Burst replaced the trick)
	h.check(st.kids.length === 49, `49 objects arrived (${st.kids.length})`);
	h.check(dyn.length === 27, `27 dynamic bodies: 24 stars + 2 planets + the template (${dyn.length})`);
	h.check(st.kids.filter((k) => /^Star \d+$/.test(k.name)).length === 24, 'the 24 stars are named Star 1..24');
	h.check(st.gravity === 0 && st.ground?.enabled === false, `zero-g with the ground off (${st.gravity}, ground ${st.ground?.enabled})`);
	h.check(st.knock?.enabled === true && Math.abs(st.knock.maxSpeed - 10) < 1e-9 && Math.abs(st.knock.spin - 0.6) < 1e-9, `the knock block restored ON from the file (${JSON.stringify(st.knock)})`);
	h.check(Math.abs((st.damping?.linear ?? 0) - 0.35) < 1e-9, `damping 0.35 (${st.damping?.linear})`);
	h.check(st.play?.simOnPlay === true && st.play?.interaction === 'grab' && st.play?.grounded === false, 'play block: grab, flying, simOnPlay');
	h.check(st.state === 'menu' && st.screen === 'start', `starts on the start screen (${st.state}/${st.screen})`);
	const chime = await page.evaluate(() => {
		const s = window.__stores;
		const snd = s.allNodes().find((n) => n.type === 'sound');
		const hash = snd?.data?.hash ?? null;
		return { hash, held: hash ? !!s.explorer.itemByHash(hash) : false, nodes: s.allNodes().length };
	});
	h.check(!!chime.hash && /^[0-9a-f]{16,}$/.test(chime.hash) && chime.held, `the chime's hash was remapped and its bytes rode the file into the Explorer (${chime.hash?.slice(0, 8)}, held ${chime.held})`);
	h.check(chime.nodes > 200, `the graph is there (${chime.nodes} nodes)`);

	// 1b — 30: the look and the emitter budget, measured
	const look = await page.evaluate(() => {
		const s = window.__stores;
		const g = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const group = g(s.objectsGroup);
		const walls = ['Wall north', 'Wall south', 'Wall west', 'Wall east'].map((n) => group.getObjectByName(n));
		const star = group.getObjectByName('Star 1');
		let userEmitters = 0;
		group.traverse((o) => { if (o.userData?.particles) userEmitters++; });
		const env = g(s.environment.environment);
		return {
			glass: walls.every((w) => w?.userData?.pick === 'through' && w.material.opacity < 0.25),
			star: star && { geo: star.geometry.type, mat: star.material.type, collider: star.userData.physics?.collider },
			particleNodes: s.allNodes().filter((n) => n.type === 'particle').length,
			userEmitters,
			starfield: !!group.getObjectByName('Starfield')?.userData?.particles,
			exposure: env?.exposure, gradient: !!env?.customPreset?.gradient
		};
	});
	h.check(look.glass, 'the four walls are glass panels, select-through');
	h.check(look.star?.geo === 'IcosahedronGeometry' && look.star.mat === 'MeshPhysicalMaterial' && look.star.collider === 'sphere', `the stars are crystals with sphere colliders (${JSON.stringify(look.star)})`);
	h.check(look.starfield && look.exposure >= 0.9 && look.gradient, `a starfield under a gradient sky, exposure ${look.exposure}`);
	h.check(look.particleNodes + look.userEmitters <= 8, `the emitters fit the runtime's cap of 8 (${look.particleNodes} nodes + ${look.userEmitters} on objects; it was 24 per-star bursts)`);
	const loadToasts = await page.locator('.tp-toast').allTextContents().catch(() => []);
	h.check(!loadToasts.some((t) => /emitter cap|cap \(8\)/i.test(t)), `no emitter-cap toast on load (${JSON.stringify(loadToasts).slice(0, 120)})`);

	// 30b: the game-feel stores the suite reads (sound / burst / banner / music)
	const feel = () =>
		page.evaluate(() => {
			const k = window.__stores.gameKit;
			let music, ann;
			k.gameMusic.gameMusicState.subscribe((v) => (music = v))();
			k.gameAnnounce.gameAnnouncement.subscribe((v) => (ann = v))();
			const d = k.gameFeelActions.gameFeelActionsDebug();
			return { music: music?.preset ?? null, ann: ann?.text ?? null, last: d.last, fired: d.fired, sounds: d.sounds };
		});
	const resetFeel = () => page.evaluate(() => window.__stores.gameKit.gameFeelActions.resetGameFeelActionsDebug());

	// 2 — entering play starts the sim (free play, no round)
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => snap().then((v) => v.sim), (v) => v === true, 'entering play starts the sim', 10000);
	await page.waitForTimeout(600);
	st = await snap();
	h.check(st.state === 'menu' && st.screen === 'start', 'the start screen shows in play, the sim running behind it');
	// 30b: the menu says how to play, the room has its music, and Play put you on the spawn
	h.check(/HOW TO PLAY/.test(await hud()) && /Knock every crystal star once to light it/.test(await hud()), '30b: the start screen says HOW TO PLAY');
	await h.eventually(() => feel().then((f) => f.music), (m) => m === 'space', '30b: the space music plays in Play', 6000);
	const eye = await page.evaluate(() => {
		const s = window.__stores;
		let cam; s.playerCam.subscribe((v) => (cam = v))();
		const p = cam.getWorldPosition(new s.THREE.Vector3());
		return [p.x, p.y, p.z].map((n) => +n.toFixed(2));
	});
	h.check(Math.abs(eye[0]) < 0.05 && Math.abs(eye[1] - 1.7) < 0.05 && Math.abs(eye[2] - 5.2) < 0.05, `30b: Play put the eye on the spawn, inside the south glass (${eye})`);
	h.check(/Start round/.test(await hud()) && /Free play/.test(await hud()) && /Your best round: 0 \/ 24/.test(await hud()), 'it offers Start round and Free play, and this device\'s best (none yet)');
	await clickBtn('Free play');
	await h.eventually(() => snap().then((v) => `${v.state}/${v.screen}`), (v) => v === 'free/free', 'Free play: the `free` state and its screen', 6000);
	h.check(/STARS ROOM/.test(await hud()) && /free play/.test(await hud()), 'the free-play banner renders');
	// 30: a READABLE frame in play — mean luminance of the centred 360 px square (fork 11)
	await page.waitForTimeout(800);
	const lum = await page.evaluate(async (b64) => {
		const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
		const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
		const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
		const d = x.getImageData(Math.round(bmp.width / 2 - 180), Math.round(bmp.height / 2 - 180), 360, 360).data;
		let sum = 0;
		for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
		return sum / (d.length / 4) / 255;
	}, (await page.screenshot()).toString('base64'));
	h.check(lum >= 0.25, `the play frame reads: centre luminance ${lum.toFixed(3)} >= 0.25`);

	// 3 — a hand knocks Star 1: it leaves at hand speed, and damping bleeds it
	const k1 = await knockStar('Star 1', 4);
	h.check(k1.hits === 1, `a 4 m/s pass knocks Star 1 once (${k1.hits})`);
	h.check(!!k1.atHit && Math.abs(mag(k1.atHit) - 4) < 0.4, `...and it leaves at ~4 m/s (${mag(k1.atHit).toFixed(2)})`);
	// 30b: the knocked star SPARKLES where it was hit — the core's pooled Effect Burst, at the
	// star (the 30 anchor-and-Script trick is retired)
	await page.waitForTimeout(250);
	const star1At = (await snap()).kids.find((k) => k.name === 'Star 1')?.pos;
	const sparkle = (await feel()).last.filter((e) => e.type === 'effectburst' && e.kind === 'sparkle' && e.fired);
	const near = sparkle.find((e) => star1At && Math.hypot(e.where[0] - star1At[0], e.where[1] - star1At[1], e.where[2] - star1At[2]) < 1.2);
	h.check(!!near, `the knocked star sparkled where it was hit (${JSON.stringify(sparkle.map((e) => e.where))}, star ${star1At})`);
	await page.waitForTimeout(350);
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
	await resetFeel();
	await clickBtn('Start round: light every star');
	await h.eventually(() => snap().then((v) => v.state), (v) => v === 'playing', 'Start flips to playing', 8000);
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'hud', 'the round HUD shows', 6000);
	await h.eventually(() => feel(), (f) => f.last.some((e) => e.type === 'announce' && e.text === 'Light every star!') && f.last.some((e) => e.sound === 'whistle'), '30b: the round opens with a banner and a whistle', 4000);
	await page.waitForTimeout(800);
	await resetFeel();
	await knockStar('Star 3', 3, 'q');
	await h.eventually(async () => await hud(), (t) => /Lit: 1 \/ 24/.test(t), 'one hit lights one star (Lit: 1 / 24)', 8000);
	// 30b: LIGHTING a star pays a coin chime at it and a tap in VR — once per star per round
	await h.eventually(() => feel(), (f) => f.last.filter((e) => e.sound === 'coin' && e.spatial).length === 1 && (f.fired.hapticpulse ?? 0) === 1, '30b: lighting Star 3 plays one coin at it and asks one tap', 4000);
	await page.waitForTimeout(1500); // let it drift, then knock it again inside the same round
	await knockStar('Star 3', 3, 'q2');
	await page.waitForTimeout(700);
	const again = await feel();
	h.check(again.last.filter((e) => e.sound === 'coin').length === 1 && again.last.filter((e) => e.type === 'effectburst').length >= 2, `30b: a second knock sparkles again but pays no second coin (coins ${again.last.filter((e) => e.sound === 'coin').length}, sparkles ${again.last.filter((e) => e.type === 'effectburst').length})`);
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
	// 30b: the round ends in confetti and a cheer, and the win is announced
	await h.eventually(() => feel(), (f) => f.fired.effectburst > 0 && f.last.some((e) => e.type === 'effectburst' && e.kind === 'confetti') && f.last.some((e) => e.sound === 'cheer') && f.last.some((e) => e.type === 'announce' && e.text === 'Every star lit!'), '30b: over = confetti, a cheer and "Every star lit!"', 4000);
	const coins = (await feel()).sounds.coin ?? 0;
	h.check(coins === 24, `30b: the sweep paid exactly one coin per star lit (${coins} / 24)`);
	await h.eventually(async () => await hud(), (t) => /EVERY STAR LIT/.test(t) && /Every star lit in \d+s/.test(t) && /Your best: 24 \/ 24/.test(t), 'the over screen names the time and the best, from storage');
	const storedStars = await page.evaluate(() => {
		const out = {};
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			if (/^tp:scene:.*:stars-(best|last|time)$/.test(k)) out[k.split(':').pop()] = JSON.parse(localStorage.getItem(k));
		}
		return out;
	});
	h.check(storedStars['stars-best'] === 24 && storedStars['stars-last'] === 24 && storedStars['stars-time'] > 0, `the round was saved on this device (${JSON.stringify(storedStars)})`);

	// 7 — a NEW round un-lights every star (the perRound reset, and the repaint that
	// proves the paint tracks the round rather than sticking). Material colour is NOT
	// base-managed — restoreBase carries pose and visibility only — so a star does not
	// revert to its authored palette colour when the round ends; it is repainted when the
	// next round starts, which is the behaviour worth asserting.
	await clickBtn('Menu');
	await h.eventually(() => snap().then((v) => `${v.state}/${v.screen}`), (v) => v === 'menu/start', 'Menu returns to the start screen', 8000);
	h.check(/Your best round: 24 \/ 24/.test(await hud()), 'the start screen shows the saved best round (24 / 24)');
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
