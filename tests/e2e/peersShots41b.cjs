// 41b H15 — before/after screenshots of the connected-peers popover with four peers whose names and
// locations are long (desktop 1440x900, N6 folded 390x844 + unfolded 770x850, touch), dark and light.
// Not a suite: `APP_URL=… OUT=<dir> TAG=before|after node tests/e2e/peersShots41b.cjs`.
const h = require('./helpers.cjs');
const OUT = process.env.OUT || '.';
const TAG = process.env.TAG || 'shot';

/** fake a session: four long-named peers, three of them standing in long-named scenes, roles on */
async function seed(page) {
	await page.evaluate(() => {
		const s = window.__stores;
		let p;
		s.peers.subscribe((x) => (p = x))();
		const self = p?.peer?.id || 'self';
		s.username.set('Alexandra Konstantinopoulou'); // 78 PL34: else a nameless self becomes "Guest 1"
		s.userdata.set([
			[self, 'Alexandra Konstantinopoulou', null, null, null, {}],
			['p1', 'Maximilian von Hohenzollern-Sigmaringen', null, null, null, {}],
			['p2', 'Bo', null, null, null, {}],
			['p3', 'Guinevere Featherstonehaugh', null, null, null, {}],
			['p4', 'Dmitri Ivanovich Rachmaninoff', null, null, null, {}]
		]);
		s.peers.update((x) => {
			['p1', 'p2', 'p3', 'p4'].forEach((id) => x.openedPeers.add(id));
			return x;
		});
		s.peerScenes.peerScenes.set({
			p1: { scene: 'Castle Courtyard — east wing, upper battlements' },
			p2: { scene: 'Castle Courtyard — east wing, upper battlements' },
			p3: { scene: 'Forest Clearing with the old abandoned watermill' },
			p4: { scene: '' }
		});
		const roles = { [self]: 'admin', p1: 'editor', p2: 'viewer', p3: 'editor', p4: 'viewer' };
		s.cloudHooks.rolesInfo.set({
			myId: self,
			myRole: 'admin',
			amAdmin: true,
			order: ['admin', 'editor', 'viewer'],
			roleOf: (id) => roles[id] ?? 'viewer',
			setRole: () => {}
		});
	});
	await page.waitForTimeout(500);
}

h.run(async () => {
	const browser = await h.launch();
	const VIEWS = [
		['desktop', { viewport: { width: 1440, height: 900 } }],
		['n6-folded', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
		['n6-unfolded', { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }]
	];
	for (const theme of ['dark', 'light']) {
		for (const [name, context] of VIEWS) {
			const X = await h.setupPage(browser, `${name}-${theme}`, { context, storage: { theme, toursSeen: '{"editor-touch":true,"editor":true}' } });
			const page = X.page;
			await seed(page);
			await page.evaluate(() => {
				window.__stores.toastStore.set([]);
				document.querySelector('#peers-trigger')?.click();
			});
			await page.waitForTimeout(900);
			const box = await page.evaluate(() => {
				const b = document.querySelector('#peers-popover');
				if (!b) return null;
				const r = b.getBoundingClientRect();
				return { w: Math.round(r.width), h: Math.round(r.height) };
			});
			const file = `${OUT}/${TAG}-peers-${name}-${theme}.png`;
			await page.screenshot({ path: file });
			console.log(`${file} ${JSON.stringify(box)}`);
			await page.context().close();
		}
	}
	await h.finish(browser);
});
