// 86-fix N1 — THE AI WINDOW ALWAYS OPENS. With no AI provider set up the AI button used to toast and jump to
// Settings ▸ AI, so Connect Claude (which needs no provider) could not be reached. Now:
//
//   OSS (no connector): the button opens the window on a welcome with one choice — your own provider
//   (Open settings ▸ AI); no Connect Claude anywhere. The quick prompt bar (`) keeps its provider toast.
//   cloud, signed out: the first choice carries the plugin's "Sign in to connect" (a fake mount here);
//   signing in swaps it for Connect Claude IN THE SAME WINDOW; Connect → the connected state + Disconnect.
//   axe on the welcome; the OPPO Find N6 folded / unfolded (dark + light), screenshots for the docs.
//
// Run: APP_URL='https://theprototype.app:5890/' npm run e2e -- connector-window
const path = require('path');
const h = require('./helpers.cjs');
const { AxeBuilder } = require('@axe-core/playwright');
const { installProvider, fakeRelay, connectorPhase } = require('./connectorFake.cjs');

const OUT = process.env.E2E_OUT || 'test-results/86-fix';

async function axe(page, include, label) {
	const res = await new AxeBuilder({ page }).include(include).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
	const gated = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
	for (const v of res.violations) console.log(`  [${label}] ${v.impact} ${v.id} (${v.nodes.length}) — ${v.help}`);
	h.check(gated.length === 0, `${label}: no serious/critical axe violations (${gated.map((v) => v.id).join(', ') || 'none'})`);
}

const read = (page, name) => page.evaluate((n) => new Promise((r) => window.__stores[n].subscribe((v) => r(v))()), name);

/** the plugin's "Sign in to connect" mount, faked: a button that "signs in" = installs the provider */
async function installSignIn(page) {
	await page.evaluate(() => {
		window.__signInPresses = 0;
		window.__stores.cloudHooks.connectorSignInSlot.set((el) => {
			const b = document.createElement('button');
			b.id = 'connect-claude-signin';
			b.textContent = 'Sign in to connect';
			b.onclick = () => window.__signInPresses++;
			el.append(b);
			return () => b.remove();
		});
	});
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => window.__stores.toastsInDrawerOnly.set(true));

	// ---- OSS: the button opens the window on the welcome -------------------------------------------
	h.check(!(await A.page.evaluate(() => window.__stores.aiProviders.aiReady())), 'no AI provider is set up');
	await A.page.locator('#ai-hud-button').first().click();
	await A.page.locator('#ai-assistant-window').waitFor({ state: 'visible', timeout: 10000 });
	h.check((await read(A.page, 'settingsOpen')) !== true, 'the AI button opened the window, not Settings');
	h.check(await A.page.locator('#ai-welcome').isVisible(), 'the window shows the welcome');
	h.check((await A.page.locator('#connect-claude').count()) === 0, 'OSS: no Connect Claude choice');
	h.check(await A.page.locator('#ai-welcome-own').isVisible(), 'the "Use your own AI provider" choice is there');
	await A.page.locator('#ai-welcome-settings').click();
	h.check((await read(A.page, 'settingsOpen')) === true && (await read(A.page, 'settingsSection')) === 'ai', 'Open settings goes to Settings ▸ AI');
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));

	// the prompt bar keeps the provider toast (it is a prompt, not the window)
	await A.page.evaluate(() => window.__stores.settingsSection.set(''));
	await A.page.locator('#ai-welcome-own').click(); // focus the page, not a field
	await A.page.keyboard.press('Backquote');
	await A.page.waitForTimeout(300);
	h.check((await read(A.page, 'aiPromptBarOpen')) !== true && (await read(A.page, 'settingsSection')) === 'ai', 'the ` prompt bar still points at Settings ▸ AI with no provider');
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));

	// ---- cloud, signed out: Sign in to connect --------------------------------------------------------
	await installSignIn(A.page);
	const signIn = A.page.locator('#ai-welcome #connect-claude #connect-claude-signin');
	await signIn.waitFor({ state: 'visible', timeout: 10000 });
	h.check(true, 'signed out: the first choice offers Sign in to connect');
	h.check(/Connect Claude/.test((await A.page.locator('#connect-claude-title').textContent()) ?? '') && /no API key/.test((await A.page.locator('#connect-claude .cc-desc').textContent()) ?? ''), 'the choice says what it is: Connect Claude, your Claude account, no API key');
	await signIn.click();
	h.check((await A.page.evaluate(() => window.__signInPresses)) === 1, 'the press reaches the plugin');
	await axe(A.page, '#ai-welcome', 'AI welcome (signed out)');
	await A.page.screenshot({ path: path.join(OUT, 'n1-signed-out.png') }).catch(() => {});

	// "signing in": the plugin removes the mount and installs the provider — the window stays, the button appears
	const relay = await fakeRelay(A.page);
	await A.page.evaluate(() => window.__stores.cloudHooks.connectorSignInSlot.set(null));
	await installProvider(A.page);
	const button = A.page.locator('#ai-welcome #connect-claude-button');
	await button.waitFor({ state: 'visible', timeout: 10000 });
	h.check((await read(A.page, 'aiAssistantHidden')) === '' && (await A.page.locator('#connect-claude-signin').count()) === 0, 'after sign-in the same window shows Connect Claude');
	h.check((await A.page.locator('#connect-claude').count()) === 1, 'one Connect Claude control (the top row stands down while the welcome shows)');
	await axe(A.page, '#ai-welcome', 'AI welcome (signed in)');
	await A.page.screenshot({ path: path.join(OUT, 'n1-welcome.png') }).catch(() => {});

	// ---- Connect → the connected state + Disconnect, in the window ----------------------------------
	await button.click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected', 'connected', 15000);
	h.check(relay.frames.some((x) => x.f.type === 'hello'), 'the tab paired with the relay');
	const text = (await A.page.locator('#ai-welcome #connect-claude .cc-text').textContent()) ?? '';
	h.check(/Claude connected/.test(text) && (await A.page.locator('#ai-welcome #connect-claude-disconnect').isVisible()), `the window shows the connected state + Disconnect (${text.trim()})`);
	await axe(A.page, '#ai-welcome', 'AI welcome (connected)');
	await A.page.screenshot({ path: path.join(OUT, 'n1-connected.png') }).catch(() => {});
	await A.page.locator('#connect-claude-disconnect').click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'idle', 'idle again', 10000);
	h.check((await connectorPhase(A)) === 'idle' && (await button.isVisible()), 'Disconnect → Connect Claude again');

	// ---- a provider set up: the welcome stands down, the old row returns ------------------------------
	await A.page.evaluate(() => {
		window.__stores.aiProviders.addAiProvider({ preset: 'custom', label: 'Mock', baseUrl: 'https://127.0.0.1:9/v1', apiKey: 'x', model: 'mock' });
		window.__stores.aiProviders.setAiEnabled(true);
	});
	await A.page.locator('#ai-welcome').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
	h.check((await A.page.locator('#ai-welcome').count()) === 0 && (await A.page.locator('#ai-assistant-window #connect-claude-button').isVisible()), 'with a provider: no welcome, Connect Claude in its top row');
	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).slice(0, 2).join(' | ')})`);
	await h.closePeer(A);

	// ---- the OPPO Find N6, folded and unfolded ---------------------------------------------------------
	for (const [name, viewport, theme] of [
		['folded', { width: 390, height: 896 }, 'dark'],
		['unfolded', { width: 770, height: 850 }, 'dark'],
		['unfolded-light', { width: 770, height: 850 }, 'light']
	]) {
		const P = await h.setupPage(browser, name, { context: { viewport, deviceScaleFactor: 2.9, isMobile: true, hasTouch: true }, storage: { theme } });
		await installProvider(P.page);
		await P.page.evaluate(() => {
			window.__stores.toastsInDrawerOnly.set(true);
			window.__stores.aiAssistantHidden.set('');
		});
		const b = P.page.locator('#ai-welcome #connect-claude-button');
		await b.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
		const fits = async (sel) => {
			const box = await P.page.locator(sel).boundingBox();
			const hit = box ? await P.page.evaluate(([x, y, s]) => !!document.elementFromPoint(x, y)?.closest(s), [box.x + box.width / 2, box.y + box.height / 2, sel]) : false;
			return { ok: !!box && box.x >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height && box.height >= 32 && hit, box, hit };
		};
		const c = await fits('#connect-claude-button');
		const o = await fits('#ai-welcome-settings');
		h.check(c.ok && o.ok, `N6 ${name}: both choices are on screen and pressable (${JSON.stringify(c.box)} ${JSON.stringify(o.box)}, hit ${c.hit}/${o.hit})`);
		if (name === 'unfolded-light') await axe(P.page, '#ai-welcome', 'AI welcome (light)');
		await P.page.screenshot({ path: path.join(OUT, `n1-n6-${name}.png`) }).catch(() => {});
		await h.closePeer(P);
	}

	await h.finish(browser);
});
