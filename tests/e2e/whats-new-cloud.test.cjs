// 37-fx (R19): the cloud plugin's own section in What's New. Without a plugin the window is
// unchanged; `cloudApi.setWhatsNewSection({title, markdown})` adds ONE folded section above the
// releases through the same escaped markdown subset as the changelog (so a plugin cannot inject
// markup); null removes it; a bad payload is refused.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	const open = () => page.evaluate(() => window.__stores.whatsNew.openWhatsNew());
	const section = () =>
		page.evaluate(() => {
			const el = document.querySelector('#whats-new-cloud');
			if (!el) return null;
			const releases = [...document.querySelectorAll('#whats-new-window details.wn-release')];
			return {
				title: el.querySelector('summary')?.textContent?.trim(),
				text: el.textContent,
				first: releases[0] === el,
				open: el.hasAttribute('open'),
				scripts: el.querySelectorAll('script, img, iframe').length,
				links: [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'))
			};
		});

	await open();
	await page.waitForSelector('#whats-new-window');
	h.check((await section()) === null, 'no plugin: no cloud section (the OSS window is unchanged)');

	const ok = await page.evaluate(() =>
		window.__stores.cloudPlugin.makeCloudApi().setWhatsNewSection({
			title: 'theprototype.app cloud',
			markdown:
				'## October\n- **Rooms** remember who was there\n- a [status page](https://theprototype.app/status)\n- <img src=x onerror=alert(1)> stays text\n- [bad](javascript:alert(1)) is not a link'
		})
	);
	h.check(ok === true, 'setWhatsNewSection accepts a {title, markdown} section');
	await h.eventually(section, (s) => !!s, 'the cloud section appears in the open window');
	const s = await section();
	h.check(s.title === 'theprototype.app cloud' && s.first && s.open, `it is the first, open section (${JSON.stringify({ title: s.title, first: s.first, open: s.open })})`);
	h.check(s.text.includes('Rooms') && s.text.includes('remember who was there'), 'its markdown renders (bold, bullets)');
	h.check(s.scripts === 0 && s.text.includes('<img'), 'markup in the plugin text stays text (escaped)');
	h.check(
		JSON.stringify(s.links) === JSON.stringify(['https://theprototype.app/status']),
		`only https links become links (${JSON.stringify(s.links)})`
	);

	const refused = await page.evaluate(() => window.__stores.cloudPlugin.makeCloudApi().setWhatsNewSection({ title: 'x', markdown: 42 }));
	h.check(refused === false, 'a section without markdown is refused');
	await h.eventually(section, (v) => v === null, 'a refused section clears it');

	await page.evaluate(() => window.__stores.cloudHooks.setWhatsNewCloud({ markdown: 'one line' }));
	await h.eventually(section, (v) => v?.title === 'Cloud', 'an untitled section is titled "Cloud"');
	await page.evaluate(() => window.__stores.cloudPlugin.makeCloudApi().setWhatsNewSection(null));
	await h.eventually(section, (v) => v === null, 'null removes the section');

	await h.finish(browser);
});
