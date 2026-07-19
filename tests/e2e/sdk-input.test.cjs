// K-C: SDK input layer — key codes visible in getInput(), module bindings list
// in the shortcuts registry, the 'keys' claim pauses the editor fly-navigation,
// and window blur clears held keys. Single page (input is local by nature).
const h = require('./helpers.cjs');

const camPos = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.globalCamera.subscribe((c) => r(c ? [c.position.x, c.position.y, c.position.z] : null))())
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// key codes land in the per-frame snapshot
	await A.page.keyboard.down('T');
	await A.page.waitForTimeout(100);
	const held = await A.page.evaluate(() => [...window.__stores.inputRuntime.getInput().codes]);
	await A.page.keyboard.up('T');
	h.check(held.includes('KeyT'), `held keys appear in getInput().codes (${held.join(',')})`);
	const released = await A.page.evaluate(() => window.__stores.inputRuntime.getInput().codes.size);
	h.check(released === 0, `key-up clears the code (${released} held)`);

	// onInput events fire down/up
	const events = await A.page.evaluate(async () => {
		const log = [];
		const off = window.__stores.inputRuntime.onInput((kind, code) => log.push(kind + ':' + code));
		const down = new KeyboardEvent('keydown', { code: 'KeyG', key: 'g', bubbles: true });
		const up = new KeyboardEvent('keyup', { code: 'KeyG', key: 'g', bubbles: true });
		window.dispatchEvent(down);
		window.dispatchEvent(up);
		off();
		return log;
	});
	h.check(events.join(',') === 'down:KeyG,up:KeyG', `onInput fires down/up (${events.join(',')})`);

	// module bindings list in the shortcuts registry under the module group
	const listed = await A.page.evaluate(() => {
		window.__stores.inputRuntime.registerBindings('testmod', [{ label: 'Test forward', keys: 'W' }]);
		return window.__stores.shortcutsRegistry.shortcuts.some(
			(s) => s.group === 'Module: testmod' && s.label === 'Test forward'
		);
	});
	h.check(listed === true, 'module binding listed in the shortcuts registry');

	// the 'keys' claim pauses the editor WASD fly: W moves the camera normally,
	// and stops moving it once claimed
	const before = await camPos(A.page);
	await A.page.mouse.click(640, 400); // focus the canvas area
	await A.page.keyboard.down('W');
	await A.page.waitForTimeout(500);
	await A.page.keyboard.up('W');
	const moved = await camPos(A.page);
	const dist1 = Math.hypot(moved[0] - before[0], moved[1] - before[1], moved[2] - before[2]);
	h.check(dist1 > 0.05, `editor fly moves the camera without a claim (${dist1.toFixed(2)})`);

	await A.page.evaluate(() => window.__stores.inputRuntime.claimInput('keys'));
	const p1 = await camPos(A.page);
	await A.page.keyboard.down('W');
	await A.page.waitForTimeout(500);
	await A.page.keyboard.up('W');
	const p2 = await camPos(A.page);
	const dist2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
	h.check(dist2 < 0.01, `claimed 'keys' pauses the editor fly (${dist2.toFixed(3)})`);
	await A.page.evaluate(() => window.__stores.inputRuntime.releaseInput('keys'));
	const claims = await A.page.evaluate(() => new Promise((r) => window.__stores.inputRuntime.inputClaims.subscribe(r)()));
	h.check(claims.length === 0, 'release clears the claim');

	// blur clears held keys (stuck-key guard)
	await A.page.keyboard.down('D');
	await A.page.waitForTimeout(100);
	await A.page.evaluate(() => window.dispatchEvent(new Event('blur')));
	const afterBlur = await A.page.evaluate(() => window.__stores.inputRuntime.getInput().codes.size);
	h.check(afterBlur === 0, `blur clears held keys (${afterBlur})`);
	await A.page.keyboard.up('D');

	await h.finish(browser);
});
