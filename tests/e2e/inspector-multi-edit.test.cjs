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
	h.check(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(banner.text), 'and does not print a uuid');
	h.check(banner.badge === '3 objects', `the header badge shows the count ("${banner.badge}")`);
	const identity = await A.page.evaluate(() => ({
		name: !!document.querySelector('#name'),
		uuid: !!document.querySelector('#uuid'),
		group: !!document.querySelector('#select-group')
	}));
	h.check(
		!identity.name && !identity.uuid && !identity.group,
		`single-object identity fields are hidden for a set (name ${identity.name}, uuid ${identity.uuid}, group ${identity.group})`
	);

	// ---------- transforms move the whole selection RIGIDLY ----------
	// The rows drive the selection's ORIGIN, so every axis shows a real number:
	// the objects sit at different X/Z, which used to render as a useless dash.
	const posBefore = await A.page.evaluate(() =>
		window.__d1.uuids.map((u) => window.__d1.group.getObjectByProperty('uuid', u).position.toArray())
	);
	const axis = (name) =>
		A.page
			.locator('#inspector-position .dn-wrap', { has: A.page.locator('.dn-label', { hasText: name }) })
			.locator('.dn-input')
			.first();
	await axis('X').scrollIntoViewIfNeeded();
	const shown = {
		x: await axis('X').inputValue(),
		y: await axis('Y').inputValue(),
		z: await axis('Z').inputValue()
	};
	h.check(
		![shown.x, shown.y, shown.z].includes('—'),
		`no axis shows a dash for a selection (${shown.x}, ${shown.y}, ${shown.z})`
	);
	// the origin sits at the centroid of the three boxes (x 0/2/4 -> 2)
	h.check(Math.abs(parseFloat(shown.x) - 2) < 0.01, `X shows the origin, not one member (${shown.x})`);

	// typing an origin value MOVES the set — it must not collapse it onto a plane
	await axis('Y').click();
	await A.page.waitForTimeout(150);
	await axis('Y').fill('3');
	await A.page.waitForTimeout(350);
	const posAfter = await A.page.evaluate(() =>
		window.__d1.uuids.map((u) => window.__d1.group.getObjectByProperty('uuid', u).position.toArray())
	);
	const centroidY = posAfter.reduce((sum, p) => sum + p[1], 0) / posAfter.length;
	h.check(Math.abs(centroidY - 3) < 0.01, `typing origin Y moves the set there (centroid ${centroidY.toFixed(2)})`);
	const spreadBefore = posBefore.map((p) => p[1] - posBefore.reduce((s, q) => s + q[1], 0) / 3);
	const spreadAfter = posAfter.map((p) => p[1] - centroidY);
	h.check(
		spreadAfter.every((d, i) => Math.abs(d - spreadBefore[i]) < 0.01),
		`and keeps them spread out instead of collapsing (${posAfter.map((p) => p[1].toFixed(2)).join(', ')})`
	);
	h.check(
		posAfter.every((p, i) => Math.abs(p[0] - posBefore[i][0]) < 0.001),
		'the other axes are untouched'
	);
	// the gesture seals after ~500ms into ONE transformSet entry
	await A.page.waitForTimeout(900);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(400);
	const posUndone = await A.page.evaluate(() =>
		window.__d1.uuids.map((u) => window.__d1.group.getObjectByProperty('uuid', u).position.toArray())
	);
	h.check(
		posUndone.every((p, i) => Math.abs(p[1] - posBefore[i][1]) < 0.001),
		`ONE undo restores every original Y (${posUndone.map((p) => p[1].toFixed(2)).join(', ')})`
	);

	// ---------- "Move origin" re-points the gizmo, objects stay put ----------
	const originMoved = await A.page.evaluate(async () => {
		const w = window.__stores;
		document.querySelector('#origin-mode')?.click();
		await new Promise((r) => setTimeout(r, 250));
		const on = await new Promise((r) => w.multiTransform.pivotOnly.subscribe(r)());
		const before = window.__d1.uuids.map((u) =>
			window.__d1.group.getObjectByProperty('uuid', u).position.toArray()
		);
		return { on, before };
	});
	h.check(originMoved.on === true, 'the Move origin button turns the mode on');
	await axis('X').click();
	await A.page.waitForTimeout(150);
	await axis('X').fill('7');
	await A.page.waitForTimeout(350);
	const afterOrigin = await A.page.evaluate(async () => {
		const w = window.__stores;
		const pose = await new Promise((r) => w.multiTransform.pivotPose.subscribe(r)());
		return {
			originX: pose?.pos?.[0] ?? null,
			positions: window.__d1.uuids.map((u) =>
				window.__d1.group.getObjectByProperty('uuid', u).position.toArray()
			)
		};
	});
	h.check(Math.abs((afterOrigin.originX ?? 0) - 7) < 0.01, `the origin moved to 7 (${afterOrigin.originX})`);
	h.check(
		afterOrigin.positions.every((p, i) => Math.abs(p[0] - originMoved.before[i][0]) < 0.001),
		`and NO object moved with it (${afterOrigin.positions.map((p) => p[0].toFixed(2)).join(', ')})`
	);
	// leaving origin mode, a rotation now turns the set about that origin
	const rotated = await A.page.evaluate(async () => {
		const w = window.__stores;
		document.querySelector('#origin-mode')?.click(); // Done
		await new Promise((r) => setTimeout(r, 250));
		const before = window.__d1.uuids.map((u) =>
			window.__d1.group.getObjectByProperty('uuid', u).position.toArray()
		);
		// rotate 90 degrees about the origin through the same path the rows use
		w.multiTransform.applyPivotTransform((pivot) => {
			pivot.rotation.y = Math.PI / 2;
		});
		await new Promise((r) => setTimeout(r, 250));
		const after = window.__d1.uuids.map((u) =>
			window.__d1.group.getObjectByProperty('uuid', u).position.toArray()
		);
		const pose = await new Promise((r) => w.multiTransform.pivotPose.subscribe(r)());
		return { before, after, origin: pose?.pos ?? null };
	});
	// A 90-degree turn about Y around origin O sends offset (dx,dz) to (dz,-dx):
	// x' = O.x + dz, z' = O.z - dx. With the origin parked at x=7 and everything
	// on z=0, all three must land ON x=7 with z = 7 - x. Exact, so a no-op or a
	// rotation about the old centroid both fail.
	const ox = rotated.origin?.[0] ?? 0;
	const oz = rotated.origin?.[2] ?? 0;
	const turnedRight = rotated.after.every((p, i) => {
		const dx = rotated.before[i][0] - ox;
		const dz = rotated.before[i][2] - oz;
		return Math.abs(p[0] - (ox + dz)) < 0.05 && Math.abs(p[2] - (oz - dx)) < 0.05;
	});
	h.check(
		turnedRight,
		`rotation swings the set around the placed origin (${rotated.after.map((p) => `${p[0].toFixed(1)}/${p[2].toFixed(1)}`).join(' ')} about ${ox.toFixed(1)})`
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
