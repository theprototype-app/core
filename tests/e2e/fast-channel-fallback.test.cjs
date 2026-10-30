// 60 Q2 — GRACEFUL FALLBACK: a peer without the fast channel (an older build; here B with
// `fastChannel = off` from boot, so it advertises no `fc` and ignores the hello) gets every
// pose down the reliable conn, and nothing is opened on either side. Then the same pair the
// other way round: B's own stream reaches A. And the avatar really moves on the receiver.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B', { storage: { fastChannel: 'off' } });
	await h.connect(A, B);
	await A.page.waitForTimeout(2000);

	const open = {
		a: await A.page.evaluate((id) => window.__stores.fastChannel.isOpen(id), B.id),
		b: await B.page.evaluate((id) => window.__stores.fastChannel.isOpen(id), A.id),
		aPeers: await A.page.evaluate(() => window.__stores.fastChannel.links.peers())
	};
	h.check(
		!open.a && !open.b && open.aPeers.length === 0,
		'no fast channel is opened with a peer that lacks it ' + JSON.stringify(open)
	);

	/** stream n camera poses from `from` with {fast:true}; `to` records how they arrived */
	async function stream(from, to, n) {
		await to.page.evaluate((fid) => {
			window.__poses = [];
			window.__stores.fastChannel.setPoseTap((peer, d, via) => {
				// only the suite's own poses (z -1, yaw 0.5): the app's camera loop sends real ones too
				if (peer === fid && d.type === 'camera' && d.position?.[2] === -1 && d.rotation?.[1] === 0.5) window.__poses.push({ via, x: d.position[0] });
			});
		}, from.id);
		await from.page.evaluate(
			(n) =>
				new Promise((resolve) => {
					let p;
					window.__stores.peers.subscribe((x) => (p = x))();
					let i = 0;
					const t = setInterval(() => {
						p.send(
							{
								type: 'camera',
								peerId: p.peer.id,
								position: [2 + i * 0.01, 1.6, -1],
								rotation: [0, 0.5, 0]
							},
							{ fast: true }
						);
						if (++i >= n) (clearInterval(t), resolve(null));
					}, 50);
				}),
			n
		);
		await to.page.waitForTimeout(1500);
		return to.page.evaluate(() => window.__poses);
	}

	const toB = await stream(A, B, 60);
	h.check(toB.length === 60, `A -> B: every pose arrived on the fallback (${toB.length}/60)`);
	h.check(
		toB.every((p) => p.via === 'reliable'),
		'A -> B: all of them on the reliable conn'
	);
	const avatar = await B.page.evaluate((aid) => {
		let scene;
		window.__stores.globalScene.subscribe((s) => (scene = s))();
		const m = scene?.getObjectByName(aid);
		return m ? m.position.x : null;
	}, A.id);
	h.check(
		avatar !== null && Math.abs(avatar - (2 + 59 * 0.01)) < 1e-6,
		`B draws A's avatar at the last pose (${avatar})`
	);

	const toA = await stream(B, A, 40);
	h.check(
		toA.length === 40 && toA.every((p) => p.via === 'reliable'),
		`B -> A: every pose arrived, reliable (${toA.length}/40)`
	);

	await h.finish(browser);
});
