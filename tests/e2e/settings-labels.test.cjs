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

	await h.finish(browser);
});
