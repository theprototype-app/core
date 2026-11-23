// 63 PG1 (63-export row 1) — AN EXPORTED GAME NEEDS NO INTERNET. Against a BUILT app
// (scripts/serve-build.cjs; a dev server has no export manifest and vite preview silently skips):
//
//   1. three scenes are exported with the DEFAULT options (itch.io preset, packs copied in):
//        starter  the preset starter game (scenes games/starter-dash, row 5) — else Mini Golf
//        packs    a pack-heavy scene (templates/tavern-interior: ~60 pack pieces)
//        sink     text objects + a rigged avatar + a user module + a sky at Max: Football (its
//                 module zip) with a text object, the knight avatar GLB and the meadow sky at Max
//                 added in the editor before the export
//   2. each zip passes scripts/check-export.cjs --preset itch
//   3. each is unzipped and served from a SUBPATH on a SECOND origin inside the itch-style iframe,
//      with EVERY request outside the game's own origin (and the host page's) ABORTED and listed;
//      it boots the slim play entry (no editor page node), reaches Play and is played
//   4. the refused list is EMPTY for all three, the frame logged no console error, and the unit
//      allow list (exportCore.EXPORT_ALLOWED_HOSTS) is empty for these presets
//
// Evidence: EXPORT_EVIDENCE=<dir> writes <scene>.har, <scene>-refused.json and summary.json there
// (the HARs are the release proof). Scenes: STARTER_TPSCENE / PACKS_TPSCENE / SINK_TPSCENE +
// SINK_MODULE_ZIP, else the sibling scenes / modules checkouts. A missing scene SKIPS its row.
const h = require('./helpers.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { unzipSync, strFromU8 } = require('fflate');
const X = require('./export-helpers.cjs');

const ROOT = path.resolve(__dirname, '../..');
const SIBLINGS = path.resolve(ROOT, '..');
const find = (/** @type {(string | undefined)[]} */ list) => list.filter(Boolean).find((p) => fs.existsSync(/** @type {string} */ (p)));
const scenesDir = find([process.env.SCENES_DIR, path.join(SIBLINGS, 'scenes'), path.join(SIBLINGS, 'theprototype.app-scenes')]) || '';
const STARTER = find([process.env.STARTER_TPSCENE, scenesDir && path.join(scenesDir, 'games/starter-dash/scene.tpscene')]);
const GOLF = find([process.env.MINIGOLF_TPSCENE, scenesDir && path.join(scenesDir, 'games/mini-golf/scene.tpscene')]);
const PACKS = find([process.env.PACKS_TPSCENE, scenesDir && path.join(scenesDir, 'templates/tavern-interior/scene.tpscene')]);
const SINK = find([process.env.SINK_TPSCENE, scenesDir && path.join(scenesDir, 'games/football/scene.tpscene')]);
const SINK_ZIP = find([process.env.SINK_MODULE_ZIP, h.moduleZipPath ? h.moduleZipPath('football') : '', ...fs.readdirSync(SIBLINGS).filter((d) => /^(theprototype\.app-)?modules$/.test(d)).map((d) => path.join(SIBLINGS, d, 'football.zip'))]);
const EVIDENCE = process.env.EXPORT_EVIDENCE || '';
const WORK = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tp-export-offline-'));

/** @param {string} zipPath */
function checkItch(zipPath) {
	try {
		return { ok: true, out: execFileSync('node', [path.join(ROOT, 'scripts/check-export.cjs'), zipPath, '--preset', 'itch'], { encoding: 'utf8' }) };
	} catch (e) {
		return { ok: false, out: String(/** @type {any} */ (e).stdout || e) };
	}
}

/** a real key held for a while, inside the frame @param {any} p @param {string} key @param {number} ms */
async function hold(p, key, ms) {
	await p.keyboard.down(key);
	await p.waitForTimeout(ms);
	await p.keyboard.up(key);
}

h.run(async () => {
	const scenes = [
		{ key: 'starter', file: STARTER || GOLF, title: STARTER ? 'Starter Dash' : 'Mini Golf (starter stand-in)' },
		{ key: 'packs', file: PACKS, title: 'Tavern' },
		{ key: 'sink', file: SINK, title: 'Kitchen Sink' }
	];
	for (const s of scenes) if (!s.file) console.log(`SKIP row ${s.key}: no scene file`);
	if (!STARTER) console.log('NOTE: no starter-dash scene yet — Mini Golf stands in for the starter row');
	if (EVIDENCE) fs.mkdirSync(EVIDENCE, { recursive: true });

	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	// a dev server (the desk battery) has no build: SKIP, never fail (export-zip's rule)
	const built = await page.evaluate(() => fetch(new URL('export-manifest.json', document.baseURI)).then((r) => r.ok).catch(() => false));
	if (!built) {
		console.log('SKIP: no export-manifest.json — run against the BUILT app (scripts/serve-build.cjs)');
		await browser.close();
		return;
	}

	// the unit allow list the proof is measured against
	const allowed = await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.exportCore?.EXPORT_ALLOWED_HOSTS ?? null);
	h.check(!!allowed && allowed.itch?.length === 0 && allowed.static?.length === 0, `the allowed outside hosts for itch.io / static exports are none (${JSON.stringify(allowed)})`);

	/** @type {Record<string, any>} */
	const summary = {};
	for (const s of scenes) {
		if (!s.file) continue;
		console.log(`\n--- ${s.key}: ${path.relative(SIBLINGS, s.file)}`);
		await X.loadSceneBytes(page, fs.readFileSync(s.file));
		if (s.key === 'sink') {
			// the user module the scene needs, installed the way a person does (a zip)
			if (SINK_ZIP) {
				await page.evaluate(async (/** @type {number[]} */ arr) => /** @type {any} */ (window).__tp.test.v1.userModules.installZip(new File([new Uint8Array(arr)], 'football.zip')), Array.from(fs.readFileSync(SINK_ZIP)));
				await page.waitForTimeout(1500);
			} else console.log('NOTE: no football.zip — the sink scene exports without its module');
			await page.evaluate(async () => {
				const t = /** @type {any} */ (window).__tp.test.v1;
				// a text object (64-text) — its font must come with the export
				t.textPathEdit.createTextObject({ text: 'Kick off!' }, [0, 2, -3]);
				// the knight (a rigged avatar GLB from the app's own avatars/ folder)
				const res = await fetch(new URL('avatars/knight.glb', document.baseURI));
				const blob = await res.blob();
				await t.fileHandler.importFile(new File([blob], 'knight.glb', { type: 'model/gltf-binary' }));
				// the sky at Max: meadow is the one sky with an 8K file
				t.environment.setEnvironment('meadow');
				t.environment.editEnvSky({ hdri: { quality: 'max' } });
			});
			await page.waitForTimeout(3000);
		}
		const built = await X.buildZip(page, { preset: 'itch', title: s.title });
		const zipPath = path.join(WORK, `${s.key}.zip`);
		fs.writeFileSync(zipPath, built.bytes);
		console.log(`  ${built.fileName}: ${(built.bytes.length / 1048576).toFixed(1)} MB, ${built.stats.files} files; breakdown ${JSON.stringify(built.breakdown)}`);
		for (const w of built.warnings) console.log('  warning: ' + w);
		const check = checkItch(zipPath);
		console.log(check.out);
		h.check(check.ok, `[${s.key}] check-export.cjs --preset itch passes`);
		const entries = unzipSync(new Uint8Array(built.bytes));
		const html = strFromU8(entries['index.html']);
		h.check(/nodes\/4\.|play/.test(html) && !Object.keys(entries).some((n) => n === 'play.html' || n === 'kit.html'), `[${s.key}] the zip boots the play entry (play.html became index.html; no editor / kit page)`);
		if (s.key === 'sink') {
			h.check(Object.keys(entries).some((n) => /^assets\/modules\/.*football/.test(n)) || !SINK_ZIP, `[sink] the user module rides in assets/modules/`);
			h.check(Object.keys(entries).some((n) => /meadow.*8k/i.test(n)), `[sink] the Max sky's 8K file is in the zip`);
		}
		const dir = path.join(WORK, s.key);
		X.unzipTo(new Uint8Array(built.bytes), dir);
		summary[s.key] = { zipBytes: built.bytes.length, files: built.stats.files, breakdown: built.breakdown, warnings: built.warnings };
	}
	await A.ctx.close();

	const routes = Object.fromEntries(scenes.filter((s) => s.file).map((s, i) => [`/html/${5100 + i}/`, path.join(WORK, s.key)]));
	const game = await X.serve(routes);
	const gameOrigin = `http://127.0.0.1:${game.address().port}`;
	const hostDir = path.join(WORK, 'host');
	fs.mkdirSync(hostDir);
	scenes.filter((s) => s.file).forEach((s, i) => fs.writeFileSync(path.join(hostDir, `${s.key}.html`), X.hostHtml(`${gameOrigin}/html/${5100 + i}/index.html`)));
	const host = await X.serve({ '/': hostDir });
	const hostOrigin = `http://localhost:${host.address().port}`;

	for (const s of scenes) {
		if (!s.file) continue;
		const har = EVIDENCE ? path.join(EVIDENCE, `${s.key}.har`) : '';
		const G = await X.openFramed(browser, `${hostOrigin}/${s.key}.html`, { allowOrigins: [gameOrigin, hostOrigin], har });
		await h.eventually(() => X.phaseOf(G.frame), (v) => v.phase === 'playing' || v.phase === 'failed', `[${s.key}] the exported game boots and asks for Play`, 90000);
		const st = await G.frame.evaluate(() => {
			const t = /** @type {any} */ (window).__tp.test.v1;
			let locked;
			t.isLocked.subscribe((/** @type {any} */ v) => (locked = v))();
			let group;
			t.objectsGroup.subscribe((/** @type {any} */ v) => (group = v))();
			return { phase: t.exportRuntime.exportRuntimeState.phase, error: t.exportRuntime.exportRuntimeState.error, locked, objects: group?.children.length ?? 0, editor: !!document.querySelector('#editor-chrome, #sidebar, #logo-menu') };
		});
		h.check(st.phase === 'playing' && st.locked === true, `[${s.key}] playing (${st.phase}${st.error ? ' — ' + st.error : ''}, ${st.objects} objects)`);
		h.check(!st.editor, `[${s.key}] no editor chrome in the page at all (the play entry)`);

		// play it: the starter to its win screen, the others for a while with real input
		await G.p.mouse.click(640, 360);
		if (s.key === 'starter' && STARTER) {
			const won = await G.frame.evaluate(() => /** @type {any} */ (window).__starterDash?.autoplay?.());
			h.check(won === true, `[starter] the starter game is played to its win screen`);
		} else {
			await hold(G.p, 'KeyW', 1500);
			await G.p.mouse.move(700, 360, { steps: 6 });
			await hold(G.p, 'KeyD', 800);
			await hold(G.p, 'Space', 200);
			await G.p.waitForTimeout(8000);
		}
		await G.p.waitForTimeout(2000);
		if (EVIDENCE) await G.p.screenshot({ path: path.join(EVIDENCE, `${s.key}-playing.png`) });
		const fetchErrors = G.errors.filter((e) => /fetch|net::|ERR_|load|404/i.test(e));
		console.log(`  [${s.key}] refused ${G.refused.length}: ${G.refused.slice(0, 12).join(' | ')}`);
		if (G.errors.length) console.log(`  [${s.key}] console errors: ${G.errors.slice(0, 8).join(' | ')}`);
		h.check(G.refused.length === 0, `[${s.key}] ZERO requests outside the game's origin (${G.refused.length})`);
		if (G.missing.length) console.log(`  [${s.key}] missing in the zip: ${G.missing.slice(0, 12).join(' | ')}`);
		h.check(G.missing.length === 0, `[${s.key}] every file the game asks its own origin for is in the zip (${G.missing.length} missing)`);
		h.check(fetchErrors.length === 0, `[${s.key}] no failed-load console errors (${fetchErrors.length})`);
		summary[s.key] = { ...summary[s.key], refused: G.refused, missing: G.missing, consoleErrors: G.errors };
		if (EVIDENCE) fs.writeFileSync(path.join(EVIDENCE, `${s.key}-refused.json`), JSON.stringify(G.refused, null, 2));
		await G.ctx.close();
	}
	if (EVIDENCE) fs.writeFileSync(path.join(EVIDENCE, 'summary.json'), JSON.stringify(summary, null, 2));
	game.close();
	host.close();
	await browser.close();
});
