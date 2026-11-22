#!/usr/bin/env node
// @ts-nocheck
// 94 SP3 — FIRST FRAME ON A THROTTLED PHONE. The other half of the boot gate (scripts/boot-size.cjs
// holds the BYTES; this holds the TIME): open each page of perf/boot-budget.json from the BUILT app
// on a throttled profile and measure the moment its 3D view first draws. The profile is
// `throttle` in the budget file (default: Lighthouse's mobile line — 1.6 Mbps down, 150 ms RTT,
// 4x CPU slowdown), the server compresses like the host does (serve-build --gzip), every run is a
// fresh context (no cache), and the reading is the MEDIAN of `--runs` (default 3).
//
// "First frame" = the first WebGL clear/draw on a canvas that is in the page (a hook on
// getContext, installed before any page script runs) — the same for both pages, needing no app
// hook, and blind to the WebGL2 support probe (its canvas is never attached).
//
//   npm run build && node scripts/boot-frame.cjs [--check] [--json] [--runs 3] [--page play]
//   node scripts/boot-frame.cjs --url https://localhost:5961/   (an already running server)
//   node scripts/boot-frame.cjs --port 5964                      (pin the spawned server's port)
//
// --check exits 1 when a page's median is over its `maxFirstFrameMs` (0 = not gated). Timing on a
// shared CI runner is noisy, so the lines are deliberately LOOSE: this catches a boot that got
// seconds slower, not one that got 50 ms slower — the byte budget is the precise gate.
// Exit 2 = could not measure (no build, the server did not start, the page never drew).
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
	const i = argv.indexOf(n);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const budget = JSON.parse(fs.readFileSync(path.join(ROOT, 'perf/boot-budget.json'), 'utf8'));
const T = { cpu: 4, downKbps: 1600, upKbps: 750, rttMs: 150, ...(budget.throttle || {}) };
const RUNS = Math.max(1, Number(opt('--runs', '3')));
const ONLY = opt('--page', '');
const PAGE_PATH = { play: 'play', editor: '' };

const freePort = () =>
	new Promise((res, rej) => {
		const s = net.createServer();
		s.once('error', rej);
		s.listen(0, '127.0.0.1', () => {
			const p = s.address().port;
			s.close(() => res(p));
		});
	});

async function startServer() {
	if (!fs.existsSync(path.join(ROOT, 'build/index.html'))) {
		console.error('boot-frame: no build (npm run build first)');
		process.exit(2);
	}
	const port = Number(opt('--port', 0)) || (await freePort());
	const child = spawn(process.execPath, [path.join(ROOT, 'scripts/serve-build.cjs'), '--http', '--gzip', '--port', String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
	await new Promise((res, rej) => {
		const t = setTimeout(() => rej(new Error('serve-build did not start')), 20000);
		child.stdout.on('data', (b) => {
			if (String(b).includes('serve-build:')) {
				clearTimeout(t);
				res();
			}
		});
		child.once('exit', (c) => rej(new Error('serve-build exited ' + c)));
	});
	return { base: `http://localhost:${port}/`, stop: () => child.kill() };
}

/** installed before any page script: stamp the first clear/draw on an attached WebGL canvas */
function firstDrawHook() {
	const orig = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
		const ctx = orig.call(this, type, ...rest);
		if (ctx && /webgl/i.test(String(type)) && !ctx.__tpHooked) {
			ctx.__tpHooked = true;
			for (const m of ['clear', 'drawElements', 'drawArrays']) {
				const f = ctx[m];
				ctx[m] = function (...a) {
					if (!window.__tpFirstDraw && this.canvas && this.canvas.isConnected) window.__tpFirstDraw = performance.now();
					return f.apply(this, a);
				};
			}
		}
		return ctx;
	};
}

async function measure(browser, url) {
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
	await ctx.addInitScript(firstDrawHook);
	const page = await ctx.newPage();
	const cdp = await ctx.newCDPSession(page);
	await cdp.send('Network.enable');
	await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
	await cdp.send('Network.emulateNetworkConditions', {
		offline: false,
		latency: T.rttMs,
		downloadThroughput: (T.downKbps * 1000) / 8,
		uploadThroughput: (T.upKbps * 1000) / 8
	});
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: T.cpu });
	try {
		await page.goto(url, { waitUntil: 'commit', timeout: 120000 });
		await page.waitForFunction(() => window.__tpFirstDraw, null, { timeout: 180000, polling: 100 });
		return Math.round(await page.evaluate(() => window.__tpFirstDraw));
	} catch (e) {
		return null;
	} finally {
		await ctx.close();
	}
}

(async () => {
	const { chromium } = require('playwright');
	const ext = opt('--url', '');
	const srv = ext ? { base: ext.endsWith('/') ? ext : ext + '/', stop: () => {} } : await startServer();
	const browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
	const out = { throttle: T, runs: RUNS, pages: {} };
	let over = false;
	let failed = false;
	try {
		for (const [name, page] of Object.entries(budget.pages)) {
			if (ONLY && name !== ONLY) continue;
			const url = srv.base + (PAGE_PATH[name] ?? String(page.html).replace(/(index)?\.html$/, ''));
			const all = [];
			for (let i = 0; i < RUNS; i++) all.push(await measure(browser, url));
			const ok = all.filter((v) => v != null).sort((a, b) => a - b);
			const median = ok.length ? ok[Math.floor(ok.length / 2)] : null;
			const max = Number(page.maxFirstFrameMs) || 0;
			if (median == null) failed = true;
			else if (max && median > max) over = true;
			out.pages[name] = { url, firstFrameMs: all, medianMs: median, maxFirstFrameMs: max };
		}
	} finally {
		await browser.close();
		srv.stop();
	}
	if (flag('--json')) console.log(JSON.stringify(out, null, 2));
	else {
		console.log(`throttle: ${T.downKbps} kbps down / ${T.upKbps} up, ${T.rttMs} ms RTT, CPU x${T.cpu}; median of ${RUNS}`);
		console.log('| page | first frame (median) | runs | budget | verdict |');
		console.log('|---|---:|---|---:|---|');
		for (const [name, r] of Object.entries(out.pages)) {
			const v = r.medianMs == null ? '**NO FRAME**' : r.maxFirstFrameMs && r.medianMs > r.maxFirstFrameMs ? `**OVER by ${r.medianMs - r.maxFirstFrameMs} ms**` : 'ok';
			console.log(`| ${name} | ${r.medianMs ?? '-'} ms | ${r.firstFrameMs.join(', ')} | ${r.maxFirstFrameMs || '-'} ms | ${v} |`);
		}
	}
	if (failed) process.exit(2);
	if (flag('--check') && over) process.exit(1);
})().catch((e) => {
	console.error('boot-frame:', e?.message || e);
	process.exit(2);
});
