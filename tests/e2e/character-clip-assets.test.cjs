// 57 union (M1 clip assets x M2 retarget): a HUMANOID `.tpanim` clip file, applied with Apply clip…
// to a rig of another family (the shipped KayKit knight), plays retargeted on every peer. The clip is
// written in 57 M1's shape (encodeTpanim(toHumanoid(...)), from a Mixamo-named rig's own clip), sits in
// the Explorer, and Apply clip lists it under "Clip files"; applying assigns it as a CLIP ASSET (the
// refs replicate, B pulls the bytes by hash and binds through the M2 retarget for itself).
const h = require('./helpers.cjs');
const { mixamoGlb, FULL_RESOURCE_TIMING } = require('./characterFixtures.cjs');

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
/** the most a bone's local rotation moves over ~1 s of playback (rAF-sampled) */
const swingOf = (page, uuid, bone) =>
	page.evaluate(
		({ uuid, bone }) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const b = g?.getObjectByProperty('uuid', uuid)?.getObjectByName(bone);
					if (!b) return r(-1);
					const q0 = b.quaternion.clone();
					let most = 0;
					const t0 = performance.now();
					const step = () => {
						most = Math.max(most, 1 - Math.abs(q0.dot(b.quaternion)));
						if (performance.now() - t0 < 1200) requestAnimationFrame(step);
						else r(most);
					};
					requestAnimationFrame(step);
				})()
			),
		{ uuid, bone }
	);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { init: FULL_RESOURCE_TIMING });
	const B = await h.setupPage(browser, 'B', { init: FULL_RESOURCE_TIMING });
	await h.connect(B, A);

	// 1. the source rig (its own Kick) and the target (the KayKit knight, no clips)
	const hero = await mixamoGlb(A.page, { clip: true });
	await A.page.evaluate(async (hero) => {
		await window.__stores.fileHandler.importFile(
			new File([new Uint8Array(hero)], 'hero.glb'),
			'Hero',
			undefined,
			[1, 0, 0]
		);
		const knight = await (await fetch('avatars/knight.glb')).arrayBuffer();
		await window.__stores.fileHandler.importFile(
			new File([knight], 'knight.glb'),
			'Knight',
			undefined,
			[-1, 0, 0]
		);
	}, hero);
	await h.eventually(
		() => states(A.page),
		(m) => Object.keys(m).length >= 2,
		'premise: both rigs registered'
	);
	const heroU = await uuidOf(A.page, 'Hero');
	const knight = await uuidOf(A.page, 'Knight');
	await h.eventually(
		() => uuidOf(B.page, 'Knight'),
		(u) => u === knight,
		'B holds the knight'
	);

	// 2. Hero's Kick as a humanoid .tpanim (57 M1's writer), into the Explorer
	const made = await A.page.evaluate(async (u) => {
		const s = window.__stores;
		const root =
			s.objectsGroup && (await new Promise((r) => s.objectsGroup.subscribe((g) => r(g))()));
		const model = root.getObjectByProperty('uuid', u);
		const map = s.humanoidRig.humanoidOf(u)?.map;
		const clip = s.animatedImports.clipOf(u, 'Kick');
		const tp = s.tpanim.tpFromThreeClip(model, clip, {
			fps: 30,
			loop: true,
			rest: s.animatedImports.restPoseOf(u)
		});
		const bytes = s.tpanim.encodeTpanim(s.tpanim.toHumanoid(tp, map));
		const item = await s.explorer.addItemFromBytes(bytes, 'Kick.tpanim');
		const back = s.tpanim.decodeTpanim(bytes);
		return { hash: item?.hash ?? null, kind: item?.kind, humanoid: !!back.humanoid };
	}, heroU);
	h.check(
		!!made.hash && made.kind === 'anim' && made.humanoid,
		`premise: a humanoid .tpanim is in the Explorer (${JSON.stringify(made)})`
	);

	// 3. Apply clip… lists it under "Clip files"
	const listed = await A.page.evaluate(async () =>
		(await window.__stores.humanoidRig.clipSourcesInScene()).filter((s) => s.group === 'Clip files')
	);
	h.check(
		listed.some((s) => s.label === 'Kick' && s.src.asset === made.hash),
		`Apply clip lists the clip file (${JSON.stringify(listed)})`
	);

	// 4. apply it to the knight: a clip ASSET on it (one ref), playing, retargeted onto KayKit bones
	const res = await A.page.evaluate(
		({ knight, hash }) => window.__stores.humanoidRig.applyClipTo([knight], { asset: hash }),
		{ knight, hash: made.hash }
	);
	h.check(
		res.applied.length === 1 && !res.refused.length,
		`applied to the knight (${JSON.stringify(res)})`
	);
	await h.eventually(
		() => states(A.page),
		(m) => m[knight]?.clips?.includes('Kick') && m[knight]?.clip === 'Kick' && m[knight]?.playing,
		'A: the knight plays Kick'
	);
	const refs = await A.page.evaluate(
		(u) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(g.getObjectByProperty('uuid', u)?.userData?.clipRefs ?? null)
				)()
			),
		knight
	);
	h.check(
		Array.isArray(refs) && refs.length === 1 && refs[0].hash === made.hash,
		`it is a clip asset ref, not a copy (${JSON.stringify(refs)})`
	);
	const swingA = await swingOf(A.page, knight, 'upperlegl');
	h.check(swingA > 0.005, `A: the knight's left thigh kicks (${swingA.toFixed(4)})`);

	// 5. B: the ref arrived, the bytes were pulled by hash, B bound it for itself
	await h.eventually(
		() => states(B.page),
		(m) => m[knight]?.clips?.includes('Kick') && m[knight]?.playing,
		'B: the knight plays Kick too',
		45000
	);
	const swingB = await swingOf(B.page, knight, 'upperlegl');
	h.check(swingB > 0.005, `B: the knight's left thigh kicks there too (${swingB.toFixed(4)})`);

	// 6. one undo takes the clip away everywhere
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(
		() => states(B.page),
		(m) => !m[knight]?.clips?.includes('Kick'),
		'undo: the clip is gone on B'
	);
	h.check(!(await states(A.page))[knight]?.clips?.includes('Kick'), 'undo: ...and on A');
	h.check(
		!h.pageErrors(A).length && !h.pageErrors(B).length,
		`no page errors (${JSON.stringify([...h.pageErrors(A), ...h.pageErrors(B)].slice(0, 3))})`
	);

	await h.finish(browser);
});
