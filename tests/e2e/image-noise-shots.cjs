// 105-noise — docs screenshots (not a suite): the Noise panel with its live preview in the dark and light themes,
// and the size dialog from an empty Roughness row. Writes test-results/105-noise/shots/.
// Run: APP_URL='https://localhost:7208/' node tests/e2e/image-noise-shots.cjs
const h = require('./helpers.cjs');
const fs = require('fs');

const OUT = 'test-results/105-noise/shots';
const S = (p, fn, arg) => p.page.evaluate(fn, arg);

h.run(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	await S(A, () => window.__tp.test.v1.explorer.loadExplorer());
	const id = await S(A, async () => {
		const s = window.__tp.test.v1;
		const r = await s.noiseRun.renderNoise({ kind: 'value', scale: 2, octaves: 2, colors: ['#5b3a24', '#c89a62', '#e8d2a8'] }, { width: 512, height: 512 });
		const blob = await s.imageEditor.encodeImage(r, { type: 'image/png' });
		const rec = await s.explorer.addItemFromBytes(await blob.arrayBuffer(), 'planks base.png', null, { type: 'image/png' });
		return rec.id;
	});
	for (const [n, themeId] of [
		['01', 'dark'],
		['02', 'light']
	]) {
		await S(A, (t) => window.__tp.test.v1.themes.theme.set(t), themeId);
		await S(A, (i) => window.__tp.test.v1.imageEditor.openImageEditor(i, { panel: 'noise', noise: { kind: 'worley', scale: 6, blend: 'overlay', opacity: 0.7 } }), id);
		await A.page.locator('#image-noise-apply').waitFor({ timeout: 15000 });
		await A.page.locator('#image-editor-noise-badge').waitFor({ timeout: 15000 });
		await S(A, () => document.querySelectorAll('.toasts-stack .tp-toast-x').forEach((b) => b.click()));
		// a docs shot wants the whole panel: give the window the screen's height and its sidebar room
		await S(A, () => {
			const w = document.querySelector('#image-preview-window');
			Object.assign(w.style, { top: '64px', left: '200px', width: '980px', height: '828px' });
		});
		await A.page.waitForTimeout(600);
		await S(A, () => document.getElementById('image-editor-noise-section')?.scrollIntoView({ block: 'start' }));
		await A.page.waitForTimeout(800);
		await A.page.locator('#image-preview-window').screenshot({ path: `${OUT}/${n}-noise-panel-${themeId}.png` });
		await S(A, () => window.__tp.test.v1.imageEditor.closeImageEditor());
		await A.page.waitForTimeout(500);
	}
	await S(A, () => window.__tp.test.v1.themes.theme.set('dark'));
	// the preview window stays open in View after the editor closes: close it, the Inspector is the subject now
	await S(A, () => {
		const fw = window.__tp.test.v1.fileWindows;
		let list = [];
		fw.previewWindows.subscribe((v) => (list = v))();
		for (const w of list) fw.closePreviewWindow(w.id);
	});
	await A.page.waitForTimeout(400);
	await S(A, () => window.__tp.test.v1.commandsHandler.sceneCommand('/create Box 1 1 1'));
	await A.page.waitForTimeout(800);
	const box = await S(A, async () => {
		const g = await new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe(r)());
		return g.children[g.children.length - 1].uuid;
	});
	await S(A, (u) => window.__tp.test.v1.objectActions.selectObject(u, true), box);
	await A.page.waitForTimeout(800);
	await A.page.locator('#map-noise-roughnessMap').scrollIntoViewIfNeeded();
	await A.page.locator('#map-noise-roughnessMap').click();
	await A.page.locator('#confirm-dialog-1024').waitFor({ timeout: 8000 });
	await A.page.waitForTimeout(400);
	await A.page.screenshot({ path: `${OUT}/03-fill-with-noise.png` });
	await A.page.keyboard.press('Escape');
	console.log('shots in ' + OUT);
	await h.finish(browser);
});
