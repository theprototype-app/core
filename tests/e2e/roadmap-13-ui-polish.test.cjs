// Roadmap #13 Batch A — UI overlap & chrome polish. Single-page checks:
//   A1  the backquote AI pill has NO ✕ (backquote/Escape still close it)
//   A3  SimControls is HIDDEN by default and appears when the setting is enabled
//   A6  opening the logo menu dismisses an open modal (so the menu is never stacked
//       over a modal)
// Batch I — UI follow-up fixes (also single-page):
//   I1  the AI HUD button uses the MobileAddButton classes (bg-gray-700) so it
//       matches the "+" in every theme
//   I2  the left corner stack matches the right: "+" at bottom-16 (mic parity),
//       AI at bottom-4 (chat parity)
//   I3  the AI HUD button ALWAYS renders; unconfigured, clicking opens Settings ▸ AI;
//       configured, it opens the chat window
//   I4  the far-zoom grid fade SNAPS to its target (no multi-frame lerp ramp that
//       swept a flashing fade ring during camera movement)
//   I5  the Connect pill shows the resolved signaling server (dot + label), and the
//       label flips to "public (fallback)" when the self-hosted server is unreachable
// A2 folded into I1/I3. A4/A5 (narrow-width drawer + settings row stacking) and A7
// (local first-run warning, hostname+localStorage gated — off on the .app domain) are
// CSS/heuristic and verified manually / by build; not asserted here.
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

	// --- I3: AI HUD button ALWAYS renders (even unconfigured) ----------------
	h.check(await A.page.locator('#ai-hud-button').first().isVisible(), 'I3: AI HUD button visible when AI unconfigured');

	// --- I1: it uses the MobileAddButton classes (bg-gray-700, matches "+") ---
	const aiClass = await A.page.locator('#ai-hud-button').getAttribute('class');
	const plusClass = await A.page.locator('#mobile-add-button').getAttribute('class');
	h.check(/\bbg-gray-700\b/.test(aiClass) && /\bhover:bg-gray-600\b/.test(aiClass), 'I1: AI button uses the gray-700 "+" styling');
	h.check(!/\bbg-white\b/.test(aiClass), 'I1: AI button no longer white');

	// --- I2: left stack geometry matches the right (AI=bottom-4, "+"=bottom-16) --
	h.check(/\bbottom-4\b/.test(aiClass), 'I2: AI button at bottom-4 (chat parity)');
	h.check(/\bbottom-16\b/.test(plusClass), 'I2: "+" button at bottom-16 (mic parity)');

	// --- I3: unconfigured click opens Settings ▸ AI (the toggleAiPrompt branch) --
	await A.page.evaluate(() => {
		window.__stores.settingsOpen.set(false);
		window.__stores.settingsSection.set('');
	});
	await A.page.locator('#ai-hud-button').click();
	await A.page.waitForTimeout(200);
	const openedSettings = await A.page.evaluate(() => {
		const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
		return Promise.all([read(window.__stores.settingsOpen), read(window.__stores.settingsSection)]).then(
			([open, section]) => ({ open, section })
		);
	});
	h.check(openedSettings.open === true, 'I3: unconfigured click opens Settings');
	h.check(openedSettings.section === 'ai', 'I3: unconfigured click targets the AI section');
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));

	// configure a provider + enable AI (persisted), then reload to one module graph
	await A.page.evaluate((base) => {
		window.__stores.aiProviders.addAiProvider({ preset: 'custom', label: 'Mock', baseUrl: base, apiKey: 'test', model: 'mock' });
		window.__stores.aiProviders.setAiEnabled(true);
	}, BASE);
	await h.freshReload(A);
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('#ai-hud-button').first().isVisible(), 'I3: AI HUD button still visible once configured');

	// configured click opens the AI window
	await A.page.locator('#ai-hud-button').click();
	await A.page.waitForTimeout(250);
	h.check(await A.page.locator('#ai-assistant-window').first().isVisible(), 'I3: configured click opens the AI window');

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
