// 102 — GAUSSIAN SPLATS: REDUCE TO FIT. A splat file over the Library's 25 MB cap cannot be stored or
// shared as it is; the import offers a smaller copy (convert to .spz -> drop the view-dependent colour
// -> keep the most solid splats) and stores THAT, as <name>.spz.
//
//   §1 a 26 MB 3DGS .ply (110 000 splats, colour bands 3, made here) dropped on the viewport asks
//      "This splat is over the 25 MB file limit" with the plan's size
//   §2 "Make a smaller copy" stores big.spz under the cap, places it, and keeps every splat
//   §3 the over-cap original is not stored
//
// One page (the splats suite covers peers); its own file so each suite fits the runner's 8 min cap.
// Run: e2e-slot --dev <lane> 7076 -- env APP_URL=https://theprototype.app:7076/ npm run e2e -- splats-reduce
const h = require('./helpers.cjs');
const { gaussianPly, carriers, items, pick } = require('./splatFixtures.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	A.page.on('crash', () => console.log('  [A] PAGE CRASHED'));
	// look up at the sky: nothing to draw, so timers and imports run at full speed on a software-GL slot
	await A.page.evaluate(() => {
		const v1 = window.__tp.test.v1;
		let cam, oc;
		v1.globalCamera.subscribe((c) => (cam = c))();
		v1.orbitControls?.subscribe?.((c) => (oc = c))?.();
		cam.position.set(0, 3, 0);
		if (oc?.target) {
			oc.target.set(0, 30, 0.01);
			oc.update?.();
		} else cam.lookAt(0, 30, 0.01);
	});

	const BIG = 110000;
	const big = gaussianPly(BIG, 3);
	console.log(`  big .ply ${(big.length / 1048576).toFixed(1)} MB`);
	await pick(A.page, 'big.ply', big);
	/** @type {any} */
	let dialog = null;
	await h.eventually(
		async () =>
			(dialog = await A.page.evaluate(() => {
				let d;
				window.__tp.test.v1.confirmDialog.confirmDialog.subscribe((x) => (d = x))();
				return d ? { id: d.id, title: d.title, message: d.message, items: d.items } : null;
			})),
		(d) => !!d && d.id === 'splat-reduce',
		'§1 an over-cap .ply asks to make a smaller copy',
		120000
	);
	console.log(`  dialog: ${dialog?.title} | ${dialog?.message} | ${JSON.stringify(dialog?.items)}`);
	h.check(/26(\.0)? MB/.test(dialog?.message ?? '') && /110,000 splats|110 k splats/.test(dialog?.message ?? ''), '§1 ...naming the file size and the splat count');
	h.check(/\.spz/.test((dialog?.items ?? [])[0] ?? ''), '§1 ...and the step the plan takes (convert to .spz)');

	await A.page.evaluate(() => window.__tp.test.v1.confirmDialog.resolveConfirm('reduce'));
	await h.eventually(() => carriers(A.page), (c) => c.some((x) => x.splat.file === 'big.spz'), '§2 the smaller copy is placed as big.spz', 240000);
	const bigItem = (await items(A.page)).find((it) => it.name === 'big.spz');
	const bigRec = (await carriers(A.page)).find((x) => x.splat.file === 'big.spz');
	h.check(!!bigItem && bigItem.kind === 'splat' && bigItem.size <= 25 * 1024 * 1024, `§2 ...a splat item under the 25 MB cap (${((bigItem?.size ?? 0) / 1048576).toFixed(1)} MB from ${(big.length / 1048576).toFixed(1)} MB)`);
	h.check(bigRec?.splat.count === BIG, `§2 ...every splat kept (${bigRec?.splat.count})`);
	h.check(!(await items(A.page)).some((it) => it.name === 'big.ply'), '§3 the over-cap original is not stored');

	await h.finish(browser);
});
