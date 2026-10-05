// 36-vr-ai (B9): the VR keyboard as THE text input in the headset — the fallback when voice typing is not
// set up (the AI panel's input row; vr-ai-panel covers that path), renames, and now SETTINGS SEARCH. This
// suite covers what B9 added: the punctuation a sentence needs (with Shift on the US layout's keys), a Clear
// key, the plate fitting its widest row, a live `onInput` (a search filters as you type), the VR Settings
// panel's Search page (type -> results -> press one), Esc putting the old query back, and a rename with
// punctuation going through. Laser typing feel in a headset is the user's check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- 1. pure: punctuation, shift, clear ---
	const pure = await A.page.evaluate(() => {
		const k = window.__stores.vrKeyboard;
		let s = { buffer: '', shift: false };
		const feed = (...keys) => keys.forEach((key) => (s = k.keyPress(key, s)));
		feed('i', "'", 'm', 'space', 'o', 'k', ',', 'space', 'r', 'e', 'd', '-', 'b', 'o', 'x', '?');
		const sentence = s.buffer;
		feed('shift', '-', 'shift', "'", 'shift', ';', 'shift', '?');
		const shifted = s.buffer.slice(sentence.length);
		feed('clear');
		return { sentence, shifted, cleared: s.buffer, rows: k.KEY_ROWS.flat() };
	});
	h.check(pure.sentence === "i'm ok, red-box?", `punctuation types (${pure.sentence})`);
	h.check(pure.shifted === '_":/', `Shift gives the US layout's second symbols (${pure.shifted})`);
	h.check(pure.cleared === '', 'Clear empties the line');

	// --- 2. live input + the rendered grid fits its plate ---
	await A.page.evaluate(() => {
		window.__seen = [];
		window.__stores.vrKeyboard.openVRKeyboard({ title: 'Test', onCommit: () => {}, onInput: (t) => window.__seen.push(t) });
		['a', 'b', 'backspace', 'enter'].forEach((key) => window.__stores.vrKeyboard.pressVRKey(key));
	});
	h.check(JSON.stringify(await A.page.evaluate(() => window.__seen)) === '["a","ab","a"]', 'onInput hears every edit (and not Enter)');
	await A.page.evaluate(() => window.__stores.vrKeyboard.openVRKeyboard({ title: 'Look', onCommit: () => {} }));
	await A.page.waitForTimeout(400);
	const grid = await A.page.evaluate(() => {
		const THREE = window.__stores.THREE;
		let scene;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		const plate = scene.getObjectByName('vr-keyboard');
		plate.updateMatrixWorld(true);
		const keys = [];
		const box = new THREE.Box3();
		plate.traverse((o) => {
			if (o.name?.startsWith('vrkey-')) {
				keys.push(o.name.slice(6));
				box.expandByObject(o);
			}
		});
		const back = new THREE.Box3().setFromObject(plate.children[0]);
		return { keys, inside: box.min.x >= back.min.x - 1e-6 && box.max.x <= back.max.x + 1e-6 };
	});
	h.check(["?", ',', '.', "'", '-', ';', 'clear'].every((k) => grid.keys.includes(k)), `the grid renders the new keys (${grid.keys.length} keys)`);
	h.check(grid.inside, 'every key sits on the plate (the widest row sets its width)');
	await A.page.evaluate(() => window.__stores.vrKeyboard.closeVRKeyboard());

	// --- 3. Settings ▸ Search in the headset panel ---
	const search = await A.page.evaluate(() => {
		const s = window.__stores;
		const schema = s.vrSettingsSchema;
		const get = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		s.vrSettingsPanelOpen.set(true);
		s.vrControls.executeVRMenuAction('vrset:page:search');
		const empty = schema.settingsPanelRows('search').map((r) => r.action);
		s.vrControls.executeVRMenuAction('vrset:search');
		const kb = get(s.vrKeyboard.vrKeyboardTarget);
		['t', 'u', 'r', 'n'].forEach((key) => s.vrKeyboard.pressVRKey(key));
		const live = schema.settingsPanelRows('search').map((r) => r.rowId).filter(Boolean);
		s.vrKeyboard.pressVRKey('enter');
		const committed = get(schema.vrSettingsQuery);
		return { empty, title: kb?.title, page: get(schema.vrSettingsPage), live, committed };
	});
	h.check(search.empty.includes('vrset:search') && search.empty.length === 4, `the Search page starts with only its query row (${search.empty})`);
	h.check(search.title === 'Search settings' && search.page === 'search', 'the query row opens the VR keyboard');
	h.check(['turning', 'snapAngle', 'smoothSpeed', 'mirror'].every((id) => search.live.includes(id)), `results follow the keys as you type (${search.live})`);
	h.check(!search.live.includes('teleport'), 'and only what matches (Teleport is not a turn setting)');
	h.check(search.committed === 'turn', 'Enter keeps the query');

	const press = await A.page.evaluate(() => {
		const s = window.__stores;
		const schema = s.vrSettingsSchema;
		const get = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		// type a query that finds the Teleport toggle, press the result
		s.vrControls.executeVRMenuAction('vrset:search');
		s.vrKeyboard.pressVRKey('clear');
		'teleport'.split('').forEach((key) => s.vrKeyboard.pressVRKey(key));
		s.vrKeyboard.pressVRKey('enter');
		const before = get(s.vrTeleportEnabled);
		s.vrControls.executeVRMenuAction('vrset:teleport');
		const after = get(s.vrTeleportEnabled);
		s.vrControls.executeVRMenuAction('vrset:teleport'); // put it back
		// Esc puts the old query back
		s.vrControls.executeVRMenuAction('vrset:search');
		['z', 'z', 'z'].forEach((key) => s.vrKeyboard.pressVRKey(key));
		const nothing = schema.settingsPanelRows('search').map((r) => r.label);
		s.vrKeyboard.pressVRKey('esc');
		return { flipped: before !== after, nothing, restored: get(schema.vrSettingsQuery) };
	});
	h.check(press.flipped, 'a search result is the real setting: pressing it changes it');
	h.check(press.nothing.includes('No VR setting matches'), 'a query that finds nothing says so');
	h.check(press.restored === 'teleport', `Esc puts the previous query back (${press.restored})`);

	await A.page.waitForTimeout(400);
	const meshes = await A.page.evaluate(() => {
		let scene;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		const names = [];
		scene.getObjectByName('vr-settings-panel')?.traverse((o) => o.name?.startsWith('vrsettings-') && names.push(o.name));
		return names;
	});
	h.check(meshes.includes('vrsettings-vrset:page:search') && meshes.includes('vrsettings-vrset:search') && meshes.includes('vrsettings-vrset:teleport'),
		`the panel draws the Search tab, the query row and the result (${meshes.length} controls)`);
	await A.page.evaluate(() => window.__stores.vrSettingsPanelOpen.set(false));

	// --- 4. a rename with punctuation goes through the keyboard ---
	const renamed = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 300));
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		const box = group.children[group.children.length - 1];
		s.vrControls.executeVRMenuAction('panel:rename:' + box.uuid);
		s.vrKeyboard.pressVRKey('clear');
		['t', 'o', 'm', "'", 's', '-', '2'].forEach((key) => s.vrKeyboard.pressVRKey(key));
		s.vrKeyboard.pressVRKey('enter');
		await new Promise((r) => setTimeout(r, 200));
		return box.name;
	});
	h.check(renamed === "tom's-2", `a VR rename keeps its punctuation (${renamed})`);

	await h.finish(browser);
});
