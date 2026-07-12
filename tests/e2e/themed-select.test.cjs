// Phase 146: ThemedSelect replaces the white/OS-styled native <select>. Driven
// through a real in-app dropdown (the material-type select the user flagged):
// it opens a themed popup (portaled to body, NOT white), picking an item fires
// onchange (switches the material), and the popup recolors when the theme
// changes.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// a box, selected with the properties inspector open -> the Material section
	// renders the #select-material ThemedSelect
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		window.__box = box;
		window.__stores.objectActions.selectObject(box.uuid, true);
	});
	await A.page.waitForTimeout(600);

	// --- the trigger renders (a button, not a native <select>) + is not white ---
	const trigger = await A.page.evaluate(() => {
		const el = document.querySelector('#select-material');
		if (!el) return null;
		return {
			tag: el.tagName,
			bg: getComputedStyle(el).backgroundColor,
			label: el.textContent.trim()
		};
	});
	h.check(!!trigger, 'the material select renders');
	h.check(trigger.tag === 'BUTTON', 'it is a themed button, not a native <select>');
	h.check(trigger.bg !== 'rgb(255, 255, 255)', `the trigger is themed, not white (${trigger.bg})`);
	h.check(/Basic|Standard|Phong|Toon|Shadow/.test(trigger.label), `the trigger shows the current material type (${trigger.label})`);

	// --- clicking opens a popup portaled to <body>, themed dark (not white) ---
	const popup = await A.page.evaluate(() => {
		document.querySelector('#select-material').click();
		return new Promise((resolve) =>
			setTimeout(() => {
				const list = document.querySelector('.ts-list');
				resolve({
					open: !!list,
					onBody: list?.parentElement === document.body,
					bg: list ? getComputedStyle(list).backgroundColor : null,
					options: list ? [...list.querySelectorAll('.ts-opt')].map((o) => o.textContent.trim()) : []
				});
			}, 200)
		);
	});
	h.check(popup.open && popup.onBody, 'clicking opens the popup portaled to <body> (never clipped)');
	h.check(popup.bg === 'rgb(31, 41, 55)', `the popup is themed dark, not white (${popup.bg})`);
	h.check(
		popup.options.length >= 3 && popup.options.some((o) => o.includes('Basic')),
		`the popup lists the material types (${popup.options.length})`
	);

	// --- picking an item fires onchange -> switches the material type + closes ---
	const picked = await A.page.evaluate(() => {
		const typeByName = {
			Basic: 'MeshBasicMaterial',
			Standard: 'MeshStandardMaterial',
			Phong: 'MeshPhongMaterial',
			Toon: 'MeshToonMaterial',
			Shadow: 'ShadowMaterial'
		};
		const before = window.__box.material.type;
		// pick the first option whose type differs from the current one
		const opt = [...document.querySelectorAll('.ts-list .ts-opt')].find(
			(o) => typeByName[o.textContent.trim()] && typeByName[o.textContent.trim()] !== before
		);
		const targetType = typeByName[opt.textContent.trim()];
		opt.click();
		return new Promise((resolve) =>
			setTimeout(() => {
				resolve({
					before,
					targetType,
					after: window.__box.material.type,
					closed: !document.querySelector('.ts-list')
				});
			}, 200)
		);
	});
	h.check(
		picked.after === picked.targetType && picked.after !== picked.before,
		`picking fires onchange + switches the material (${picked.before} -> ${picked.after})`
	);
	h.check(picked.closed, 'the popup closes after picking');

	// --- the popup recolors with the theme (green console -> dark green) ---
	const themed = await A.page.evaluate(() => {
		window.__stores.themes.theme.set('green');
		document.querySelector('#select-material').click();
		return new Promise((resolve) =>
			setTimeout(() => {
				const list = document.querySelector('.ts-list');
				const bg = list ? getComputedStyle(list).backgroundColor : null;
				list && document.querySelector('#select-material').click(); // close
				resolve(bg);
			}, 200)
		);
	});
	h.check(themed === 'rgb(4, 23, 10)', `the popup follows the theme tokens (green surface ${themed})`);

	// restore
	await A.page.evaluate(() => window.__stores.themes.theme.set('dark'));

	await h.finish(browser);
});
