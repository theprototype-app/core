// 92-menus — THE SAVE FILE STAYS COMPATIBLE (GC5 is a save-touching lane: the int's rule).
//
//   A. an OLD scene loads unchanged: an official scene saved by an earlier release, loaded and saved again,
//      has the same physics block and NO `play.menus` appears.
//   C. this lane writes a scene WITH menus (title, saves, auto-admit) to MENUS_OUT (default
//      test-results/92-menus/menus-92.tpscene) and reads it back.
//   B. a file SAVED BY THIS LANE opens in the newest release: run this suite against the release's dev
//      server with MENUS_FILE=<the zip C wrote>; the scene loads and `play.menus` rides a re-save untouched
//      (the older normalizer keeps unknown play keys verbatim).
// Scenes: SHELL_SCENES_DIR=<dir with <slug>/scene.tpscene>, else the sibling scenes checkout (games/<slug>).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const { check } = h;
const SUITE_LIMIT_MS = Number(process.env.SUITE_LIMIT_MS || 240000);
setTimeout(() => {
	console.error(`SUITE TIMEOUT after ${SUITE_LIMIT_MS / 1000} s`);
	process.kill(process.pid, 'SIGKILL');
}, SUITE_LIMIT_MS).unref();
process.on('exit', (c) => c && process.kill(process.pid, 'SIGKILL'));
const SCENES_REPO = [path.resolve(__dirname, '../../../theprototype.app-scenes'), path.resolve(__dirname, '../../../scenes')].find((p) => fs.existsSync(p));
const SLUG = process.env.PLAY_SLUG || 'stars-room';
const oldScene = (() => {
	const dir = process.env.SHELL_SCENES_DIR;
	const p = dir ? path.join(dir, SLUG, 'scene.tpscene') : SCENES_REPO && path.join(SCENES_REPO, 'games', SLUG, 'scene.tpscene');
	return p && fs.existsSync(p) ? p : null;
})();
const OUT = process.env.MENUS_OUT || path.resolve(__dirname, '../../test-results/92-menus/menus-92.tpscene');
const MENUS = { title: { title: 'Compat Title', subtitle: 'saved by 92-menus', background: 'color', color: '#203040' }, saves: { on: true }, autoAdmit: true };

/** load zip bytes in the editor and save again; returns the file's and the re-saved blocks */
async function roundTrip(page, bytes) {
	return page.evaluate(async (arr) => {
		const S = window.__tp.test.v1.sessions;
		const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(what + ' did not finish in ' + ms / 1000 + ' s; dialog: ' + (document.querySelector('[role=dialog],[role=alertdialog]')?.textContent?.trim().slice(0, 120) ?? 'none'))), ms))]);
		const before = await within(S.importSessionZip(new Uint8Array(arr).buffer), 30000, 'import');
		if (!before) throw new Error('import was cancelled');
		await within(S.applySession(before), 60000, 'apply');
		await new Promise((r) => setTimeout(r, 2500));
		const after = S.buildSessionPayload('again', { thumbnail: false });
		const strip = (o) => JSON.parse(JSON.stringify(o ?? null, (k, v) => (k === 'changedAt' || k === 'ts' ? undefined : v)));
		let live;
		window.__tp.test.v1.scenePhysics.scenePhysicsState_.subscribe((x) => (live = x))();
		return { count: after.count, physicsBefore: strip(before.physics), physicsAfter: strip(after.physics), liveMenus: strip(live?.play?.menus ?? null) };
	}, Array.from(bytes));
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	A.page.on('crash', () => console.error('page crashed'));

	if (process.env.MENUS_FILE) {
		// B — this lane's file in whichever build serves the page (the newest release for the proof)
		const r = await roundTrip(A.page, fs.readFileSync(process.env.MENUS_FILE));
		console.log('B', JSON.stringify({ count: r.count, menus: r.physicsAfter?.play?.menus ?? null }));
		check(r.count >= 1, `B: the lane's scene loads (${r.count} objects)`);
		check(JSON.stringify(r.physicsBefore?.play?.menus) === JSON.stringify(MENUS_NORMALIZED()), 'B: the file carries the lane\'s menus');
		check(JSON.stringify(r.physicsAfter?.play?.menus) === JSON.stringify(r.physicsBefore?.play?.menus), 'B: play.menus rides through a re-save untouched');
		const rest = (p) => JSON.stringify({ ...(p ?? {}), play: { ...(p?.play ?? {}), menus: undefined } });
		check(rest(r.physicsAfter) === rest(r.physicsBefore), 'B: the rest of the physics block re-saves unchanged');
		return h.finish(browser);
	}

	// A — an old official scene
	if (!oldScene) check(false, `the ${SLUG} scene is available to the suite`);
	else {
		const r = await roundTrip(A.page, fs.readFileSync(oldScene));
		check(r.count >= 1, `A: the old scene loads (${r.count} objects)`);
		check(JSON.stringify(r.physicsAfter) === JSON.stringify(r.physicsBefore), `A: its physics block re-saves unchanged (${JSON.stringify(r.physicsAfter?.play ?? null).slice(0, 160)})`);
		check(!('menus' in (r.physicsAfter?.play ?? {})), 'A: no play.menus appears');
		check(r.liveMenus === null, 'A: no menus at run time (the 1.74 pause menu)');
	}

	// C — the lane writes a scene with menus
	const bytes = await A.page.evaluate(async (menus) => {
		const s = window.__tp.test.v1;
		await s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		s.scenePhysics.setScenePhysics({ play: { menus } });
		const zip = await s.sessions.exportSessionZip(s.sessions.buildSessionPayload('menus 92', { thumbnail: false }));
		const back = await s.sessions.importSessionZip(zip.buffer);
		window.__e2eBack = back.physics?.play?.menus ?? null;
		return Array.from(zip);
	}, MENUS);
	const back = await A.page.evaluate(() => window.__e2eBack);
	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	fs.writeFileSync(OUT, Buffer.from(bytes));
	check(JSON.stringify(back) === JSON.stringify(MENUS_NORMALIZED()), 'C: the menus survive the .tpscene round trip (' + JSON.stringify(back) + ')');
	console.log('C wrote ' + OUT + ' (' + bytes.length + ' bytes)');
	await h.finish(browser);
});

/** what normalizeGameMenus makes of MENUS (v1) */
function MENUS_NORMALIZED() {
	return { v: 1, title: { on: true, title: 'Compat Title', subtitle: 'saved by 92-menus', background: 'color', color: '#203040', editor: true }, saves: { on: true }, autoAdmit: true };
}
