// tests/e2e/tools/kit-diff.cjs — roadmap 38, NOTES-38 #18: the TOKEN SCREENSHOT DIFF.
// Renders /kit (every redesign primitive in every state) in the dark, light and custom
// .theme.json themes and diffs it against a baseline, so a token change that shifts a colour,
// a radius or a size anywhere in the kit shows up as pixels on the PR.
//
//   node tests/e2e/tools/kit-diff.cjs shoot <app-url> <out-dir>         /kit?theme=… -> <out-dir>/kit-<theme>.png
//   node tests/e2e/tools/kit-diff.cjs diff <base-dir> <head-dir> <out-dir>
//        -> <out-dir>/kit-<theme>-diff.png (changed pixels in red over a faded head), report.md,
//           and exit 1 when any theme changed more than KIT_DIFF_MAX (fraction, default 0.0001)
//
// CI (.github/workflows/ci.yml › kit-diff) shoots the PR's BASE ref and its HEAD on the same
// runner and diffs the two, so there is no committed baseline to drift with fonts or
// anti-aliasing between machines. A base without /kit (before 38-tokens lands) is skipped.
// The decode and the compare run in a browser page (no image library in the repo); only the
// counts and the diff PNG cross back.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const THEMES = ['dark', 'light', 'custom'];
const WIDTH = 1440;
const MAX = Number(process.env.KIT_DIFF_MAX ?? 0.0001);
// a channel difference at or under this is anti-aliasing noise, not a token change
const TOLERANCE = Number(process.env.KIT_DIFF_TOLERANCE ?? 16);

async function shoot(url, out) {
	fs.mkdirSync(out, { recursive: true });
	const browser = await chromium.launch({ headless: true });
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: WIDTH, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
	const page = await ctx.newPage();
	let missing = 0;
	for (const theme of THEMES) {
		const target = new URL('kit?theme=' + theme, url.endsWith('/') ? url : url + '/').href;
		await page.goto(target, { waitUntil: 'networkidle', timeout: 90000 });
		await page.waitForTimeout(1200);
		await page.evaluate(() => document.fonts?.ready);
		// a caret or a focus ring would be a difference that is not a token change
		await page.addStyleTag({ content: '*{caret-color:transparent!important;animation:none!important;transition:none!important}' });
		await page.evaluate(() => /** @type {any} */ (document.activeElement)?.blur?.());
		const hasKit = await page.evaluate(() => !/not available/i.test(document.body.innerText) && document.body.innerText.length > 200);
		if (!hasKit) {
			missing++;
			console.log(`kit-diff: ${target} has no kit (not available on this build)`);
			continue;
		}
		await page.screenshot({ path: path.join(out, `kit-${theme}.png`), fullPage: true });
		console.log(`kit-diff: shot ${theme}`);
	}
	await browser.close();
	return missing;
}

async function diff(baseDir, headDir, out) {
	fs.mkdirSync(out, { recursive: true });
	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	const rows = [];
	let failed = false;
	for (const theme of THEMES) {
		const a = path.join(baseDir, `kit-${theme}.png`);
		const b = path.join(headDir, `kit-${theme}.png`);
		if (!fs.existsSync(a) || !fs.existsSync(b)) {
			rows.push(`| ${theme} | — | skipped (${!fs.existsSync(a) ? 'no base shot' : 'no head shot'}) |`);
			continue;
		}
		const r = await page.evaluate(
			async ({ a, b, tol }) => {
				const load = (b64) =>
					new Promise((res, rej) => {
						const img = new Image();
						img.onload = () => res(img);
						img.onerror = rej;
						img.src = 'data:image/png;base64,' + b64;
					});
				const [ia, ib] = /** @type {HTMLImageElement[]} */ (await Promise.all([load(a), load(b)]));
				const w = Math.max(ia.width, ib.width);
				const h = Math.max(ia.height, ib.height);
				const draw = (img) => {
					const c = document.createElement('canvas');
					c.width = w;
					c.height = h;
					const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
					x.fillStyle = '#ff00ff';
					x.fillRect(0, 0, w, h);
					x.drawImage(img, 0, 0);
					return x.getImageData(0, 0, w, h);
				};
				const da = draw(ia);
				const db = draw(ib);
				const outC = document.createElement('canvas');
				outC.width = w;
				outC.height = h;
				const ox = /** @type {CanvasRenderingContext2D} */ (outC.getContext('2d'));
				const od = ox.createImageData(w, h);
				let changed = 0;
				for (let i = 0; i < da.data.length; i += 4) {
					const d = Math.max(Math.abs(da.data[i] - db.data[i]), Math.abs(da.data[i + 1] - db.data[i + 1]), Math.abs(da.data[i + 2] - db.data[i + 2]));
					if (d > tol) {
						changed++;
						od.data[i] = 255;
						od.data[i + 1] = 0;
						od.data[i + 2] = 0;
						od.data[i + 3] = 255;
					} else {
						const g = (db.data[i] + db.data[i + 1] + db.data[i + 2]) / 3;
						od.data[i] = od.data[i + 1] = od.data[i + 2] = 200 + g * 0.2;
						od.data[i + 3] = 255;
					}
				}
				ox.putImageData(od, 0, 0);
				return { changed, total: w * h, size: [ia.width, ia.height, ib.width, ib.height], png: outC.toDataURL('image/png').split(',')[1] };
			},
			{ a: fs.readFileSync(a).toString('base64'), b: fs.readFileSync(b).toString('base64'), tol: TOLERANCE }
		);
		fs.writeFileSync(path.join(out, `kit-${theme}-diff.png`), Buffer.from(r.png, 'base64'));
		const frac = r.changed / r.total;
		const sizeNote = r.size[0] !== r.size[2] || r.size[1] !== r.size[3] ? ` · size ${r.size[0]}×${r.size[1]} -> ${r.size[2]}×${r.size[3]}` : '';
		const bad = frac > MAX;
		failed ||= bad;
		rows.push(`| ${theme} | ${(frac * 100).toFixed(3)}% (${r.changed} px)${sizeNote} | ${bad ? 'CHANGED — look at kit-' + theme + '-diff.png' : 'same'} |`);
	}
	await browser.close();
	const report = `## /kit token screenshot diff (NOTES-38 #18)\n\nBase vs head, ${WIDTH}px wide, per-channel tolerance ${TOLERANCE}, limit ${(MAX * 100).toFixed(3)}% of pixels.\n\n| theme | changed | verdict |\n|---|---|---|\n${rows.join('\n')}\n\n${failed ? 'A token change moved pixels in the kit. If it is intended, say so in the PR; the diff images are in the job artifact.' : 'No visible change.'}\n`;
	fs.writeFileSync(path.join(out, 'report.md'), report);
	console.log(report);
	return failed;
}

(async () => {
	const [mode, x, y, z] = process.argv.slice(2);
	if (mode === 'shoot' && x && y) {
		await shoot(x, y);
		process.exit(0);
	}
	if (mode === 'diff' && x && y && z) process.exit((await diff(x, y, z)) ? 1 : 0);
	console.error('usage: kit-diff.cjs shoot <app-url> <out-dir> | diff <base-dir> <head-dir> <out-dir>');
	process.exit(2);
})().catch((e) => {
	console.error(e);
	process.exit(2);
});
