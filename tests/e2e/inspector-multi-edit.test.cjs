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
