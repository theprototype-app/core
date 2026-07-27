// Shift+A opens the Add-search popover AT THE CURSOR and spawns the picked object
// under it (previously it opened centred and objects landed at their default spot),
// and the popover is clamped so no edge ever leaves the viewport — including after
// a right-drag, near a screen corner, and across a window resize.
const h = require('./helpers.cjs');

const names = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => r((g?.children ?? []).map((c) => c.name)))()
			)
	);
const posOf = (page, name) =>
	page.evaluate(
		(name) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(g?.children.find((c) => c.name === name)?.position.toArray())
				)()
			),
		name
	);
/** The box rect + whether it sits fully inside the viewport. */
const boxRect = async (page) => {
	const r = await page.locator('#add-search-box').boundingBox();
	const vp = page.viewportSize();
	return {
		...r,
		inside: r.x >= 0 && r.y >= 0 && r.x + r.width <= vp.width && r.y + r.height <= vp.height
	};
};
const openAt = async (page, x, y) => {
	await page.mouse.move(x, y);
	await page.waitForTimeout(120); // let Scene record the pointer
	await page.keyboard.press('Shift+KeyA');
	await page.locator('#add-search-box').waitFor({ state: 'visible', timeout: 10000 });
	await page.waitForTimeout(250); // placement runs on the next frame
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const vp = A.page.viewportSize();

	// --- opens at the cursor ---------------------------------------------------
	await openAt(A.page, 500, 300);
	let r = await boxRect(A.page);
	h.check(
		Math.abs(r.x - 500) < 40 && Math.abs(r.y - 300) < 40,
		`opens next to the cursor (cursor 500,300 -> box ${Math.round(r.x)},${Math.round(r.y)})`
	);
	h.check(r.inside, 'fully on-screen at the cursor');

	// --- spawns UNDER the cursor, not at the origin ----------------------------
	await A.page.keyboard.type('cone');
	await A.page.keyboard.press('Enter');
	await h.eventually(() => names(A.page), (l) => l.includes('Cone'), 'Shift+A search spawns the object');
	const conePos = await posOf(A.page, 'Cone');
	h.check(
		Math.hypot(conePos[0], conePos[2]) > 0.5,
		`spawned under the cursor, not the origin (${conePos.map((v) => v.toFixed(1))})`
	);

	// a DIFFERENT cursor position gives a different spawn point
	await openAt(A.page, 900, 480);
	await A.page.keyboard.type('capsule');
	await A.page.keyboard.press('Enter');
	await h.eventually(() => names(A.page), (l) => l.includes('Capsule'), 'second spawn lands');
	const capsulePos = await posOf(A.page, 'Capsule');
	h.check(
		Math.hypot(capsulePos[0] - conePos[0], capsulePos[2] - conePos[2]) > 0.5,
		`a different cursor spawns elsewhere (${capsulePos.map((v) => v.toFixed(1))})`
	);

	// --- every corner keeps the box fully inside -------------------------------
	for (const [cx, cy, label] of [
		[vp.width - 3, vp.height - 3, 'bottom-right'],
		[2, vp.height - 3, 'bottom-left'],
		[vp.width - 3, 2, 'top-right'],
		[2, 2, 'top-left']
	]) {
		await openAt(A.page, cx, cy);
		r = await boxRect(A.page);
		h.check(
			r.inside,
			`stays fully on-screen at the ${label} corner (${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)})`
		);
		await A.page.keyboard.press('Escape');
		await A.page.waitForTimeout(150);
	}

	// --- a right-drag cannot push it off either --------------------------------
	await openAt(A.page, 600, 300);
	const before = await boxRect(A.page);
	await A.page.mouse.move(before.x + 100, before.y + 120);
	await A.page.mouse.down({ button: 'right' });
	await A.page.mouse.move(vp.width + 400, vp.height + 400, { steps: 8 }); // shove far off
	await A.page.mouse.up({ button: 'right' });
	await A.page.waitForTimeout(250);
	r = await boxRect(A.page);
	h.check(r.inside, `a right-drag past the edge clamps (${Math.round(r.x)},${Math.round(r.y)})`);
	h.check(r.x > before.x, 'the drag still moved the box');

	// typing after a drag must not snap it back to the cursor anchor
	const dragged = await boxRect(A.page);
	await A.page.locator('#add-search-input').fill('to');
	await A.page.waitForTimeout(350);
	r = await boxRect(A.page);
	h.check(
		Math.abs(r.x - dragged.x) < 2,
		`filtering keeps a dragged box in place (${Math.round(dragged.x)} -> ${Math.round(r.x)})`
	);
	h.check(r.inside, 'still fully on-screen after filtering');

	// --- the document never scrolls (an off-edge box would grow it) ------------
	const overflow = await A.page.evaluate(() => ({
		x: document.documentElement.scrollWidth - window.innerWidth,
		y: document.documentElement.scrollHeight - window.innerHeight
	}));
	h.check(
		overflow.x <= 0 && overflow.y <= 0,
		`the popover never grows the document (${overflow.x}, ${overflow.y})`
	);

	// --- shrinking the window keeps it inside ---------------------------------
	await A.page.setViewportSize({ width: 700, height: 420 });
	await A.page.waitForTimeout(400);
	r = await boxRect(A.page);
	const small = A.page.viewportSize();
	h.check(
		r.x >= 0 && r.y >= 0 && r.x + r.width <= small.width && r.y + r.height <= small.height,
		`a window resize re-clamps it (${Math.round(r.x)},${Math.round(r.y)} in ${small.width}x${small.height})`
	);

	await h.finish(browser);
});
