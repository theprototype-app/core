// Roadmap #13 batch M1 — open-core extension points. Single-page checks that the
// seams are INERT by default (byte-identical OSS behaviour) and that a configured
// cloud plugin can drive them: capability gate, auth hook, UI mount points, notice.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- default path: every seam inert ------------------------------------
	const def = await A.page.evaluate(() => {
		const c = window.__stores.cloudHooks;
		return {
			create: c.canApply('peer1', 'create'),
			move: c.canApply('peer1', 'move'),
			hasProvider: c.hasCapabilityProvider(),
			auth: c.getAuthProvider()
		};
	});
	h.check(def.create === true && def.move === true, 'M1a: canApply allows everything with no plugin');
	h.check(def.hasProvider === false, 'M1a: no capability provider installed by default');
	h.check(def.auth === null, 'M1b: no auth provider installed by default');
	h.check((await A.page.locator('.cloud-slot').count()) === 0, 'M1d: no cloud UI mounted by default');

	// --- load the example plugin -------------------------------------------
	await A.page.evaluate(() => localStorage.setItem('cloudPluginUrl', '/cloud-plugin-example.js'));
	await h.freshReload(A);
	await A.page.waitForTimeout(500); // let the dynamic import + register() run

	const withPlugin = await A.page.evaluate(() => {
		const c = window.__stores.cloudHooks;
		const auth = c.getAuthProvider();
		return {
			hasProvider: c.hasCapabilityProvider(),
			viewerCreate: c.canApply('viewer1', 'create'), // mutation -> dropped
			viewerChat: c.canApply('viewer1', 'sent'), // chat -> allowed
			viewerUserdata: c.canApply('viewer1', 'userdata'), // core floor -> always allowed
			editorCreate: c.canApply('editor1', 'create'), // non-viewer -> allowed
			authOk: !!auth && auth.authorize('cloud42') === true,
			authNo: !!auth && auth.authorize('rando') === false
		};
	});
	h.check(withPlugin.hasProvider === true, 'M1a: plugin installs a capability provider');
	h.check(withPlugin.viewerCreate === false, 'M1a: viewer mutation (create) is dropped');
	h.check(withPlugin.viewerChat === true, 'M1a: viewer chat (sent) is allowed');
	h.check(withPlugin.viewerUserdata === true, 'M1a: core control floor (userdata) always allowed');
	h.check(withPlugin.editorCreate === true, 'M1a: non-viewer mutation is allowed');
	h.check(withPlugin.authOk === true && withPlugin.authNo === true, 'M1b: plugin auth provider authorizes as configured');

	// M1c/M1d: the plugin mounted a login button into the Connect slot
	h.check(await A.page.locator('#cloud-login-btn').first().isVisible(), 'M1c/M1d: plugin UI mounts in the Connect slot');

	// the plugin rebranded the first-run notice
	const notice = await A.page.evaluate(
		() => new Promise((r) => window.__stores.appNotice.subscribe((v) => r(v))())
	);
	h.check(!!notice && /example plugin/.test(notice.text), 'M1d: plugin can rebrand the appNotice banner');

	// --- unload the plugin -> back to inert --------------------------------
	await A.page.evaluate(() => localStorage.removeItem('cloudPluginUrl'));
	await h.freshReload(A);
	await A.page.waitForTimeout(300);
	const back = await A.page.evaluate(() => ({
		hasProvider: window.__stores.cloudHooks.hasCapabilityProvider(),
		create: window.__stores.cloudHooks.canApply('viewer1', 'create'),
		slots: document.querySelectorAll('.cloud-slot').length
	}));
	h.check(back.hasProvider === false && back.create === true && back.slots === 0, 'unloading the plugin restores inert defaults');

	await h.finish(browser);
});
