// 36-avatars (plan 76.5): the customise side panel, driven through the real UI.
//  1. Profile menu > Customize Character opens the panel and flies the camera to YOUR character
//     (a local preview: the same AvatarRig peers use, never in objectsGroup).
//  2. Every change previews live on it; nothing is applied or sent while editing.
//  3. Cancel / Escape drop the draft and return the camera exactly.
//  4. Ping preview pings beside your character on THIS screen only (nothing is sent).
//  5. Apply writes avatarConfig + storage + your userdata row + the ping prefs, closes, returns the camera.
// Screenshots of the panel in dark + light go to AVATAR_SHOTS when set.
const h = require('./helpers.cjs');

const SHOTS = process.env.AVATAR_SHOTS || '';

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	for (const theme of ['dark', 'light']) {
		const A = await h.setupPage(browser, 'A-' + theme, { context: { viewport: { width: 1280, height: 720 } }, storage: { theme } });
		const page = A.page;
		const t = (s) => `[${theme}] ${s}`;
		const camPos = () =>
			page.evaluate(() => {
				let c;
				window.__stores.globalCamera.subscribe((x) => (c = x))();
				return c.position.toArray();
			});
		const read = (name) =>
			page.evaluate((name) => {
				let v;
				window.__stores[name].subscribe((x) => (v = x))();
				return v;
			}, name);
		await page.evaluate(() => window.__stores.objectActions.flyTo([2, 1.6, 4], [0, 1, 0], 0));
		await page.waitForTimeout(600);
		const home = await camPos();
		// count every send while the panel is open
		await page.evaluate(() => {
			let p;
			window.__stores.peers.subscribe((x) => (p = x))();
			window.__sent = [];
			const orig = p.send.bind(p);
			p.send = (m) => {
				window.__sent.push(m?.type);
				return orig(m);
			};
		});

		// ---- 1. open through the profile menu ----
		await page.click('#avatar-trigger');
		await page.getByText('Customize Character', { exact: true }).click();
		await page.waitForSelector('#character-panel');
		await h.eventually(
			() => page.evaluate(() => window.__stores.avatars.avatarsDebug()['avatar-preview'] ?? null),
			(s) => s && s.ready && s.visible,
			t('1.1 the panel shows a live preview of YOUR character'),
			15000
		);
		await page.waitForTimeout(800);
		const flown = await camPos();
		h.check(Math.hypot(flown[0] - home[0], flown[1] - home[1], flown[2] - home[2]) > 2, t('1.2 the camera flew to your character'));
		const inGroup = await page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			return !!g.getObjectByName('avatar-preview') || !!g.getObjectByName('avatar-preview-avatar');
		});
		h.check(!inGroup, t('1.3 the preview is local (not in the replicated objectsGroup)'));
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/0${theme === 'dark' ? 1 : 2}-customise-panel-${theme}.png` });

		// ---- 2. live edits ----
		await page.click('[data-character="skeleton-mage"]');
		await page.click('[data-head="box"]');
		await page.click('[data-hat="tophat"]');
		await h.eventually(
			() => page.evaluate(() => window.__stores.avatars.avatarsDebug()['avatar-preview']),
			(s) => s.ready && s.character === 'skeleton-mage' && s.head === 'box',
			t('2.1 picks show on the preview straight away')
		);
		const cfgMid = await read('avatarConfig');
		h.check(cfgMid.character !== 'skeleton-mage', t('2.2 nothing is applied while editing'));

		// ---- 3. Escape drops the draft, the camera comes home ----
		await page.keyboard.press('Escape');
		await page.waitForSelector('#character-panel', { state: 'detached' });
		await page.waitForTimeout(800);
		const back = await camPos();
		h.check(Math.hypot(back[0] - home[0], back[1] - home[1], back[2] - home[2]) < 0.05, t('3.1 Escape returns the camera'));
		h.check((await read('avatarConfig')).character !== 'skeleton-mage', t('3.2 ...and keeps the old look'));
		h.check(!(await page.evaluate(() => window.__stores.avatars.avatarsDebug()['avatar-preview'])), t('3.3 ...and removes the preview'));

		// ---- 4. ping preview is local ----
		await page.evaluate(() => window.__stores.characterModalOpen.set(true));
		await page.waitForSelector('#character-panel');
		await page.selectOption('#character-ping-sound', 'bell');
		await page.click('#character-ping-preview');
		const pings = await page.evaluate(() => {
			let v;
			window.__stores.ping?.pings?.subscribe?.((x) => (v = x))();
			return v?.length ?? null;
		});
		h.check(pings === null || pings >= 1, t('4.1 the preview pings on this screen'));
		const sentPing = await page.evaluate(() => window.__sent.includes('ping') || window.__sent.includes('userdata'));
		h.check(!sentPing, t('4.2 previewing and editing sent nothing'));

		// ---- 5. Apply ----
		await page.click('[data-character="rogue"]');
		await page.click('[data-hat="crown"]');
		await page.click('#character-cancel');
		await page.waitForSelector('#character-panel', { state: 'detached' });
		h.check((await read('avatarConfig')).character !== 'rogue', t('5.0 Cancel keeps the old look'));
		await page.evaluate(() => window.__stores.characterModalOpen.set(true));
		await page.waitForSelector('#character-panel');
		await page.click('[data-character="rogue"]');
		await page.click('[data-hat="crown"]');
		await page.selectOption('#character-ping-sound', 'pop');
		await page.click('#character-apply');
		await page.waitForSelector('#character-panel', { state: 'detached' });
		await page.waitForTimeout(800);
		const cfg = await read('avatarConfig');
		h.check(cfg.character === 'rogue' && cfg.hat === 'crown', t('5.1 Apply commits the look'));
		const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('avatarConfig') || '{}'));
		h.check(stored.character === 'rogue', t('5.2 ...persists it'));
		const row = await page.evaluate(() => {
			let ud, p;
			window.__stores.userdata.subscribe((x) => (ud = x))();
			window.__stores.peers.subscribe((x) => (p = x))();
			return ud.find((r) => r[0] === p.peer.id)?.[5] ?? null;
		});
		h.check(row?.character === 'rogue', t('5.3 ...writes your userdata row (slot 5)'));
		h.check((await page.evaluate(() => localStorage.getItem('pingSound'))) === 'pop', t('5.4 ...and the ping sound'));
		const end = await camPos();
		h.check(Math.hypot(end[0] - home[0], end[1] - home[1], end[2] - home[2]) < 0.05, t('5.5 the camera is home again'));
		// ---- 6. Settings ▸ Avatars: the local classic switch + search ----
		if (theme === 'dark') {
			await page.evaluate(() => {
				const s = window.__stores;
				const ud = [];
				s.userdata.subscribe((v) => ud.push(...(v ?? [])))();
				s.userdata.set([...ud, ['fakePeer', 'Fake', null, null, null, { character: 'knight' }]]);
			});
			await h.eventually(
				() => page.evaluate(() => !!window.__stores.avatars.avatarsDebug().fakePeer),
				(v) => v,
				t('6.0 (premise) the peer is a rigged knight')
			);
			await page.evaluate(() => window.__stores.settingsOpen.set(true));
			await page.fill('#settings-search', 'avatar');
			await page.waitForTimeout(400);
			h.check(await page.locator('#avatars-peers-classic').isVisible(), t('6.1 the settings search finds the Avatars section'));
			await page.locator('#avatars-peers-classic').click({ force: true });
			await h.eventually(
				() =>
					page.evaluate(() => {
						let scene;
						window.__stores.globalScene.subscribe((x) => (scene = x))();
						return { classic: !!scene.getObjectByName('fakePeer-body'), rigged: !!window.__stores.avatars.avatarsDebug().fakePeer };
					}),
				(v) => v.classic && !v.rigged,
				t('6.2 "Show everyone as classic heads" draws the peer as the floating head')
			);
			h.check((await page.evaluate(() => localStorage.getItem('avatars:peersClassic'))) === '1', t('6.3 ...and remembers it on this device'));
			const rowAfter = await page.evaluate(() => {
				let ud;
				window.__stores.userdata.subscribe((x) => (ud = x))();
				return ud.find((r) => r[0] === 'fakePeer')?.[5]?.character;
			});
			h.check(rowAfter === 'knight', t('6.4 ...without touching anybody\'s choice'));
		}
		await A.ctx.close();
	}
	await h.finish(browser);
});
