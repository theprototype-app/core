// 57 M9 + M7 — Download… a character with its clips: layout (a) one GLB re-imports with EVERY clip
// (its own + one applied from the avatar motions, baked onto its skeleton), (b) gives the model +
// one .tpanim per clip, a clip as .bvh reads back (three's BVHLoader) with the same joint positions
// at frame 0, .vrma names the human bones, FBX / USD are listed but off. A VRM whose meta says no
// redistribution shows the licence warning in Download, Export and Publish. The writers are lazy.
const h = require('./helpers.cjs');
const fs = require('fs');
const { mixamoGlb, toVrm, readGlb } = require('./characterFixtures.cjs');

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
const loaded = (page, re) =>
	page.evaluate(
		(src) => performance.getEntriesByType('resource').some((e) => new RegExp(src).test(e.name)),
		re
	);

/** click and capture the download's bytes */
async function download(page, selector) {
	const [dl] = await Promise.all([
		page.waitForEvent('download', { timeout: 30000 }),
		page.click(selector)
	]);
	return { name: dl.suggestedFilename(), bytes: fs.readFileSync(await dl.path()) };
}

async function openDownload(page, uuid) {
	await page.evaluate((u) => window.__stores.characterUi.downloadRequest.set(null), uuid);
	await page.waitForTimeout(150);
	await page.evaluate((u) => window.__stores.characterUi.openDownload([u]), uuid);
	await page.waitForSelector('#download-dialog #download-go', { timeout: 20000 });
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const { page } = A;
	h.check(
		!(await loaded(page, 'characterDownload|bvhWriter|glbEdit|clipFiles|three-vrm|vrmRuntime')),
		'boot: no download / BVH / VRM code is loaded'
	);

	// a Mixamo-named rig with its OWN clip (Kick) + an APPLIED one (Walking_A)
	const rig = await mixamoGlb(page, { clip: true });
	await page.evaluate(async (bytes) => {
		await window.__stores.fileHandler.importFile(
			new File([new Uint8Array(bytes)], 'hero.glb'),
			'Hero',
			undefined,
			[0, 0, 0]
		);
	}, rig);
	await h.eventually(
		() => uuidOf(page, 'Hero'),
		(u) => !!u,
		'the rig is placed'
	);
	const hero = await uuidOf(page, 'Hero');
	await page.evaluate(
		(u) => window.__stores.humanoidRig.applyClipTo([u], { lib: 'avatars', clip: 'Walking_A' }),
		hero
	);
	await h.eventually(
		() => states(page),
		(m) => m[hero]?.clips?.includes('Kick') && m[hero]?.clips?.includes('Walking_A'),
		'premise: Hero has its own Kick + the applied Walking_A'
	);

	// 1. through the Inspector: Character ▸ Download…, layout (a)
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), hero);
	await page.waitForSelector('#character-download', { timeout: 15000 });
	await page.click('#character-download');
	await page.waitForSelector('#download-dialog #download-clips [data-clip="Walking_A"]', {
		timeout: 20000
	});
	h.check(
		await loaded(page, 'characterDownload'),
		'the download code loaded when the dialog opened'
	);
	h.check(
		(await page.locator('#download-dialog #download-clips .dl-row').count()) === 2,
		'the dialog lists both clips'
	);
	const a = await download(page, '#download-go');
	h.check(a.name === 'Hero.glb', `(a) downloads one GLB (${a.name})`);
	const aDoc = readGlb(a.bytes);
	const aNames = (aDoc.json.animations ?? []).map((x) => x.name).sort();
	h.check(
		JSON.stringify(aNames) === '["Kick","Walking_A"]',
		`(a) the GLB embeds every clip (${aNames})`
	);
	h.check(
		aDoc.json.extras?.theprototype?.provenance?.some((p) => p.tool === 'download'),
		'(a) the GLB records its provenance in extras'
	);
	const orig = readGlb(rig);
	h.check(
		JSON.stringify(aDoc.json.skins) === JSON.stringify(orig.json.skins) &&
			aDoc.json.nodes.length === orig.json.nodes.length,
		'(a) the model itself is untouched (same skins, same nodes)'
	);
	// ...and it re-imports with every clip
	await page.evaluate(async (bytes) => {
		await window.__stores.fileHandler.importFile(
			new File([new Uint8Array(bytes)], 'Hero.glb'),
			'HeroAgain',
			undefined,
			[2, 0, 0]
		);
	}, Array.from(a.bytes));
	await h.eventually(
		() => uuidOf(page, 'HeroAgain'),
		(u) => !!u,
		'(a) re-imported'
	);
	const again = await uuidOf(page, 'HeroAgain');
	await h.eventually(
		() => states(page),
		(m) => m[again]?.clips?.includes('Kick') && m[again]?.clips?.includes('Walking_A'),
		'(a) the re-import plays BOTH clips as its own'
	);

	// 2. layout (b): model + one .tpanim per clip
	await openDownload(page, hero);
	await page.click('#download-layout-b');
	const b = await download(page, '#download-go');
	h.check(b.name === 'Hero.zip', `(b) downloads a zip (${b.name})`);
	const { unzipSync } = require('fflate');
	const files = unzipSync(new Uint8Array(b.bytes));
	const list = Object.keys(files).sort();
	h.check(
		JSON.stringify(list) === '["Hero-Kick.tpanim","Hero-Walking_A.tpanim","Hero.glb"]',
		`(b) model + one .tpanim per clip (${list})`
	);
	h.check(
		!(readGlb(files['Hero.glb']).json.animations ?? []).length,
		'(b) the model in the zip carries no clips'
	);
	const t = readGlb(files['Hero-Walking_A.tpanim']).json;
	h.check(
		t.extras?.theprototype?.kind === 'clip' &&
			t.extras.theprototype.format === 1 &&
			t.animations?.length === 1,
		'(b) a .tpanim is a skeleton + one animation with extras.theprototype'
	);
	h.check(
		t.extensionsUsed?.includes('VRMC_vrm_animation') &&
			t.extensions.VRMC_vrm_animation.humanoid.humanBones.hips != null,
		'(b) a humanoid .tpanim is VRM Animation inside'
	);

	// 3. one clip as .bvh: same joint positions at frame 0 (three's BVHLoader in node)
	await openDownload(page, hero);
	await page.click('#download-mode-clip');
	await page.selectOption('#download-clip', 'Walking_A');
	await page.check('#download-formats input[value="bvh"]');
	h.check(
		(await page.locator('#download-formats [data-format="fbx"] input').isDisabled()) &&
			(await page.locator('#download-formats [data-format="usd"] input').isDisabled()),
		'FBX / USD are listed, off, with the reason'
	);
	const bvh = await download(page, '#download-go');
	h.check(
		bvh.name === 'Hero-Walking_A.bvh' && bvh.bytes.toString().startsWith('HIERARCHY'),
		`a clip downloads as BVH (${bvh.name})`
	);
	h.check(await loaded(page, 'bvhWriter'), 'the BVH writer loaded only for the BVH download');
	const want = await page.evaluate((u) => {
		const THREE = window.__stores.THREE;
		const ai = window.__stores.animatedImports;
		const rows = ai.restRowsOf(u);
		const clip = ai.clipOf(u, 'Walking_A');
		const L = rows.map((r) => ({ t: r.t.slice(), q: r.q.slice(), s: r.s.slice() }));
		for (const tr of clip.tracks) {
			const [node, prop] = tr.name.split(/\.(?=[^.]+$)/);
			const i = rows.findIndex((r) => r.name === node);
			if (i < 0) continue;
			const v = Array.from(tr.values.slice(0, prop === 'quaternion' ? 4 : 3));
			if (prop === 'quaternion') L[i].q = v;
			else if (prop === 'position') L[i].t = v;
		}
		const M = [];
		const out = {};
		rows.forEach((r, i) => {
			const m = new THREE.Matrix4().compose(
				new THREE.Vector3(...L[i].t),
				new THREE.Quaternion(...L[i].q),
				new THREE.Vector3(...L[i].s)
			);
			if (r.parent >= 0) m.premultiply(M[r.parent]);
			M.push(m);
			if (r.bone) out[r.name] = new THREE.Vector3().setFromMatrixPosition(m).toArray();
		});
		return out;
	}, hero);
	const THREE = await import('three');
	const { BVHLoader } = await import('three/examples/jsm/loaders/BVHLoader.js');
	const res = new BVHLoader().parse(bvh.bytes.toString());
	const mixer = new THREE.AnimationMixer(res.skeleton.bones[0]);
	mixer.clipAction(res.clip).play();
	mixer.setTime(0);
	res.skeleton.bones[0].updateMatrixWorld(true);
	let worst = 0;
	let compared = 0;
	for (const b of res.skeleton.bones) {
		const w = want[b.name];
		if (!w) continue;
		compared++;
		worst = Math.max(
			worst,
			new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).distanceTo(new THREE.Vector3(...w))
		);
	}
	h.check(
		compared >= 20 && worst < 1e-3,
		`.bvh re-imports with the same pose at frame 0 (${compared} joints, worst ${worst.toExponential(2)})`
	);

	// 4. .vrma
	await openDownload(page, hero);
	await page.click('#download-mode-clip');
	await page.selectOption('#download-clip', 'Kick');
	await page.check('#download-formats input[value="vrma"]');
	const vrma = await download(page, '#download-go');
	const vj = readGlb(vrma.bytes).json;
	h.check(
		vrma.name === 'Hero-Kick.vrma' &&
			vj.extensions?.VRMC_vrm_animation?.humanoid?.humanBones?.leftUpperLeg != null,
		`.vrma names the human bones (${vrma.name})`
	);

	// 5. licence warnings: a VRM that says "no redistribution"
	const vrm = toVrm(await mixamoGlb(page, { hair: true }), { version: '1' });
	await page.evaluate(async (bytes) => {
		await window.__stores.fileHandler.importFile(
			new File([new Uint8Array(bytes)], 'locked.vrm'),
			'Locked',
			undefined,
			[-2, 0, 0]
		);
	}, vrm);
	await h.eventually(
		() => uuidOf(page, 'Locked'),
		(u) => !!u,
		'the restricted VRM is placed'
	);
	const locked = await uuidOf(page, 'Locked');
	await h.eventually(
		() => page.evaluate((u) => window.__stores.animatedImports.vrmDebug(u)?.vrm, locked),
		(v) => v === true,
		'premise: it is a VRM'
	);
	await openDownload(page, locked);
	const dlWarn = await page.evaluate(() => {
		const el = document.querySelector('#licence-warnings-download');
		return el ? { restricted: el.getAttribute('data-restricted'), text: el.textContent } : null;
	});
	h.check(
		dlWarn &&
			Number(dlWarn.restricted) >= 1 &&
			/Locked/.test(dlWarn.text) &&
			/passing the file on/.test(dlWarn.text),
		`Download warns (${dlWarn?.text?.replace(/\s+/g, ' ').slice(0, 120)})`
	);
	h.check(
		!(await page.locator('#download-go').isDisabled()),
		'...and still lets you download (warn, never block)'
	);
	await page.evaluate(() => window.__stores.characterUi.downloadRequest.set(null));
	// Export + Publish tabs
	const opened = await page.evaluate(() => {
		const s = window.__stores.exportStores;
		if (!s?.publishExportOpen) return false;
		s.publishExportTab.set('export');
		s.publishExportOpen.set(true);
		return true;
	});
	if (opened) {
		await page.waitForSelector('#licence-warnings-export', { timeout: 20000 }).catch(() => null);
		const ex = await page.evaluate(
			() => document.querySelector('#licence-warnings-export')?.textContent ?? ''
		);
		h.check(
			/Locked/.test(ex) && /redistribut/.test(ex),
			`Export warns (${ex.replace(/\s+/g, ' ').slice(0, 100)})`
		);
		await page.evaluate(() => window.__stores.exportStores.publishExportTab.set('publish'));
		await page.waitForSelector('#licence-warnings-publish', { timeout: 20000 }).catch(() => null);
		h.check(
			/Locked/.test(
				await page.evaluate(
					() => document.querySelector('#licence-warnings-publish')?.textContent ?? ''
				)
			),
			'Publish warns'
		);
	} else h.check(false, 'premise: the Publish / Export stores are on the debug hook');

	await h.finish(browser);
});
