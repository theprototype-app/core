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
//   I4  the far-zoom "circle": (a) the grid fade SNAPS to its target (no multi-frame
//       lerp ramp), and (b) the shadow-catcher disc has depthWrite:false so N8AO no
//       longer paints it as a dark disc at the scene centre on far dolly-out
//   I5  (roadmap-14 CN migration) server info moved behind the (i) button's info
//       drawer — asserts the drawer server label, fallback flip + (i) badge; the
//       label flips to "public (fallback)" when the self-hosted server is unreachable
//   +   the logo-menu Docs link opens docs.theprototype.app
//   +   Settings ▸ About links point at the theprototype-app org (core/modules/docs)
//   +   the first-run banner is driven by the `appNotice` store (OSS "local version"
//       notice; the cloud plugin can rebrand or remove it via appNotice.set(null))
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

	// --- I5 (migrated to the CN drawer): server info lives behind the (i) button --
	h.check(await A.page.locator('[data-testid="connect-info-button"]').first().isVisible(), 'I5/CN: (i) info button renders in the Connect pill');
	await A.page.locator('[data-testid="connect-info-button"]').click();
	await A.page.waitForTimeout(250);
	h.check(await A.page.locator('[data-testid="connect-info-drawer"]').first().isVisible(), 'I5/CN: the info drawer opens');
	const srvLabel = (await A.page.locator('[data-testid="drawer-server-label"]').first().innerText()).trim();
	h.check(srvLabel.length > 0, 'I5/CN: drawer shows a non-empty server label (' + srvLabel + ')');
	// drive the fallback state and confirm the label + kind flip + the (i) badge
	await A.page.evaluate(() => {
		window.__stores.peerServer.peerServerStatus.set({
			kind: 'public', label: 'public cloud', host: 'PeerJS public cloud', port: 443, path: '/', didFallback: true
		});
	});
	await A.page.waitForTimeout(150);
	const fbLabel = (await A.page.locator('[data-testid="drawer-server-label"]').first().innerText()).trim();
	const fbKind = await A.page.locator('[data-testid="drawer-server-row"]').first().getAttribute('data-kind');
	h.check(fbLabel === 'public (fallback)', 'I5/CN: fallback flips the drawer label to "public (fallback)"');
	h.check(fbKind === 'fallback', 'I5/CN: fallback sets data-kind="fallback"');
	h.check(await A.page.locator('[data-testid="drawer-fallback-warn"]').first().isVisible(), 'I5/CN: fallback warning row shows');
	h.check(await A.page.locator('[data-testid="connect-info-warn"]').first().isVisible(), 'I5/CN: the (i) button gains the amber fallback badge');
	// close the drawer (outside pointerdown). Poll past the slide-out transition
	// before asserting it's gone from the DOM.
	await A.page.mouse.click(10, 400);
	await h.eventually(
		() => A.page.locator('[data-testid="connect-info-drawer"]').count(),
		(n) => n === 0,
		'I5/CN: clicking outside closes the drawer'
	);

	// --- I4: far-zoom grid fade SNAPS (no multi-frame lerp ramp) --------------
	// dolly the camera far out, then sample the grid fadeDistance uniform: the old
	// 0.2/frame lerp ramped over ~35 frames (the sweeping ring); the fix reaches the
	// target within a frame and holds it.
	const readFade = () =>
		A.page.evaluate(
			() =>
				new Promise((resolve) => {
					window.__stores.globalScene.subscribe((sc) => {
						let fade = null;
						sc?.traverse((o) => {
							const m = o.material;
							if (m && m.uniforms && 'fadeDistance' in m.uniforms) fade = m.uniforms.fadeDistance.value;
						});
						resolve(fade);
					})();
				})
		);
	await A.page.evaluate(() => {
		return new Promise((resolve) => {
			window.__stores.orbitControls.subscribe((oc) => {
				window.__stores.globalCamera.subscribe((cam) => {
					if (cam && oc) {
						oc.target.set(0, 1.5, 0);
						cam.position.set(1200, 900, 1200);
						oc.update();
					}
					resolve(true);
				})();
			})();
		});
	});
	await A.page.waitForTimeout(60); // two frames
	const f1 = await readFade();
	await A.page.waitForTimeout(400); // many more frames
	const f2 = await readFade();
	h.check(f1 != null && f1 > 500, 'I4: grid fade tracks far zoom (' + Math.round(f1) + ')');
	h.check(f1 != null && f2 != null && Math.abs(f2 - f1) < f1 * 0.05, 'I4: grid fade snaps — no multi-frame ramp (Δ ' + Math.round(Math.abs(f2 - f1)) + ')');

	// --- I4 (disc): the shadow catcher is kept OUT of the N8AO depth buffer ---
	// so AO can't paint the scene-span disc as a dark "far-zoom circle". The disc
	// still receives shadows (depthWrite only affects the depth buffer AO samples).
	const catcherDepthWrite = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((sc) => {
					let dw = 'missing';
					sc?.traverse((o) => {
						if (o.name === 'env-shadow-catcher') dw = o.material && o.material.depthWrite;
					});
					resolve(dw);
				})();
			})
	);
	h.check(catcherDepthWrite === false, 'I4: shadow catcher has depthWrite:false (no AO far-zoom disc)');

	// --- Docs menu link points at docs.theprototype.app ----------------------
	await A.page.evaluate(() => {
		window.__lastOpen = null;
		window.open = (u) => {
			window.__lastOpen = u;
			return null;
		};
		window.__stores.closeMenu.set(false); // open the logo/burger menu
	});
	await A.page.waitForTimeout(200);
	await A.page.getByRole('button', { name: 'Docs' }).click();
	const docUrl = await A.page.evaluate(() => window.__lastOpen);
	h.check(docUrl === 'https://docs.theprototype.app', 'Docs menu link -> docs.theprototype.app (' + docUrl + ')');
	await A.page.evaluate(() => window.__stores.closeMenu.set(true));

	// --- Settings ▸ About links point at the theprototype-app org ------------
	await A.page.evaluate(() => {
		window.__stores.settingsSection.set('about');
		window.__stores.settingsOpen.set(true);
	});
	await A.page.waitForTimeout(300);
	await A.page
		.getByRole('button', { name: 'About', exact: true })
		.click()
		.catch(() => {});
	await A.page.waitForTimeout(200);
	const aboutLinks = await A.page.evaluate(() =>
		Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'))
	);
	h.check(aboutLinks.includes('https://github.com/theprototype-app/core'), 'About: Source Code -> core repo');
	h.check(aboutLinks.includes('https://github.com/theprototype-app/modules'), 'About: Modules -> modules repo');
	h.check(aboutLinks.includes('https://github.com/theprototype-app/docs'), 'About: Docs -> docs repo');
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));

	// --- first-run notice is driven by appNotice (cloud plugin can override) --
	// OSS default is a "local version" notice; the cloud plugin can rebrand it or
	// remove it entirely via appNotice.set(null).
	await A.page.evaluate(() => {
		localStorage.removeItem('hasSeenDisclaimer'); // let the first-run banner show
		window.__stores.appNotice.set({
			text: 'You are running the local, open-source version of theprototype.',
			ctaLabel: 'Source',
			ctaUrl: 'https://github.com/theprototype-app/core'
		});
	});
	await A.page.waitForTimeout(250);
	const noticeVisible = await A.page
		.getByText('local, open-source version', { exact: false })
		.first()
		.isVisible()
		.catch(() => false);
	h.check(noticeVisible, 'first-run notice shows the appNotice text (local version)');
	h.check(
		(await A.page.getByText('This is an alpha release', { exact: false }).count()) === 0,
		'the old "alpha release" toast is gone'
	);
	// cloud plugin removes the banner
	await A.page.evaluate(() => window.__stores.appNotice.set(null));
	await A.page.waitForTimeout(200);
	h.check(
		(await A.page.getByText('local, open-source version', { exact: false }).count()) === 0,
		'appNotice.set(null) removes the banner (cloud override seam)'
	);
	await A.page.evaluate(() => localStorage.setItem('hasSeenDisclaimer', 'true'));

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
