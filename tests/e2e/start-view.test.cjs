// 36 L2 — THE SCENE START VIEW: applied at the START of a load, and a user's move wins.
//
// The report: Tavern Interior and Market Square snapped the camera back a few seconds into the
// load; Forest Clearing and Castle Courtyard did not. The cause (scripts/start-view-probe.cjs):
// the saved view was applied at the END of the restore, ~0.1 s into a pack-stub scene and
// ~2.6 s into a scene of inline objects. For each of the four scenes, opened the Templates way
// (loadRemoteScene -> importSessionZip -> applySession), in a fresh page:
//   still   no input: the camera is on the saved view BEFORE the build ends, ends on it, and
//           no "Back to start view" button appears
//   moved   a REAL orbit drag while the scene loads: no frame after the drag ever lands back
//           on the saved view, the camera ends where the drag left it, the Back button
//           appears and flies back (Home on one scene)
// plus the autosave Restore path (Tavern), which applied the camera the same late way.
// COUNTERFACTUAL (recorded in the lane evidence): with 1.21's late apply restored, the Tavern
// and Market `moved` checks go red — the camera snaps back at the end of the build.
//
//   APP_URL=https://theprototype.app:5345/ node tests/e2e/start-view.test.cjs
//   SLUGS=tavern-interior,…  SCENES_DIR=<scenes checkout>  PACKS_DIR=<packs mirror>  VIDEO=1
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');
const S = require('./startViewShared.cjs');

const SLUGS = (process.env.SLUGS || 'tavern-interior,market-square,castle-courtyard,forest-clearing').split(',').filter(Boolean);
/** the scenes whose build outlasts a drag (inline objects): the drag must END before the build does */
const SLOW = new Set(['tavern-interior', 'market-square']);

h.run(async () => {
	const index = S.readIndex();
	if (!index) {
		console.log('SKIP: no scenes feed at ' + S.SCENES_DIR);
		process.exit(0);
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	for (const slug of SLUGS) {
		if (!S.entryOf(index, slug)) {
			h.check(false, slug + ' is in the scenes feed');
			continue;
		}
		// ---- still ------------------------------------------------------------------------
		console.log('-- ' + slug + ' / still');
		{
			const A = await S.preparePeer(browser, slug + '-still', index, slug);
			h.check(!!A.saved?.position, `${slug}: the file carries a saved view`);
			await A.page.evaluate(S.ARM);
			await A.page.evaluate((url) => void window.__stores.sceneTemplates.loadRemoteScene({ slug: 'x', title: 'x', sceneUrl: url }), A.sceneUrl);
			await S.loadEnded(A.page, `${slug}: the load ends`);
			await A.page.waitForTimeout(1200);
			const rec = await S.disarm(A.page);
			const onView = (/** @type {any} */ s) => S.dist(s.p, A.saved.position) < 0.02 && S.dist(s.q, A.saved.target) < 0.02;
			const parked = rec.samples.find(onView);
			const buildEnd = rec.phases.find((p) => p.phase === 'models')?.t ?? Infinity;
			h.check(!!parked && parked.t < 600, `${slug}: the camera is on the saved view ${parked?.t} ms into the load (< 600)`);
			h.check(!!parked && parked.t <= buildEnd, `${slug}: …before the objects are built (build ended at ${buildEnd} ms)`);
			const after = rec.samples.filter((s) => parked && s.t >= parked.t);
			const strays = after.filter((s) => !onView(s)).length;
			h.check(strays === 0, `${slug}: with no input it never leaves the view (${strays} of ${after.length} frames off it)`);
			const end = await S.camPose(A.page);
			h.check(S.dist(end.position, A.saved.position) < 0.02, `${slug}: the load ends on the start view`);
			h.check((await S.startView(A.page)).hint === null, `${slug}: no "Back to start view" when nobody moved`);
			await A.ctx.close();
		}
		// ---- moved ------------------------------------------------------------------------
		console.log('-- ' + slug + ' / moved');
		{
			const video = process.env.VIDEO !== '0' && slug === 'tavern-interior';
			const videoDir = path.join(S.SHOTS, 'video-tmp');
			const A = await S.preparePeer(browser, slug + '-moved', index, slug, video ? { context: { recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } } } : {});
			await A.page.evaluate(S.ARM);
			await A.page.evaluate((url) => void window.__stores.sceneTemplates.loadRemoteScene({ slug: 'x', title: 'x', sceneUrl: url }), A.sceneUrl);
			await A.page.waitForTimeout(450);
			await S.orbitDrag(A.page);
			await S.loadEnded(A.page, `${slug}: the load ends`);
			await A.page.waitForTimeout(1200);
			const rec = await S.disarm(A.page);
			const loadEnd = rec.phases.filter((p) => p.phase === 'none').pop()?.t ?? 0;
			const buildEnd = rec.phases.find((p) => p.phase === 'models')?.t ?? 0;
			// a fast scene can finish while the drag is still going: what matters is that the drag
			// MOVED the camera while the load ran (that is what loading used to override)
			const leftView = rec.samples.find((s) => s.t >= rec.down && S.dist(s.p, A.saved.position) > 0.05);
			h.check(!!leftView && leftView.t < loadEnd, `${slug}: premise — the drag moved the camera while the scene was loading (${leftView?.t} < ${loadEnd} ms)`);
			if (SLOW.has(slug)) h.check(rec.up < buildEnd, `${slug}: premise — …before the build ended, where 1.21 applied the view (${rec.up} < ${buildEnd} ms)`);
			const back = rec.samples.find((s) => s.t > rec.up && S.dist(s.p, A.saved.position) < 0.3);
			h.check(!back, `${slug}: no frame after the drag lands back on the saved view${back ? ' (snapped at ' + back.t + ' ms)' : ''}`);
			// the late apply ran controls.update() with the drag's leftover damping, so its snap can
			// land metres off the view: catch it as a one-frame JUMP (damping moves a frame < 1 m)
			const jump = S.maxJumpAfter(rec.samples, rec.up);
			h.check(jump.m < 2.5, `${slug}: no one-frame jump after the drag (largest ${jump.m.toFixed(2)} m at ${jump.t} ms)`);
			const end = await S.camPose(A.page);
			h.check(S.dist(end.position, A.saved.position) > 1, `${slug}: the camera ends where the user left it (${S.dist(end.position, A.saved.position).toFixed(2)} m from the start view)`);
			const sv = await S.startView(A.page);
			h.check(sv.moved === true && sv.hint?.kind === 'back', `${slug}: the move was seen and "Back to start view" is offered (${JSON.stringify(sv.hint)})`);
			h.check(await A.page.locator('#start-view-back').isVisible(), `${slug}: the Back button is on screen`);
			h.check((await A.page.locator('[data-tour="start-view-back"]').count()) === 1, `${slug}: it carries its data-tour id`);
			if (slug === 'tavern-interior') await S.shot(A.page, '03-back-to-start-view-dark.png');
			if (slug === 'castle-courtyard') {
				// Home works whether or not the button is still up
				await A.page.keyboard.press('Home');
			} else if (await A.page.locator('#start-view-back').isVisible()) await A.page.locator('#start-view-back').click();
			else await A.page.keyboard.press('Home'); // (only when the check above already failed)
			await A.page.waitForTimeout(1100);
			const home = await S.camPose(A.page);
			h.check(S.dist(home.position, A.saved.position) < 0.3, `${slug}: ${slug === 'castle-courtyard' ? 'Home' : 'the button'} flies back to the start view (${S.dist(home.position, A.saved.position).toFixed(3)} m)`);
			h.check(!(await A.page.locator('#start-view-back').isVisible()), `${slug}: the button is gone once used`);
			await A.ctx.close();
			if (video) {
				const file = fs.readdirSync(videoDir).find((f) => f.endsWith('.webm'));
				if (file) {
					fs.renameSync(path.join(videoDir, file), path.join(S.SHOTS, '08-tavern-move-mid-load.webm'));
					console.log('  video 08-tavern-move-mid-load.webm');
				}
				fs.rmSync(videoDir, { recursive: true, force: true });
			}
		}
	}

	// ---- the autosave Restore path ----------------------------------------------------------
	if (SLUGS.includes('tavern-interior')) {
		console.log('-- restore');
		const A = await S.preparePeer(browser, 'restore', index, 'tavern-interior');
		await A.page.evaluate(S.ARM);
		await A.page.evaluate((url) => window.__stores.sceneTemplates.loadRemoteScene({ slug: 'x', title: 'x', sceneUrl: url }), A.sceneUrl);
		await S.loadEnded(A.page, 'restore: the scene loads first');
		await A.page.waitForTimeout(1500);
		await A.page.evaluate(() => window.__stores.autosave.saveNow());
		await A.page.reload({ waitUntil: 'domcontentloaded' });
		await A.page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 60000 });
		await h.eventually(
			() => A.page.evaluate(() => { let v; window.__stores.autosave.restoreAvailable.subscribe((x) => (v = x))(); return !!v; }),
			(v) => v,
			'restore: the Restore offer is up after the reload',
			30000
		);
		await A.page.evaluate(S.ARM);
		await A.page.evaluate(() => void window.__stores.autosave.restoreSnapshot());
		await A.page.waitForTimeout(450);
		await S.orbitDrag(A.page);
		await S.loadEnded(A.page, 'restore: the restore ends');
		await A.page.waitForTimeout(1200);
		const rec = await S.disarm(A.page);
		const loadEnd = rec.phases.filter((p) => p.phase === 'none').pop()?.t ?? 0;
		const parked = rec.samples.find((s) => S.dist(s.p, A.saved.position) < 0.02);
		h.check(!!parked && parked.t < 800, `restore: the saved view is applied at the start (${parked?.t} ms)`);
		h.check(rec.up > 0 && rec.up < loadEnd, `restore: premise — the drag ended mid-restore (${rec.up} < ${loadEnd} ms)`);
		const back = rec.samples.find((s) => s.t > rec.up && S.dist(s.p, A.saved.position) < 0.3);
		h.check(!back, `restore: no frame after the drag lands back on the saved view${back ? ' (snapped at ' + back.t + ' ms)' : ''}`);
		const jump = S.maxJumpAfter(rec.samples, rec.up);
		h.check(jump.m < 2.5, `restore: no one-frame jump after the drag (largest ${jump.m.toFixed(2)} m at ${jump.t} ms)`);
		await A.ctx.close();
	}
	await h.finish(browser);
});
