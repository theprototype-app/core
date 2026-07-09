// Phase 38: waypoint markers + polyline while capturing; drag moves, right-click removes.
const h = require('./helpers.cjs');

const nodePoints = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.flowNodes.subscribe((nodes) => {
					resolve(nodes.find((n) => n.id === 'pp1')?.data.points ?? null);
				})();
			})
	);

const markerInfo = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const group = scene?.getObjectByName('path-waypoints');
					if (!group) return resolve(null);
					let markers = 0;
					group.traverse((o) => {
						if (o.userData?.wpIndex != null) markers++;
					});
					resolve({ markers });
				})();
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// path node + capture two waypoints
	await A.page.evaluate(() => {
		const node = {
			id: 'pp1',
			type: 'pathpatrol',
			position: { x: 0, y: 0 },
			data: { type: 'pathpatrol', points: [], speed: 1, mode: 'loop' },
			class: 'w-[150px]'
		};
		window.__stores.flowNodes.set([node]);
		return new Promise((resolve) => {
			window.__stores.peers.subscribe((peer) => {
				peer.send({ type: 'nodecreate', node });
				resolve();
			})();
		});
	});
	await A.page.evaluate(() => window.__stores.pathCapture.togglePathCapture('pp1'));
	for (const [x, y] of [[420, 500], [700, 480]]) {
		await A.page.mouse.click(x, y);
		await A.page.waitForTimeout(250);
	}

	h.check((await nodePoints(A.page))?.length === 2, '2 waypoints captured');
	const viz = await markerInfo(A.page);
	h.check(viz?.markers === 2, `markers visible while capturing (${viz?.markers})`);

	// clicking ON a marker must not add a duplicate point
	const p0 = (await nodePoints(A.page))[0];
	const pixel0 = await h.projectPoint(A.page, p0);
	await A.page.mouse.click(pixel0.x, pixel0.y);
	await A.page.waitForTimeout(300);
	h.check((await nodePoints(A.page)).length === 2, 'clicking a marker does not add a point');

	// drag marker 0 to a new spot -> replicates to B
	const before0 = (await nodePoints(A.page))[0];
	await A.page.mouse.move(pixel0.x, pixel0.y);
	await A.page.mouse.down();
	for (let i = 1; i <= 6; i++) {
		await A.page.mouse.move(pixel0.x - i * 25, pixel0.y - i * 6);
		await A.page.waitForTimeout(80);
	}
	await A.page.mouse.up();
	await A.page.waitForTimeout(400);
	const after0 = (await nodePoints(A.page))[0];
	h.check(
		Math.hypot(after0[0] - before0[0], after0[2] - before0[2]) > 0.3,
		'dragging a marker moves the waypoint'
	);
	await h.eventually(
		() => nodePoints(B.page),
		(p) => p && Math.abs(p[0][0] - after0[0]) < 0.001,
		'dragged waypoint replicated to B'
	);

	// right-click removes a waypoint
	const p1 = (await nodePoints(A.page))[1];
	const pixel1 = await h.projectPoint(A.page, p1);
	await A.page.mouse.click(pixel1.x, pixel1.y, { button: 'right' });
	await h.eventually(() => nodePoints(A.page), (p) => p?.length === 1, 'right-click removes the waypoint');
	await h.eventually(() => nodePoints(B.page), (p) => p?.length === 1, 'removal replicated to B');

	// capture off (and node not selected) -> markers gone
	await A.page.evaluate(() => window.__stores.pathCapture.togglePathCapture('pp1'));
	await A.page.waitForTimeout(300);
	h.check((await markerInfo(A.page)) === null, 'markers hidden when not capturing/selected');

	await h.finish(browser);
});
