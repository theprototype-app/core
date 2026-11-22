// 103 (H6) — VIBRATION ON GAMEPADS AND PHONES. The haptic patterns used to reach the Quest's
// controllers only; one output layer (hapticOutput.js) now plays them on a gamepad (dual rumble,
// trigger rumble where the pad has it) and on an Android phone (navigator.vibrate).
//
// A motor cannot be felt headlessly, so `navigator.getGamepads` returns a FAKE pad whose
// vibrationActuator records every playEffect / reset, and `navigator.vibrate` is a recorder —
// the two browser seams the layer drives, so everything above them is the real code path. What
// a pattern FEELS like is the owed device check (a real pad on the PC, the N6).
//
// 1 the Vibrate node: silent in Edit, a trigger-rumble pattern in Interact, a hand, a custom
// buzz sized by a wired strength · 2 the player's switch and strength · 3 no pad = the phone
// motor; no motor at all = nothing, no error · 4 it stops part-way when the player leaves the
// game · 5 the game-feel nodes (#580) bring their default feel, and `vibrate` off removes it ·
// 6 api.feel / api.hapticPattern in a module reach the pad · 7 two peers: `who: me` buzzes only
// the player whose pulse it was, `everyone` both, and no message of its own goes on the wire ·
// 8 feature unused = zero change: no Vibrate node, no buzz, the output layer is not even loaded in Edit.
const h = require('./helpers.cjs');

const NOW = () => (Date.now() % 86400000) / 1000;

/** the fake pad + phone motor, recorders on window @param {any} page @param {{pad?: boolean, triggers?: boolean, vibrate?: boolean}} opts */
const installMotors = (page, opts = {}) =>
	page.evaluate((o) => {
		const w = /** @type {any} */ (window);
		w.__effects = [];
		w.__resets = 0;
		w.__vibrates = [];
		w.__pad = {
			id: 'Fake Xbox pad',
			index: 0,
			connected: true,
			mapping: 'standard',
			timestamp: 0,
			axes: [0, 0, 0, 0],
			buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
			vibrationActuator: {
				effects: o.triggers ? ['dual-rumble', 'trigger-rumble'] : ['dual-rumble'],
				playEffect: (/** @type {string} */ type, /** @type {any} */ params) => {
					w.__effects.push({ type, ...params, t: performance.now() });
					return Promise.resolve('complete');
				},
				reset: () => {
					w.__resets++;
					return Promise.resolve('complete');
				}
			}
		};
		Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => (o.pad ? [w.__pad] : []) });
		if (o.vibrate) Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (/** @type {any} */ p) => (w.__vibrates.push(p), true) });
		else Object.defineProperty(navigator, 'vibrate', { configurable: true, value: undefined });
		return true;
	}, opts);

const motors = (page) => page.evaluate(() => ({ effects: window.__effects, resets: window.__resets, vibrates: window.__vibrates }));
const clearMotors = (page) =>
	page.evaluate(() => {
		window.__effects = [];
		window.__resets = 0;
		window.__vibrates = [];
	});

/** a key -> Vibrate graph (plus whatever `more` adds) @param {any} page @param {any[]} more */
const build = (page, more = []) =>
	page.evaluate(async (more) => {
		const s = window.__tp.test.v1;
		const N = (id, type, data) => ({ id, type, position: { x: 0, y: 0 }, data: { label: id, ...data }, class: 'w-[150px]' });
		const E = (a, b, th) => ({ id: 'e-' + a + '-' + b + (th ? '.' + th : ''), source: a, target: b, ...(th ? { targetHandle: th } : {}) });
		const nodes = [N('vKey', 'keypress', { code: 'KeyJ', edge: 'down', pulse: 0.3 }), ...more.map((m) => N(m.id, m.type, m.data))];
		const edges = more.flatMap((m) => [E(m.from ?? 'vKey', m.id, 'trigger'), ...(m.edges ?? []).map((e) => E(e[0], m.id, e[1]))]);
		s.flowGraphs.update((g) => ({ ...g, scene: { nodes, edges } }));
		s.flowNodes.set(nodes);
		s.flowEdges.set(edges);
		await new Promise((r) => setTimeout(r, 800)); // past the nodes' first-seen (actionSeenAt)
		return true;
	}, more);

const pulse = (page, replicate = false) =>
	page.evaluate(({ t, replicate }) => window.__tp.test.v1.flowRuntime.applyNodeTrigger('vKey', t, replicate), { t: NOW(), replicate });

const mode = (page, m) => page.evaluate((m) => window.__tp.test.v1.objectActions.setEditorMode(m), m);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;

	console.log('\n=== 8. feature unused = zero change ===');
	const unused = await page.evaluate(() => {
		const urls = performance.getEntriesByType('resource').map((e) => e.name);
		return { loaded: urls.some((u) => /hapticOutput/.test(u)) };
	});
	h.check(!unused.loaded, '8.1 in Edit with no game the output layer is not loaded at all (lazy)');
	await installMotors(page, { pad: true, triggers: true, vibrate: true });
	await build(page, [{ id: 'vGame', type: 'gamesound', data: { sound: 'coin' } }]);
	await mode(page, 'interact');
	await pulse(page);
	await page.waitForTimeout(400);
	const none = await motors(page);
	h.check(none.effects.length === 0 && none.vibrates.length === 0, '8.2 a game with no Vibrate node buzzes nothing in Interact (' + JSON.stringify(none) + ')');
	await mode(page, 'edit');

	console.log('\n=== 1. the Vibrate node ===');
	await build(page, [{ id: 'vHit', type: 'vibrate', data: { pattern: 'hit', strength: 1, hand: 'both', who: 'me' } }]);
	await clearMotors(page);
	await pulse(page);
	await page.waitForTimeout(400);
	const edit = await motors(page);
	h.check(edit.effects.length === 0 && edit.vibrates.length === 0, '1.1 silent in Edit (' + JSON.stringify(edit) + ')');
	await mode(page, 'interact');
	await page.waitForTimeout(300);
	await pulse(page);
	await page.waitForTimeout(400);
	const hit = await motors(page);
	h.check(hit.effects.length === 2 && hit.effects.every((e) => e.type === 'trigger-rumble'), '1.2 Interact: the two pulses of `hit` as trigger-rumble on a pad that has it (' + JSON.stringify(hit.effects) + ')');
	h.check(hit.effects[0]?.strongMagnitude === 0.85 && hit.effects[0]?.weakMagnitude === 0.85 && hit.effects[0]?.leftTrigger > 0 && hit.effects[0]?.duration === 35, '1.3 the first pulse: both motors at 0.85, the triggers in, 35 ms');
	h.check(hit.effects[1] && hit.effects[1].t - hit.effects[0].t >= 45, '1.4 the second pulse ~55 ms later (' + Math.round((hit.effects[1]?.t ?? 0) - (hit.effects[0]?.t ?? 0)) + ' ms)');
	h.check(hit.vibrates.length === 0, '1.5 with a pad taking it, the phone motor stays still');

	await build(page, [
		{ id: 'vNum', type: 'number', data: { value: 0.5 }, from: null },
		{ id: 'vCus', type: 'vibrate', data: { pattern: 'custom', strength: 1, ms: 300, hand: 'left', who: 'me' }, edges: [['vNum', 'strength']] }
	]);
	await clearMotors(page);
	await pulse(page);
	await page.waitForTimeout(400);
	const custom = await motors(page);
	const c0 = custom.effects[0] ?? {};
	h.check(custom.effects.length === 1 && c0.duration === 300 && c0.strongMagnitude === 0.5 && c0.weakMagnitude === 0 && c0.rightTrigger === 0, '1.6 custom: one 300 ms buzz at the WIRED strength 0.5, left side only (' + JSON.stringify(c0) + ')');

	console.log('\n=== 2. the player switch and strength ===');
	await build(page, [{ id: 'vHit', type: 'vibrate', data: { pattern: 'bump', strength: 1, hand: 'both', who: 'me' } }]);
	const settings = async (patch) =>
		page.evaluate((p) => {
			const gs = window.__tp.test.v1.gameKit.gameSettings;
			for (const [k, v] of Object.entries(p)) gs.setGameSetting(k, v);
			return gs.shellSettingViews ? gs.shellSettingViews({ vr: false }).map((r) => r.id) : null;
		}, patch);
	const rows = await settings({ hapticStrength: 50 });
	h.check(!rows || (rows.includes('haptics') && rows.includes('hapticStrength')), '2.1 Vibration + Vibration strength are rows of the game settings (' + JSON.stringify(rows) + ')');
	await clearMotors(page);
	await pulse(page);
	await page.waitForTimeout(300);
	const half = await motors(page);
	h.check(Math.abs((half.effects[0]?.weakMagnitude ?? 0) - 0.225) < 1e-3, '2.2 strength 50 % halves it (' + JSON.stringify(half.effects[0]) + ')');
	await settings({ haptics: false });
	await clearMotors(page);
	await pulse(page);
	await page.waitForTimeout(300);
	const off = await motors(page);
	h.check(off.effects.length === 0, '2.3 Vibration off: nothing');
	await settings({ haptics: true, hapticStrength: 100 });

	console.log('\n=== 3. no pad: the phone; no motor: nothing ===');
	await installMotors(page, { pad: false, vibrate: true });
	await pulse(page);
	await page.waitForTimeout(300);
	const phone = await motors(page);
	h.check(phone.vibrates.length === 1 && JSON.stringify(phone.vibrates[0]) === '[19]', '3.1 an Android phone gets navigator.vibrate([19]) for a bump: no amplitude, so its 0.45 becomes 67 % of 28 ms (' + JSON.stringify(phone.vibrates) + ')');
	await installMotors(page, { pad: false, vibrate: false });
	await pulse(page);
	await page.waitForTimeout(300);
	const ios = await page.evaluate(async () => (await window.__tp.test.v1.gameKit.gameFeelActions.hapticOutputModule()).hapticOutputDebug().env);
	h.check(ios.pads.length === 0 && ios.vibrate === false, '3.2 nothing there (iOS): the layer sees no motor and does nothing (' + JSON.stringify(ios) + ')');

	console.log('\n=== 4. stops part-way when the player leaves ===');
	await installMotors(page, { pad: true, triggers: false, vibrate: false });
	await build(page, [{ id: 'vRum', type: 'vibrate', data: { pattern: 'rumble', strength: 1, hand: 'both', who: 'me' } }]);
	await pulse(page);
	await page.waitForTimeout(60);
	await mode(page, 'edit');
	await page.waitForTimeout(600);
	const stopped = await motors(page);
	const dbg = await page.evaluate(async () => (await window.__tp.test.v1.gameKit.gameFeelActions.hapticOutputModule()).hapticOutputDebug());
	h.check(stopped.effects.length === 1 && stopped.resets >= 1 && dbg.lastStop === 'left-game' && dbg.pending === 0, '4.1 a 4-pulse rumble cut after its first pulse, the pad told to stop (' + JSON.stringify({ n: stopped.effects.length, resets: stopped.resets, lastStop: dbg.lastStop }) + ')');
	await mode(page, 'interact');
	await page.evaluate(() => window.__tp.test.v1.gameState.setGameState('playing'));
	await clearMotors(page);
	await pulse(page);
	await page.waitForTimeout(60);
	await page.evaluate(() => window.__tp.test.v1.gameState.setGameState('paused'));
	await page.waitForTimeout(600);
	const paused = await motors(page);
	h.check(paused.effects.length === 1 && paused.resets >= 1, '4.2 a pause stops it too (' + paused.effects.length + ' pulses)');
	await page.evaluate(() => window.__tp.test.v1.gameState.resetGame?.());

	console.log('\n=== 5. the game-feel nodes bring their default feel ===');
	await build(page, [
		{ id: 'vShake', type: 'camerashake', data: { strength: 0.3, seconds: 0.4, frequency: 18, who: 'me' } },
		{ id: 'vFlash', type: 'screenflash', data: { color: '#ff0000', strength: 0.6, seconds: 0.2, who: 'me', vibrate: false } }
	]);
	await clearMotors(page);
	await pulse(page);
	await page.waitForTimeout(400);
	const shake = await motors(page);
	h.check(shake.effects.length === 1 && shake.effects[0].duration === 400 && Math.abs(shake.effects[0].strongMagnitude - 0.74) < 1e-3, '5.1 Camera Shake rumbles for its seconds at its strength; Screen Flash with vibrate off adds nothing (' + JSON.stringify(shake.effects) + ')');

	console.log('\n=== 6. api.feel and api.hapticPattern in a module ===');
	const mod = await page.evaluate(async () => {
		const sdk = window.__tp.test.v1.moduleSDK;
		await sdk.initModules([{ id: 'vib103', name: 'Vibrate test', version: '1.0.0', description: 'inline', register: (api) => (window.__vibApi = api) }]);
		const api = window.__vibApi;
		window.__effects = [];
		const a = api.feel.vibrate({ strength: 0.9, ms: 150 }, { hand: 'right' });
		const b = api.hapticPattern('tap');
		await new Promise((r) => setTimeout(r, 300));
		const dbg = (await window.__tp.test.v1.gameKit.gameFeelActions.hapticOutputModule()).hapticOutputDebug();
		return { a, b, effects: window.__effects, outputs: api.feel.outputs(), unknown: api.hapticPattern('nope'), dbg: { plays: dbg.plays, suppressed: dbg.suppressed, calls: dbg.calls.slice(-3), env: dbg.env, state: (() => { let v; window.__tp.test.v1.gameState.gameState?.subscribe?.((x) => (v = x?.state))?.(); return v; })() } };
	});
	h.check(mod.a === true && mod.b === true && mod.unknown === false, '6.1 api.feel.vibrate and api.hapticPattern accept, an unknown pattern is refused');
	h.check(mod.effects.length === 2 && mod.effects[0].duration === 150 && mod.effects[0].strongMagnitude === 0 && mod.effects[0].weakMagnitude === 0.9, '6.2 both reached the pad: a custom right-side buzz, then a tap (' + JSON.stringify(mod.effects) + ' ' + JSON.stringify(mod.dbg) + ')');
	h.check(mod.outputs.gamepads === 1 && mod.outputs.vr === false && mod.outputs.phone === false, '6.3 feel.outputs() says what this device has (' + JSON.stringify(mod.outputs) + ')');
	await mode(page, 'edit');

	console.log('\n=== 7. two peers: aimed at the player whose pulse it was ===');
	await build(page, [
		{ id: 'vMe', type: 'vibrate', data: { pattern: 'bump', strength: 1, hand: 'both', who: 'me' } },
		{ id: 'vAll', type: 'vibrate', data: { pattern: 'custom', strength: 0.3, ms: 200, hand: 'both', who: 'everyone' } }
	]);
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await B.page.waitForFunction(() => window.__tp.test.v1.allNodes().some((n) => n.id === 'vAll'), null, { timeout: 30000 });
	await B.page.waitForTimeout(900);
	await installMotors(B.page, { pad: true, triggers: false, vibrate: false });
	await mode(page, 'interact');
	await mode(B.page, 'interact');
	await page.evaluate(() => {
		let peer;
		window.__tp.test.v1.peers.subscribe((v) => (peer = v))();
		window.__sent = [];
		const send = peer.send.bind(peer);
		peer.send = (msg) => {
			window.__sent.push(msg?.type);
			return send(msg);
		};
	});
	await page.waitForTimeout(300);
	await clearMotors(page);
	await clearMotors(B.page);
	await pulse(B.page, true); // B's press, replicated
	await page.waitForTimeout(1200);
	const onA = await motors(page);
	const onB = await motors(B.page);
	const durs = (m) => m.effects.map((e) => e.duration).sort((x, y) => x - y);
	h.check(JSON.stringify(durs(onB)) === '[28,200]', "7.1 B (whose press it was) feels both: `me` and `everyone` (" + JSON.stringify(durs(onB)) + ')');
	h.check(JSON.stringify(durs(onA)) === '[200]', '7.2 A feels only the `everyone` one (' + JSON.stringify(durs(onA)) + ')');
	await clearMotors(page);
	await clearMotors(B.page);
	await pulse(page, true); // A's press
	await page.waitForTimeout(1200);
	h.check(JSON.stringify(durs(await motors(page))) === '[28,200]' && JSON.stringify(durs(await motors(B.page))) === '[200]', '7.3 and the other way round');
	const sent = await page.evaluate(() => window.__sent);
	h.check(!sent.some((t) => /vibrat|haptic|rumble|buzz/i.test(String(t))), '7.4 no vibration message on the wire (' + JSON.stringify([...new Set(sent)]) + ')');
	await mode(page, 'edit');
	await mode(B.page, 'edit');

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, 'no page error (' + JSON.stringify([...h.pageErrors(A), ...h.pageErrors(B)].slice(0, 3)) + ')');
	await h.finish(browser);
});
