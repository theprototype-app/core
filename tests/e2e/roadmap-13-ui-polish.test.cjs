// Roadmap #13 Batch A — UI overlap & chrome polish. Single-page checks:
//   A1  the backquote AI pill has NO ✕ (backquote/Escape still close it)
//   A2  the AI HUD button (bottom-left) is hidden until AI is configured, then shows
//   A3  SimControls is HIDDEN by default and appears when the setting is enabled
//   A6  opening the logo menu dismisses an open modal (so the menu is never stacked
//       over a modal)
// A4/A5 (narrow-width drawer + settings row stacking) and A7 (local first-run
// warning, hostname+localStorage gated — off on the .app domain) are CSS/heuristic
// and verified manually / by build; not asserted here.
const h = require('./helpers.cjs');

const BASE = 'https://theprototype.app:5173/mock-ai/v1';

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- A3: SimControls hidden by default -----------------------------------
	const simDefault = await A.page.locator('#sim-play').count();
	h.check(simDefault === 0, 'A3: simulation controls hidden by default');

	await A.page.evaluate(() => window.__stores.showSimControls.set(true));
	await A.page.waitForTimeout(200);
	h.check(await A.page.locator('#sim-play').first().isVisible(), 'A3: enabling the setting shows the sim play button');
	await A.page.evaluate(() => window.__stores.showSimControls.set(false));
	await A.page.waitForTimeout(150);
	h.check((await A.page.locator('#sim-play').count()) === 0, 'A3: disabling the setting hides it again');

	// --- A6: opening the logo menu closes an open modal ----------------------
	await A.page.evaluate(() => {
		window.__stores.closeMenu.set(true); // menu closed
		window.__stores.settingsOpen.set(true); // a modal is open
	});
	await A.page.waitForTimeout(200);
	await A.page.locator('#logo-menu').click();
	await A.page.waitForTimeout(250);
	const settingsClosed = await A.page.evaluate(
		() => new Promise((r) => window.__stores.settingsOpen.subscribe((v) => r(v))())
	);
	h.check(settingsClosed === false, 'A6: opening the menu closed the open Settings modal');
	// tidy up: close the menu again
	await A.page.evaluate(() => window.__stores.closeMenu.set(true));

	// --- A2: AI HUD button hidden until AI is configured ---------------------
	h.check((await A.page.locator('#ai-hud-button').count()) === 0, 'A2: AI HUD button hidden when AI unconfigured');

	// configure a provider + enable AI (persisted), then reload to one module graph
	await A.page.evaluate((base) => {
		window.__stores.aiProviders.addAiProvider({ preset: 'custom', label: 'Mock', baseUrl: base, apiKey: 'test', model: 'mock' });
		window.__stores.aiProviders.setAiEnabled(true);
	}, BASE);
	await h.freshReload(A);
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('#ai-hud-button').first().isVisible(), 'A2: AI HUD button shows once AI is configured');

	// clicking it opens the AI window
	await A.page.locator('#ai-hud-button').click();
	await A.page.waitForTimeout(250);
	h.check(await A.page.locator('#ai-assistant-window').first().isVisible(), 'A2: AI HUD button opens the AI window');

	// --- A1: the pill has no ✕ close button ----------------------------------
	// the pill only shows while the full window is hidden — close it first
	await A.page.evaluate(() => window.__stores.aiAssistantHidden.set('hidden'));
	await A.page.waitForTimeout(150);
	await A.page.evaluate(() => window.__stores.aiPromptBarOpen.set(true));
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('.ai-pill').first().isVisible(), 'A1: backquote pill shows');
	const pillText = await A.page.locator('.ai-pill').first().innerText();
	h.check(!pillText.includes('✕'), 'A1: pill has no ✕ close button');
	await A.page.evaluate(() => window.__stores.aiPromptBarOpen.set(false));

	await h.finish(browser);
});
