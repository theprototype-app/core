// Phase 35: drawing mode — stroke replicates on release, selectable, undoes as create.
const h = require('./helpers.cjs');

const strokeInfo = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const stroke = g?.children.find((c) => c.name === 'Stroke');
					resolve(
						stroke ? { uuid: stroke.uuid, geo: stroke.geometry?.type, mat: stroke.material?.type } : null
					);
				})();
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	await A.page.evaluate(() => window.__stores.drawMode.toggleDrawMode());
	await A.page.waitForTimeout(400);
	h.check(await A.page.locator('#draw-toolbar').isVisible(), 'draw toolbar appears');

	await A.page.mouse.move(500, 520);
	await A.page.mouse.down();
	for (let i = 1; i <= 10; i++) {
		await A.page.mouse.move(500 + i * 18, 520 + Math.sin(i) * 25);
		await A.page.waitForTimeout(30);
	}
	await A.page.mouse.up();
	await A.page.waitForTimeout(800);

	const aStroke = await strokeInfo(A.page);
	h.check(
		aStroke?.geo === 'TubeGeometry' && aStroke?.mat === 'MeshBasicMaterial',
		'stroke created on A (tube mesh)'
	);
	await h.eventually(
		() => strokeInfo(B.page),
		(s) => s?.uuid === aStroke.uuid,
		'stroke replicated to B (same uuid)'
	);

	await A.page.evaluate(() => window.__stores.drawMode.toggleDrawMode());
	await A.page.waitForTimeout(300);
	h.check(!(await A.page.locator('#draw-toolbar').isVisible()), 'toggle exits draw mode');

	const clickAt = await A.page.evaluate(() =>
		new Promise((resolve) => {
			window.__stores.objectsGroup.subscribe((g) => {
				window.__stores.globalCamera.subscribe((camera) => {
					const stroke = g.children.find((c) => c.name === 'Stroke');
					const pts = stroke.geometry.parameters.path.points;
					const mid = pts[Math.floor(pts.length / 2)].clone().project(camera);
					resolve({
						x: (mid.x * 0.5 + 0.5) * window.innerWidth,
						y: (-mid.y * 0.5 + 0.5) * window.innerHeight
					});
				})();
			})();
		})
	);
	await A.page.mouse.click(clickAt.x, clickAt.y);
	const selected = await A.page.evaluate(
		() => new Promise((r) => window.__stores.selectedObject.subscribe((s) => r(s?.uuid))())
	);
	h.check(selected === aStroke.uuid, 'stroke is selectable like any object');

	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => strokeInfo(A.page), (s) => s === null, 'undo removes the stroke on A');
	await h.eventually(() => strokeInfo(B.page), (s) => s === null, 'undo replicates to B');
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => strokeInfo(B.page), (s) => s?.uuid === aStroke.uuid, 'redo restores it on both');

	await h.finish(browser);
});
