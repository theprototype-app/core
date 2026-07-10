// Phase 87: ping v2 — pings carry the sender's color + chime and render the
// layered burst on peers; annotations pin at the EXACT pointed spot; scene-root
// system objects are annotatable (and survive the prune); the VR right-stick
// ping math picks object hit > ground plane > nothing. On-device VR feel and
// the audible chime are the user's manual checks.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A, 8000);

	// A picks a custom ping color + chime, then Alt+clicks the floor
	await A.page.evaluate(() => {
		window.__stores.ping.pingColor.set('#ff2200');
		window.__stores.ping.pingSound.set('bell');
	});
	await A.page.keyboard.down('Alt');
	await A.page.mouse.click(400, 550);
	await A.page.keyboard.up('Alt');
	await A.page.waitForTimeout(1200);

	const bPing = await B.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.ping.pings.subscribe((list) =>
					resolve(list[0] ? { color: list[0].color, sound: list[0].sound } : null)
				)();
			})
	);
	h.check(
		bPing && bPing.color === '#ff2200' && bPing.sound === 'bell',
		`ping carries the sender color + sound (${JSON.stringify(bPing)})`
	);

	// v2 marker parts render on B, tinted with the sender color
	const marker = await B.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const counts = { ring: 0, glow: 0, beam: 0, spark: 0 };
					let ringColor = null;
					scene?.traverse((o) => {
						const g = o.geometry?.type;
						if (g === 'RingGeometry') {
							counts.ring++;
							ringColor = ringColor ?? '#' + o.material.color.getHexString();
						}
						if (g === 'CircleGeometry') counts.glow++;
						if (g === 'CylinderGeometry') counts.beam++;
						if (g === 'OctahedronGeometry') counts.spark++;
					});
					resolve({ counts, ringColor });
				})();
			})
	);
	h.check(
		marker.counts.ring >= 2 && marker.counts.glow >= 1 && marker.counts.beam >= 2 && marker.counts.spark >= 1,
		`v2 marker parts render on B (${JSON.stringify(marker.counts)})`
	);
	h.check(marker.ringColor === '#ff2200', `marker tinted with sender color (${marker.ringColor})`);

	// exact-point annotation: the pin lands where pointed, not at the bbox top
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		box.position.set(2, 0.5, 0);
		box.updateMatrixWorld(true);
		window.__box = box;
	});
	const draft = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.annotationsHandler.addAnnotation(window.__box.uuid, [2.5, 0.75, 0.3]);
				window.__stores.annotationsHandler.activeAnnotation.subscribe((a) =>
					resolve(a?.draft ? { offset: a.draft.offset } : null)
				)();
			})
	);
	h.check(
		draft &&
			Math.abs(draft.offset[0] - 0.5) < 0.01 &&
			Math.abs(draft.offset[1] - 0.25) < 0.01 &&
			Math.abs(draft.offset[2] - 0.3) < 0.01,
		`annotation anchors at the exact hit point (${draft?.offset.map((v) => v.toFixed(2))})`
	);
	// finalize + replicate (read the draft first — never write a store from its own subscriber)
	await A.page.evaluate(() => {
		let current = null;
		window.__stores.annotationsHandler.activeAnnotation.subscribe((a) => (current = a))();
		window.__stores.annotationsHandler.setAnnotation({ ...current.draft, text: 'exact pin' });
		window.__stores.annotationsHandler.activeAnnotation.set(null);
	});
	await B.page.waitForTimeout(1000);
	const bNote = await B.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.annotationsHandler.annotations.subscribe((list) =>
					resolve(list.find((a) => a.text === 'exact pin')?.offset ?? null)
				)();
			})
	);
	h.check(
		bNote && Math.abs(bNote[0] - 0.5) < 0.01 && Math.abs(bNote[1] - 0.25) < 0.01,
		`exact offset replicated to B (${bNote?.map((v) => v.toFixed(2))})`
	);

	// scene-root system objects: annotatable, and the pin survives the prune
	const sys = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				const THREE = window.__stores.THREE;
				window.__stores.globalScene.subscribe((scene) => {
					const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
					mesh.name = 'sys-test';
					mesh.position.set(-3, 0.5, 0);
					scene.add(mesh);
					mesh.updateMatrixWorld(true);
					window.__stores.annotationsHandler.addAnnotation(mesh.uuid, [-3, 1, 0.5]);
					let current = null;
					window.__stores.annotationsHandler.activeAnnotation.subscribe((a) => (current = a))();
					if (current?.draft) {
						window.__stores.annotationsHandler.setAnnotation({ ...current.draft, text: 'sys pin' });
						window.__stores.annotationsHandler.activeAnnotation.set(null);
					}
					resolve({ hasDraft: !!current?.draft, offset: current?.draft?.offset ?? null });
				})();
			})
	);
	h.check(
		sys.hasDraft && Math.abs(sys.offset[1] - 0.5) < 0.01 && Math.abs(sys.offset[2] - 0.5) < 0.01,
		`system object at the scene root is annotatable (${sys.offset?.map((v) => v.toFixed(2))})`
	);
	// churn objectsGroup so the debounced prune runs — the system pin must stay
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		group.children[group.children.length - 1].position.set(0, 0.5, -8);
	});
	await A.page.waitForTimeout(900);
	const sysKept = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.annotationsHandler.annotations.subscribe((list) =>
					resolve(list.some((a) => a.text === 'sys pin'))
				)();
			})
	);
	h.check(sysKept, 'system-object pin survives the objectsGroup prune');

	// VR right-stick ping math: object hit > ground-plane fallback > sky = nothing
	const vr = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				const THREE = window.__stores.THREE;
				window.__stores.objectsGroup.subscribe((group) => {
					const pick = (origin, dir, g) => {
						const ray = new THREE.Raycaster(
							new THREE.Vector3(...origin),
							new THREE.Vector3(...dir).normalize()
						);
						const p = window.__stores.vrControls.pingPointFromRay(ray, g);
						return p ? [p.x, p.y, p.z] : null;
					};
					resolve({
						onBox: pick([2, 0.5, 5], [0, 0, -1], group),
						ground: pick([0, 1.6, 0], [0, -1, -0.1], null),
						sky: pick([0, 1.6, 0], [0, 1, 0], null)
					});
				})();
			})
	);
	h.check(
		vr.onBox && Math.abs(vr.onBox[2] - 0.5) < 0.01,
		`stick ping lands on the pointed object face (${vr.onBox?.map((v) => v.toFixed(2))})`
	);
	h.check(
		vr.ground && Math.abs(vr.ground[1]) < 0.001,
		`empty aim falls back to the ground plane (${vr.ground?.map((v) => v.toFixed(2))})`
	);
	h.check(vr.sky === null, 'sky aim pings nothing');

	await h.finish(browser);
});
