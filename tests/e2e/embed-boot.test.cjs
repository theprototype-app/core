// Roadmap #29 / E (28's "later" list) — the additive `?embed=1` boot flag. The community
// Worker's `/e/<id>` frames the app at `/?s=<id>&play=1&embed=1`; core's part is ONE flag,
// read once at module evaluation (playMode.embedMode), that hides the editor chrome for the
// page's life — the whole Menu tree (#editor-chrome), the editor windows, the dock inset —
// and draws exactly two things of its own: a corner link back to the same scene in the full
// app and a ▶ button that re-enters play after an Esc. Single page, no signaling, no plugin
// (the `?s=` load itself is the cloud smoke's check; here `s` only has to reach the link).
//
// Counterfactuals in this suite: a BARE boot and `?embed=0` keep the old behaviour (chrome
// visible, no embed chrome, embedMode false); leaving play inside an embed must NOT bring
// the chrome back (plain play mode would).
const h = require('./helpers.cjs');

const { check } = h;
const read = `(s) => { let v; s.subscribe((x) => (v = x))(); return v; }`;

/** everything the suite reads, in one evaluate */
async function snapshot(peer) {
	return peer.page.evaluate((readSrc) => {
		const rd = eval(readSrc);
		const pm = window.__stores.playMode;
		const chrome = document.querySelector('#editor-chrome');
		const link = document.querySelector('#embed-open-link');
		return {
			embed: rd(pm.embedMode),
			sceneId: pm.embedSceneId,
			openUrl: pm.embedOpenUrl(),
			chromePresent: !!chrome,
			chromeHidden: chrome ? chrome.classList.contains('hidden') : null,
			link: link ? link.getAttribute('href') : null,
			linkTarget: link ? link.getAttribute('target') : null,
			play: !!document.querySelector('#embed-play'),
			canvas: !!document.querySelector('.viewport canvas'),
			inset: document.querySelector('.viewport')?.classList.contains('viewport-inset') ?? null,
			// `__stores.viewPrefs` is the MODULE; its store is `.viewPrefs`
			dockPref: !!rd(window.__stores.viewPrefs.viewPrefs)?.dockPushesViewport,
			locked: rd(window.__stores.isLocked),
			logoMenu: !!document.querySelector('#logo-menu')
		};
	}, read);
}

h.run(async () => {
	const browser = await h.launch();

	// ------------------------------------------------ 1. absent = the old app (counterfactual)
	const A = await h.setupPage(browser, 'A');
	const bare = await snapshot(A);
	check(bare.embed === false && bare.sceneId === '' && bare.openUrl === '/', 'bare boot: embedMode false, no scene id, openUrl = /');
	check(bare.chromePresent && bare.chromeHidden === false && bare.logoMenu, 'bare boot: the editor chrome (#editor-chrome, the logo menu) is visible');
	check(bare.link === null && !bare.play, 'bare boot: no embed link, no embed ▶ button');
	check(bare.inset === bare.dockPref, `bare boot: the dock inset follows the pref as before (pref ${bare.dockPref})`);
	await A.ctx.close();

	const Z = await h.setupPage(browser, 'Z', { hash: '?embed=0&s=zzz' });
	const zero = await snapshot(Z);
	check(zero.embed === false && zero.chromeHidden === false && zero.link === null, '?embed=0 is not the flag: old behaviour (only "1" counts)');
	await Z.ctx.close();

	// --------------------------------------------------------------- 2. the embed boot
	const E = await h.setupPage(browser, 'E', { hash: '?s=abc123&embed=1' });
	const emb = await snapshot(E);
	check(emb.embed === true, 'embed boot: playMode.embedMode is true');
	check(emb.chromePresent && emb.chromeHidden === true, 'embed boot: #editor-chrome (sidebar, pill, panels, toasts) is hidden');
	check(emb.sceneId === 'abc123' && emb.link === '/?s=abc123' && emb.openUrl === '/?s=abc123', `embed boot: the corner link opens the same scene in the full app (${emb.link})`);
	check(emb.linkTarget === '_blank', 'embed boot: the link opens a new tab (the iframe stays)');
	check(emb.inset === false, `embed boot: no dock inset whatever the pref (pref ${emb.dockPref})`);
	check(emb.locked !== true && emb.play === true, 'embed boot: not playing yet → the ▶ button is offered');

	// a REAL click on ▶ — the pointer lock wants a gesture, and requestPlay is the same press
	// the Controls button makes
	await E.page.click('#embed-play');
	await h.eventually(
		() => E.page.evaluate((r) => eval(r)(window.__stores.isLocked), read),
		(v) => v === true,
		'embed ▶: enters play mode (isLocked true)',
		15000
	);
	const playing = await snapshot(E);
	check(!playing.play && playing.link === '/?s=abc123', 'embed playing: the ▶ button is gone, the corner link stays');
	check(playing.canvas === true && playing.inset === false, 'embed playing: the viewport canvas is there, full-bleed (no dock inset)');
	check(playing.chromeHidden === true, 'embed playing: chrome still hidden');

	// leaving play must NOT bring the editor back (plain play mode would — that is the
	// difference the flag makes)
	await E.page.evaluate(() => window.__stores.playMode.exitPlay());
	await h.eventually(
		() => E.page.evaluate((r) => eval(r)(window.__stores.isLocked), read),
		(v) => v !== true,
		'embed exit: exitPlay leaves play mode',
		10000
	);
	const after = await snapshot(E);
	check(after.chromeHidden === true && after.embed === true, 'embed exit: the editor chrome STAYS hidden (embed mode is for the page\'s life)');
	check(after.play === true, 'embed exit: the ▶ button is back, so there is a way back in');
	check(h.pageErrors(E).length === 0, 'embed: no page errors');
	await E.ctx.close();

	// ----------------------------------------- 3. embed without a scene: the link is "/"
	const N = await h.setupPage(browser, 'N', { hash: '?embed=1' });
	const none = await snapshot(N);
	check(none.embed === true && none.chromeHidden === true && none.link === '/', 'embed without ?s: still an embed, the link goes to the app root');
	await N.ctx.close();

	await h.finish(browser);
});
