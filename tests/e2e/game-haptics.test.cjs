// 30b (vr-play) P1 — C4 HAPTICS. The user, from a Quest: "For games, also enable controller
// vibration, make it cool like haptic, so it would be good for users to interact with the
// world. The vibration should be only interactive mode, not in edit mode."
//
// No headset runs headless, so the XR session is a STUB whose gamepads carry recording
// actuators — every assertion reads what the actuator was actually asked to do.
// 1 Edit is silent (api.haptic, a core pulse, a pattern) · 2 Interact buzzes, on the named
// hand · 3 patterns play as timed pulses and stop when the player leaves mid-pattern ·
// 4 the hover-enter TAP: once per entry, only on clickable things (On Click / device part /
// marked), never in Edit · 5 the press BUMP · 6 the knock is scaled by its strength.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	await page.evaluate(async () => {
		const s = window.__stores;
		await s.moduleSDK.initModules([
			{ id: 'haptic30b', name: 'Haptic test', version: '1.0.0', description: 'the 30b haptic seams', register(api) { window.__api = api; } }
		]);
		let renderer;
		s.globalRenderer.subscribe((r) => (renderer = r))();
		window.__buzz = [];
		const source = (hand) => ({
			handedness: hand,
			gamepad: { buttons: [], axes: [], hapticActuators: [{ pulse: (i, ms) => window.__buzz.push({ hand, i, ms, t: performance.now() }) }] }
		});
		const session = { inputSources: [source('left'), source('right')] };
		renderer.xr.getSession = () => session;
		renderer.xr.getController(0).userData.handedness = 'left';
		renderer.xr.getController(1).userData.handedness = 'right';
	});
	const buzz = () => page.evaluate(() => window.__buzz.splice(0));
	const mode = (m) => page.evaluate((m) => window.__stores.objectActions.setEditorMode(m), m);

	console.log('\n=== 1. Edit mode is silent ===');
	await mode('edit');
	const edit = await page.evaluate(() => {
		const s = window.__stores;
		const before = s.vrControls.hapticDebug().suppressed;
		window.__api.haptic(0.6, 50, 'left');
		s.vrControls.hapticPulse(0.4, 40); // a core pulse (menus, teleport, the sleeve)
		const pattern = window.__api.hapticPattern('success', 'right');
		return { pattern, suppressed: s.vrControls.hapticDebug().suppressed - before };
	});
	await page.waitForTimeout(300);
	const editBuzz = await buzz();
	h.check(editBuzz.length === 0, '1.1 no actuator pulsed in Edit (' + editBuzz.length + ')');
	h.check(edit.suppressed === 2 && edit.pattern === false, '1.2 the pulses were swallowed by the gate and the pattern refused (' + JSON.stringify(edit) + ')');

	console.log('\n=== 2. Interact buzzes, on the named hand ===');
	await mode('interact');
	await page.evaluate(() => window.__api.haptic(0.6, 50, 'left'));
	const one = await buzz();
	h.check(one.length === 1 && one[0].hand === 'left' && one[0].i === 0.6 && one[0].ms === 50, '2.1 api.haptic pulses the LEFT actuator in Interact (' + JSON.stringify(one) + ')');
	await page.evaluate(() => window.__stores.vrControls.hapticPulse(0.3, 20));
	const both = await buzz();
	h.check(both.length === 2 && both.some((b) => b.hand === 'left') && both.some((b) => b.hand === 'right'), '2.2 a pulse with no hand reaches both');

	console.log('\n=== 3. patterns are timed pulses and stop when the player leaves ===');
	const ok = await page.evaluate(() => ({ s: window.__api.hapticPattern('success', 'right'), u: window.__api.hapticPattern('zzz') }));
	await page.waitForTimeout(400);
	const success = await buzz();
	h.check(ok.s === true && ok.u === false, '3.1 a known pattern plays, an unknown one is refused');
	h.check(
		success.length === 3 && success.every((b) => b.hand === 'right') && success[0].i < success[1].i && success[1].i < success[2].i,
		'3.2 success = three rising pulses on the right (' + JSON.stringify(success.map((b) => b.i)) + ')'
	);
	h.check(success[2].t - success[0].t > 120, '3.3 they are spaced in time, not fired at once (' + (success[2].t - success[0].t).toFixed(0) + ' ms)');
	await page.evaluate(() => {
		window.__api.hapticPattern('rumble', 'left');
		window.__stores.objectActions.setEditorMode('edit');
	});
	await page.waitForTimeout(600);
	const cut = await buzz();
	h.check(cut.length === 1, '3.4 leaving Interact mid-rumble stops it after the first pulse (' + cut.length + ' of 4)');
	await mode('interact');

	console.log('\n=== 4. the hover-enter tap ===');
	const ids = await page.evaluate(async () => {
		const s = window.__stores;
		const make = async (at) => {
			const [uuid] = await window.__api.create('/create box 1 1 1', { at });
			return uuid;
		};
		const clickable = await make([0, 1, -4]);
		const plain = await make([3, 1, -4]);
		const marked = await make([-3, 1, -4]);
		await new Promise((r) => setTimeout(r, 400));
		window.__api.flow.addNodes({ graphId: clickable, nodes: [{ type: 'onclick', x: 40, y: 40, data: {} }] });
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		g.getObjectByProperty('uuid', marked).userData.clickable = true;
		return { clickable, plain, marked };
	});
	await page.waitForTimeout(500);
	const hover = await page.evaluate((ids) => {
		const s = window.__stores;
		const THREE = s.THREE;
		const k = s.gameKit.vrGameInput;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const rayTo = (uuid) => {
			const target = g.getObjectByProperty('uuid', uuid).getWorldPosition(new THREE.Vector3());
			const origin = new THREE.Vector3(target.x, 1, 2);
			return new THREE.Raycaster(origin, target.clone().sub(origin).normalize());
		};
		const miss = new THREE.Raycaster(new THREE.Vector3(0, 30, 0), new THREE.Vector3(0, 1, 0));
		const out = {};
		out.first = k.hoverFrame(0, rayTo(ids.clickable))?.key ?? null;
		out.a = window.__buzz.splice(0);
		k.hoverFrame(0, rayTo(ids.clickable));
		k.hoverFrame(0, rayTo(ids.clickable));
		out.b = window.__buzz.splice(0);
		out.plain = k.hoverFrame(0, rayTo(ids.plain))?.key ?? null;
		out.c = window.__buzz.splice(0);
		out.marked = k.hoverFrame(0, rayTo(ids.marked))?.key ?? null;
		out.d = window.__buzz.splice(0);
		k.hoverFrame(0, miss);
		k.hoverFrame(0, rayTo(ids.clickable));
		out.e = window.__buzz.splice(0);
		s.objectActions.setEditorMode('edit');
		k.hoverFrame(0, miss);
		out.editKey = k.hoverFrame(0, rayTo(ids.clickable))?.key ?? null;
		out.f = window.__buzz.splice(0);
		s.objectActions.setEditorMode('interact');
		return out;
	}, ids);
	h.check(hover.first === ids.clickable && hover.a.length === 1 && hover.a[0].hand === 'left' && hover.a[0].i < 0.25, '4.1 the laser entering an On Click object taps that hand lightly (' + JSON.stringify(hover.a) + ')');
	h.check(hover.b.length === 0, '4.2 staying on it taps nothing more (' + hover.b.length + ')');
	h.check(hover.plain === null && hover.c.length === 0, '4.3 a plain object is not clickable: no tap');
	h.check(hover.marked === ids.marked && hover.d.length === 1, '4.4 an object marked userData.clickable taps');
	h.check(hover.e.length === 1, '4.5 leaving and coming back taps again (re-armed)');
	h.check(hover.editKey === null && hover.f.length === 0, '4.6 in Edit the hover resolves nothing and never taps');

	console.log('\n=== 5. the press bump ===');
	const press = await page.evaluate((ids) => {
		const s = window.__stores;
		const THREE = s.THREE;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const rayTo = (uuid) => {
			const target = g.getObjectByProperty('uuid', uuid).getWorldPosition(new THREE.Vector3());
			const origin = new THREE.Vector3(target.x, 1, 2);
			return new THREE.Raycaster(origin, target.clone().sub(origin).normalize());
		};
		const k = s.gameKit.vrGameInput;
		const hit = k.pressFeedback(1, rayTo(ids.clickable));
		const a = window.__buzz.splice(0);
		const none = k.pressFeedback(1, rayTo(ids.plain));
		const b = window.__buzz.splice(0);
		return { hit, a, none, b };
	}, ids);
	h.check(press.hit && press.a.length === 1 && press.a[0].hand === 'right' && press.a[0].i >= 0.4, '5.1 a trigger landing on a clickable bumps the pressing hand (' + JSON.stringify(press.a) + ')');
	h.check(press.none === false && press.b.length === 0, '5.2 a press on nothing clickable does not');

	console.log('\n=== 6. the knock is scaled by its strength ===');
	await page.evaluate(() => {
		const v = window.__stores.vrControls;
		v.hapticKnock(Math.min(1, 0.2 + 0.4 / 10), 30, 'right'); // a brush at 0.4 m/s
	});
	await page.waitForTimeout(800); // headless timers run late — let the second pulse land
	const soft = await buzz();
	await page.evaluate(() => window.__stores.vrControls.hapticKnock(Math.min(1, 0.2 + 6 / 10), 30, 'right')); // a swing at 6 m/s
	await page.waitForTimeout(800);
	const hard = await buzz();
	h.check(soft.length === 2 && hard.length === 2, '6.1 a knock plays the two-pulse hit (' + soft.length + ', ' + hard.length + ')');
	h.check(hard[0].i > soft[0].i * 2 && hard[0].i <= 1, '6.2 a harder knock buzzes harder (' + soft[0].i.toFixed(3) + ' -> ' + hard[0].i.toFixed(3) + ')');

	await h.finish(browser);
});
