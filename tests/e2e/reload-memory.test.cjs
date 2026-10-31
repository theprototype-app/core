// test-health-1 (plans review #24, roadmap-42 Follow-ups): RELOADING ONE TAB MUST NOT GROW IT.
//
// The report: editor-ui-33 died on its 5th reload in one tab (WebGL context lost / Target crashed)
// and the heap grew ~29 MB per reload. A reload replaces the document, so anything that grows
// ACROSS reloads is something the old document left behind: the old document itself (a reference
// from something that outlives it), or GPU memory the old page's WebGL contexts still held.
//
// Per reload, after a forced GC: the JS heap, the number of live Documents (1 = only the current
// one; more = an old document is retained), and the resident memory of this browser's renderer and
// GPU processes (ps, so it sees what Chromium's own heap metrics do not: WebGL buffers live in the
// GPU process). Evidence: EVIDENCE/reload-memory.json.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const RELOADS = Number(process.env.RELOADS || 6);
const SETTLE_MS = Number(process.env.RELOAD_SETTLE_MS || 4000);
const EVIDENCE = process.env.EVIDENCE || path.join(process.env.HOME || '.', '.code/lanes-30/after-60/60-test-health-1');
// thresholds: the growth that killed a tab was ~29 MB/reload of JS heap; a steady state after the
// first reload (caches warm) should be flat within noise
const MAX_HEAP_MB_PER_RELOAD = Number(process.env.MAX_HEAP_MB_PER_RELOAD || 5);
const MAX_GPU_MB_PER_RELOAD = Number(process.env.MAX_GPU_MB_PER_RELOAD || 25);

/** RSS (MB) of the renderer + gpu processes of this browser, by type, from Chromium's own process
 * list (SystemInfo.getProcessInfo — Playwright's Browser has no process(), only a BrowserServer
 * does, so the first version never measured these). /proc is local only: on a remote slot the
 * browser runs elsewhere and this answers null. @param {any} bcdp */
async function processRss(bcdp) {
	try {
		const { processInfo } = await bcdp.send('SystemInfo.getProcessInfo');
		const rss = (/** @type {number} */ pid) => {
			const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
			return m ? +m[1] / 1024 : 0;
		};
		const sum = (/** @type {string} */ type) => Math.round(processInfo.filter((/** @type {any} */ p) => p.type === type).reduce((t, /** @type {any} */ p) => t + rss(p.id), 0));
		return { renderer: sum('renderer'), gpu: sum('GPU') };
	} catch {
		return { renderer: null, gpu: null };
	}
}

h.run(async () => {
	const browser = await h.launch();
	const bcdp = await browser.newBrowserCDPSession();
	const A = await h.setupPage(browser, 'A');
	// Runtime.getHeapUsage + Memory.getDOMCounters are read FRESH per call; the first version read
	// Performance.getMetrics, which on a reloaded target kept answering the first document's
	// numbers (seven byte-identical rows), so it could not see growth at all
	const cdp = await A.page.context().newCDPSession(A.page);
	await cdp.send('HeapProfiler.enable');
	const sample = async (/** @type {number} */ i) => {
		await A.page.waitForTimeout(SETTLE_MS);
		await cdp.send('HeapProfiler.collectGarbage');
		await cdp.send('HeapProfiler.collectGarbage');
		const heap = await cdp.send('Runtime.getHeapUsage');
		const dom = await cdp.send('Memory.getDOMCounters');
		const gl = await A.page.evaluate(() => {
			/** @type {any} */ let r;
			window.__stores.globalRenderer.subscribe((/** @type {any} */ v) => (r = v))();
			return r?.info?.memory ?? null;
		}).catch(() => null);
		// the premise: every sample is a FRESH document (an unchanged timeOrigin = no reload happened)
		const origin = await A.page.evaluate(() => performance.timeOrigin);
		return {
			reload: i,
			origin,
			heapMB: Math.round((heap.usedSize / 1048576) * 10) / 10,
			documents: dom.documents,
			nodes: dom.nodes,
			listeners: dom.jsEventListeners,
			gl,
			...(await processRss(bcdp))
		};
	};
	/** @type {any[]} */
	const rows = [await sample(0)];
	console.log(JSON.stringify(rows[0]));
	let crashed = '';
	for (let i = 1; i <= RELOADS; i++) {
		try {
			await h.freshReload(A);
			await h.answerRestore(A).catch(() => false);
		} catch (error) {
			crashed = `reload ${i}: ${String(/** @type {any} */ (error)?.message ?? error).split('\n')[0]}`;
			break;
		}
		rows.push(await sample(i));
		console.log(JSON.stringify(rows[rows.length - 1]));
	}
	fs.mkdirSync(EVIDENCE, { recursive: true });
	fs.writeFileSync(path.join(EVIDENCE, 'reload-memory.json'), JSON.stringify({ at: new Date().toISOString(), url: h.URL, rows, crashed }, null, 1));

	h.check(!crashed, `the tab survives ${RELOADS} reloads (${crashed || 'all of them'})`);
	h.check(new Set(rows.map((r) => r.origin)).size === rows.length, `premise: each sample is a fresh document (${new Set(rows.map((r) => r.origin)).size} distinct of ${rows.length})`);
	// growth from the FIRST reload on: reload 0 -> 1 warms caches every app has
	const from = rows[1] ?? rows[0];
	const last = rows[rows.length - 1];
	const n = Math.max(1, last.reload - from.reload);
	const heapPer = (last.heapMB - from.heapMB) / n;
	h.check(heapPer <= MAX_HEAP_MB_PER_RELOAD, `JS heap after GC grows <= ${MAX_HEAP_MB_PER_RELOAD} MB per reload (${heapPer.toFixed(1)} MB/reload: ${rows.map((r) => r.heapMB).join(' → ')})`);
	// an absolute count says little (the page legitimately owns more than one: iframes, an inert
	// template document); a RETAINED old document shows up as the count climbing reload by reload
	h.check(last.documents <= from.documents, `no old document is retained (live Documents per reload: ${rows.map((r) => r.documents).join(', ')})`);
	if (last.gpu != null && from.gpu != null) {
		const gpuPer = (last.gpu - from.gpu) / n;
		h.check(gpuPer <= MAX_GPU_MB_PER_RELOAD, `GPU process RSS grows <= ${MAX_GPU_MB_PER_RELOAD} MB per reload (${gpuPer.toFixed(1)} MB/reload: ${rows.map((r) => r.gpu).join(' → ')})`);
	}
	await h.finish(browser);
});
