// 57 M4 — VRM characters: a VRM 1.0 (built here, never committed: a Mixamo-named rig + the VRM
// extension) and a VRM 0.x import through three-vrm — a LAZY chunk (absent from the boot graph) —
// ride the raw-bytes path as kind 'vrm' on every peer, bring their own humanoid map, spring bones
// and expressions, show their licence meta in the Inspector and carry it as provenance.
const h = require('./helpers.cjs');
const { mixamoGlb, toVrm, FULL_RESOURCE_TIMING } = require('./characterFixtures.cjs');

const states = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.animatedImports.animatedObjects.subscribe((m) =>
					r(JSON.parse(JSON.stringify(m)))
				)()
			)
	);
const uuidOf = (page, name) =>
	page.evaluate(
		(name) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(g?.children.find((c) => c.name === name)?.uuid ?? null)
				)()
			),
		name
	);
const vrmLoaded = (page) =>
	page.evaluate(() =>
		performance.getEntriesByType('resource').some((e) => /three-vrm|vrmRuntime/.test(e.name))
	);
const boneQ = (page, uuid, bone) =>
	page.evaluate(
		({ uuid, bone }) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(
						g?.getObjectByProperty('uuid', uuid)?.getObjectByName(bone)?.quaternion.toArray() ??
							null
					)
				)()
			),
		{ uuid, bone }
	);
const qDiff = (a, b) => (a && b ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : -1);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { init: FULL_RESOURCE_TIMING });
	const B = await h.setupPage(browser, 'B', { init: FULL_RESOURCE_TIMING });
	await h.connect(B, A);

	// 0. boot graph: no VRM code until a VRM arrives
	h.check(
		!(await vrmLoaded(A.page)) && !(await vrmLoaded(B.page)),
		'boot: three-vrm is not loaded on either peer'
	);

	const rig = await mixamoGlb(A.page, { hair: true });
	const vrm1 = toVrm(rig, { version: '1' });
	const vrm0 = toVrm(rig, { version: '0' });
	h.check(
		vrm1.length > rig.length && vrm0.length > rig.length,
		'premise: the VRM fixtures were written'
	);

	// 1. VRM 1.0 import
	await A.page.evaluate(async (bytes) => {
		await window.__stores.fileHandler.importFile(
			new File([new Uint8Array(bytes)], 'test.vrm'),
			'Avatar1',
			undefined,
			[0, 0, 0]
		);
	}, vrm1);
	await h.eventually(
		() => uuidOf(A.page, 'Avatar1'),
		(u) => !!u,
		'A: the VRM 1.0 is placed'
	);
	const v1 = await uuidOf(A.page, 'Avatar1');
	h.check(await vrmLoaded(A.page), 'A: three-vrm loaded once a VRM arrived');
	h.check(
		(await A.page.evaluate((u) => window.__stores.animatedImports.animatedImportKind(u), v1)) ===
			'vrm',
		'it rides the bytes path as kind vrm'
	);
	await h.eventually(
		() => A.page.evaluate((u) => window.__stores.animatedImports.vrmDebug(u), v1),
		(d) =>
			// three-vrm makes ONE joint per bone that has a next bone in its chain: Hair1 -> Hair2 is 1
			d?.vrm && d.joints === 1 && d.expressions.includes('happy') && d.expressions.includes('wink'),
		'A: the VRM runtime adopted it (the spring joint, expressions incl. a custom one)'
	);
	const hm = await A.page.evaluate((u) => {
		const x = window.__stores.humanoidRig.humanoidOf(u);
		return (
			x && { via: x.via, rig: x.rig, ok: x.ok, hips: x.map.hips, upperChest: x.map.upperChest }
		);
	}, v1);
	h.check(
		hm?.via === 'file' &&
			hm.rig === 'vrm' &&
			hm.ok &&
			hm.hips === 'mixamorigHips' &&
			hm.upperChest === 'mixamorigSpine2',
		`the humanoid map comes from the file (${JSON.stringify(hm)})`
	);
	const lic = await A.page.evaluate((u) => {
		const root = window.__stores.objectsGroup && null;
		return new Promise((r) =>
			window.__stores.objectsGroup.subscribe((g) =>
				r(window.__stores.provenance.licenceOf(g.getObjectByProperty('uuid', u).userData))
			)()
		);
	}, v1);
	h.check(
		lic?.id === 'VRM' &&
			lic.redistribution === false &&
			lic.commercial === false &&
			lic.credit === true &&
			lic.author === 'theprototype tests',
		`provenance carries the VRM licence (${JSON.stringify(lic)})`
	);

	// 2. B parses the same bytes with three-vrm (lazily, there too)
	await h.eventually(
		() => uuidOf(B.page, 'Avatar1'),
		(u) => u === v1,
		'B: the VRM arrived'
	);
	await h.eventually(
		() => B.page.evaluate((u) => window.__stores.animatedImports.vrmDebug(u), v1),
		(d) => d?.vrm && d.joints === 1,
		'B: adopted as a VRM with its spring bones'
	);
	h.check(
		(await B.page.evaluate((u) => window.__stores.animatedImports.animatedImportKind(u), v1)) ===
			'vrm',
		'B: kind vrm'
	);

	// 3. Inspector ▸ Character shows the VRM meta and the licence
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), v1);
	await A.page.waitForSelector('#character-vrm', { timeout: 15000 });
	const vrmText = await A.page.evaluate(
		() => document.querySelector('#character-vrm')?.textContent ?? ''
	);
	h.check(
		/VRM 1\.0/.test(vrmText) && /Test Avatar/.test(vrmText) && /Redistribution: no/.test(vrmText),
		`the Inspector shows the VRM meta ("${vrmText.replace(/\s+/g, ' ').trim().slice(0, 140)}")`
	);
	h.check(
		(await A.page.evaluate(() =>
			document.querySelector('#character-section')?.getAttribute('data-rig')
		)) === 'vrm',
		'the rig reads as VRM'
	);
	h.check(
		(await A.page.evaluate(() =>
			document.querySelector('#character-provenance')?.getAttribute('data-licence')
		)) === 'VRM',
		'the provenance line names the licence'
	);

	// 4. spring bones move the hair while the body moves (a local visual). Sampled DURING the
	// motion: the spring is damped, so a while after a move it has settled back to rest.
	const swing = await A.page.evaluate(
		(u) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const root = g.getObjectByProperty('uuid', u);
					const hair = root.getObjectByName('mixamorigHair1');
					const q0 = hair.quaternion.clone();
					let n = 0;
					let most = 0;
					const step = () => {
						root.position.x += 0.04;
						most = Math.max(most, 1 - Math.abs(q0.dot(hair.quaternion)));
						if (++n < 40) requestAnimationFrame(step);
						else r({ most, frames: n });
					};
					requestAnimationFrame(step);
				})()
			),
		v1
	);
	h.check(
		swing.most > 1e-5,
		`spring bones: the hair swings while the body moves (${JSON.stringify(swing)})`
	);

	// 5. expressions: the Inspector slider replicates; the weight reaches B's face
	await A.page.evaluate(() => {
		const sel = document.querySelector('#character-expression select');
		sel.value = 'happy';
		sel.dispatchEvent(new Event('change', { bubbles: true }));
		const range = document.querySelector('#character-expression input[type=range]');
		range.value = '0.75';
		range.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await h.eventually(
		() => A.page.evaluate((u) => window.__stores.animatedImports.vrmDebug(u)?.value('happy'), v1),
		(v) => Math.abs(v - 0.75) < 1e-6,
		'A: happy = 0.75'
	);
	await h.eventually(
		() => B.page.evaluate((u) => window.__stores.animatedImports.vrmDebug(u)?.value('happy'), v1),
		(v) => Math.abs(v - 0.75) < 1e-6,
		'B: happy = 0.75 (replicated)'
	);

	// 6. Apply clip… works on a VRM (its own map)
	const r = await A.page.evaluate(
		(u) => window.__stores.humanoidRig.applyClipTo([u], { lib: 'avatars', clip: 'Walking_A' }),
		v1
	);
	h.check(r.applied.length === 1, 'Apply clip onto the VRM');
	const q1 = await boneQ(A.page, v1, 'mixamorigLeftUpLeg');
	await A.page.waitForTimeout(500);
	h.check(qDiff(q1, await boneQ(A.page, v1, 'mixamorigLeftUpLeg')) > 0.005, 'the VRM walks');
	await h.eventually(
		() => states(B.page),
		(m) => m[v1]?.clips?.includes('Walking_A') && m[v1]?.playing,
		'B: the VRM walks there too'
	);

	// 7. a VRM 0.x: Redistribution_Prohibited, turned to face +Z, mapped by its file
	await A.page.evaluate(async (bytes) => {
		await window.__stores.fileHandler.importFile(
			new File([new Uint8Array(bytes)], 'old.glb'),
			'Avatar0',
			undefined,
			[2, 0, 0]
		);
	}, vrm0);
	await h.eventually(
		() => uuidOf(A.page, 'Avatar0'),
		(u) => !!u,
		'A: the VRM 0.x (named .glb) is placed'
	);
	const v0 = await uuidOf(A.page, 'Avatar0');
	h.check(
		(await A.page.evaluate((u) => window.__stores.animatedImports.animatedImportKind(u), v0)) ===
			'vrm',
		'a .glb carrying the VRM extension is read as a VRM'
	);
	await h.eventually(
		() => A.page.evaluate((u) => window.__stores.humanoidRig.humanoidOf(u)?.via, v0),
		(v) => v === 'file',
		'VRM 0.x: the map comes from the file'
	);
	const lic0 = await A.page.evaluate(
		(u) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(
						window.__stores.provenance.licenceFlags(
							window.__stores.provenance.licenceOf(g.getObjectByProperty('uuid', u).userData)
						)
					)
				)()
			),
		v0
	);
	h.check(
		lic0?.noRedistribution === true && lic0.nonCommercial === true,
		`VRM 0.x licence flags (${JSON.stringify(lic0)})`
	);
	const rotY = await A.page.evaluate(
		(u) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(g.getObjectByProperty('uuid', u).rotation.y)
				)()
			),
		v0
	);
	h.check(
		Math.abs(Math.abs(rotY) - Math.PI) < 1e-3,
		`VRM 0.x is turned to face +Z (root y ${rotY.toFixed(3)})`
	);
	const j0 = await A.page.evaluate(
		(u) => window.__stores.humanoidRig.applyClipTo([u], { lib: 'avatars', clip: 'Walking_A' }),
		v0
	);
	h.check(j0.applied.length === 1, 'Apply clip onto the VRM 0.x');

	await h.finish(browser);
});
