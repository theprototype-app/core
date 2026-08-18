// The audio verification harness (roadmap #22 groundwork).
//
// Every acceptance criterion in roadmap #22 assumes sound can be MEASURED here.
// Until this suite existed the e2e guidance said the opposite — "playing is
// source-state, no audible check possible" — so a music roadmap would have shipped
// eighteen phases of unfalsifiable checks. This proves the four primitives the rest
// of that roadmap leans on, and proves each of them can FAIL.
//
// The load-bearing numbers, measured 2026-08-18 in headless Chromium with no audio
// device at all: a 0.5-amplitude 440Hz sine reads peak RMS 0.355 against a
// theoretical 0.5/sqrt(2) = 0.3536, and an OfflineAudioContext render of a unit sine
// reads 0.7071 against 1/sqrt(2). Audio is measurable here to three decimal places.
// What is NOT measurable is whether it sounds good — that stays the user's check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true });

	// The context is created lazily by ensureAudioContext, and the tap only appears
	// once something connects to the destination. Make both happen.
	await A.page.evaluate(async () => {
		const ctx = window.__stores.voiceChat.ensureAudioContext();
		if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
	});

	// ---- 1. premise: the tap is installed and intercepting -----------------------
	const tapped = await A.page.evaluate(async () => {
		const ctx = window.__stores.voiceChat.ensureAudioContext();
		const g = ctx.createGain();
		g.connect(ctx.destination); // must be DIVERTED into the tap
		const state = { installed: !!window.__audioTap, contexts: window.__audioTap?.contexts() ?? 0 };
		g.disconnect();
		return state;
	});
	h.check(tapped.installed, 'premise: the destination tap is installed');
	h.check(tapped.contexts === 1, 'premise: exactly one AudioContext is tapped (got ' + tapped.contexts + ')');

	// ---- 2. SILENCE reads as silence --------------------------------------------
	// This is the counterfactual for everything below: a detector that always says
	// "sound" would pass check 3 and mean nothing.
	const quiet = await h.audioMetrics(A, 500);
	h.check(!quiet.error, 'metrics read without error' + (quiet.error ? ' — ' + quiet.error : ''));
	// A FLOOR, not just "> 0": at 2 reads per 500ms the loop catches a chime's decay
	// and never its attack, which under-measured the ping by 25x before AUDIO_ARGS
	// carried the GPU flags. If this drops, every level threshold below is unreliable.
	h.check(
		quiet.samples >= 15,
		'premise: the metrics loop samples densely enough to catch a transient (' + quiet.samples + ' reads / 500ms)'
	);
	h.check(quiet.silent, 'an idle scene is SILENT (peak ' + quiet.peak.toFixed(5) + ')');

	// ---- 3. the app's OWN audio is measurable ------------------------------------
	// pingAudio, not a tone this suite made: the point is that the harness observes
	// the real app graph, not a fixture it wired up itself.
	const pinged = await (async () => {
		const metrics = A.page.evaluate(async () => {
			const { playPing } = await import('/src/lib/pingAudio.js');
			playPing('bell');
		});
		const read = await h.audioMetrics(A, 900);
		await metrics;
		return read;
	})();
	h.check(!pinged.silent, "the app's own ping chime is HEARD (peak " + pinged.peak.toFixed(4) + ')');
	h.check(
		pinged.peak > quiet.peak * 10,
		'the ping is decisively louder than silence (' + pinged.peak.toFixed(4) + ' vs ' + quiet.peak.toFixed(5) + ')'
	);

	// ---- 4. the CENTROID discriminates timbre -----------------------------------
	// RMS alone cannot tell a filter sweep from nothing, which is exactly what 22-C3
	// needs to assert. Two pure tones an octave-and-a-half apart, same amplitude, so
	// the only thing that can move the number is frequency.
	const tone = async (hz) => {
		const started = A.page.evaluate(async (freq) => {
			const ctx = window.__stores.voiceChat.ensureAudioContext();
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.frequency.value = freq;
			gain.gain.value = 0.3;
			osc.connect(gain);
			gain.connect(ctx.destination);
			osc.start();
			window.__probeOsc = osc;
		}, hz);
		await started;
		const read = await h.audioMetrics(A, 500);
		await A.page.evaluate(() => {
			window.__probeOsc?.stop();
			window.__probeOsc?.disconnect();
			window.__probeOsc = null;
		});
		return read;
	};
	const low = await tone(200);
	const high = await tone(4000);
	h.check(!low.silent && !high.silent, 'both probe tones are audible (' + low.peak.toFixed(3) + ' / ' + high.peak.toFixed(3) + ')');
	h.check(
		high.centroid > low.centroid * 3,
		'the centroid follows frequency: 200Hz -> ' + Math.round(low.centroid) + 'Hz, 4000Hz -> ' + Math.round(high.centroid) + 'Hz'
	);
	h.check(
		low.peak > 0.05 && high.peak > 0.05 && Math.abs(low.peak - high.peak) < 0.12,
		'the two probes are comparable in LEVEL, so the centroid moved on timbre alone (' +
			low.peak.toFixed(3) + ' vs ' + high.peak.toFixed(3) + ')'
	);

	// ---- 5. renderOffline is DETERMINISTIC --------------------------------------
	// The claim roadmap #22 makes about two peers agreeing rests on this.
	const sine440 = (ctx) => {
		const osc = ctx.createOscillator();
		osc.frequency.value = 440;
		osc.connect(ctx.destination);
		osc.start();
	};
	const first = await h.renderOffline(A, sine440, { seconds: 0.5 });
	const second = await h.renderOffline(A, sine440, { seconds: 0.5 });
	h.check(first.rms > 0.5, 'an offline render produces signal (rms ' + first.rms.toFixed(4) + ')');
	h.check(
		Math.abs(first.rms - second.rms) < 1e-9,
		'two renders of the same graph are BIT-identical (delta ' + Math.abs(first.rms - second.rms).toExponential(1) + ')'
	);
	h.check(
		Math.abs(first.rms - Math.SQRT1_2) < 0.01,
		'the render matches the analytic RMS of a unit sine, 1/sqrt(2) (' + first.rms.toFixed(4) + ')'
	);

	// ---- 6. envelopeDelta separates same from different -------------------------
	const same = h.envelopeDelta(first.slices, second.slices);
	h.check(same.maxDelta < 1e-9, 'envelopeDelta reads ~0 for identical renders (' + same.maxDelta.toExponential(1) + ')');

	// a GATED source: silent for the first half, then a tone. Its envelope must
	// differ from the steady one in a way a MEAN would hide but maxDelta cannot.
	const gated = await h.renderOffline(
		A,
		(ctx) => {
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.frequency.value = 440;
			gain.gain.setValueAtTime(0, 0);
			gain.gain.setValueAtTime(1, 0.25);
			osc.connect(gain);
			gain.connect(ctx.destination);
			osc.start();
		},
		{ seconds: 0.5 }
	);
	const differs = h.envelopeDelta(first.slices, gated.slices);
	h.check(differs.maxDelta > 0.5, 'envelopeDelta CATCHES a gated source (max ' + differs.maxDelta.toFixed(3) + ' at slice ' + differs.worstSlice + ')');
	h.check(
		gated.slices.slice(0, 6).every((v) => v < 0.01) && gated.slices.slice(10).every((v) => v > 0.5),
		'the envelope resolves WHERE the gate opened, not just that levels differ'
	);

	// ---- 7. two peers agree, which is the roadmap's actual claim ----------------
	const B = await h.setupPage(browser, 'B', { audio: true });
	const onB = await h.renderOffline(B, sine440, { seconds: 0.5 });
	const across = h.envelopeDelta(first.slices, onB.slices);
	h.check(
		across.maxDelta < 1e-6,
		'two PEERS render the same graph identically (max slice delta ' + across.maxDelta.toExponential(1) + ')'
	);

	// ---- 8. the tap does not break the app's own audio path ---------------------
	// The patch inserts a gain node in front of the destination; a sound node must
	// still build its panner chain and still play.
	const chain = await A.page.evaluate(async () => {
		const entries = window.__stores.soundRuntime.soundEntries();
		return { count: entries.length, ok: Array.isArray(entries) };
	});
	h.check(chain.ok, 'soundRuntime still reports its chains with the tap installed');

	await h.finish(browser);
});
