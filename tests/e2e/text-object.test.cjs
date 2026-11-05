// 64-text — THE ONE TEXT OBJECT: flat (troika) and solid (extruded) on one record, bundled and
// user-added fonts, Bake → mesh, the per-device cap. Measured through `textPathDebug()` (glyph
// layout, the solid build's triangles / missing glyphs, the font each peer drew with) and the
// record itself; the pictures go to OUT.
//
//   §1 /create Text on two peers: a flat BLOCK (no path) — both peers lay the same glyphs out;
//      Wrap width breaks it into lines, Anchor moves it, every edit undoes on both peers
//   §2 Solid: A and B build the extruded mesh from the record; each bundled font builds "HELLO"
//      with no missing glyph; depth / bevel / quality change the mesh; undo; flat ↔ solid keeps
//      the text and its style
//   §3 the mesh is never saved: a serializer (toJSON under the park ritual) sees the placeholder
//   §4 (run LAST) save → reload → identical record, the solid rebuilt from it
//   §5 Bake → mesh on A: a normal mesh on A and B (no record, same triangle count), its
//      vertices editable; ONE undo brings the text back
//   §6 the cap: a phone / headset writer is refused past its solid cap with the plain message
//   §7 fonts: an uploaded WOFF (as a TTF-class file) and a WOFF2 (decoded on import) become
//      Library fonts; a Google font by name (mocked CSS + file), then Google BLOCKED: B pulls the
//      bytes from A and draws with it, the scene's asset list (what a .tpscene / export carries)
//      names it; a no-embedding font raises the export licence warning
//   §8 the Inspector: Flat / Solid buttons, the solid rows, the licence line (screenshots)
//   §9 the agent: create_text "HELLO" solid with a bevel on both peers, set_geometry params,
//      list_fonts, one undo per call
//   §10 a record from a newer build: one notice, and an edit here keeps its fields on B
//
// Counterfactual: v1.60.0 has no Text kind — `/create Text` makes nothing, every row is red.
// Run: e2e-slot --dev <lane> 5996 -- env APP_URL=https://localhost:5996/ npm run e2e -- text-object
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const OUT = process.env.E2E_OUT ?? 'test-results/64-text-object';
fs.mkdirSync(OUT, { recursive: true });

/** @param {any} page */
const dbg = (page) => page.evaluate(() => window.__stores.textPath.textPathDebug());
/** @param {any} page @param {string} uuid */
const one = async (page, uuid) => (await dbg(page)).find((/** @type {any} */ d) => d.uuid === uuid);
/** @param {any} page @param {string} uuid @param {any} patch */
const set = (page, uuid, patch) => page.evaluate(([u, p]) => !!window.__stores.textPathEdit.setTextPathFor(u, p), [uuid, patch]);
/** @param {any} page @param {string} uuid */
const record = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return JSON.parse(JSON.stringify(g.getObjectByProperty('uuid', u)?.userData?.textPath ?? null));
	}, uuid);
/** the carrier's own geometry/material facts @param {any} page @param {string} uuid */
const carrier = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		if (!o) return null;
		return {
			verts: o.geometry?.getAttribute?.('position')?.count ?? 0,
			groups: o.geometry?.groups?.length ?? 0,
			matIndexes: [...new Set((o.geometry?.groups ?? []).map((gr) => gr.materialIndex))],
			mats: Array.isArray(o.material) ? o.material.map((m) => m.type + ':' + m.color.getHexString()) : [o.material?.type],
			text: !!o.userData.textPath
		};
	}, uuid);
/** @param {any} page @param {string} uuid @param {(d: any) => boolean} pred @param {string} label */
async function until(page, uuid, pred, label, timeout = 30000) {
	await h.eventually(async () => (await one(page, uuid)) ?? null, (d) => !!d && pred(d), label, timeout);
	return one(page, uuid);
}
const solidBuilt = (/** @type {any} */ d) => d.mode === 'extruded' && !!d.solid && !d.solid.building && d.solid.triangles > 0;
const undo = (/** @type {any} */ page) => page.evaluate(() => window.__stores.history.undo());
const redo = (/** @type {any} */ page) => page.evaluate(() => window.__stores.history.redo());
/** the y of every glyph baseline, rounded @param {any} d */
const lineYs = (d) => [...new Set(d.baseline.map((/** @type {number[]} */ p) => +p[1].toFixed(2)))];

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---- §1 flat block --------------------------------------------------------------------
	const uuid = await A.page.evaluate(() => window.__stores.addObjects.spawnAtPoint('/create Text', [0, 1, 0]).uuid);
	const a1 = await until(A.page, uuid, (d) => d.synced && d.glyphs === 4, '§1 A lays "Text" out as a flat block');
	await until(B.page, uuid, (d) => d.synced && d.glyphs === 4, '§1 B lays the same 4 glyphs out');
	h.check(a1.block && a1.mode === 'flat', `§1 a new text is a flat block (block=${a1.block}, mode=${a1.mode})`);
	await set(A.page, uuid, { text: 'one two three four five six' });
	const wide = await until(B.page, uuid, (d) => d.synced && d.text === 'one two three four five six', '§1 B follows the new text');
	h.check(lineYs(wide).length === 1, `§1 no wrap width = one line (${lineYs(wide).length})`);
	await set(A.page, uuid, { maxWidth: 1.2 });
	const wrapped = await until(B.page, uuid, (d) => d.synced && lineYs(d).length >= 3, '§1 Wrap width 1.2 m breaks it into lines on B');
	h.check(lineYs(wrapped).length >= 3, `§1 wrapped into ${lineYs(wrapped).length} lines`);
	const xBefore = Math.min(...wrapped.baseline.map((/** @type {number[]} */ p) => p[0]));
	await set(A.page, uuid, { anchor: 'top-left' });
	const anchored = await until(B.page, uuid, (d) => d.synced && Math.min(...d.baseline.map((/** @type {number[]} */ p) => p[0])) > xBefore + 0.3, '§1 Anchor top-left moves the block right of the origin on B');
	h.check(Math.min(...anchored.baseline.map((/** @type {number[]} */ p) => p[0])) > -0.05, '§1 top-left anchor: the block starts at the object');
	await undo(A.page);
	await until(B.page, uuid, (d) => d.synced && Math.abs(Math.min(...d.baseline.map((/** @type {number[]} */ p) => p[0])) - xBefore) < 0.05, '§1 undo the anchor (on B)');
	await undo(A.page);
	await until(B.page, uuid, (d) => d.synced && lineYs(d).length === 1, '§1 undo the wrap (on B)');

	// ---- §2 solid -------------------------------------------------------------------------
	await set(A.page, uuid, { text: 'HELLO', mode: 'extruded' });
	const s1 = await until(A.page, uuid, solidBuilt, '§2 A builds the solid text');
	const s1b = await until(B.page, uuid, solidBuilt, '§2 B builds the same solid text from the record');
	h.check(s1.solid.triangles === s1b.solid.triangles && s1.solid.drawn === 5 && s1.solid.missing === 0, `§2 same mesh on both peers: ${s1.solid.triangles} / ${s1b.solid.triangles} triangles, 5 letters, 0 missing`);
	const c1 = await carrier(A.page, uuid);
	h.check(c1.groups >= 2 && c1.matIndexes.every((/** @type {number} */ i) => i === 0 || i === 1) && c1.mats.length === 2 && c1.mats[0].startsWith('MeshStandardMaterial'), `§2 the carrier IS the mesh: face (0) + side (1) groups, two materials (${JSON.stringify(c1.mats)})`);
	const fonts = await A.page.evaluate(() => window.__stores.textFonts.bundledFonts().map((f) => f.id));
	h.check(fonts.length >= 5, `§2 at least five bundled fonts (${fonts.join(', ')})`);
	for (const f of fonts) {
		await set(A.page, uuid, { font: f });
		const d = await until(A.page, uuid, (x) => solidBuilt(x) && x.font === f && String(x.fontUrl).includes(f === 'sans' ? 'sans-serif' : '') && x.solid.drawn === 5, `§2 font ${f} builds`);
		h.check(d.solid.missing === 0, `§2 ${f}: "HELLO" has no missing glyph (${d.solid.triangles} triangles)`);
		await until(B.page, uuid, (x) => solidBuilt(x) && x.font === f, `§2 B builds ${f} too`);
	}
	await set(A.page, uuid, { font: 'sans' });
	const base = await until(A.page, uuid, (d) => solidBuilt(d) && d.font === 'sans', '§2 back on sans');
	await set(A.page, uuid, { bevel: { size: 0 } });
	const noBevel = await until(A.page, uuid, (d) => solidBuilt(d) && d.solid.triangles < base.solid.triangles, '§2 no bevel = fewer triangles');
	await set(A.page, uuid, { quality: 'high' });
	await until(A.page, uuid, (d) => solidBuilt(d) && d.solid.triangles > noBevel.solid.triangles, '§2 high quality = more triangles');
	await undo(A.page);
	await undo(A.page);
	await until(B.page, uuid, (d) => solidBuilt(d) && d.solid.triangles === base.solid.triangles, '§2 two undos restore the bevel + quality on B');
	await set(A.page, uuid, { depth: 0.4, color: '#ff8800', sideColor: '#224488', emissive: 1 });
	await h.eventually(() => carrier(B.page, uuid), (c) => !!c && c.mats[0]?.endsWith('ff8800') && c.mats[1]?.endsWith('224488'), '§2 B draws the face orange and the sides blue', 20000);
	await set(A.page, uuid, { mode: 'flat' });
	const back = await until(B.page, uuid, (d) => d.mode === 'flat' && d.synced && d.glyphs === 5, '§2 flat again on B');
	const r2 = await record(B.page, uuid);
	h.check(back.text === 'HELLO' && r2.color === '#ff8800' && r2.depth === 0.4, '§2 flat ↔ solid keeps the text, colour and solid settings');
	const c3 = await carrier(A.page, uuid);
	h.check(c3.mats.length === 1 && c3.groups === 0, `§2 flat: the carrier is the invisible hit proxy again (${JSON.stringify(c3.mats)})`);
	await set(A.page, uuid, { mode: 'extruded' });
	await until(A.page, uuid, solidBuilt, '§2 solid again');

	// ---- §3 the mesh is never saved ---------------------------------------------------------
	const saved = await A.page.evaluate(async (u) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		const unpark = window.__stores.flowRuntime.parkAnimatedAtBase();
		const json = o.toJSON();
		unpark();
		const geo = json.geometries?.[0];
		const verts = geo?.data?.attributes?.position?.array?.length ?? -1;
		return { verts, after: o.geometry.getAttribute('position').count, bytes: JSON.stringify(json).length };
	}, uuid);
	h.check(saved.verts > 0 && saved.verts <= 12 && saved.after > 100, `§3 a serializer sees the placeholder (${saved.verts / 3} verts, ${saved.bytes} bytes), the scene keeps the mesh (${saved.after} verts)`);

	// ---- §5 Bake -> mesh -----------------------------------------------------------------
	const premise5 = await until(A.page, uuid, solidBuilt, '§5 premise: the solid text is built on A');
	const tri = premise5.solid.triangles;
	const baked = await A.page.evaluate((u) => window.__stores.textPathEdit.bakeTextToMesh(u), uuid);
	h.check(baked.ok, '§5 Bake to mesh succeeds');
	const ca = await carrier(A.page, uuid);
	await h.eventually(() => carrier(B.page, uuid), (c) => !!c && !c.text && c.verts === tri * 3, '§5 B holds the baked mesh (no record, same vertices)', 20000);
	h.check(!ca.text && ca.verts === tri * 3, `§5 a normal mesh on A (${ca.verts} verts) and B`);
	const edited = await A.page.evaluate((u) => {
		window.__stores.meshEdit.enterEditMode(u);
		let e;
		window.__stores.meshEdit.editingObject.subscribe((v) => (e = v))(); // the uuid being edited
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const n = e === u ? window.__stores.meshEdit.vertexCount(g.getObjectByProperty('uuid', u)) : 0;
		window.__stores.meshEdit.exitEditMode();
		return n;
	}, uuid);
	h.check(edited > 0, `§5 its vertices are editable (${edited} in the vertex editor)`);
	await undo(A.page);
	await until(A.page, uuid, solidBuilt, '§5 ONE undo brings the text back on A');
	await until(B.page, uuid, solidBuilt, '§5 ...and on B');
	const nameOf = (/** @type {any} */ page) => page.evaluate((u) => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return g.getObjectByProperty('uuid', u)?.name; }, uuid);
	const undoneName = await nameOf(A.page);
	h.check(undoneName === 'Text', `§5 the undo gives the name back ("${undoneName}", Bake had made it "Text mesh")`);
	await redo(A.page);
	await h.eventually(() => carrier(A.page, uuid), (c) => !!c && !c.text && c.verts === tri * 3, '§5 a REDO bakes again on A (the mesh, not a bare carrier)', 20000);
	await h.eventually(() => carrier(B.page, uuid), (c) => !!c && !c.text && c.verts === tri * 3, '§5 ...and on B', 20000);
	await undo(A.page);
	await until(A.page, uuid, solidBuilt, '§5 undo again: the text is back for the rest of the suite');
	await until(B.page, uuid, solidBuilt, '§5 ...on B too');

	// fix-bake (the 1.61.0 production red): Bake → Undo → Redo within about a second, five times, the gap
	// between the undo and the redo growing from none to a second. The writer's redo is the one that raced
	// (it kept its text while B baked); both peers must end as the mesh, and STAY it.
	const loopRed = [];
	for (const [i, gap] of [0, 60, 250, 600, 1000].entries()) {
		const n = i + 1;
		await until(A.page, uuid, solidBuilt, `§5 loop ${n}: the solid text is built on A`);
		await until(B.page, uuid, solidBuilt, `§5 loop ${n}: ...and on B`);
		const ran = await A.page.evaluate(
			async ([u, ms]) => {
				// solidBuilt reads the runtime record; an autosave export parks the solid geometry across its
				// async encode, and Bake then refuses ("still being built — try again"). Try again, as a user would.
				let out = await window.__stores.textPathEdit.bakeTextToMesh(u);
				for (let t = 0; !out.ok && /still being built/.test(out.error) && t < 40; t++) {
					await new Promise((r) => setTimeout(r, 250));
					out = await window.__stores.textPathEdit.bakeTextToMesh(u);
				}
				if (!out.ok) return out;
				window.__stores.history.undo();
				if (ms) await new Promise((r) => setTimeout(r, ms));
				window.__stores.history.redo();
				return out;
			},
			[uuid, gap]
		);
		if (!ran.ok) {
			// no bake, no undo/redo ran: undoing here would pop an unrelated entry and break every later loop
			loopRed.push(`${n}: bake refused (${ran.error})`);
			continue;
		}
		await h.eventually(() => carrier(A.page, uuid), (c) => !!c && !c.text && c.verts === tri * 3, `§5 loop ${n} (gap ${gap} ms): the redo bakes A`, 20000);
		await h.eventually(() => carrier(B.page, uuid), (c) => !!c && !c.text && c.verts === tri * 3, `§5 loop ${n} (gap ${gap} ms): ...and B`, 20000);
		// past an autosave export (it parks the solid geometry while it runs) and a late runtime build
		await A.page.waitForTimeout(1500);
		const [lateA, lateB] = [await carrier(A.page, uuid), await carrier(B.page, uuid)];
		if (lateA?.text || lateB?.text || lateA?.verts !== tri * 3 || lateB?.verts !== tri * 3)
			loopRed.push(`${n} (gap ${gap}): A ${JSON.stringify(lateA)} B ${JSON.stringify(lateB)}`);
		await undo(A.page);
	}
	h.check(loopRed.length === 0, `§5 Bake → Undo → Redo x5 ends baked on BOTH peers and stays baked${loopRed.length ? ': ' + loopRed.join('; ') : ''}`);
	await until(A.page, uuid, solidBuilt, '§5 after the loop: the text is back on A');
	await until(B.page, uuid, solidBuilt, '§5 ...and on B');

	// ---- §6 the cap ---------------------------------------------------------------------------
	const refused = await A.page.evaluate((u) => {
		window.__tpTextProfile = 'low';
		const ok = window.__stores.textPathEdit.setTextPathFor(u, { text: 'x'.repeat(120) });
		const why = window.__stores.textPathEdit.lastTextRefusal();
		window.__tpTextProfile = undefined;
		const okDesktop = !!window.__stores.textPathEdit.setTextPathFor(u, { text: 'x'.repeat(120) });
		return { ok: !!ok, why, okDesktop };
	}, uuid);
	h.check(!refused.ok && /too long.*80 characters on this device/.test(refused.why ?? ''), `§6 a phone / headset writer is refused past 80 solid characters: "${refused.why}"`);
	h.check(refused.okDesktop, '§6 the same text goes through on a desktop (cap 300)');
	await set(A.page, uuid, { text: 'HELLO' });

	// ---- §7 fonts --------------------------------------------------------------------------
	// an upload (a WOFF; TTF/OTF take the same path) and a WOFF2 decoded at import
	const up = await A.page.evaluate(async () => {
		const tf = window.__stores.textFonts;
		const get = async (/** @type {string} */ p) => new Uint8Array(await (await fetch(p)).arrayBuffer());
		const woff = await tf.addFontBytes(await get('fonts/text/nunito-latin-400-normal.woff'), 'Nunito.woff');
		const woff2 = await tf.addFontBytes(await get('fonts/ibm-plex-sans-latin.woff2'), 'IBM Plex Sans.woff2');
		return { woff, woff2 };
	});
	h.check(up.woff.ok && up.woff2.ok && up.woff2.font.format !== 'woff2', `§7 uploads become Library fonts (woff ${up.woff.ok}, woff2 → ${up.woff2.font?.format})`);
	await set(A.page, uuid, { fontAsset: up.woff2.font.hash, fontName: up.woff2.font.family });
	const own = await until(A.page, uuid, (d) => solidBuilt(d) && d.font === 'asset:' + up.woff2.font.hash && String(d.fontUrl).startsWith('blob:'), '§7 A draws with the decoded WOFF2');
	h.check(own.solid.missing === 0, '§7 the WOFF2 font builds HELLO');
	await until(B.page, uuid, (d) => solidBuilt(d) && String(d.fontUrl).startsWith('blob:'), '§7 B pulls the font from A and draws with it', 40000);

	// a Google font by name: the CSS API + the file, mocked; afterwards Google is blocked
	const lobster = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'fonts', 'press-start-2p-latin.woff2'));
	let googleCalls = 0;
	for (const P of [A, B]) {
		await P.page.context().route(/fonts\.(googleapis|gstatic)\.com/, (/** @type {any} */ route) => {
			googleCalls++;
			const u = route.request().url();
			if (u.includes('googleapis.com/css2'))
				return route.fulfill({ status: 200, contentType: 'text/css', body: `/* latin */\n@font-face { font-family: 'Lobster'; src: url(https://fonts.gstatic.com/s/lobster/v30/latin.woff2) format('woff2'); }` });
			return route.fulfill({ status: 200, contentType: 'font/woff2', body: lobster });
		});
	}
	const g = await A.page.evaluate(() => window.__stores.textFonts.addGoogleFont('Lobster'));
	h.check(g.ok && g.font.family === 'Lobster' && googleCalls === 2, `§7 Google font "Lobster" fetched ONCE (2 requests: CSS + file) and kept (${g.error ?? g.font?.hash})`);
	for (const P of [A, B]) {
		await P.page.context().unroute(/fonts\.(googleapis|gstatic)\.com/);
		await P.page.context().route(/fonts\.(googleapis|gstatic)\.com/, (/** @type {any} */ route) => {
			googleCalls++;
			return route.abort('failed');
		});
	}
	const callsBefore = googleCalls;
	await set(A.page, uuid, { fontAsset: g.font.hash, fontName: 'Lobster', fontMeta: { licence: 'Test', url: '', noEmbed: true } });
	await until(B.page, uuid, (d) => solidBuilt(d) && d.font === 'asset:' + g.font.hash && String(d.fontUrl).startsWith('blob:'), '§7 B draws Lobster (bytes from A, never Google)', 40000);
	h.check(googleCalls === callsBefore, `§7 no peer called Google at run time (${googleCalls - callsBefore} calls)`);
	const assets = await A.page.evaluate(async () => {
		const sa = window.__stores.sceneAssets;
		sa.refreshSceneAssets?.();
		await new Promise((r) => setTimeout(r, 600));
		return sa.sceneAssetList().map((/** @type {any} */ a) => a.hash);
	});
	h.check(assets.includes(g.font.hash), `§7 the scene's asset list (what .tpscene / export carry) names the font (${assets.length} assets)`);
	const warn = await A.page.evaluate(() => window.__stores.sceneLicences.licenceWarningsFor(null, 'export').map((/** @type {any} */ w) => w.text));
	h.check(warn.some((t) => /redistribut/.test(t)), `§7 a no-embedding font raises the export licence warning (${JSON.stringify(warn)})`);
	// B reloads with Google blocked: the font comes from its own Library copy or from A
	await h.freshReload(B);
	// a joiner's reload REJOINS the session by itself (run6's shot: connected, 2 users, no restore question,
	// so no dial input either). Wait for that; only a page that does not rejoin answers the restore and dials
	const rejoined = await B.page
		.waitForFunction(() => { let p; window.__stores.peers.subscribe((v) => (p = v))(); return (p?.openedPeers?.length ?? p?.openedPeers?.size ?? 0) > 0; }, null, { timeout: 30000, polling: 250 })
		.then(() => true)
		.catch(() => false);
	console.log('[text-object] B rejoined after its reload by itself:', rejoined);
	if (!rejoined) {
		await h.answerRestore(B, 'dismiss');
		await h.connect(B, A);
	}
	await h.eventually(() => one(B.page, uuid).catch(() => null), (d) => !!d && solidBuilt(d) && String(d.fontUrl).startsWith('blob:'), '§7 after a reload with Google blocked, B still draws Lobster', 60000);
	h.check(googleCalls === callsBefore, '§7 ...still without a single Google call');

	// ---- §8 the Inspector ---------------------------------------------------------------------
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), uuid);
	await A.page.waitForSelector('#text-mode-solid', { timeout: 20000 });
	const ui = await A.page.evaluate(() => ({
		solidPressed: document.querySelector('#text-mode-solid')?.getAttribute('aria-pressed'),
		depth: !!document.querySelector('#text-solid-depth'),
		bake: !!document.querySelector('#text-solid-bake'),
		licence: document.querySelector('#text-font-licence')?.textContent?.trim(),
		noEmbed: !!document.querySelector('#text-font-noembed')
	}));
	h.check(ui.solidPressed === 'true' && ui.depth && ui.bake && ui.noEmbed, `§8 the Inspector shows Solid pressed, depth, Bake, the no-embedding note (${JSON.stringify(ui)})`);
	await A.page.locator('#text-mode-solid').scrollIntoViewIfNeeded();
	await A.page.screenshot({ path: path.join(OUT, 'text-object-inspector.png') });
	await A.page.click('#text-mode-flat');
	await until(A.page, uuid, (d) => d.mode === 'flat' && d.synced, '§8 pressing Flat switches the mode');
	await A.page.screenshot({ path: path.join(OUT, 'text-object-flat.png') });

	// ---- §9 the agent: "HELLO", solid, with a bevel -------------------------------------------
	const exec = (/** @type {any} */ page, /** @type {string} */ t, /** @type {any} */ a) => page.evaluate(([tn, ta]) => window.__stores.aiTools.executeAiTool(tn, ta), [t, a]);
	const agent = await exec(A.page, 'create_text', { text: 'HELLO', solid: true, depth: 0.15, bevel: 0.01, font: 'serif', position: [0, 2, -2] });
	const au = agent?.created?.uuid;
	h.check(!!au && agent.created.mode === 'solid', `§9 create_text makes a solid "HELLO" (${JSON.stringify(agent).slice(0, 200)})`);
	const ag = await until(A.page, au, solidBuilt, '§9 A builds the agent\'s solid text');
	const agB = await until(B.page, au, solidBuilt, '§9 ...and B, from the record');
	h.check(ag.solid.drawn === 5 && ag.solid.missing === 0 && ag.solid.triangles === agB.solid.triangles, `§9 5 bevelled serif letters on both peers (${ag.solid.triangles} triangles)`);
	const arec = await record(B.page, au);
	h.check(arec?.bevel?.size === 0.01 && arec?.depth === 0.15 && arec?.font === 'serif', `§9 B holds the record the agent asked for (bevel ${arec?.bevel?.size}, depth ${arec?.depth})`);
	const edited9 = await exec(A.page, 'set_geometry', { updates: [{ uuid: au, params: { text: 'HELLO!', bevel: false } }] });
	h.check(edited9?.updated?.[0]?.ok === true, '§9 set_geometry params edit the text');
	await until(B.page, au, (d) => solidBuilt(d) && d.text === 'HELLO!', '§9 B follows the edit');
	const fonts9 = await exec(A.page, 'list_fonts', {});
	h.check(fonts9?.bundled?.length >= 5 && fonts9.library?.length >= 3 && fonts9.caps?.solid === 300, `§9 list_fonts: bundled, the Library's (two uploads + a Google font: ${fonts9?.library?.length}), caps`);
	await undo(A.page);
	await until(B.page, au, (d) => d.text === 'HELLO', '§9 one undo takes the edit back on B');
	await undo(A.page);
	await h.eventually(() => one(B.page, au), (d) => !d, '§9 a second undo removes the agent\'s text on B', 20000);

	// ---- §10 a record from a newer build -------------------------------------------------------
	const newer = await A.page.evaluate((u) => {
		window.__stores.toastStore.set([]);
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		o.userData.textPath = { ...o.userData.textPath, v: 99, gradient: { from: '#000000', to: '#ffffff' } };
		return true;
	}, uuid);
	await h.eventually(
		() => A.page.evaluate(() => { let t; window.__stores.toastStore.subscribe((v) => (t = v))(); return t.map((x) => (typeof x === 'string' ? x : x.text)).join(' | '); }),
		(t) => /made with a newer version/.test(t),
		'§10 a newer record says so once',
		10000
	);
	await set(A.page, uuid, { text: 'Kept' });
	const kept = await record(B.page, uuid).then(async (r) => (r?.text === 'Kept' ? r : (await new Promise((res) => setTimeout(res, 1500)), record(B.page, uuid))));
	h.check(newer && kept?.v === 99 && kept?.gradient?.to === '#ffffff', `§10 an edit here keeps the newer build's fields on B (v ${kept?.v})`);

	// ---- §4 save -> reload -> identical (LAST: a reload gives A a new peer id, so B is not with it afterwards) ----
	await set(A.page, uuid, { text: 'HELLO', mode: 'extruded' });
	await until(A.page, uuid, (d) => solidBuilt(d) && d.text === 'HELLO', '§4 premise: a solid HELLO before the save');
	const before = await record(A.page, uuid);
	await A.page.evaluate(() => window.__stores.autosave.saveNow());
	await A.page.waitForTimeout(1500);
	await h.freshReload(A);
	await h.answerRestore(A, 'restore');
	await h.eventually(() => record(A.page, uuid), (r) => !!r, '§4 the text is back after a reload', 30000);
	const reloaded = await record(A.page, uuid); // h.eventually returns nothing
	h.check(JSON.stringify(reloaded) === JSON.stringify(before), '§4 the record is identical after save + reload');
	const rebuilt4 = await until(A.page, uuid, solidBuilt, '§4 the solid text rebuilds from the record');
	h.check(rebuilt4.solid.drawn === 5, `§4 rebuilt: ${rebuilt4.solid.triangles} triangles`);

	await h.finish(browser);
});
