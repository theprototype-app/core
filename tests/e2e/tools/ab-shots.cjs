// tests/e2e/tools/ab-shots.cjs — deps-auto: THE A/B SCREENSHOT SET, for a before/after of a change that should
// look like nothing (a dependency bump). The integrators' release A/B, made generic for scripts/ci/pc-battery.sh.
//
//   node tests/e2e/tools/ab-shots.cjs shoot <app-url> <out-dir>
//        app surfaces (start, object list, Inspector, Settings, logo menu) x dark/light x desktop 1440x900 + a
//        folded (390x896) and an unfolded (770x850) touch phone -> <out-dir>/<surface>-<device>-<theme>.png
//        The 3D canvas is hidden (a GPU's anti-aliasing is not a UI change), transitions are off and the
//        random 5-letter peer id and any toast (load-timed wording) are masked.
//   node tests/e2e/tools/ab-shots.cjs diff <base-dir> <head-dir> <out-dir> [--noise <base2-dir>]
//        every PNG present in both dirs: changed pixels (a channel moved more than AB_TOLERANCE, default 16)
//        -> <out-dir>/<name>-diff.png + report.md + report.json. A shot fails when head-vs-base moved more than
//        AB_MAX (fraction, default 0.0001). With --noise <base2>, the head is compared with the closer of the two
//        base runs and the base-vs-base diff is the floor (animated scenes never shoot the same twice): it fails
//        only past max(1.5 x the floor, AB_MAX). Exit 1 on a failure.
//
// Like kit-diff.cjs the decode and the compare run in a browser page (no image library in the repo).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const THEMES = (process.env.AB_THEMES || 'dark,light').split(',');
const DEVICES = {
	desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
	'phone-folded': { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true },
	'phone-unfolded': { viewport: { width: 770, height: 850 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }
};
const TOLERANCE = Number(process.env.AB_TOLERANCE ?? 16);
const MAX = Number(process.env.AB_MAX ?? 0.0001);

/** @param {any} ctx @param {string} url */
async function boot(ctx, url) {
	const p = await ctx.newPage();
	// a dev server's second fresh context sometimes never publishes the stores (deps re-optimised): reload
	for (let attempt = 1; ; attempt++) {
		await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
		const ok = await p.waitForFunction(() => /** @type {any} */ (window).__stores?.themes, null, { timeout: 90000 }).then(
			() => true,
			() => false
		);
		if (ok) break;
		if (attempt === 4) throw new Error('app never booted');
	}
	await p.waitForTimeout(3500);
	await p.locator('#restore-session-dismiss').click({ timeout: 1500 }).catch(() => {});
	return p;
}

/** @param {string} url @param {string} out */
async function shoot(url, out) {
	fs.mkdirSync(out, { recursive: true });
	const b = await chromium.launch({ headless: true });
	let failed = 0;
	for (const [dev, opts] of Object.entries(DEVICES)) {
		for (const theme of THEMES) {
			const ctx = await b.newContext({ ignoreHTTPSErrors: true, reducedMotion: 'reduce', ...opts });
			await ctx.addInitScript((t) => {
				localStorage.setItem('debugStores', 'true');
				localStorage.setItem('hasSeenDisclaimer', 'true');
				localStorage.setItem('hasSeenWelcome', 'true');
				localStorage.setItem('theme', t);
			}, theme);
			/** @type {any} */
			let p;
			try {
				p = await boot(ctx, url);
			} catch {
				console.log('boot failed', dev, theme);
				failed++;
				await ctx.close();
				continue;
			}
			await p.addStyleTag({ content: 'canvas{visibility:hidden!important} *{transition:none!important;animation:none!important;caret-color:transparent!important}' });
			/** @param {string} name */
			const shot = async (name) => {
				await p.waitForTimeout(900);
				await p.screenshot({ path: path.join(out, `${name}-${dev}-${theme}.png`), mask: [p.getByText(/^[A-Z0-9]{5}$/), p.locator('.tp-toast, [class*="toast"]')] }).catch(() => failed++);
			};
			const reset = () =>
				p.evaluate(() => {
					const s = /** @type {any} */ (window).__stores;
					s.settingsOpen.set(false);
					s.inspectorClose.set(true);
					s.objectListClose?.set(true);
				});
			await p.evaluate(() => /** @type {any} */ (window).__stores.commandsHandler.sceneCommand('/create box'));
			await p.waitForTimeout(700);
			await reset();
			await shot('start');
			await p.evaluate(() => /** @type {any} */ (window).__stores.objectListClose?.set(false));
			await shot('list');
			await reset();
			await p.evaluate(() => {
				const s = /** @type {any} */ (window).__stores;
				/** @type {any} */
				let g;
				s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
				const box = g?.children?.[g.children.length - 1];
				if (box) s.objectActions?.selectObject?.(box) ?? s.selectedObjects.set([box.uuid]);
				s.inspectorClose.set(false);
			});
			// the Inspector shows the box's random uuid: not a difference worth a red
			await p.waitForTimeout(900);
			await p.screenshot({ path: path.join(out, `inspector-${dev}-${theme}.png`), mask: [p.getByText(/^[A-Z0-9]{5}$/), p.getByText(/[0-9a-f]{8}-[0-9a-f]{4}-/), p.locator('.tp-toast, [class*="toast"]')] }).catch(() => failed++);
			await reset();
			await p.evaluate(() => {
				const s = /** @type {any} */ (window).__stores;
				s.settingsSection.set('interface');
				s.settingsOpen.set(true);
			});
			await p.waitForSelector('dialog.settings-dialog .ss-page', { timeout: 15000 }).catch(() => {});
			await shot('settings');
			await reset();
			await p.locator('#logo-menu').click({ timeout: 3000 }).catch(() => {});
			await shot('menu');
			await ctx.close();
		}
	}
	await b.close();
	return failed;
}

/** @param {any} page @param {string} a @param {string} b @param {string|null} diffOut */
async function compare(page, a, b, diffOut) {
	const r = await page.evaluate(
		async (/** @type {{a: string, b: string, tol: number, want: boolean}} */ { a, b, tol, want }) => {
			const load = (/** @type {string} */ s) =>
				new Promise((res, rej) => {
					const i = new Image();
					i.onload = () => res(i);
					i.onerror = rej;
					i.src = 'data:image/png;base64,' + s;
				});
			const [ia, ib] = /** @type {HTMLImageElement[]} */ (await Promise.all([load(a), load(b)]));
			const w = Math.max(ia.width, ib.width);
			const h = Math.max(ia.height, ib.height);
			const draw = (/** @type {HTMLImageElement} */ img) => {
				const c = document.createElement('canvas');
				c.width = w;
				c.height = h;
				const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
				x.fillStyle = '#f0f';
				x.fillRect(0, 0, w, h);
				x.drawImage(img, 0, 0);
				return x.getImageData(0, 0, w, h);
			};
			const da = draw(ia);
			const db = draw(ib);
			const oc = document.createElement('canvas');
			oc.width = w;
			oc.height = h;
			const ox = /** @type {CanvasRenderingContext2D} */ (oc.getContext('2d'));
			const od = ox.createImageData(w, h);
			let changed = 0;
			for (let i = 0; i < da.data.length; i += 4) {
				const d = Math.max(Math.abs(da.data[i] - db.data[i]), Math.abs(da.data[i + 1] - db.data[i + 1]), Math.abs(da.data[i + 2] - db.data[i + 2]));
				if (d > tol) {
					changed++;
					od.data.set([255, 0, 0, 255], i);
				} else {
					const g = 200 + ((db.data[i] + db.data[i + 1] + db.data[i + 2]) / 3) * 0.2;
					od.data.set([g, g, g, 255], i);
				}
			}
			if (!want) return { changed, total: w * h, png: '' };
			ox.putImageData(od, 0, 0);
			return { changed, total: w * h, png: oc.toDataURL('image/png').split(',')[1] };
		},
		{ a: fs.readFileSync(a).toString('base64'), b: fs.readFileSync(b).toString('base64'), tol: TOLERANCE, want: !!diffOut }
	);
	if (diffOut && r.changed) fs.writeFileSync(diffOut, Buffer.from(r.png, 'base64'));
	return { changed: r.changed, fraction: r.changed / r.total };
}

/** @param {string} base @param {string} head @param {string} out @param {string|null} noise */
async function diff(base, head, out, noise) {
	fs.mkdirSync(out, { recursive: true });
	const names = fs.readdirSync(base).filter((n) => n.endsWith('.png') && fs.existsSync(path.join(head, n))).sort();
	const b = await chromium.launch({ headless: true });
	const page = await b.newPage();
	const rows = [];
	for (const n of names) {
		let d = await compare(page, path.join(base, n), path.join(head, n), path.join(out, n.replace(/\.png$/, '-diff.png')));
		let floor = 0;
		if (noise && fs.existsSync(path.join(noise, n))) {
			floor = (await compare(page, path.join(base, n), path.join(noise, n), null)).fraction;
			// head against the CLOSER base run: an animated frame matches one of two samples better than either
			const d2 = await compare(page, path.join(noise, n), path.join(head, n), null);
			if (d2.fraction < d.fraction) d = d2;
		}
		const fail = d.fraction > Math.max(floor * 1.5, MAX);
		rows.push({ name: n, changed: d.changed, fraction: d.fraction, floor, fail });
	}
	await b.close();
	const missing = fs.readdirSync(base).filter((n) => n.endsWith('.png') && !names.includes(n));
	const pct = (/** @type {number} */ f) => (f * 100).toFixed(3) + ' %';
	let md = `| shot | changed px | head vs base | base vs base |\n|---|---:|---:|---:|\n`;
	md += rows.map((r) => `| ${r.fail ? '**' + r.name + '**' : r.name} | ${r.changed} | ${pct(r.fraction)} | ${noise ? pct(r.floor) : '–'} |`).join('\n') + '\n';
	if (missing.length) md += `\nNot shot on the head: ${missing.join(', ')}\n`;
	const failed = rows.filter((r) => r.fail).length + missing.length;
	md = `${failed ? `**${failed} shot(s) changed**` : `${rows.length} shots, no change beyond the noise`}\n\n` + md;
	fs.writeFileSync(path.join(out, 'report.md'), md);
	fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ rows, missing }, null, 1));
	console.log(md);
	return failed;
}

if (require.main === module) {
	const [cmd, ...a] = process.argv.slice(2);
	const ni = a.indexOf('--noise');
	const noise = ni >= 0 ? a.splice(ni, 2)[1] : null;
	const run = cmd === 'shoot' && a.length >= 2 ? shoot(a[0], a[1]) : cmd === 'diff' && a.length >= 3 ? diff(a[0], a[1], a[2], noise) : null;
	if (!run) {
		console.error('usage: ab-shots.cjs shoot <url> <out> | diff <base> <head> <out> [--noise <base2>]');
		process.exit(2);
	}
	run.then((failed) => process.exit(failed ? 1 : 0));
}
