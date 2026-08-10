// Roadmap #17 batch D1 — the Inspector edits the whole SELECTION SET.
//
// Transforms and several context-menu ops already acted on the set, but every
// Inspector write read `$selectedObject` alone, so material/colour/physics edits
// silently applied to one member of a multi-selection. D1 fans those writes over
// `$selectedObjects` through the SAME per-uuid entry points (byte-identical wire
// messages) and wraps N>1 in ONE history batch, so a single undo restores every
// object's own previous value — that last part is what this suite mainly guards.
//
// Rows whose members disagree render an em-dash instead of one member's number
// (DragRow `mixed`), and the fanned sections carry a counted note.
const h = require('./helpers.cjs');

/** 1x1 png — a real one, `createImageBitmap` (the downscale step) rejects fakes */
const TINY_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** type a hex into the Nth picker's own text field (fires the lib's onInput) —
 *  same hook color-picker-15c uses; far stabler than canvas-drag math */
const typeIntoPicker = (page, index, hex) =>
	page.evaluate(
		([i, value]) => {
			const wrapper = document.querySelectorAll('.wrapper')[i];
			const input = wrapper?.querySelector('input');
			if (!input) return false;
			input.value = value;
			input.dispatchEvent(new Event('input', { bubbles: true })); // delegated handlers need bubbles
			return true;
		},
		[index, hex]
	);

/** the numeric field of a SliderRow by its label */
const rowField = (page, label) =>
	page.locator('.ui-row', { has: page.getByTitle(label, { exact: true }) }).locator('.dn-input').first();

/** live material/physics readout for the trio */
const readTrio = (page) =>
	page.evaluate(() =>
		window.__d1.uuids.map((uuid) => {
			const object = window.__d1.group.getObjectByProperty('uuid', uuid);
			return {
				roughness: object.material.roughness,
				colour: object.material.color.getHexString(),
				restitution: object.userData.physics?.restitution ?? null
			};
		})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// three boxes with DIFFERENT roughness, all selected, Material + Physics open
	await A.page.evaluate(async () => {
		const w = window.__stores;
		localStorage.setItem('inspector:sec:Material', 'open');
		localStorage.setItem('inspector:sec:Physics', 'open');
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 400));
		const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const trio = group.children.slice(-3);
		trio[0].material.roughness = 0.2;
		trio[1].material.roughness = 0.5;
		trio[2].material.roughness = 0.8;
		// spread them out so the transform rows have genuinely DIFFERING values —
		// three boxes stacked at the origin would make the "mixed" check vacuous
		trio.forEach((object, i) => object.position.set(i * 2, i * 0.5, 0));
		trio.forEach((object, i) => object.material.color.set(['#ff0000', '#00ff00', '#0000ff'][i]));
		window.__d1 = { group, uuids: trio.map((object) => object.uuid) };
		// open the properties panel on the primary, then build the SET
		w.objectActions.selectObject(window.__d1.uuids[0], true);
		await new Promise((r) => setTimeout(r, 200));
		w.objectActions.applySelectionSet(window.__d1.uuids);
	});
	await A.page.waitForTimeout(900);

	// PREMISE: the set really holds three and the panel is showing the material
	const premise = await A.page.evaluate(async () => ({
		set: await new Promise((r) => window.__stores.selectedObjects.subscribe((v) => r([...v]))()),
		note: document.querySelector('#material-multi-note')?.textContent?.trim() ?? '',
		physicsNote: document.querySelector('#physics-multi-note')?.textContent?.trim() ?? ''
	}));
	h.check(premise.set.length === 3, `three objects selected (${premise.set.length})`);
	h.check(/3 selected objects/.test(premise.note), `the Material section says what it acts on ("${premise.note}")`);
	h.check(/3 selected objects/.test(premise.physicsNote), `the Physics section says the same ("${premise.physicsNote}")`);

	// ---------- mixed values render as a dash, not one member's number ----------
	const rough = rowField(A.page, 'Roughness');
	await rough.scrollIntoViewIfNeeded();
	h.check((await rough.count()) > 0, 'the Roughness row renders');
	h.check((await rough.inputValue()) === '—', `differing roughness shows a dash (got "${await rough.inputValue()}")`);

	// ---------- one edit writes the value to EVERY member ----------
	await rough.click();
	await A.page.waitForTimeout(150);
	await rough.fill('0.4');
	await A.page.waitForTimeout(350);
	let trio = await readTrio(A.page);
	h.check(
		trio.every((o) => Math.abs(o.roughness - 0.4) < 0.001),
		`typing roughness applies to all three (${trio.map((o) => o.roughness).join(', ')})`
	);
	// no longer mixed once they agree
	await A.page.locator('#drawer-label').click({ position: { x: 5, y: 5 } }).catch(() => {});
	await A.page.waitForTimeout(250);
	h.check(
		(await rough.inputValue()) === '0.40',
		`agreeing values show the number again (got "${await rough.inputValue()}")`
	);

	// ---------- ONE undo restores each object's OWN previous value ----------
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(400);
	trio = await readTrio(A.page);
	const restored =
		Math.abs(trio[0].roughness - 0.2) < 0.001 &&
		Math.abs(trio[1].roughness - 0.5) < 0.001 &&
		Math.abs(trio[2].roughness - 0.8) < 0.001;
	h.check(restored, `ONE undo restores all three originals (${trio.map((o) => o.roughness).join(', ')})`);

	// ---------- colour fans, and replicates once per object ----------
	await A.page.evaluate(async () => {
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		window.__sentColors = [];
		const orig = peer.send.bind(peer);
		peer.send = (m) => {
			if (m && m.type === 'color') window.__sentColors.push(m.uuid);
			return orig(m);
		};
	});
	h.check(await typeIntoPicker(A.page, 0, '#123456'), 'the material picker hex field is reachable');
	await A.page.waitForTimeout(300);
	trio = await readTrio(A.page);
	h.check(
		trio.every((o) => o.colour === '123456'),
		`the picker colours the whole selection (${trio.map((o) => o.colour).join(', ')})`
	);
	const sentTo = await A.page.evaluate(() => [...new Set(window.__sentColors)]);
	h.check(sentTo.length === 3, `one colour message per object (${sentTo.length})`);

	// the colour gesture seals ~600ms after the last input — then ONE undo must
	// bring back each object's OWN colour (red/green/blue), not a shared one
	await A.page.waitForTimeout(900);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(400);
	trio = await readTrio(A.page);
	h.check(
		trio[0].colour === 'ff0000' && trio[1].colour === '00ff00' && trio[2].colour === '0000ff',
		`ONE undo restores each original colour (${trio.map((o) => o.colour).join(', ')})`
	);

	// ---------- physics fans too (Bounciness renders for every body mode) ----------
	const bounce = rowField(A.page, 'Bounciness');
	await bounce.scrollIntoViewIfNeeded();
	await bounce.click();
	await A.page.waitForTimeout(150);
	await bounce.fill('0.75');
	await A.page.waitForTimeout(400);
	trio = await readTrio(A.page);
	h.check(
		trio.every((o) => Math.abs((o.restitution ?? 0) - 0.75) < 0.001),
		`bounciness applies to all three (${trio.map((o) => o.restitution).join(', ')})`
	);

	// ---------- the panel says it is editing a SET, not one object ----------
	const banner = await A.page.evaluate(() => {
		const el = document.querySelector('#selection-multi-banner');
		const badge = [...document.querySelectorAll('#drawer-label *')]
			.map((n) => n.textContent?.trim() ?? '')
			.find((t) => /objects$/.test(t));
		return { text: el?.textContent?.replace(/\s+/g, ' ').trim() ?? '', badge: badge ?? '' };
	});
	h.check(/Editing 3 objects/.test(banner.text), `the banner names the count ("${banner.text.slice(0, 60)}")`);
	h.check(/last selected/.test(banner.text), 'and explains that name/id belong to the last selected');
	h.check(banner.badge === '3 objects', `the header badge shows the count ("${banner.badge}")`);

	// ---------- transforms move the whole selection, one undo ----------
	// (they were single-target: typing Y moved only the last-clicked object)
	const posBefore = await A.page.evaluate(() =>
		window.__d1.uuids.map((u) => window.__d1.group.getObjectByProperty('uuid', u).position.toArray())
	);
	const posY = A.page
		.locator('#inspector-position .dn-wrap', { has: A.page.locator('.dn-label', { hasText: 'Y' }) })
		.locator('.dn-input')
		.first();
	await posY.scrollIntoViewIfNeeded();
	h.check((await posY.inputValue()) === '—', `differing Y shows a dash (got "${await posY.inputValue()}")`);
	await posY.click();
	await A.page.waitForTimeout(150);
	await posY.fill('3');
	await A.page.waitForTimeout(300);
	const posAfter = await A.page.evaluate(() =>
		window.__d1.uuids.map((u) => window.__d1.group.getObjectByProperty('uuid', u).position.toArray())
	);
	h.check(
		posAfter.every((p) => Math.abs(p[1] - 3) < 0.001),
		`typing Y moves all three (${posAfter.map((p) => p[1].toFixed(2)).join(', ')})`
	);
	h.check(
		posAfter.every((p, i) => Math.abs(p[0] - posBefore[i][0]) < 0.001),
		'and leaves the other axes alone'
	);
	// the gesture seals after ~500ms into ONE transformSet entry
	await A.page.waitForTimeout(800);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(400);
	const posUndone = await A.page.evaluate(() =>
		window.__d1.uuids.map((u) => window.__d1.group.getObjectByProperty('uuid', u).position.toArray())
	);
	h.check(
		posUndone.every((p, i) => Math.abs(p[1] - posBefore[i][1]) < 0.001),
		`ONE undo restores every original Y (${posUndone.map((p) => p[1].toFixed(2)).join(', ')})`
	);

	// ---------- geometry fans across ONE primitive type ----------
	const geo = await A.page.evaluate(async () => {
		const w = window.__stores;
		localStorage.setItem('inspector:sec:Geometry', 'open');
		// three boxes share a gtype; add a sphere to prove the type gate
		w.commandsHandler.sceneCommand('/create Sphere 0.5');
		await new Promise((r) => setTimeout(r, 400));
		const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const sphere = group.children[group.children.length - 1];
		window.__d1.sphere = sphere.uuid;
		// the PRIMARY is the last uuid, so keep a Box primary: the geometry rows
		// follow the primary's type and the Sphere must be the odd one out
		w.objectActions.applySelectionSet([sphere.uuid, ...window.__d1.uuids]);
		await new Promise((r) => setTimeout(r, 700));
		return {
			note: document.querySelector('#geometry-mixed-note')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
		};
	});
	h.check(/Sphere/.test(geo.note), `a mixed-shape selection says what it skips ("${geo.note.slice(0, 70)}")`);
	const width = rowField(A.page, 'Width');
	await width.scrollIntoViewIfNeeded();
	await width.click();
	await A.page.waitForTimeout(150);
	await width.fill('2.5');
	await A.page.waitForTimeout(500);
	const geoApplied = await A.page.evaluate(() => {
		const w = window.__stores;
		const boxes = window.__d1.uuids.map((u) => {
			const object = window.__d1.group.getObjectByProperty('uuid', u);
			return w.geometryEdit.geometryParamsOf(object)?.params?.width ?? null;
		});
		const sphere = window.__d1.group.getObjectByProperty('uuid', window.__d1.sphere);
		return { boxes, sphereType: w.geometryEdit.geometryParamsOf(sphere)?.gtype ?? null };
	});
	h.check(
		geoApplied.boxes.every((v) => Math.abs(v - 2.5) < 0.001),
		`one width edit resizes every Box (${geoApplied.boxes.join(', ')})`
	);
	h.check(geoApplied.sphereType === 'Sphere', 'the Sphere in the selection is untouched');

	// ---------- one texture pick applies to every selected material ----------
	const label = await A.page.evaluate(
		() =>
			[...document.querySelectorAll('.ui-section-label')]
				.map((n) => n.textContent?.trim() ?? '')
				.find((t) => t.startsWith('Texture')) ?? ''
	);
	h.check(/applies to all 4/.test(label), `the Texture row says it fans ("${label}")`);
	await A.page.locator('#texture-file').setInputFiles({
		name: 'tex.png',
		mimeType: 'image/png',
		buffer: Buffer.from(TINY_PNG, 'base64')
	});
	await A.page.waitForTimeout(1500);
	const textured = await A.page.evaluate(() => {
		const all = [...window.__d1.uuids, window.__d1.sphere];
		return all.map((uuid) => {
			const object = window.__d1.group.getObjectByProperty('uuid', uuid);
			let material = null;
			object?.traverse((o) => {
				if (o.material && !material) material = o.material;
			});
			return !!material?.userData?.mapDataUrl;
		});
	});
	h.check(
		textured.length === 4 && textured.every(Boolean),
		`the texture landed on all four materials (${textured.join(', ')})`
	);
	// and one undo takes it off every one of them
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(600);
	const untextured = await A.page.evaluate(() => {
		const all = [...window.__d1.uuids, window.__d1.sphere];
		return all.map((uuid) => {
			const object = window.__d1.group.getObjectByProperty('uuid', uuid);
			let material = null;
			object?.traverse((o) => {
				if (o.material && !material) material = o.material;
			});
			return !!material?.userData?.mapDataUrl;
		});
	});
	h.check(
		untextured.every((has) => !has),
		`ONE undo removes it from all four (${untextured.join(', ')})`
	);

	// ---------- particles stay single-object, with a pointer to the menu ----------
	const particles = await A.page.evaluate(() => ({
		note: document.querySelector('#particles-multi-note')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
		presetPicker: !!document.querySelector('#particles-add')
	}));
	h.check(/Right-click/.test(particles.note), `particles explain the safe path ("${particles.note.slice(0, 60)}")`);
	h.check(!particles.presetPicker, 'no emitter picker for a multi-selection (it would overwrite tuned configs)');

	// ---------- a single selection keeps the old, unbatched behaviour ----------
	await A.page.evaluate(() => {
		const w = window.__stores;
		w.objectActions.applySelectionSet([window.__d1.uuids[1]]);
	});
	await A.page.waitForTimeout(600);
	const single = await A.page.evaluate(() => ({
		note: document.querySelector('#material-multi-note'),
		depth: null
	}));
	h.check(single.note === null, 'a single selection shows no counted note');
	const solo = rowField(A.page, 'Roughness');
	await solo.scrollIntoViewIfNeeded();
	await solo.click();
	await A.page.waitForTimeout(150);
	await solo.fill('0.15');
	await A.page.waitForTimeout(350);
	trio = await readTrio(A.page);
	h.check(
		Math.abs(trio[1].roughness - 0.15) < 0.001 && Math.abs(trio[0].roughness - 0.2) < 0.001,
		`editing one member leaves the others alone (${trio.map((o) => o.roughness).join(', ')})`
	);

	await h.finish(browser);
});
