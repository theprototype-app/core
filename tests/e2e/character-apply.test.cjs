// 57 M2 — Apply clip… onto rigged characters: a KayKit avatar (the shipped knight.glb) and a
// Mixamo-named test rig (built in-page), from the built-in avatar motions. Rigs WITHOUT clips ride
// the raw-bytes path now; the applied clip is a CONFIG that every peer (and a late joiner) retargets
// for itself — the model bytes never change, and one undo takes it back everywhere.
const h = require('./helpers.cjs');

/** a small Mixamo-named humanoid (no clips): a skinned box on mixamorig bones, as a GLB */
const mixamoGlb = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				const THREE = window.__stores.THREE;
				const { GLTFExporter } = window.__stores.GLTFExporterModule;
				const bones = {};
				const mk = (name, parent, x, y, z) => {
					const b = new THREE.Bone();
					b.name = 'mixamorig' + name;
					b.position.set(x, y, z);
					if (parent) bones[parent].add(b);
					bones[name] = b;
					return b;
				};
				mk('Hips', null, 0, 1, 0);
				mk('Spine', 'Hips', 0, 0.1, 0);
				mk('Spine1', 'Spine', 0, 0.12, 0);
				mk('Spine2', 'Spine1', 0, 0.12, 0);
				mk('Neck', 'Spine2', 0, 0.15, 0);
				mk('Head', 'Neck', 0, 0.1, 0);
				for (const [S, x] of [
					['Left', 1],
					['Right', -1]
				]) {
					mk(S + 'Shoulder', 'Spine2', 0.05 * x, 0.1, 0);
					mk(S + 'Arm', S + 'Shoulder', 0.1 * x, 0, 0);
					mk(S + 'ForeArm', S + 'Arm', 0.25 * x, 0, 0);
					mk(S + 'Hand', S + 'ForeArm', 0.25 * x, 0, 0);
					mk(S + 'UpLeg', 'Hips', 0.1 * x, -0.05, 0);
					mk(S + 'Leg', S + 'UpLeg', 0, -0.45, 0);
					mk(S + 'Foot', S + 'Leg', 0, -0.45, 0);
					mk(S + 'ToeBase', S + 'Foot', 0, -0.05, 0.1);
				}
				const list = Object.values(bones);
				const geo = new THREE.BoxGeometry(0.4, 1.6, 0.3);
				geo.translate(0, 0.8, 0);
				const n = geo.attributes.position.count;
				const si = new Uint16Array(n * 4);
				const sw = new Float32Array(n * 4);
				for (let i = 0; i < n; i++) sw[i * 4] = 1; // all on the hips
				geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
				geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
				const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
				mesh.name = 'Body';
				const root = new THREE.Group();
				root.add(bones.Hips);
				root.add(mesh);
				root.updateMatrixWorld(true);
				mesh.bind(new THREE.Skeleton(list));
				new GLTFExporter().parse(
					root,
					(buf) => resolve(Array.from(new Uint8Array(buf))),
					() => resolve(null),
					{ binary: true }
				);
			})
	);

const states = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.animatedImports.animatedObjects.subscribe((m) =>
					r(JSON.parse(JSON.stringify(m)))
				)()
			)
	);

/** the root uuid named `name` */
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

/** a bone's local quaternion */
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

/** a cheap content digest of the bytes the model replicates as */
const bytesDigest = (page, uuid) =>
	page.evaluate((uuid) => {
		const b = window.__stores.animatedImports.animatedImportPayload(uuid);
		if (!b) return null;
		const u = new Uint8Array(b);
		let x = 0;
		for (let i = 0; i < u.length; i++) x = (x * 31 + u[i]) >>> 0;
		return u.length + ':' + x;
	}, uuid);

const qDiff = (a, b) => (a && b ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : -1);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// 1. two rigs WITHOUT clips: the KayKit knight (shipped) and a Mixamo-named one
	const mixamo = await mixamoGlb(A.page);
	h.check(Array.isArray(mixamo) && mixamo.length > 1000, 'premise: the Mixamo-named rig exported');
	await A.page.evaluate(async (mixamo) => {
		const knight = await (await fetch('avatars/knight.glb')).arrayBuffer();
		await window.__stores.fileHandler.importFile(
			new File([knight], 'knight.glb'),
			'Knight',
			undefined,
			[-1, 0, 0]
		);
		await window.__stores.fileHandler.importFile(
			new File([new Uint8Array(mixamo)], 'mixamo.glb'),
			'MixamoRig',
			undefined,
			[1, 0, 0]
		);
	}, mixamo);
	await h.eventually(
		() => states(A.page),
		(m) => Object.keys(m).length >= 2,
		'both rigs registered on the bytes path (no clips)'
	);
	const knight = await uuidOf(A.page, 'Knight');
	const rig = await uuidOf(A.page, 'MixamoRig');
	h.check(!!knight && !!rig, 'premise: both rigs are in the scene');
	const before = { knight: await bytesDigest(A.page, knight), rig: await bytesDigest(A.page, rig) };
	h.check(
		!!before.knight && !!before.rig,
		'a rig without clips keeps its original bytes (raw-bytes path)'
	);
	await h.eventually(
		() => uuidOf(B.page, 'Knight'),
		(u) => u === knight,
		'B received the knight as its bytes'
	);

	// 2. the Inspector names each rig
	const rigLabel = async (uuid) => {
		await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid, true), uuid);
		await A.page.waitForSelector('#character-rig', { timeout: 15000 });
		return A.page.evaluate(
			() =>
				document.querySelector('#character-section')?.getAttribute('data-rig') +
				'|' +
				document.querySelector('#character-section')?.getAttribute('data-ok')
		);
	};
	h.check(
		(await rigLabel(knight)) === 'kaykit|1',
		'Inspector ▸ Character: the knight is a full KayKit humanoid'
	);
	h.check(
		(await rigLabel(rig)) === 'mixamo|1',
		'Inspector ▸ Character: the test rig is a full Mixamo humanoid'
	);

	// 3. Apply clip… through the dialog: avatar motion Walking_A onto BOTH
	await A.page.click('#character-apply-clip');
	await A.page.waitForSelector('#apply-clip-dialog #apply-clip-targets .ac-row', {
		timeout: 20000
	});
	// preselect the walk (ThemedSelect is a portaled list; reopen with the source preset instead)
	await A.page.evaluate(() => window.__stores.characterUi.applyClipRequest.set(null));
	await A.page.waitForTimeout(200);
	await A.page.evaluate(
		(rig) =>
			window.__stores.characterUi.openApplyClip({
				targets: [rig],
				src: { lib: 'avatars', clip: 'Walking_A' }
			}),
		rig
	);
	await A.page.waitForSelector(`#apply-clip-targets .ac-row[data-uuid="${knight}"]`, {
		timeout: 20000
	});
	await A.page.waitForFunction(
		() => document.querySelector('#apply-clip-source')?.textContent?.includes('Walking_A'),
		null,
		{ timeout: 20000 }
	);
	await A.page.click(`#apply-clip-targets .ac-row[data-uuid="${knight}"] label`);
	h.check(
		await A.page.evaluate(() =>
			document.querySelector('#apply-clip-go')?.textContent?.includes('Apply to 2')
		),
		'the dialog counts both characters'
	);
	const undoBase = await A.page.evaluate(
		() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))())
	);
	await A.page.click('#apply-clip-go');
	await h.eventually(
		() => states(A.page),
		(m) => m[knight]?.clips?.includes('Walking_A') && m[rig]?.clips?.includes('Walking_A'),
		'A: both characters carry Walking_A'
	);
	const sa = await states(A.page);
	h.check(
		sa[knight].clip === 'Walking_A' && sa[knight].playing && sa[rig].playing,
		'A: and both play it'
	);
	const undoAfter = await A.page.evaluate(
		() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))())
	);
	h.check(undoAfter === undoBase + 1, `one undo step for the apply (${undoBase} -> ${undoAfter})`);

	// 4. it MOVES the bones (the knight's thigh, the rig's UpLeg), and the bytes never changed
	const k1 = await boneQ(A.page, knight, 'upperlegl');
	const r1 = await boneQ(A.page, rig, 'mixamorigLeftUpLeg');
	await A.page.waitForTimeout(500);
	const k2 = await boneQ(A.page, knight, 'upperlegl');
	const r2 = await boneQ(A.page, rig, 'mixamorigLeftUpLeg');
	h.check(qDiff(k1, k2) > 0.005, `the knight's left thigh swings (${qDiff(k1, k2).toFixed(3)})`);
	h.check(
		qDiff(r1, r2) > 0.005,
		`the Mixamo rig's left UpLeg swings (${qDiff(r1, r2).toFixed(3)})`
	);
	h.check(
		(await bytesDigest(A.page, knight)) === before.knight &&
			(await bytesDigest(A.page, rig)) === before.rig,
		"the models' bytes never changed"
	);
	const cfg = await A.page.evaluate((u) => window.__stores.humanoidRig.configOf(u), knight);
	h.check(
		cfg.clips?.length === 1 &&
			cfg.clips[0].src.lib === 'avatars' &&
			cfg.clips[0].licence?.id === 'CC0-1.0',
		'the config names the source + its CC0 licence'
	);

	// 5. B rebuilt the same clip for itself, and plays it
	await h.eventually(
		() => states(B.page),
		(m) =>
			m[knight]?.clips?.includes('Walking_A') &&
			m[knight]?.playing &&
			m[rig]?.clips?.includes('Walking_A'),
		'B: both characters carry + play Walking_A'
	);
	const kb1 = await boneQ(B.page, knight, 'upperlegl');
	await B.page.waitForTimeout(500);
	h.check(
		qDiff(kb1, await boneQ(B.page, knight, 'upperlegl')) > 0.005,
		'B: the knight walks there too'
	);
	h.check((await bytesDigest(B.page, knight)) === before.knight, 'B: same model bytes');

	// 6. a late joiner gets the config with the bytes and retargets for itself
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	await h.eventually(
		() => states(C.page),
		(m) => m[knight]?.clips?.includes('Walking_A') && m[rig]?.clips?.includes('Walking_A'),
		'late joiner C: both characters carry Walking_A'
	);

	// 7. undo takes it off everywhere
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(
		() => states(A.page),
		(m) => !m[knight]?.clips?.includes('Walking_A') && !m[rig]?.clips?.includes('Walking_A'),
		'undo: A drops the clip from both'
	);
	await h.eventually(
		() => states(B.page),
		(m) => !m[knight]?.clips?.includes('Walking_A'),
		'undo: B drops it too'
	);

	// 8. a rig that is not a humanoid is refused with a reason (a lone bone)
	const refused = await A.page.evaluate(async (rig) => {
		const r = await window.__stores.humanoidRig.applyClipTo(
			[rig, 'nope'],
			{ lib: 'avatars', clip: 'Idle' },
			{ play: false }
		);
		return r;
	}, rig);
	h.check(
		refused.applied.length === 1 && refused.refused[0]?.uuid === 'nope',
		'applyClipTo refuses what is not a mapped humanoid, applies the rest'
	);

	await h.finish(browser);
});
