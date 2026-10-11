// 41 G8 / G9 / G10 — Customize character on a foldable phone and a desktop.
//
//   G10  the panel opens an ISOLATED STUDIO: the camera sees only the studio layer (backdrop,
//        floor disc, key light and YOUR character), the scene's objects keep `visible` and
//        their layers untouched, nothing extra is sent to peers; "Show in scene" previews the
//        character in the scene instead and is REMEMBERED across reopen; leaving puts the camera
//        mask, the projection and the pose back exactly.
//   G8   the whole character stays in view in the part of the viewport the drawer leaves free —
//        folded (390x896) -> unfolded (770x850) -> folded again (the fold flips the drawer
//        between a bottom sheet and a side drawer), and on a desktop (1440x900) through a drawer
//        resize and a window resize. Asserted on the character's PROJECTED bounds.
//   G9   Surprise me deals a new character every press (10 presses = 10 distinct, none equal to
//        the one before); a preset shows ITS defaults; an edit after it adds + selects Custom,
//        re-picking a preset resets, and Custom brings the edits back.
// Phone gestures are REAL touch events (CDP Input.dispatchTouchEvent). Screenshots (dark +
// light, every posture) go to CHAR_SHOTS when set, prefixed CHAR_SHOTS_TAG (before / after).
const h = require('./helpers.cjs');

const SHOTS = process.env.CHAR_SHOTS || '';
const TAG = process.env.CHAR_SHOTS_TAG || 'after';
const shot = async (page, name) => {
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/${TAG}-${name}.png` });
};
const store = (name) => `(() => { let v; window.__stores.${name}.subscribe((x) => (v = x))(); return v; })()`;
const LOOK_KEYS = ['character', 'head', 'shape', 'face', 'hat', 'outfit', 'body'];

/** @param {import('playwright').Page} page */
async function touchApi(page) {
	const cdp = await page.context().newCDPSession(page);
	const tapAt = async (x, y) => {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
		await new Promise((r) => setTimeout(r, 40));
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	};
	/** tap an element's centre (scrolled into view first) @param {string} sel */
	const tap = async (sel) => {
		const el = page.locator(sel).first();
		await el.scrollIntoViewIfNeeded({ timeout: 4000 });
		const b = await el.boundingBox();
		if (!b) throw new Error(`no box for ${sel}`);
		await tapAt(b.x + b.width / 2, b.y + b.height / 2);
		await page.waitForTimeout(120);
	};
	return { tap, tapAt };
}

/** the draft look the preview shows (= what Apply would write) */
const draftLook = (page) =>
	page.evaluate((keys) => {
		let p;
		window.__stores.avatars.avatarPreview.subscribe((x) => (p = x))();
		if (!p) return null;
		const out = {};
		for (const k of keys) out[k] = String(p.config?.[k] ?? '').toLowerCase();
		return out;
	}, LOOK_KEYS);
const sig = (l) => (l ? LOOK_KEYS.map((k) => `${k}=${l[k]}`).join('|') : 'none');

/** the preview character's projected bounds, and the free part of the canvas (css px) */
const framing = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let cam, r;
		s.globalCamera.subscribe((v) => (cam = v))();
		s.globalRenderer.subscribe((v) => (r = v))();
		let g;
		s.globalScene?.subscribe?.((v) => (g = v))();
		const scene = g ?? cam?.parent ?? null;
		// the preview is two roots: the head group and, beside it, the rigged body
		const roots = ['avatar-preview', 'avatar-preview-avatar'].map((n) => scene?.getObjectByName(n)).filter(Boolean);
		const panel = document.getElementById('character-panel')?.getBoundingClientRect();
		const canvas = r?.domElement?.getBoundingClientRect();
		if (!cam || !roots.length || !panel || !canvas) return null;
		cam.updateMatrixWorld();
		// what is DRAWN: visible meshes only (a rigged body hides the classic head group)
		const box = new s.THREE.Box3();
		for (const root of roots) {
			root.updateMatrixWorld(true);
			root.traverseVisible((o) => {
				if (o.isMesh && o.geometry) box.expandByObject(o, false);
			});
		}
		if (box.isEmpty()) return null;
		const pts = [];
		for (const x of [box.min.x, box.max.x])
			for (const y of [box.min.y, box.max.y])
				for (const z of [box.min.z, box.max.z]) {
					const v = new s.THREE.Vector3(x, y, z).project(cam);
					pts.push([canvas.left + ((v.x + 1) / 2) * canvas.width, canvas.top + ((1 - v.y) / 2) * canvas.height, v.z]);
				}
		const xs = pts.map((p) => p[0]);
		const ys = pts.map((p) => p[1]);
		const sheet = innerWidth <= 640;
		const free = sheet
			? { left: canvas.left, top: canvas.top, right: canvas.right, bottom: Math.min(canvas.bottom, panel.top) }
			: { left: canvas.left, top: canvas.top, right: Math.min(canvas.right, panel.left), bottom: canvas.bottom };
		return {
			l: Math.min(...xs),
			r: Math.max(...xs),
			t: Math.min(...ys),
			b: Math.max(...ys),
			behind: pts.some((p) => p[2] > 1),
			free,
			sheet,
			height: box.max.y - box.min.y,
			vw: innerWidth,
			vh: innerHeight
		};
	});

/** the character is whole inside the free part of the viewport (a 2 px slack) */
const inFree = (f) => !!f && !f.behind && f.l >= f.free.left - 2 && f.r <= f.free.right + 2 && f.t >= f.free.top - 2 && f.b <= f.free.bottom + 2;
const fmt = (f) => (f ? `[${Math.round(f.l)},${Math.round(f.t)} - ${Math.round(f.r)},${Math.round(f.b)}] in [${Math.round(f.free.left)},${Math.round(f.free.top)} - ${Math.round(f.free.right)},${Math.round(f.free.bottom)}] ${f.vw}x${f.vh}` : 'no framing');

/** wait until the preview body has loaded and the framing has settled */
async function settled(page, t) {
	await h.eventually(
		() => page.evaluate(() => window.__stores.avatars.avatarsDebug()['avatar-preview'] ?? null),
		(s) => s && s.ready && s.visible,
		t('the preview body is ready'),
		20000
	);
	let last = null;
	for (let i = 0; i < 12; i++) {
		await page.waitForTimeout(250);
		const f = await framing(page);
		if (f && last && Math.abs(f.l - last.l) < 0.5 && Math.abs(f.t - last.t) < 0.5 && Math.abs(f.r - last.r) < 0.5 && Math.abs(f.b - last.b) < 0.5) return f;
		last = f;
	}
	return last;
}

const studioState = (page) => page.evaluate(() => window.__stores.characterStudio?.state?.() ?? null);
const camPose = (page) =>
	page.evaluate(() => {
		let c, o;
		window.__stores.globalCamera.subscribe((x) => (c = x))();
		window.__stores.orbitControls.subscribe((x) => (o = x))();
		return { pose: [...c.position.toArray(), ...(o ? o.target.toArray() : [0, 0, 0])], mask: c.layers.mask, view: !!(c.view && c.view.enabled) };
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });

	// =============================== THE PHONE (OPPO Find N6) ===============================
	for (const theme of ['dark', 'light']) {
		const t = (s) => `[phone ${theme}] ${s}`;
		const A = await h.setupPage(browser, `phone-${theme}`, {
			context: { viewport: { width: 390, height: 896 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
			storage: { theme, toursSeen: '{"editor-touch":true,"editor":true}', 'characterStudio:inScene': '0' }
		});
		const P = A.page;
		const touch = await touchApi(P);

		// a scene object, so "the scene is hidden" has something to hide
		await P.evaluate(() => window.__stores.objectActions?.flyTo?.([2, 1.6, 4], [0, 1, 0], 0));
		await P.evaluate(async () => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const m = new s.THREE.Mesh(new s.THREE.BoxGeometry(1, 1, 1), new s.THREE.MeshStandardMaterial());
			m.name = 'studio-probe-box';
			m.position.set(0, 0.5, 0);
			g.add(m);
		});
		await P.waitForTimeout(600);
		const home = await camPose(P);

		// count sends while the panel is open (the studio must send nothing)
		await P.evaluate(() => {
			let p;
			window.__stores.peers.subscribe((x) => (p = x))();
			window.__sent = [];
			const orig = p.send.bind(p);
			p.send = (m) => {
				window.__sent.push(m?.type);
				return orig(m);
			};
		});

		await P.evaluate(() => window.__stores.characterModalOpen.set(true));
		await P.waitForSelector('#character-panel');
		let f = await settled(P, t);

		// ---- G10: the studio ----
		const st = await studioState(P);
		h.check(!!st && st.shown, t('G10.1 the studio is shown around your character'));
		h.check(!!st && st.cameraMask === 1 << st.studioLayer, t(`G10.2 the camera sees only the studio layer (mask ${st?.cameraMask})`));
		const probe = await P.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const m = g.getObjectByName('studio-probe-box');
			return m ? { visible: m.visible, mask: m.layers.mask } : null;
		});
		h.check(!!probe && probe.visible && probe.mask === 1, t(`G10.3 the scene object is untouched (visible ${probe?.visible}, layers ${probe?.mask})`));
		await shot(P, `01-phone-folded-studio-${theme}`);

		// ---- G8: folded -> unfolded -> folded ----
		h.check(inFree(f) && f.sheet, t(`G8.1 folded: the whole character is above the sheet ${fmt(f)}`));
		await P.setViewportSize({ width: 770, height: 850 });
		f = await settled(P, t);
		h.check(inFree(f) && !f.sheet, t(`G8.2 unfolded: the whole character is left of the drawer ${fmt(f)}`));
		await shot(P, `02-phone-unfolded-studio-${theme}`);
		await P.setViewportSize({ width: 390, height: 896 });
		f = await settled(P, t);
		h.check(inFree(f) && f.sheet, t(`G8.3 folded again: the whole character is back above the sheet ${fmt(f)}`));
		const centre = f ? (f.l + f.r) / 2 : -1;
		h.check(f && Math.abs(centre - (f.free.left + f.free.right) / 2) < (f.free.right - f.free.left) * 0.12, t(`G8.4 ...and centred across the free width (x ${Math.round(centre)})`));

		// ---- G9: presets, Custom, Surprise me (taps) ----
		try {
			await touch.tap('[data-character="mage"]');
			const mage = await draftLook(P);
			h.check(mage?.character === 'mage' && mage.hat === 'none' && mage.outfit === '' && mage.head === 'character', t(`G9.1 picking a preset shows ITS defaults (${sig(mage)})`));
			h.check((await P.locator('[data-character="mage"][aria-checked="true"]').count()) === 1, t('G9.2 ...and selects it'));
			await touch.tap('[data-hat="crown"]');
			const edited = await draftLook(P);
			h.check(edited?.hat === 'crown' && edited.character === 'mage', t('G9.3 an edit keeps the body and changes the hat'));
			h.check((await P.locator('[data-character="custom"][aria-checked="true"]').count()) === 1, t('G9.4 ...and adds + selects Custom'));
			await touch.tap('[data-character="knight"]');
			const knight = await draftLook(P);
			h.check(knight?.character === 'knight' && knight.hat === 'none', t('G9.5 re-picking a preset resets to its defaults'));
			h.check((await P.locator('[data-character="custom"]').count()) === 1, t('G9.6 ...and keeps the Custom entry'));
			await touch.tap('[data-character="custom"]');
			const back = await draftLook(P);
			h.check(back?.character === 'mage' && back.hat === 'crown', t('G9.7 Custom brings the edits back'));

			const seen = new Set();
			let prev = await draftLook(P);
			let repeats = 0;
			for (let i = 0; i < 10; i++) {
				await touch.tap('#character-surprise');
				const now = await draftLook(P);
				if (sig(now) === sig(prev)) repeats++;
				seen.add(sig(now));
				prev = now;
			}
			h.check(repeats === 0, t('G9.8 every Surprise press deals a different character from the one before'));
			h.check(seen.size === 10, t(`G9.9 10 presses = 10 distinct characters (${seen.size})`));
			h.check((await P.locator('[data-character="custom"][aria-checked="true"]').count()) === 1, t('G9.10 a surprise is a custom look (selected as Custom)'));
		} catch (e) {
			h.check(false, t(`G9 could drive the picker: ${String(e.message).split('\n')[0]}`));
		}
		await P.waitForTimeout(600);
		await shot(P, `03-phone-folded-surprise-${theme}`);

		// ---- G10: Show in scene, remembered ----
		try {
			await touch.tap('#character-show-in-scene');
			await P.waitForTimeout(300);
			const inScene = await studioState(P);
			const cam = await camPose(P);
			h.check(!!inScene && !inScene.shown && cam.mask === home.mask, t(`G10.4 Show in scene: the studio hides and the camera sees the scene again (mask ${cam.mask})`));
			h.check((await P.evaluate(() => localStorage.getItem('characterStudio:inScene'))) === '1', t('G10.5 ...remembered'));
			await shot(P, `04-phone-folded-in-scene-${theme}`);
		} catch (e) {
			h.check(false, t(`G10 Show in scene: ${String(e.message).split('\n')[0]}`));
		}

		// ---- leaving restores everything ----
		await P.evaluate(() => window.__stores.characterModalOpen.set(false));
		await P.waitForSelector('#character-panel', { state: 'detached' });
		await P.waitForTimeout(900);
		const after = await camPose(P);
		const off = Math.max(...after.pose.map((v, i) => Math.abs(v - home.pose[i])));
		h.check(off < 1e-3, t(`G10.6 leaving puts the camera pose back exactly (off ${off.toExponential(1)})`));
		h.check(after.mask === home.mask && !after.view, t(`G10.7 ...the camera mask and a plain projection (mask ${after.mask}, view offset ${after.view})`));
		h.check((await P.evaluate(() => (window.__stores.characterStudio?.state ? 1 : 0) && document.documentElement.classList.contains('character-studio'))) === false, t('G10.8 ...and the studio overlay class is gone'));
		// your own head pose ('camera' presence) follows the camera as it always did; no SCENE content may go
		const sent = await P.evaluate(() => window.__sent.filter((type) => type !== 'camera'));
		h.check(!sent.length, t(`G10.9 no scene content was sent to peers while customising (${sent.join(',') || 'none'})`));

		// reopen: the remembered choice holds, then back to the studio for the next run
		await P.evaluate(() => window.__stores.characterModalOpen.set(true));
		await P.waitForSelector('#character-panel');
		await P.waitForTimeout(400);
		h.check((await P.locator('#character-show-in-scene[aria-pressed="true"]').count()) === 1, t('G10.10 reopened: Show in scene is still on'));
		const reopened = await studioState(P);
		h.check(!!reopened && !reopened.shown, t('G10.11 ...and the studio stays hidden'));
		await P.evaluate(() => window.__stores.avatars.studioInScene?.set(false));
		await P.evaluate(() => window.__stores.characterModalOpen.set(false));
		await A.ctx.close();
	}

	// =============================== THE DESKTOP (1440x900, mouse) ===============================
	for (const theme of ['dark', 'light']) {
		const t = (s) => `[desktop ${theme}] ${s}`;
		const D = await h.setupPage(browser, `desktop-${theme}`, {
			context: { viewport: { width: 1440, height: 900 } },
			storage: { theme, 'characterStudio:inScene': '0' }
		});
		const P = D.page;
		await P.evaluate(() => window.__stores.objectActions?.flyTo?.([2, 1.6, 4], [0, 1, 0], 0));
		await P.waitForTimeout(600);
		await P.evaluate(() => window.__stores.characterModalOpen.set(true));
		await P.waitForSelector('#character-panel');
		let f = await settled(P, t);
		h.check(inFree(f) && !f.sheet, t(`G8.5 desktop: the whole character is left of the drawer ${fmt(f)}`));
		await shot(P, `05-desktop-studio-${theme}`);
		// the drawer grows by keyboard on its grip (+5 x 64 px): the free part shrinks
		await P.focus('#character-resize');
		for (let i = 0; i < 5; i++) await P.keyboard.press('Shift+ArrowLeft');
		f = await settled(P, t);
		h.check(inFree(f), t(`G8.6 a wider drawer: still whole in what is left ${fmt(f)}`));
		await P.setViewportSize({ width: 1000, height: 700 });
		f = await settled(P, t);
		h.check(inFree(f), t(`G8.7 a smaller window: still whole ${fmt(f)}`));
		await P.setViewportSize({ width: 1440, height: 900 });
		await P.focus('#character-resize');
		for (let i = 0; i < 5; i++) await P.keyboard.press('Shift+ArrowRight');
		await P.waitForTimeout(400);
		await P.click('#character-show-in-scene').catch(() => {});
		await P.waitForTimeout(600);
		await shot(P, `06-desktop-in-scene-${theme}`);
		await P.click('#character-show-in-scene').catch(() => {});
		await P.keyboard.press('Escape');
		await D.ctx.close();
	}

	await h.finish(browser);
});
