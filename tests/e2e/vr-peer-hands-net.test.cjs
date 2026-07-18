// Roadmap #7 N5 (cross-peer): a VR peer's hand broadcast must reach a DESKTOP peer
// and render there. Sends a real vrhands message over the mesh from A and checks B
// receives it into peerHands + renders A's hand group (25 joint spheres + a box).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);

	// B2.3: assert the sphere style (the default is cuboid-bone hands now)
	await B.page.evaluate(() => window.__stores.peerHandStyle.set('spheres'));
	// A broadcasts articulated hands (left) + a controller hand (right), as the VR
	// presence loop would
	await A.page.evaluate(() => {
		const s = window.__stores;
		let peer;
		s.peers.subscribe((p) => (peer = p))();
		const joints = [];
		for (let i = 0; i < 25; i++) joints.push(i * 0.001, i * 0.002, i * 0.003);
		peer.send({
			type: 'vrhands',
			peerId: peer.peer.id,
			left: { pos: [1, 1, -2], rot: [0, 0, 0], joints },
			right: { pos: [1.2, 1, -2], rot: [0, 0, 0], joints: null },
			active: true
		});
	});

	await h.eventually(
		() =>
			B.page.evaluate((aid) => {
				const s = window.__stores;
				let ph;
				s.peerHands.subscribe((x) => (ph = x))();
				let scene;
				s.globalScene.subscribe((x) => (scene = x))();
				const count = (name) => {
					const g = scene?.getObjectByName(name);
					let n = 0;
					g?.traverse((o) => {
						if (o.isMesh) n++;
					});
					return n;
				};
				return {
					hasEntry: !!ph[aid],
					active: ph[aid]?.active,
					left: count(aid + '-hand-left'),
					right: count(aid + '-hand-right')
				};
			}, A.id),
		(r) => r.hasEntry && r.active === true && r.left === 25 && r.right === 2,
		'desktop peer receives + renders the VR peer hands (25 joint spheres + box)'
	);

	await h.finish(browser);
});
