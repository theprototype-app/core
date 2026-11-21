// 102-splats P0 SPIKE (evidence, not a suite): Spark (@sparkjsdev/spark) in the live render path.
// For 0 / 250k / 1M procedural splats x {shaded, shaded-ao, Product shot (AO + TRAA + bloom)}: fps,
// p50/p95 frame ms, draw calls, a screenshot; then the raster still (agent screenshot with post),
// a Photo (path tracer) and an IWER headset session.
//   APP_URL=https://theprototype.app:7076/ e2e-slot --dev . 7076 -- node tests/e2e/splat-spike.cjs
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const OUT = process.env.SPIKE_OUT || path.resolve(__dirname, '../../test-results/102-splats');
fs.mkdirSync(OUT, { recursive: true });
const COUNTS = (process.env.SPIKE_COUNTS || '0,250000,1000000').split(',').map(Number);
const MS = Number(process.env.SPIKE_MS || 4000);

/** mean luminance + spread of a PNG's centre half @param {Buffer} buf */
async function stats(buf) {
	const img = sharp(buf);
	const m = await img.metadata();
	const { data, info } = await img
		.extract({ left: Math.floor(m.width / 4), top: Math.floor(m.height / 4), width: Math.floor(m.width / 2), height: Math.floor(m.height / 2) })
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	let sum = 0;
	const n = info.width * info.height;
	for (let i = 0; i < data.length; i += 3) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
	const mean = sum / n;
	let dev = 0;
	for (let i = 0; i < data.length; i += 3) dev += Math.abs((data[i] + data[i + 1] + data[i + 2]) / 3 - mean);
	return { mean: Math.round(mean), spread: Math.round(dev / n), w: m.width, h: m.height };
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const opts = { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } }, storage: { autoQuality: 'false' } };
	// a remote slot's first boot of a cold dev server can pass setupPage's 90 s wait: the retry boots warm
	let A;
	try {
		A = await h.setupPage(browser, 'A', opts);
	} catch (e) {
		console.log('setupPage retry after', String(e?.message ?? e).slice(0, 80));
		A = await h.setupPage(browser, 'A', opts);
	}
	const page = A.page;
	const gl = await page.evaluate(() => {
		let r;
		window.__tp.test.v1.globalRenderer.subscribe((v) => (r = v))();
		const g = r.getContext();
		const ext = g.getExtension('WEBGL_debug_renderer_info');
		return { gpu: ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER), dpr: devicePixelRatio, w: r.domElement.width, h: r.domElement.height };
	});
	console.log('GPU', JSON.stringify(gl));
	await page.evaluate(async () => {
		window.__spike = await import('/src/lib/splat/splatSpike.js');
	});
	const setMode = async (mode) => {
		await page.evaluate(async (mode) => {
			const s = window.__tp.test.v1;
			if (mode === 'product') {
				s.viewMode.set('shaded');
				await s.proPresets.applyProPreset('product');
			} else {
				s.scenePost.setScenePostEnabled?.(false);
				s.viewMode.set(mode);
			}
		}, mode);
		await page.waitForTimeout(1500);
	};
	const rows = [];
	for (const count of COUNTS) {
		let built = null;
		if (count > 0) {
			built = await page.evaluate(async (count) => {
				const r = await window.__spike.addCloud({ count });
				window.__spike.lookAtCloud();
				return r;
			}, count);
			console.log('built', count, JSON.stringify(built));
		} else {
			await page.evaluate(() => window.__spike.lookAtCloud() || null);
		}
		await page.waitForTimeout(2000);
		for (const mode of ['shaded', 'shaded-ao', 'product']) {
			await setMode(mode);
			// keep the camera moving a little so the sort + TRAA history are exercised, not a frozen frame
			await page.evaluate(() => {
				let r;
				window.__tp.test.v1.globalCamera.subscribe((v) => (r = v))();
				window.__spikeOrbit = true;
				const t0 = performance.now();
				const spin = () => {
					if (!window.__spikeOrbit) return;
					const a = (performance.now() - t0) / 4000;
					r.position.set(Math.cos(a) * 7, 3, -4 + Math.sin(a) * 7);
					r.lookAt(0, 1, -4);
					requestAnimationFrame(spin);
				};
				spin();
			});
			const m = await page.evaluate((ms) => window.__spike.measure(ms), MS);
			await page.evaluate(() => (window.__spikeOrbit = false));
			await page.waitForTimeout(400);
			const shot = await page.screenshot({ path: path.join(OUT, `spike-${count}-${mode}.png`) });
			const st = await stats(shot);
			const row = { count, mode, ...m, shotMean: st.mean, shotSpread: st.spread, buildMs: built?.buildMs ?? '', importMs: built?.importMs ?? '' };
			rows.push(row);
			console.log(JSON.stringify(row));
		}
	}
	// the raster still (agent screenshot WITH post effects = postShot.js composer) and a Photo (path tracer)
	const stills = await page.evaluate(async () => {
		const s = window.__tp.test.v1;
		const toB64 = async (blob) => {
			const b = new Uint8Array(await blob.arrayBuffer());
			let str = '';
			for (let i = 0; i < b.length; i += 32768) str += String.fromCharCode(...b.subarray(i, i + 32768));
			return btoa(str);
		};
		const out = {};
		try {
			const { rasterPhoto } = await import('/src/lib/photo/photoRender.js');
			const blob = await rasterPhoto({ width: 640, height: 360 });
			out.raster = blob ? await toB64(blob) : null;
		} catch (e) {
			out.rasterErr = String(e?.message ?? e);
		}
		try {
			const r = await (await import('/src/lib/photo/photoRender.js')).renderPhoto({ samples: 4, seconds: 60, width: 320, height: 180, denoise: false });
			out.photo = await toB64(r.blob);
			out.photoNotes = r.notes;
		} catch (e) {
			out.photoErr = String(e?.message ?? e);
		}
		return out;
	});
	const still = {};
	for (const k of ['raster', 'photo']) {
		if (stills[k]) {
			const buf = Buffer.from(stills[k], 'base64');
			fs.writeFileSync(path.join(OUT, `spike-still-${k}.png`), buf);
			still[k] = await stats(buf);
		}
	}
	console.log('STILLS', JSON.stringify({ ...still, rasterErr: stills.rasterErr, photoErr: stills.photoErr, photoNotes: stills.photoNotes }));
	// an IWER headset session with the last cloud in the scene: does Spark keep drawing while presenting
	let xr = {};
	try {
		await setMode('shaded');
		await iwer.enter(page);
		await iwer.pose(page, 'head', [3, 1.6, 1], { yaw: 0.6 });
		await iwer.frames(page, 30);
		xr = await page.evaluate(
			() =>
				new Promise((resolve) => {
					const sess = window.__iwer.sessions.filter((x) => !x.ended).at(-1).session;
					let r;
					window.__tp.test.v1.globalRenderer.subscribe((v) => (r = v))();
					const t0 = performance.now();
					let n = 0;
					const tick = () => {
						n++;
						if (performance.now() - t0 < 4000) sess.requestAnimationFrame(tick);
						else resolve({ xrFps: Math.round((n / (performance.now() - t0)) * 10000) / 10, calls: r.info.render.calls, tris: r.info.render.triangles, presenting: r.xr.isPresenting });
					};
					sess.requestAnimationFrame(tick);
				})
		);
		const shot = await page.screenshot({ path: path.join(OUT, 'spike-xr.png') });
		xr.shot = await stats(shot);
		await iwer.exit(page);
	} catch (e) {
		xr.error = String(e?.message ?? e);
	}
	console.log('XR', JSON.stringify(xr));
	const md = [
		`# 102-splats spike — Spark in the live render path`,
		'',
		`GPU: ${gl.gpu}; canvas ${gl.w}x${gl.h} (dpr ${gl.dpr}); ${MS} ms per row with the camera orbiting.`,
		'',
		'| splats | look | fps | p50 ms | p95 ms | calls | shot mean | shot spread | build ms | import ms |',
		'|---|---|---|---|---|---|---|---|---|---|',
		...rows.map((r) => `| ${r.count} | ${r.mode} | ${r.fps} | ${r.p50} | ${r.p95} | ${r.calls} | ${r.shotMean} | ${r.shotSpread} | ${r.buildMs} | ${r.importMs} |`),
		'',
		`Stills: ${JSON.stringify({ ...still, rasterErr: stills.rasterErr, photoErr: stills.photoErr })}`,
		'',
		`Photo parity notes: ${JSON.stringify(stills.photoNotes ?? null)}`,
		'',
		`XR (IWER, Quest 3 profile): ${JSON.stringify(xr)}`,
		'',
		`Errors: ${JSON.stringify(page.__errors ?? [])}`
	].join('\n');
	const tag = process.env.SPIKE_TAG || 'run';
	fs.writeFileSync(path.join(OUT, `spike-${tag}.md`), md + '\n');
	console.log(md);
	await browser.close();
});
