// WASD fly panning vs keyboard COMMANDS. Shift on its own is the 3x fly modifier,
// but Shift+A is the Add-menu shortcut — it used to open the menu AND strafe the
// camera left at 3x, so the viewport lurched first (user-reported).
// editorNavigation now consults the shortcut registry and ignores a key whose
// Shift+<key> combo is a registered command.
const h = require('./helpers.cjs');

const camPos = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.globalCamera.subscribe((c) => r(c?.position?.toArray()))()
			)
		);

const moved = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- Shift+A opens the Add menu and must NOT move the camera ---------------
	const before = await camPos(A.page);
	await A.page.keyboard.press('Shift+KeyA');
	// poll for the box: the shortcut action dynamically imports appStore, so a fixed
	// short wait is racy on a loaded machine
	await A.page.locator('#add-search-box').waitFor({ state: 'visible', timeout: 10000 });
	h.check(true, 'Shift+A opens the Add menu');
	await A.page.waitForTimeout(600); // let several frames run
	const after = await camPos(A.page);
	h.check(
		moved(before, after) < 0.01,
		`Shift+A leaves the camera still (moved ${moved(before, after).toFixed(3)})`
	);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(300);

	// --- plain A still strafes (fly mode is untouched) -------------------------
	const b2 = await camPos(A.page);
	await A.page.keyboard.down('KeyA');
	await A.page.waitForTimeout(500);
	await A.page.keyboard.up('KeyA');
	await A.page.waitForTimeout(200);
	const a2 = await camPos(A.page);
	h.check(moved(b2, a2) > 0.1, `plain A still flies (moved ${moved(b2, a2).toFixed(2)})`);

	// --- Shift+W still flies, and faster than W alone (Shift = 3x) ------------
	const bw = await camPos(A.page);
	await A.page.keyboard.down('KeyW');
	await A.page.waitForTimeout(500);
	await A.page.keyboard.up('KeyW');
	await A.page.waitForTimeout(200);
	const aw = await camPos(A.page);
	const plain = moved(bw, aw);
	h.check(plain > 0.1, `plain W flies (moved ${plain.toFixed(2)})`);

	const bs = await camPos(A.page);
	await A.page.keyboard.down('Shift');
	await A.page.keyboard.down('KeyW');
	await A.page.waitForTimeout(500);
	await A.page.keyboard.up('KeyW');
	await A.page.keyboard.up('Shift');
	await A.page.waitForTimeout(200);
	const as = await camPos(A.page);
	const fast = moved(bs, as);
	// 3x nominally; assert clearly faster without being flaky about frame timing
	h.check(
		fast > plain * 1.5,
		`Shift+W is still the 3x fly modifier (${plain.toFixed(2)} -> ${fast.toFixed(2)})`
	);

	await h.finish(browser);
});
