// 61 G3 — the "Test with players" suites' storage spy. A bot frame keeps every storage write in a memory
// overlay (safeStorage), so the app never calls the REAL setItem / removeItem / clear from one; this init
// script records every call that does reach the real Storage from a non-top frame, in
// `window.top.__tpBotRealWrites`. Install it BEFORE the harness seeds storage (that seed is an init
// script too and runs in every frame) and pass the seeded keys, which are left out.

/** keys helpers.setupPage seeds AFTER a suite's init scripts (so the spy sees the seed run in each frame) */
const HARNESS_SEEDS = ['cloudPluginUrl'];

/** @param {string[]} seeded @returns {string} */
function writeSpy(seeded = []) {
	return `(() => {
	// the list is made in the TOP realm: one made by a bot frame's first write would keep that frame's whole realm
	// alive after Stop (measured: the heap stayed +45 MB per bot)
	if (window === window.top) {
		window.__tpBotRealWrites = [];
		return;
	}
	const seeded = new Set(${JSON.stringify([...seeded, ...HARNESS_SEEDS])});
	for (const name of ['setItem', 'removeItem', 'clear']) {
		const orig = Storage.prototype[name];
		Storage.prototype[name] = function (k, ...rest) {
			if (!(name !== 'clear' && seeded.has(k))) try { window.top.__tpBotRealWrites?.push(String(name) + ':' + String(k ?? '')); } catch {}
			return orig.call(this, k, ...rest);
		};
	}
})();`;
}

/** the positive control: a bot frame's real write is seen, then forgotten @param {any} page @param {any} frame */
async function probe(page, frame) {
	await frame?.evaluate(() => Storage.prototype.setItem.call(window.top.localStorage, 'tp-spy-probe', '1'));
	return page.evaluate(() => {
		const w = window.__tpBotRealWrites ?? [];
		const hit = w.includes('setItem:tp-spy-probe');
		window.__tpBotRealWrites = w.filter((x) => x !== 'setItem:tp-spy-probe');
		localStorage.removeItem('tp-spy-probe');
		return hit;
	});
}

/** @param {any} page @returns {Promise<string[]>} */
const writes = (page) => page.evaluate(() => (window.__tpBotRealWrites ?? []).slice());

/** why a bot never said hello: the hub's trace, each bot frame's state, the tab's errors @param {any} page @param {any} dbg */
async function stuck(page, dbg) {
	console.log('[stuck] hub', JSON.stringify({ attached: dbg?.attached, hellos: dbg?.hellos }));
	for (const f of page.frames().filter((fr) => /[?&]tpbot=/.test(fr.url()))) {
		const fs = await f
			.evaluate(() => {
				const s = window.__tp?.test?.v1;
				let pc = null;
				s?.peers?.subscribe((v) => (pc = v))();
				return { ready: document.readyState, tp: !!s, bot: document.documentElement.dataset.tpBot ?? null, id: pc?.peer?.id ?? null, open: pc?.peer?.open ?? null, factory: !!pc?.botPeerFactory, parentSame: window.parent !== window };
			})
			.catch((e) => ({ error: String(e) }));
		console.log('[stuck] frame', f.url(), JSON.stringify(fs));
	}
	for (const m of (page.__console ?? []).filter((m) => m.type === 'error' || /test-player|localLink|Failed to fetch|optimized|tpbot/i.test(m.text)).slice(-30)) console.log('[stuck console]', m.type, m.text.slice(0, 300));
}

module.exports = { writeSpy, probe, writes, stuck };
