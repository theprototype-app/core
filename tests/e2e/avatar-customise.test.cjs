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
		// NOTES-38 #2: the WHOLE viewport pose — the camera AND the orbit target
		const camPose = () =>
			page.evaluate(() => {
				let c, o;
				window.__stores.globalCamera.subscribe((x) => (c = x))();
				window.__stores.orbitControls.subscribe((x) => (o = x))();
				return [...c.position.toArray(), ...(o ? o.target.toArray() : [0, 0, 0])];
			});
		const poseOff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
		const read = (name) =>
			page.evaluate((name) => {
				let v;
				window.__stores[name].subscribe((x) => (v = x))();
				return v;
			}, name);
		await page.evaluate(() => window.__stores.objectActions.flyTo([2, 1.6, 4], [0, 1, 0], 0));
		await page.waitForTimeout(600);
		const home = await camPos();
		const homePose = await camPose();
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
		await page.locator('#avatar-dropdown').getByRole('button', { name: /customize character/i }).click(); // 38 R8: a NavRow (sentence case)
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
		// 38 NOTES-38 #34: the body is centred in the part of the viewport the drawer leaves free
		// (wide screens: left of the drawer), not half under the drawer
		await page.waitForTimeout(900);
		const framing = await page.evaluate(() => {
			const s = window.__stores;
			let cam, g;
			s.globalCamera.subscribe((v) => (cam = v))();
			s.globalScene?.subscribe?.((v) => (g = v))();
			const scene = g ?? cam?.parent;
			let body = null;
			scene?.traverse?.((o) => { if (!body && /avatar-preview/.test(o.name || '')) body = o; });
			const panel = document.getElementById('character-panel')?.getBoundingClientRect();
			if (!cam || !body || !panel) return null;
			const box = new s.THREE.Box3().setFromObject(body);
			const c = box.getCenter(new s.THREE.Vector3()).project(cam);
			return { x: ((c.x + 1) / 2) * innerWidth, freeW: panel.left, narrow: innerWidth < 640 };
		});
		if (framing && !framing.narrow)
			h.check(Math.abs(framing.x - framing.freeW / 2) < framing.freeW * 0.12, t(`1.4 the body is centred in the free part left of the drawer (x ${Math.round(framing.x)} of ${Math.round(framing.freeW)})`));
		else if (!framing) h.check(false, t('1.4 could read the preview framing'));
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
		h.check(poseOff(await camPose(), homePose) < 1e-4, t('3.1b ...EXACTLY: position and orbit target (NOTES-38 #2)'));
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
		h.check(poseOff(await camPose(), homePose) < 1e-4, t('5.5b ...EXACTLY after Apply (NOTES-38 #2)'));

		// ---- 5c. NOTES-38 #2: orbit by hand while choosing, then Cancel — the damped orbit's
		// momentum must not carry the viewport past the pose it is returning to ----
		await page.evaluate(() => window.__stores.characterModalOpen.set(true));
		await page.waitForSelector('#character-panel');
		await page.waitForTimeout(900);
		await page.mouse.move(300, 360);
		await page.mouse.down();
		for (let i = 1; i <= 8; i++) await page.mouse.move(300 + i * 25, 360 + i * 4);
		await page.mouse.up();
		await page.click('#character-cancel');
		await page.waitForSelector('#character-panel', { state: 'detached' });
		await page.waitForTimeout(1200);
		const afterOrbit = await camPose();
		h.check(poseOff(afterOrbit, homePose) < 1e-4, t(`5.6 Cancel after an orbit drag lands EXACTLY home (off ${poseOff(afterOrbit, homePose).toExponential(1)})`));

		// ---- 5d. NOTES-38 #2: the drawer resizes by its inner edge; the size is remembered and
		// the camera re-frames the character into the space the drawer leaves free ----
		await page.evaluate(() => window.__stores.characterModalOpen.set(true));
		await page.waitForSelector('#character-panel');
		await page.waitForTimeout(900);
		const w0 = await page.locator('#character-panel').evaluate((el) => el.getBoundingClientRect().width);
		const aim0 = await camPose();
		// 41 G8: the framing centres the body in the free part with a projection VIEW OFFSET, so a
		// wider drawer can re-frame by the offset alone (the pose stays when the height limits the fit)
		const viewX = () =>
			page.evaluate(() => {
				let c;
				window.__stores.globalCamera.subscribe((x) => (c = x))();
				return c.view?.enabled ? c.view.offsetX : 0;
			});
		const offset0 = await viewX();
		const grip = await page.locator('#character-resize').boundingBox();
		await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
		await page.mouse.down();
		for (let i = 1; i <= 6; i++) await page.mouse.move(grip.x + grip.width / 2 - i * 20, grip.y + grip.height / 2);
		await page.mouse.up();
		await page.waitForTimeout(700);
		const w1 = await page.locator('#character-panel').evaluate((el) => el.getBoundingClientRect().width);
		h.check(Math.abs(w1 - w0 - 120) < 3, t(`5.7 dragging the edge 120px left widens the drawer (${Math.round(w0)} -> ${Math.round(w1)})`));
		const stored5 = await page.evaluate(() => JSON.parse(localStorage.getItem('characterDrawer:size') || 'null'));
		h.check(Math.abs((stored5?.w ?? 0) - w1) < 3, t('5.8 ...the width is remembered'));
		const offset1 = await viewX();
		h.check(
			poseOff(await camPose(), aim0) > 0.01 || Math.abs(offset1 - offset0 - 60) < 3,
			t(`5.9 ...and the camera re-frames the character (view offset ${Math.round(offset0)} -> ${Math.round(offset1)})`)
		);
		await page.click('#character-cancel');
		await page.waitForSelector('#character-panel', { state: 'detached' });
		await page.waitForTimeout(1200);
		h.check(poseOff(await camPose(), homePose) < 1e-4, t('5.10 ...and Cancel still lands exactly home'));
		await page.evaluate(() => window.__stores.characterModalOpen.set(true));
		await page.waitForSelector('#character-panel');
		const w2 = await page.locator('#character-panel').evaluate((el) => el.getBoundingClientRect().width);
		h.check(Math.abs(w2 - w1) < 3, t('5.11 reopening keeps the width'));
		await page.click('#character-cancel');
		await page.waitForSelector('#character-panel', { state: 'detached' });
		await page.evaluate(() => localStorage.removeItem('characterDrawer:size'));
		await page.waitForTimeout(800);
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
