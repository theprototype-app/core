// Roadmap #7 N3 (ship-qa D3): per-peer network-quality telemetry — latency band
// + relayed flag, median-smoothed, LOCAL (never replicated), pruned on disconnect.
// Real RTT is environment-dependent, so this exercises the pure classification +
// median + the getStats reader against a mock RTCPeerConnection. The dot itself
// renders in the peers popover (Users.svelte) + VR stats card.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const r = await A.page.evaluate(() => {
		const nq = window.__stores.networkQuality;
		const read = (id) => {
			let v;
			nq.peerQuality.subscribe((x) => (v = x))();
			return v[id];
		};
		const bands = [nq.classifyRtt(50), nq.classifyRtt(150), nq.classifyRtt(400), nq.classifyRtt(null)];
		// median smoothing: a single spike must not flip the band
		nq.updatePeerQuality('p1', { rtt: 40, relayed: false });
		nq.updatePeerQuality('p1', { rtt: 60, relayed: false });
		nq.updatePeerQuality('p1', { rtt: 900, relayed: false }); // spike
		nq.updatePeerQuality('p1', { rtt: 50, relayed: false });
		nq.updatePeerQuality('p1', { rtt: 55, relayed: false });
		const p1 = read('p1'); // median([40,50,55,60,900]) = 55 -> good
		nq.updatePeerQuality('p2', { rtt: 300, relayed: true });
		const p2 = read('p2'); // 300 -> bad, relayed
		nq.dropPeerQuality('p1');
		const p1After = read('p1');
		return { bands, p1, p2, p1After };
	});
	h.check(r.bands.join(',') === 'good,ok,bad,unknown', `classifyRtt bands (${r.bands.join(',')})`);
	h.check(
		r.p1 && r.p1.level === 'good' && Math.abs(r.p1.rtt - 55) < 0.001,
		`median ignores a single spike (rtt=${r.p1?.rtt}, ${r.p1?.level})`
	);
	h.check(r.p2 && r.p2.level === 'bad' && r.p2.relayed === true, 'high RTT reads bad + the relayed flag sticks');
	h.check(!r.p1After, 'dropPeerQuality prunes the peer (disconnect cleanup)');

	// getStats reader: selected candidate-pair RTT (s->ms) + relay detection
	const stats = await A.page.evaluate(async () => {
		const nq = window.__stores.networkQuality;
		const reports = new Map();
		reports.set('cp1', {
			type: 'candidate-pair', state: 'succeeded', nominated: true,
			currentRoundTripTime: 0.08, localCandidateId: 'lc1', remoteCandidateId: 'rc1'
		});
		reports.set('lc1', { type: 'local-candidate', candidateType: 'relay' });
		reports.set('rc1', { type: 'remote-candidate', candidateType: 'host' });
		const pc = { getStats: async () => reports };
		const direct = await nq.readPeerStats({ getStats: async () => {
			const m = new Map();
			m.set('cp', { type: 'candidate-pair', state: 'succeeded', selected: true, currentRoundTripTime: 0.02, localCandidateId: 'l', remoteCandidateId: 'r' });
			m.set('l', { type: 'local-candidate', candidateType: 'srflx' });
			m.set('r', { type: 'remote-candidate', candidateType: 'host' });
			return m;
		} });
		return { relayPair: await nq.readPeerStats(pc), direct };
	});
	h.check(
		Math.abs(stats.relayPair.rtt - 80) < 0.001 && stats.relayPair.relayed === true,
		`readPeerStats: 0.08s -> 80ms + relay detected (${stats.relayPair.rtt}, ${stats.relayPair.relayed})`
	);
	h.check(
		Math.abs(stats.direct.rtt - 20) < 0.001 && stats.direct.relayed === false,
		`direct pair reads 20ms, not relayed (${stats.direct.rtt}, ${stats.direct.relayed})`
	);

	await h.finish(browser);
});
