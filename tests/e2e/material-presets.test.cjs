// 37 R5 — MATERIAL PRESETS: named looks saved to IndexedDB, shared with peers like the
// environment presets, applied from a swatch row in the Inspector.
//
// What is measured, and why each one is the load-bearing reading:
//  - an apply is ONE undo step per object and ONE `objectParameters / materials` message
//    (no new wire type for applying: a receiver and an older peer already understand it);
//  - UNDO over a TEXTURED object gives the texture back — the reason serializeMaterials had
//    to be fixed (it handed ObjectLoader keyed caches where it walks arrays, so the map came
//    back gone); the counterfactual is computed in-page on the old shape;
//  - a multi-selection is ONE undo;
//  - the library survives a reload (IndexedDB), rename refuses a taken name, delete asks;
//  - a second peer sees the library and can apply from it, and the applied look reaches the
//    first peer; leaving drops the library.
// Screenshots (dark + light) go to the lane's evidence folder.

const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const SHOTS = process.env.MP_SHOTS || '/home/deck/.code/lanes-30/after-37/37-materials';
const shot = async (page, name) => {
	try {
		fs.mkdirSync(SHOTS, { recursive: true });
		const panel = page.locator('#material-presets');
		const box = await panel.boundingBox();
		if (box) {
			await page.screenshot({
				path: path.join(SHOTS, name),
				clip: { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 60), width: box.width + 24, height: Math.min(560, box.height + 330) }
			});
		}
		await page.screenshot({ path: path.join(SHOTS, name.replace('.png', '-full.png')) });
	} catch (e) {
		console.log('screenshot failed', name, String(e).slice(0, 120));
	}
};

/** 1x1 red png — a real one */
const TINY_PNG =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** a box's material facts @param {any} page @param {string} uuid */
const matOf = (page, uuid) =>
	page.evaluate((u) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const o = group?.getObjectByProperty('uuid', u);
		const m = o?.material;
		if (!m) return null;
		return {
			type: m.type,
			color: m.color ? m.color.getHexString() : null,
			roughness: m.roughness,
			metalness: m.metalness,
			opacity: m.opacity,
			transparent: m.transparent,
			emissive: m.emissive ? m.emissive.getHexString() : null,
			hasMap: !!m.map,
			mapUrl: (m.userData?.mapDataUrl ?? '').slice(0, 30),
			hasNormal: !!m.normalMap,
			preset: m.userData?.materialPreset ?? null,
			name: m.name
		};
	}, uuid);

const pressed = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('#material-presets .mp-swatch[aria-pressed="true"]')].map((b) => b.getAttribute('data-preset-name'))
	);

/** poll until `pred` holds; returns the last value either way @param {() => Promise<any>} fn @param {(v: any) => boolean} pred @param {number} ms */
const waitVal = async (fn, pred, ms) => {
	const start = Date.now();
	let last;
	while (Date.now() - start < ms) {
		last = await fn();
		if (pred(last)) return last;
		await new Promise((r) => setTimeout(r, 400));
	}
	return last;
};

/** wait until a swatch is (or is not) in the row — a save/rename/delete is several IndexedDB
 * round trips, which a loaded box stretches well past any fixed sleep
 * @param {any} page @param {string} kind @param {string} name @param {number} want */
const swatchCount = (page, kind, name, want = 1) =>
	waitVal(() => page.locator(`#material-presets .mp-swatch[data-preset-kind="${kind}"][data-preset-name="${name}"]`).count(), (n) => n === want, 15000);
/** the library store, by name @param {any} page */
const library = (page) =>
	page.evaluate(async () => (await new Promise((r) => window.__stores.materialPresets.materialPresets.subscribe(r)())).map((p) => p.name).sort());

const swatch = (page, kind, name) => page.locator(`#material-presets .mp-swatch[data-preset-kind="${kind}"][data-preset-name="${name}"]`);

/** create N boxes, return their uuids @param {any} page @param {number} n */
const makeBoxes = (page, n) =>
	page.evaluate(async (count) => {
		const w = window.__stores;
		const group0 = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const before = new Set(group0.children.map((c) => c.uuid));
		for (let i = 0; i < count; i++) w.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 600));
		const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const fresh = group.children.filter((c) => !before.has(c.uuid));
		fresh.forEach((o, i) => {
			o.position.set(i * 1.6 - 1, 0.5, 0);
			o.material.color.set('#3366cc');
			o.material.roughness = 0.55;
		});
		return fresh.map((o) => o.uuid);
	}, n);

/** select (and open the Inspector on) a set @param {any} page @param {string[]} uuids */
const selectSet = async (page, uuids) => {
	await page.evaluate(async (list) => {
		const w = window.__stores;
		w.objectActions.selectObject(list[0], true);
		await new Promise((r) => setTimeout(r, 200));
		if (list.length > 1) w.objectActions.applySelectionSet(list);
	}, uuids);
	await page.waitForTimeout(700);
};

/** wire spy: record what the app sends @param {any} page */
const spy = (page) =>
	page.evaluate(async () => {
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		window.__mpSent = [];
		if (!peer.__mpWrapped) {
			const orig = peer.send.bind(peer);
			peer.send = (m) => {
				if (m && typeof m === 'object' && window.__mpSent) window.__mpSent.push({ type: m.type, parameter: m.parameter, uuid: m.uuid });
				return orig(m);
			};
			peer.__mpWrapped = true;
		}
	});
const sent = (page) => page.evaluate(() => window.__mpSent ?? []);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { storage: { 'inspector:sec:Material': 'open' } });
	await A.page.evaluate(() => localStorage.setItem('inspector:sec:Material', 'open'));

	// ------------------------------------------------------------------ 1. the row
	console.log('\n=== 1. the swatch row ===');
	const [b1, b2, b3] = await makeBoxes(A.page, 3);
	h.check(!!b1 && !!b2 && !!b3, '1.0 premise: three boxes');
	await selectSet(A.page, [b1]);
	await A.page.locator('#material-presets').waitFor({ timeout: 15000 }).catch(() => {});
	const starters = await A.page.evaluate(() =>
		[...document.querySelectorAll('#material-presets .mp-swatch[data-preset-kind="starter"]')].map((b) => b.getAttribute('data-preset-name'))
	);
	h.check(
		JSON.stringify(starters) === JSON.stringify(['Wood', 'Metal', 'Plastic', 'Glass', 'Stone', 'Rubber', 'Neon']),
		'1.1 the starter set renders in the Material section: ' + starters.join(', ')
	);
	h.check((await pressed(A.page)).length === 0, '1.2 a plain box wears none of them (no swatch lit)');

	// ------------------------------------------------------------------ 2. apply
	console.log('\n=== 2. apply = one undo step, one message ===');
	await spy(A.page);
	await swatch(A.page, 'starter', 'Wood').click();
	await A.page.waitForTimeout(900);
	let m = await matOf(A.page, b1);
	h.check(m.type === 'MeshStandardMaterial' && m.color === 'b98352', `2.1 Wood applied: ${m.type} #${m.color}`);
	h.check(m.hasMap && m.hasNormal, `2.2 Wood wears its procedural grain + normal map (map ${m.hasMap}, normal ${m.hasNormal})`);
	h.check(Math.abs(m.roughness - 0.72) < 1e-3, '2.3 roughness from the preset: ' + m.roughness);
	h.check(JSON.stringify(await pressed(A.page)) === '["Wood"]', '2.4 the Wood swatch lights up: ' + JSON.stringify(await pressed(A.page)));
	const wire = (await sent(A.page)).filter((x) => x.type === 'objectParameters');
	h.check(
		wire.length === 1 && wire[0].parameter === 'materials' && wire[0].uuid === b1,
		'2.5 ONE objectParameters/materials message for the one object: ' + JSON.stringify(wire)
	);
	h.check(!(await sent(A.page)).some((x) => x.type === 'matpresets'), '2.6 applying sends no library message');
	await shot(A.page, '01-swatches-dark-wood.png');

	// undo / redo
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(500);
	m = await matOf(A.page, b1);
	h.check(m.color === '3366cc' && !m.hasMap && Math.abs(m.roughness - 0.55) < 1e-3, `2.7 ONE undo gives the old material back (#${m.color}, map ${m.hasMap}, r ${m.roughness})`);
	await A.page.evaluate(() => window.__stores.history.redo());
	await A.page.waitForTimeout(500);
	m = await matOf(A.page, b1);
	h.check(m.color === 'b98352' && m.hasMap, `2.8 redo puts Wood back (#${m.color}, map ${m.hasMap})`);

	// ------------------------------------------------------------------ 3. undo over a TEXTURE
	console.log('\n=== 3. undo over a textured object keeps the texture ===');
	await A.page.evaluate(async ({ u, url }) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const o = group.getObjectByProperty('uuid', u);
		window.__stores.materialsHandler.switchMaterialType(u, 'MeshStandardMaterial', false);
		window.__stores.materialsHandler.applyMap(o, url);
		await new Promise((r) => setTimeout(r, 400));
	}, { u: b2, url: TINY_PNG });
	m = await matOf(A.page, b2);
	h.check(m.hasMap, '3.0 premise: box 2 wears a texture');
	// the counterfactual, measured in-page: the OLD meta shape parses zero textures
	const counter = await A.page.evaluate((u) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const o = group.getObjectByProperty('uuid', u);
		const meta = { textures: [], images: [] }; // the pre-fix shape
		const json = o.material.toJSON(meta);
		const fixed = window.__stores.materialsHandler.materialsPayload(o);
		return { oldTextures: meta.textures.length, fixedTextures: fixed.textures.length, fixedImages: fixed.images.length, mapRef: !!json.map };
	}, b2);
	h.check(
		counter.mapRef && counter.oldTextures === 0 && counter.fixedTextures === 1 && counter.fixedImages === 1,
		'3.1 the undo snapshot now CARRIES the texture (old shape: ' + counter.oldTextures + ' textures, fixed: ' + counter.fixedTextures + ')'
	);
	await selectSet(A.page, [b2]);
	await swatch(A.page, 'starter', 'Metal').click();
	await A.page.waitForTimeout(700);
	m = await matOf(A.page, b2);
	h.check(!m.hasMap && Math.abs(m.metalness - 0.8) < 1e-3, `3.2 Metal replaced the texture (map ${m.hasMap}, metal ${m.metalness})`);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(900);
	m = await matOf(A.page, b2);
	h.check(m.hasMap && m.mapUrl.startsWith('data:image/png'), `3.3 undo brings the texture BACK (map ${m.hasMap}, ${m.mapUrl})`);

	// ------------------------------------------------------------------ 4. multi-select
	console.log('\n=== 4. a multi-selection is one undo ===');
	await selectSet(A.page, [b1, b2, b3]);
	const note = await A.page.locator('#material-presets .mp-title').textContent();
	h.check(/applies to all 3/.test(note ?? ''), '4.0 the row says it acts on the set: ' + note);
	await spy(A.page);
	await swatch(A.page, 'starter', 'Glass').click();
	await A.page.waitForTimeout(800);
	const glass = await Promise.all([b1, b2, b3].map((u) => matOf(A.page, u)));
	h.check(
		glass.every((g) => g.type === 'MeshPhysicalMaterial' && g.transparent && g.opacity < 0.5),
		'4.1 all three are Glass: ' + glass.map((g) => g.type + '/' + g.opacity).join(', ')
	);
	h.check((await sent(A.page)).filter((x) => x.type === 'objectParameters' && x.parameter === 'materials').length === 3, '4.2 one message per object (3)');
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(800);
	const back = await Promise.all([b1, b2, b3].map((u) => matOf(A.page, u)));
	h.check(
		back[0].color === 'b98352' && back[1].hasMap && back[2].color === '3366cc',
		'4.3 ONE undo restores each object\'s own previous look: ' + back.map((g) => g.color + (g.hasMap ? '+map' : '')).join(', ')
	);

	// the selection TINT is not a look: members wear the highlight emissive, the look reads past it
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await selectSet(A.page, [b1, b2, b3]); // a fresh set: every member wears the highlight now
	const tint = await A.page.evaluate((u) => {
		const raw = window.__stores.materialPresets.lookOfMaterial(
			window.__stores.objectsGroup && (() => { let g = null; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return g.getObjectByProperty('uuid', u).material; })()
		);
		const look = window.__stores.materialPresets.lookOfObject(u);
		return { raw: raw?.emissive ?? null, look: look?.emissive ?? null };
	}, b3);
	h.check(tint.raw === '#2a4d8f' && tint.look === null, '4.4 a tinted member reads its OWN look, not the highlight: ' + JSON.stringify(tint));
	// a preset applied to tinted members survives the deselect (the tint memory must not write
	// the REPLACED material's emissive over the new one — Neon's glow used to vanish)
	await swatch(A.page, 'starter', 'Neon').click();
	await A.page.waitForTimeout(700);
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.waitForTimeout(500);
	const glow = await Promise.all([b1, b2, b3].map((u) => matOf(A.page, u)));
	h.check(glow.every((g) => g.emissive === 'ff2bd6'), '4.5 Neon keeps its glow after the set is deselected: ' + glow.map((g) => g.emissive).join(', '));
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(800);
	const unglow = await Promise.all([b1, b2, b3].map((u) => matOf(A.page, u)));
	h.check(unglow.every((g) => g.emissive === '000000'), '4.6 and undo takes it back to no glow (no tint baked in): ' + unglow.map((g) => g.emissive).join(', '));

	// ------------------------------------------------------------------ 5. save current
	console.log('\n=== 5. save current, persist, rename, delete ===');
	await selectSet(A.page, [b3]);
	await A.page.evaluate((u) => {
		window.__stores.materialsHandler.setObjectColor(u, '#cc2244');
		window.__stores.materialsHandler.setMaterialParam(u, 'roughness', 0.2);
		window.__stores.materialsHandler.setMaterialParam(u, 'metalness', 0.4);
	}, b3);
	await A.page.waitForTimeout(400);
	await A.page.locator('#material-preset-save').click();
	const nameField = A.page.locator('#material-preset-name');
	await nameField.waitFor({ timeout: 5000 });
	await nameField.fill('Candy red');
	await nameField.press('Enter');
	h.check((await swatchCount(A.page, 'mine', 'Candy red')) === 1, '5.1 the saved preset joins the row');
	const lit = await waitVal(() => pressed(A.page), (v) => JSON.stringify(v) === '["Candy red"]', 5000);
	h.check(JSON.stringify(lit) === '["Candy red"]', '5.2 ...and lights up for the object it came from: ' + JSON.stringify(lit));
	const ballBg = await A.page.evaluate(() => {
		const ball = document.querySelector('#material-presets .mp-swatch[data-preset-name="Candy red"] .mp-ball');
		return ball ? getComputedStyle(ball).backgroundImage : '';
	});
	h.check(/rgb\(204, 34, 68\)/.test(ballBg), '5.2b the saved swatch is drawn in its own colour: ' + ballBg.slice(-80));
	const stored = await A.page.evaluate(async () => {
		await window.__stores.materialPresets.loadMaterialPresets();
		const list = await new Promise((r) => window.__stores.materialPresets.materialPresets.subscribe(r)());
		return list.map((p) => ({ name: p.name, color: p.payload.color, roughness: p.payload.roughness, emissive: p.payload.emissive ?? null }));
	});
	h.check(
		stored.length === 1 && stored[0].color === '#cc2244' && Math.abs(stored[0].roughness - 0.2) < 1e-3 && stored[0].emissive === null,
		'5.3 stored in IndexedDB with the look: ' + JSON.stringify(stored)
	);
	// a duplicate save does not overwrite: it counts up
	await A.page.locator('#material-preset-save').click();
	await nameField.fill('Candy red');
	await nameField.press('Enter');
	h.check((await swatchCount(A.page, 'mine', 'Candy red 2')) === 1, '5.4 saving a taken name never overwrites (Candy red 2)');

	await h.freshReload(A);
	// a reload is a NEW peer: the id setupPage read is gone, and section 7 dials A by id
	A.id = await waitVal(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.peer?.id ?? ''))())),
		(v) => !!v,
		20000
	);
	console.log('A id after reload: ' + A.id);
	await A.page.evaluate(() => localStorage.setItem('inspector:sec:Material', 'open'));
	const [b4] = await makeBoxes(A.page, 1);
	await selectSet(A.page, [b4]);
	await A.page.locator('#material-presets').waitFor({ timeout: 15000 }).catch(() => {});
	h.check((await swatch(A.page, 'mine', 'Candy red').count()) === 1, '5.5 the library survives a reload');
	await swatch(A.page, 'mine', 'Candy red').click();
	await A.page.waitForTimeout(600);
	m = await matOf(A.page, b4);
	h.check(m.color === 'cc2244' && Math.abs(m.metalness - 0.4) < 1e-3, `5.6 a saved preset applies (#${m.color}, metal ${m.metalness})`);

	// rename
	await A.page.locator('#material-preset-edit').click();
	await A.page.locator('[data-preset-rename="Candy red 2"]').click();
	await nameField.fill('Wood');
	await nameField.press('Enter');
	await A.page.waitForTimeout(500);
	const err = await A.page.locator('#material-presets .mp-error').textContent().catch(() => '');
	h.check(/taken/i.test(err ?? '') && (await swatch(A.page, 'mine', 'Candy red 2').count()) === 1, '5.7 renaming onto a starter name is refused: ' + err);
	await nameField.fill('Ruby');
	await nameField.press('Enter');
	const renamed = await waitVal(() => library(A.page), (v) => JSON.stringify(v) === '["Candy red","Ruby"]', 15000);
	h.check(JSON.stringify(renamed) === '["Candy red","Ruby"]', '5.8 rename moved the record: ' + JSON.stringify(renamed));
	await shot(A.page, '02-swatches-dark-edit.png');

	// delete — asks first
	await A.page.locator('[data-preset-delete="Ruby"]').click();
	await A.page.locator('#confirm-dialog-ok').waitFor({ timeout: 5000 });
	await A.page.locator('#confirm-dialog-ok').click();
	h.check((await swatchCount(A.page, 'mine', 'Ruby', 0)) === 0, '5.9 delete (after the confirm) removes it');
	await A.page.locator('#material-preset-edit').click();

	// ------------------------------------------------------------------ 6. light theme
	console.log('\n=== 6. light theme ===');
	await A.page.evaluate(() => window.__stores.themes.theme.set('light'));
	await A.page.waitForTimeout(500);
	await shot(A.page, '03-swatches-light.png');
	const ink = await A.page.evaluate(() => {
		const t = document.querySelector('#material-presets .mp-label');
		return t ? getComputedStyle(t).color : '';
	});
	h.check(!!ink && ink !== 'rgb(209, 213, 219)', '6.1 labels take the light theme ink: ' + ink);
	await A.page.evaluate(() => window.__stores.themes.theme.set('dark'));

	// ------------------------------------------------------------------ 7. two peers
	console.log('\n=== 7. a peer sees your library, applies from it, and the look replicates ===');
	const B = await h.setupPage(browser, 'B', { storage: { 'inspector:sec:Material': 'open' } });
	await B.page.evaluate(() => localStorage.setItem('inspector:sec:Material', 'open'));
	await h.connect(B, A);
	const lib = await waitVal(
		() =>
			B.page.evaluate(async () => {
				const map = await new Promise((r) => window.__stores.materialPresets.peerMaterialPresets.subscribe(r)());
				return Object.values(map).flat().map((p) => p.label);
			}),
		(v) => v.includes('Candy red'),
		15000
	);
	h.check(lib.includes('Candy red'), '7.1 B received A\'s library in the handshake: ' + JSON.stringify(lib));
	// the joiner receives the scene a moment after the handshake: select only once it holds the box
	const hasB4 = await waitVal(() => matOf(B.page, b4), (v) => !!v, 20000);
	h.check(!!hasB4, '7.1b premise: B holds A\'s box');
	await selectSet(B.page, [b4]);
	await B.page.locator('#material-presets').waitFor({ timeout: 15000 }).catch(() => {});
	h.check((await B.page.locator('#material-presets .mp-peer').count()) === 1, '7.2 B shows a "From A" row');
	await swatch(B.page, 'peer', 'Candy red').click().catch(() => {});
	await swatch(B.page, 'starter', 'Neon').click();
	await B.page.waitForTimeout(500);
	await shot(B.page, '04-peer-library-dark.png');
	const onA = await waitVal(() => matOf(A.page, b4), (v) => v && v.emissive === 'ff2bd6', 10000);
	h.check(!!onA && onA.emissive === 'ff2bd6', '7.3 B applied Neon and A sees the glow: ' + JSON.stringify(onA && { e: onA.emissive, c: onA.color }));
	// A saves a new one -> B hears it without reconnecting
	await A.page.evaluate(async () => {
		await window.__stores.materialPresets.saveMaterialPreset('Mint', { version: 1, label: 'Mint', type: 'MeshStandardMaterial', color: '#66ddaa', roughness: 0.3 });
	});
	const lib2 = await waitVal(
		() =>
			B.page.evaluate(async () => {
				const map = await new Promise((r) => window.__stores.materialPresets.peerMaterialPresets.subscribe(r)());
				return Object.values(map).flat().map((p) => p.label);
			}),
		(v) => v.includes('Mint'),
		10000
	);
	h.check(lib2.includes('Mint'), '7.4 a new save reaches the peer live: ' + JSON.stringify(lib2));
	// leaving drops the library on the other side
	await A.page.evaluate(() => {
		let p;
		window.__stores.peers.subscribe((x) => (p = x))();
		p.leaveSession();
	});
	const gone = await waitVal(
		() => B.page.evaluate(async () => Object.keys(await new Promise((r) => window.__stores.materialPresets.peerMaterialPresets.subscribe(r)())).length),
		(v) => v === 0,
		15000
	);
	h.check(gone === 0, '7.5 when A leaves, B drops A\'s library (' + gone + ' left)');

	h.check(h.pageErrors(A).length === 0, '8.1 no page errors on A: ' + h.pageErrors(A).slice(0, 2).join(' | '));
	h.check(h.pageErrors(B).length === 0, '8.2 no page errors on B: ' + h.pageErrors(B).slice(0, 2).join(' | '));
	await browser.close();
});
