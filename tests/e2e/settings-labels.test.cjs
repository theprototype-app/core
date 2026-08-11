// Phase 168: Settings rows read as a bold label + terse values (the value never
// repeats the label word). Shadow quality / Snap turn / Theme selects lost their
// redundant prefixes; the descriptions carry the label.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(500);
	await A.page.getByText('Scene', { exact: true }).first().click(); // expand Scene
	await A.page.waitForTimeout(300);
	// Theme lives in the Interface section since the settings reorg
	await A.page.getByText('Interface', { exact: true }).first().click();
	await A.page.waitForTimeout(300);

	// label prefixes on the descriptions
	h.check(await A.page.getByText('Shadow quality', { exact: false }).first().isVisible(), 'a "Shadow quality" label renders');
	h.check(await A.page.getByText('Theme', { exact: false }).first().isVisible(), 'a "Theme" label renders');

	// the redundant prefixes are gone from the option values
	const dupes = await A.page.evaluate(() => ({
		shadows: document.body.innerText.includes('Shadows: low'),
		themePrefix: document.body.innerText.includes('Theme: '),
		snap: document.body.innerText.includes('Snap turn 15')
	}));
	h.check(!dupes.shadows, 'no "Shadows: low" prefix on the values');
	h.check(!dupes.themePrefix, 'no "Theme:" prefix on the values');
	h.check(!dupes.snap, 'no "Snap turn 15" prefix on the values');

	// terse values still drive the store (shadow quality button shows the value)
	const btn = () => A.page.locator('#shadow-quality').innerText();
	await A.page.evaluate(() => window.__stores.lightParams.shadowQuality.set('low'));
	await A.page.waitForTimeout(150);
	h.check((await btn()).includes('Low'), 'the shadow-quality select shows the terse value (Low)');
	await A.page.evaluate(() => window.__stores.lightParams.shadowQuality.set('high'));
	await A.page.waitForTimeout(150);
	h.check((await btn()).includes('High'), 'and updates with the store (High)');

	// --- the settings SEARCH ---------------------------------------------------
	// It went dead in the flowbite 1.x migration: an AccordionItem mounts its body
	// only while open and the accordion was single-selection, so with the sections
	// collapsed there were literally ZERO `.setting-row` elements to filter. Search
	// now expands every section (the accordion is `multiple`) and matches a row on
	// its own text PLUS its group label and section heading.
	/** @param {string} q */
	const search = async (q) => {
		await A.page.locator('#settings-search').fill(q);
		await A.page.waitForTimeout(450);
		return A.page.evaluate(() => {
			const rows = [...document.querySelectorAll('.setting-row')];
			const headers = [...document.querySelectorAll('.modal-content h2')];
			return {
				mounted: rows.length,
				shown: rows.filter((r) => /** @type {any} */ (r).style.display !== 'none').length,
				visibleHeaders: headers.filter((x) => /** @type {any} */ (x).style.display !== 'none')
					.length,
				headers: headers.length
			};
		});
	};
	const ownLabel = await search('shadow');
	h.check(
		ownLabel.mounted > 20 && ownLabel.shown > 0,
		`searching mounts every section and finds matches (${ownLabel.shown} of ${ownLabel.mounted})`
	);
	const bySection = await search('vr');
	h.check(
		bySection.shown > 5,
		`a SECTION name matches everything under it — "vr" (${bySection.shown} rows)`
	);
	h.check(
		bySection.visibleHeaders < bySection.headers,
		`sections with no hits get out of the way (${bySection.visibleHeaders}/${bySection.headers} headers)`
	);
	const noHit = await search('zzzznotasetting');
	h.check(noHit.shown === 0, `a nonsense query shows nothing (${noHit.shown})`);
	const cleared = await search('');
	h.check(
		cleared.visibleHeaders === cleared.headers,
		`clearing the query brings every section header back (${cleared.visibleHeaders}/${cleared.headers})`
	);

	// --- autofocus is a POINTER-device courtesy --------------------------------
	// This is a fine-pointer browser, so autofocus must be allowed here; a coarse
	// pointer would raise the on-screen keyboard over the panel the user just
	// opened, and THAT cannot be emulated headlessly — it stays an on-device check.
	const device = await A.page.evaluate(() => {
		const d = window.__stores.inputDevice;
		return {
			coarse: d.coarsePointer(),
			autofocus: d.autofocusOk(),
			typing: d.isTypingKey(new KeyboardEvent('keydown', { key: 'a' })),
			shortcut: d.isTypingKey(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))
		};
	});
	h.check(
		device.coarse === false && device.autofocus === true && device.typing && !device.shortcut,
		`a pointer device may autofocus, and only printable keys count as typing (${JSON.stringify(device)})`
	);
	// the physical-keyboard path: with nothing focused, one keystroke adopts the field
	const adopted = await A.page.evaluate(async () => {
		const d = window.__stores.inputDevice;
		const input = document.createElement('input');
		document.body.appendChild(input);
		const stop = d.typeToFocus(() => input);
		/** @type {any} */ (document.activeElement)?.blur?.();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
		await new Promise((r) => setTimeout(r, 60));
		const out = { focused: document.activeElement === input, value: input.value };
		stop();
		input.blur();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
		await new Promise((r) => setTimeout(r, 60));
		const afterTeardown = input.value;
		input.remove();
		return { ...out, afterTeardown };
	});
	h.check(
		adopted.focused && adopted.value === 'k',
		`typing hands the first key to the field, so a Bluetooth keyboard still filters (${JSON.stringify(adopted)})`
	);
	h.check(adopted.afterTeardown === 'k', 'and the listener goes away on teardown');

	await h.finish(browser);
});
