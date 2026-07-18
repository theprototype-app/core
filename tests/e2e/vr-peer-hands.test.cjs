// Roadmap #7 N5: articulated peer hands. When a peer is hand-tracking, its vrhands
// message carries 25 wrist-local joints and its avatar renders a sphere per joint
// (moving fingers); a controller peer keeps the box + pointer. Capture needs a real
// XR hand-tracking session (the user's on-device check) — this drives the RECEIVE +
// RENDER path with a faked message.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const r = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				const s = window.__stores;
				s.peerHandStyle.set('spheres'); // B2.3: default is 'hands' (cuboid bones) now
				const joints = [];
				for (let i = 0; i < 25; i++) joints.push(i * 0.001, i * 0.002, i * 0.003); // 25 * 3
				let ud;
				s.userdata.subscribe((x) => (ud = x))();
				s.userdata.set([...ud, ['fakepeer', 'Fake', '']]);
				// left hand = hand-tracked (joints), right hand = controller (no joints)
				s.peerHands.set({
					fakepeer: {
						active: true,
						left: { pos: [1, 1, -2], rot: [0, 0, 0], joints },
						right: { pos: [1.2, 1, -2], rot: [0, 0, 0], joints: null }
					}
				});
				setTimeout(() => {
					s.globalScene.subscribe((scene) => {
						const count = (name) => {
							const g = scene.getObjectByName(name);
							let n = 0;
							g?.traverse((o) => {
								if (o.isMesh) n++;
							});
							return { has: !!g, meshes: n };
						};
						resolve({ left: count('fakepeer-hand-left'), right: count('fakepeer-hand-right') });
					})();
				}, 700);
			})
	);
	h.check(r.left.has && r.left.meshes === 25, `hand-tracked peer renders 25 finger-joint spheres (${r.left.meshes})`);
	h.check(r.right.has && r.right.meshes === 2, `controller peer hand stays a box + pointer (${r.right.meshes})`);

	// B2.3: the default 'hands' style renders ~24 cuboid bone segments instead
	const bones = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.peerHandStyle.set('hands');
				setTimeout(() => {
					window.__stores.globalScene.subscribe((scene) => {
						const g = scene.getObjectByName('fakepeer-hand-left');
						let n = 0;
						g?.traverse((o) => {
							if (o.isMesh) n++;
						});
						resolve(n);
					})();
				}, 500);
			})
	);
	h.check(bones === 24, `'hands' style renders 24 cuboid bones (${bones})`);

	await h.finish(browser);
});
