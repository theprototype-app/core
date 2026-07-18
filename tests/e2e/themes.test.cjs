// Phase 89: theme system — data-theme lands on :root, the tailwind .dark class
// follows (light drops it), token remaps repaint chrome surfaces, the pixel
// font loads for 8-bit, the choice persists across reload, and the replicated
// environment state is untouched.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const probe = (themeId) =>
		A.page.evaluate(
			(themeId) =>
				new Promise((resolve) => {
					window.__stores.themes.theme.set(themeId);
					// probe div exercises the remap layer without depending on any panel
					let el = document.getElementById('theme-probe');
					if (!el) {
						el = document.createElement('div');
						el.id = 'theme-probe';
						el.className = 'bg-gray-800 text-gray-400';
						document.body.appendChild(el);
					}
					requestAnimationFrame(() => {
						const style = getComputedStyle(el);
						resolve({
							dataTheme: document.documentElement.dataset.theme,
							dark: document.documentElement.classList.contains('dark'),
							bodyBg: getComputedStyle(document.body).backgroundColor,
							surface: style.backgroundColor,
							muted: style.color,
							bodyFont: getComputedStyle(document.body).fontFamily
						});
					});
				}),
			themeId
		);

	const envBefore = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.environment.environment.subscribe((e) => resolve(JSON.stringify(e)))();
			})
	);

	const dark = await probe('dark');
	h.check(
		dark.dataTheme === 'dark' && dark.dark && dark.surface === 'rgb(31, 41, 55)',
		`dark is the authored look (surface ${dark.surface})`
	);

	const light = await probe('light');
	h.check(light.dataTheme === 'light' && !light.dark, 'light drops the .dark class');
	h.check(
		light.bodyBg === 'rgb(238, 240, 243)' && light.surface === 'rgb(255, 255, 255)',
		`light repaints body + surfaces (${light.bodyBg} / ${light.surface})`
	);

	const green = await probe('green');
	h.check(green.dark, 'green console keeps .dark as base');
	h.check(
		green.bodyBg === 'rgb(2, 15, 6)' && green.surface === 'rgb(4, 23, 10)',
		`green console repaints from tokens (${green.bodyBg} / ${green.surface})`
	);
	h.check(green.bodyFont.toLowerCase().includes('mono'), `green console goes monospace (${green.bodyFont})`);

	const contrast = await probe('contrast');
	h.check(
		contrast.bodyBg === 'rgb(0, 0, 0)' && contrast.muted === 'rgb(212, 212, 212)',
		`high contrast repaints (${contrast.bodyBg} / ${contrast.muted})`
	);

	const bit8 = await probe('bit8');
	h.check(bit8.bodyBg === 'rgb(22, 18, 58)', `8-bit repaints (${bit8.bodyBg})`);
	h.check(bit8.bodyFont.includes('Press Start 2P'), `8-bit uses the pixel font (${bit8.bodyFont})`);
	const fontLoaded = await A.page.evaluate(async () => {
		const loaded = await document.fonts.load('12px "Press Start 2P"');
		return loaded.length > 0 || document.fonts.check('12px "Press Start 2P"');
	});
	h.check(fontLoaded, 'pixel font woff2 actually loads');

	// themes are local chrome only — replicated environment state untouched
	const envAfter = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.environment.environment.subscribe((e) => resolve(JSON.stringify(e)))();
			})
	);
	h.check(envBefore === envAfter, 'environment state untouched by theme switches');

	// persists: the pre-hydration snippet applies it before the app boots
	await A.page.reload();
	await A.page.waitForTimeout(2500);
	const after = await A.page.evaluate(() => ({
		dataTheme: document.documentElement.dataset.theme,
		dark: document.documentElement.classList.contains('dark')
	}));
	h.check(after.dataTheme === 'bit8' && after.dark, `theme persists across reload (${after.dataTheme})`);

	await h.finish(browser);
});
