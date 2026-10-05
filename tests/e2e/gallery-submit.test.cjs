// 36-share (B13) — PUBLISH / EXPORT ▸ COMMUNITY GALLERY: a submission zip in the gallery repo's
// own shape, and GitHub's pages opened only by the person's clicks.
//
//   1. the modal has a "Community gallery" tab (no cloud plugin needed); the thumbnail is taken
//      from the view; the folder name follows the title
//   2. validation: no "mine" tick, a non-handle author, an empty title are refused with reasons and
//      nothing downloads
//   3. a valid card downloads <slug>-gallery-submission.zip holding <slug>/scene.tpscene (a real
//      .tpscene zip whose size is the row's `bytes`), <slug>/thumb.* (480×270, ≤ 512 KB),
//      <slug>/entry.json (README order) + gallery-row.json + HOW-TO-SUBMIT.txt
//   4. the zip's folder + row pass the community-gallery repo's own validate.cjs (sibling checkout)
//   5. nothing was opened or fetched toward github.com before a click; "Upload the folder" opens
//      GitHub's upload page for the slug; "Copy the gallery.json row" copies the row and opens the
//      gallery.json editor
// Evidence: RECORDING_SHOTS=<dir> (shared with recording.test) writes 06/07 screenshots.
const h = require('./helpers.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { unzipSync, strFromU8 } = require('fflate');

const SHOTS = process.env.RECORDING_SHOTS || '';
const GALLERY = [process.env.COMMUNITY_GALLERY_DIR, path.resolve(__dirname, '../../../community-gallery')].filter(Boolean).find((p) => fs.existsSync(path.join(p, 'scripts/validate.cjs')));
/** @param {any} page @param {string} name */
async function shot(page, name) {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, name) });
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 860 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] } });
	const { page } = A;
	/** @type {string[]} */
	const opened = [];
	/** @type {string[]} */
	const githubRequests = [];
	page.on('request', (r) => /github\.com/.test(r.url()) && githubRequests.push(r.url()));
	await page.exposeFunction('__noteOpen', (/** @type {string} */ u) => opened.push(u));
	await page.evaluate(() => {
		window.open = (/** @type {any} */ u) => {
			/** @type {any} */ (window).__noteOpen(String(u));
			return null;
		};
		window.__stores.commandsHandler.sceneCommand('/create box');
		window.__stores.commandsHandler.sceneCommand('/create sphere');
	});
	await page.waitForTimeout(1200);

	// ---------- 1. the tab ----------
	await page.evaluate(() => window.__stores.exportStores.openPublishExport('export'));
	await page.waitForSelector('#publish-export-tab-gallery', { timeout: 15000 });
	await page.click('#publish-export-tab-gallery');
	await page.waitForSelector('#gallery-panel', { timeout: 10000 });
	h.check(true, 'Publish / Export has a Community gallery tab (no cloud plugin)');
	await page.waitForSelector('#gallery-thumb', { timeout: 10000 });
	const thumbOk = await page.evaluate(() => {
		const img = /** @type {HTMLImageElement} */ (document.querySelector('#gallery-thumb'));
		return img.complete ? { w: img.naturalWidth, h: img.naturalHeight } : null;
	});
	h.check(!!thumbOk && thumbOk.w === 480 && thumbOk.h === 270, `the thumbnail is taken from the view at 480×270 (${JSON.stringify(thumbOk)})`);
	await page.fill('#gallery-title', 'Sky Castle Test');
	const slug = await page.evaluate(() => document.querySelector('#gallery-panel')?.getAttribute('data-slug'));
	h.check(slug === 'sky-castle-test', `the folder name follows the title (${slug})`);

	// ---------- 2. validation ----------
	await page.fill('#gallery-author', 'two words');
	await page.click('#gallery-build');
	await page.waitForTimeout(300);
	let errs = await page.evaluate(() => document.querySelector('#gallery-errors')?.textContent ?? '');
	h.check(/Tick the box/.test(errs), 'building without the "mine" tick is refused');
	await page.check('#gallery-mine');
	await page.click('#gallery-build');
	await page.waitForTimeout(600);
	errs = await page.evaluate(() => document.querySelector('#gallery-errors')?.textContent ?? '');
	h.check(/GitHub handle/.test(errs), `a non-handle author is refused (${errs.slice(0, 60)})`);
	h.check(!(await page.$('#gallery-result')), 'nothing was built on a refusal');

	// ---------- 3. a valid card → the zip ----------
	await page.fill('#gallery-author', '@AlexZ005');
	await page.fill('#gallery-description', 'Two primitives, for the 36-share proof.');
	await page.fill('#gallery-tags', 'Showcase, test');
	await page.locator('.gl-chip', { hasText: 'building' }).click();
	await page.selectOption('#gallery-license', 'CC-BY-4.0');
	await shot(page, '06-gallery-tab.png');
	const before = { opened: opened.length, gh: githubRequests.length };
	const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#gallery-build')]);
	await page.waitForSelector('#gallery-result', { timeout: 10000 });
	h.check(download.suggestedFilename() === 'sky-castle-test-gallery-submission.zip', `downloads ${download.suggestedFilename()}`);
	h.check(opened.length === before.opened && githubRequests.length === 0, `building opens nothing and contacts no GitHub page (${opened.length} opens, ${githubRequests.length} requests)`);
	const zip = unzipSync(new Uint8Array(fs.readFileSync(/** @type {string} */ (await download.path()))));
	const names = Object.keys(zip).filter((n) => !n.endsWith('/')).sort();
	const thumbName = names.find((n) => /^sky-castle-test\/thumb\.(webp|png)$/.test(n));
	h.check(
		!!thumbName && names.includes('sky-castle-test/scene.tpscene') && names.includes('sky-castle-test/entry.json') && names.includes('gallery-row.json') && names.includes('HOW-TO-SUBMIT.txt') && names.length === 5,
		`the zip is the gallery shape (${names.join(', ')})`
	);
	const scene = zip['sky-castle-test/scene.tpscene'];
	const inner = Object.keys(unzipSync(scene));
	h.check(inner.includes('session.json'), `scene.tpscene is a real scene bundle (${inner.slice(0, 4).join(', ')})`);
	const entry = JSON.parse(strFromU8(zip['sky-castle-test/entry.json']));
	h.check(Object.keys(entry).join(',') === 'title,author,license,description,tags,appVersion,created', `entry.json in README order (${Object.keys(entry).join(',')})`);
	h.check(entry.author === 'AlexZ005' && entry.license === 'CC-BY-4.0' && entry.tags.join(',') === 'showcase,test,building', `entry.json carries the card (${entry.author}, ${entry.license}, ${entry.tags})`);
	const row = JSON.parse(strFromU8(zip['gallery-row.json']));
	h.check(row.slug === 'sky-castle-test' && row.bytes === scene.length && row.scene === 'sky-castle-test/scene.tpscene' && row.thumb === thumbName, `the row points at the files and its bytes match the scene (${row.bytes} vs ${scene.length})`);
	h.check(zip[/** @type {string} */ (thumbName)].length <= 512 * 1024, `the thumbnail is ≤ 512 KB (${zip[/** @type {string} */ (thumbName)].length})`);
	const howto = strFromU8(zip['HOW-TO-SUBMIT.txt']);
	h.check(howto.includes('upload/main/sky-castle-test'), 'HOW-TO-SUBMIT.txt names the upload page');
	await shot(page, '07-gallery-result.png');

	// ---------- 4. the gallery repo's own CI ----------
	if (GALLERY) {
		const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-gallery-e2e-'));
		fs.cpSync(GALLERY, work, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
		for (const n of names.filter((n) => n.startsWith('sky-castle-test/'))) {
			fs.mkdirSync(path.join(work, path.dirname(n)), { recursive: true });
			fs.writeFileSync(path.join(work, n), zip[n]);
		}
		const gallery = JSON.parse(fs.readFileSync(path.join(work, 'gallery.json'), 'utf8'));
		gallery.entries.push(row);
		fs.writeFileSync(path.join(work, 'gallery.json'), JSON.stringify(gallery, null, '\t'));
		let out = '';
		let code = 0;
		try {
			out = execFileSync('node', [path.join(work, 'scripts/validate.cjs')], { encoding: 'utf8' });
		} catch (e) {
			code = /** @type {any} */ (e).status;
			out = String(/** @type {any} */ (e).stdout);
		}
		h.check(code === 0 && out.includes('ALL PASS'), `the community-gallery CI passes the submission (${out.trim().split('\n').pop()})`);
		fs.rmSync(work, { recursive: true, force: true });
	} else console.log('SKIP the gallery CI check (no sibling community-gallery checkout)');

	// ---------- 5. GitHub only on a click ----------
	await page.click('#gallery-open-upload');
	await page.waitForTimeout(200);
	h.check(opened[opened.length - 1] === 'https://github.com/theprototype-app/community-gallery/upload/main/sky-castle-test', `"Upload the folder" opens GitHub's upload page for the slug (${opened[opened.length - 1]})`);
	await page.click('#gallery-copy-row');
	await page.waitForTimeout(400);
	h.check(opened[opened.length - 1] === 'https://github.com/theprototype-app/community-gallery/edit/main/gallery.json', `"Copy the row" opens the gallery.json editor (${opened[opened.length - 1]})`);
	const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
	h.check(clip.length > 0 && JSON.parse(clip).slug === 'sky-castle-test', 'the row is on the clipboard');
	h.check(githubRequests.length === 0, `the app itself never requested github.com (${githubRequests.length})`);

	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).slice(0, 2).join(' | ')})`);
	await h.finish(browser);
});
