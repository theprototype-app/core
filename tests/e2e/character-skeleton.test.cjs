// 57 M6 + M2 map editor — the Skeleton view on a Mixamo-named rig, two peers. The humanoid map fix
// is a replicated CONFIG (bytes unchanged); every bone / weight edit rewrites the GLB and replaces
// it on the other peer ONCE when the operation ends; undo puts the old file back everywhere. The rig
// code loads only when the view opens.
const h = require('./helpers.cjs');
const { mixamoGlb } = require('./characterFixtures.cjs');

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
const loaded = (page, re) =>
	page.evaluate(
		(src) => performance.getEntriesByType('resource').some((e) => new RegExp(src).test(e.name)),
		re
	);
const digest = (page, uuid) =>
	page.evaluate((uuid) => {
		const b = window.__stores.animatedImports.animatedImportPayload(uuid);
		if (!b) return null;
		const u = new Uint8Array(b);
		let x = 0;
		for (let i = 0; i < u.length; i++) x = (x * 31 + u[i]) >>> 0;
		return u.length + ':' + x;
	}, uuid);
const boneNames = (page, uuid) =>
	page.evaluate(
		(u) =>
			window.__stores.animatedImports
				.restRowsOf(u)
				.filter((r) => r.bone)
				.map((r) => r.name),
		uuid
	);
const boneWorld = (page, uuid, bone) =>
	page.evaluate(
		({ uuid, bone }) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const b = g?.getObjectByProperty('uuid', uuid)?.getObjectByName(bone);
					if (!b) return r(null);
					b.updateWorldMatrix(true, false);
					r(new window.__stores.THREE.Vector3().setFromMatrixPosition(b.matrixWorld).toArray());
				})()
			),
		{ uuid, bone }
	);
/** how many vertices of the body are NOT 100% on the hips (joint 0) */
const offHips = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					let mesh = null;
					g?.getObjectByProperty('uuid', uuid)?.traverse((o) => o.isSkinnedMesh && (mesh = o));
					if (!mesh) return r(-1);
					const si = mesh.geometry.attributes.skinIndex.array;
					const sw = mesh.geometry.attributes.skinWeight.array;
					let n = 0;
					for (let i = 0; i < sw.length / 4; i++) if (!(si[i * 4] === 0 && sw[i * 4] > 0.999)) n++;
					r(n);
				})()
			),
		uuid
	);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const { page } = A;

	const rig = await mixamoGlb(page);
	await page.evaluate(async (bytes) => {
		await window.__stores.fileHandler.importFile(
			new File([new Uint8Array(bytes)], 'rig.glb'),
			'Rigged',
			undefined,
			[0, 0, 0]
		);
	}, rig);
	await h.eventually(
		() => uuidOf(page, 'Rigged'),
		(u) => !!u,
		'the rig is placed'
	);
	const u = await uuidOf(page, 'Rigged');
	await h.eventually(
		() => uuidOf(B.page, 'Rigged'),
		(x) => x === u,
		'B holds it'
	);
	h.check(!(await loaded(page, 'rigFixes|rigOps|weightsCore')), 'boot: no rig fix-up code loaded');

	// 1. open the view from the Inspector
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), u);
	await page.waitForSelector('#character-skeleton', { timeout: 15000 });
	await page.click('#character-skeleton');
	await page.waitForSelector('#skeleton-window #skeleton-map [data-vrm-bone="leftHand"] select', {
		timeout: 20000
	});
	h.check(await loaded(page, 'rigFixes'), 'the rig code loaded with the view');

	// 2. the map editor: unmap a required bone -> not a humanoid, on both peers; bytes untouched
	const bytes0 = await digest(page, u);
	await page.selectOption('#skeleton-map [data-vrm-bone="leftHand"] select', '__none');
	await h.eventually(
		() => page.evaluate((u) => window.__stores.humanoidRig.humanoidOf(u)?.missing, u),
		(m) => Array.isArray(m) && m.includes('leftHand'),
		'map fix: leftHand unmapped -> missing on A'
	);
	await h.eventually(
		() => B.page.evaluate((u) => window.__stores.humanoidRig?.humanoidOf(u)?.missing ?? null, u),
		(m) => Array.isArray(m) && m.includes('leftHand'),
		'map fix replicated to B'
	);
	await page.selectOption(
		'#skeleton-map [data-vrm-bone="leftHand"] select',
		'mixamorigLeftForeArm'
	);
	await h.eventually(
		() => page.evaluate((u) => window.__stores.humanoidRig.humanoidOf(u)?.map.leftHand, u),
		(v) => v === 'mixamorigLeftForeArm',
		'map fix: a bone can be pointed anywhere'
	);
	await page.click('#skeleton-map-reset');
	await h.eventually(
		() => B.page.evaluate((u) => window.__stores.humanoidRig.humanoidOf(u)?.map.leftHand, u),
		(v) => v === 'mixamorigLeftHand',
		'Reset fixes: back to the detected bone on B'
	);
	h.check((await digest(page, u)) === bytes0, 'map fixes never touch the bytes');

	// 3. Bones: rename the head (rewrite + resend), then undo
	await page.click('#skeleton-tab-bones');
	await page.click('#skeleton-bones [data-bone="mixamorigHead"]');
	await page.fill('#skeleton-rename', 'HeadBone');
	await page.click('#skeleton-window button:has-text("Rename")');
	await h.eventually(
		() => boneNames(page, u),
		(n) => n.includes('HeadBone'),
		'rename: A has HeadBone'
	);
	await h.eventually(
		() => boneNames(B.page, u),
		(n) => n.includes('HeadBone') && !n.includes('mixamorigHead'),
		'rename: B got the new file'
	);
	h.check((await digest(B.page, u)) === (await digest(page, u)), 'both peers hold the same bytes');
	h.check(
		(await page.evaluate((u) => window.__stores.humanoidRig.humanoidOf(u)?.map.head, u)) ===
			'HeadBone',
		'the humanoid map follows the rename'
	);
	await page.evaluate(() => window.__stores.history.undo());
	await h.eventually(
		() => boneNames(B.page, u),
		(n) => n.includes('mixamorigHead'),
		'undo: B is back on the old file'
	);

	// 4. move a bone in the rest pose; mirror puts the other side on it
	await page.click('#skeleton-bones [data-bone="mixamorigLeftArm"]');
	const w0 = await boneWorld(page, u, 'mixamorigLeftArm');
	await page.fill('#skeleton-rest input[aria-label="Rest x"]', '0.2');
	await page.click('#skeleton-rest button:has-text("Move")');
	await h.eventually(
		() => boneWorld(B.page, u, 'mixamorigLeftArm'),
		(w) => w && Math.abs(w[0] - w0[0]) > 0.05,
		'move: the left arm moved in the rest pose (B)'
	);
	await page.click('#skeleton-mirror-lr');
	await h.eventually(
		async () => [
			await boneWorld(B.page, u, 'mixamorigLeftArm'),
			await boneWorld(B.page, u, 'mixamorigRightArm')
		],
		([l, r]) => l && r && Math.abs(r[0] + l[0]) < 1e-3 && Math.abs(r[1] - l[1]) < 1e-3,
		'mirror left -> right: the right arm is the mirror of the moved left one (B)'
	);

	// 5. add + delete
	await page.click('#skeleton-bones [data-bone="mixamorigHead"]');
	await page.fill('#skeleton-child', 'Ponytail');
	await page.click('#skeleton-window button:has-text("Add child")');
	await h.eventually(
		() => boneNames(B.page, u),
		(n) => n.includes('Ponytail'),
		'add: B has the new bone'
	);
	await page.waitForSelector('#skeleton-bones [data-bone="mixamorigLeftToeBase"]');
	await page.click('#skeleton-bones [data-bone="mixamorigLeftToeBase"]');
	await page.click('#skeleton-window button:has-text("Delete")');
	await h.eventually(
		() => boneNames(B.page, u),
		(n) => !n.includes('mixamorigLeftToeBase'),
		'delete: the bone left the skeleton (B)'
	);

	// 6. Weights: automatic weights (worker) spread the body over the bones
	await page.click('#skeleton-tab-weights');
	const off0 = await offHips(page, u);
	h.check(off0 >= 0 && off0 < 24, `premise: the fixture body is mostly on the hips (${off0} off)`);
	await page.click('#skeleton-auto-weights');
	await h.eventually(
		() => offHips(B.page, u),
		(n) => n >= off0 + 8,
		'automatic weights: the body is spread over its bones (B)'
	);
	h.check(await loaded(page, 'weightsWorker'), 'the weights ran in a worker');

	// 7. the brush on the real canvas: paint the left thigh onto the upper body
	await page.click('#skeleton-bones [data-bone="mixamorigLeftUpLeg"]');
	await page.check('#skeleton-brush');
	const before = await digest(page, u);
	const target = await page.evaluate(
		(u) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const root = g.getObjectByProperty('uuid', u);
					const v = new window.__stores.THREE.Vector3(0.15, 1.2, 0.15);
					root.localToWorld(v);
					r(v.toArray());
				})()
			),
		u
	);
	await page.evaluate(() =>
		window.__stores.objectActions.flyTo?.([-0.6, 1.2, 2.2], [0.4, 1.2, 0], 200)
	);
	await page.waitForTimeout(700);
	const px = await h.projectPoint(page, target);
	const onCanvas = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, px);
	h.check(
		onCanvas === 'CANVAS',
		`premise: the brush point is on the viewport, not under a panel (${onCanvas})`
	);
	await page.mouse.move(px.x, px.y);
	await page.mouse.down();
	await page.mouse.move(px.x + 6, px.y + 4, { steps: 4 });
	await page.mouse.up();
	await h.eventually(
		() => digest(page, u),
		(d) => d !== before,
		'brush: the stroke rewrote the file once it lifted'
	);
	await h.eventually(
		async () => (await digest(B.page, u)) === (await digest(page, u)),
		(v) => v === true,
		'brush: B got the painted file'
	);

	await h.finish(browser);
});
