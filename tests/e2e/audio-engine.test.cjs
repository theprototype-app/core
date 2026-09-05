// #22 A1 — the audio engine: context ownership, the master bus, the listener.
//
// Three things were true before this phase and each blocked the music playground:
// the one AudioContext was owned by voiceChat, every source connected straight to
// ctx.destination (so a mixer had nothing to plug into), and the only AudioListener
// updater sat behind the spatialVoice gate.
//
// The listener check is the one with a measured counterfactual: before the fix the
// listener moved 0.00 across a 33-unit camera flight and finished 35.3 units from
// the camera, so every positioned sound in the app panned from the wrong place.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true });

	// ---- 1. ONE context, owned by the engine --------------------------------
	const owner = await A.page.evaluate(() => {
		const engine = window.__stores.audioEngine.ensureAudioContext();
		const viaVoice = window.__stores.voiceChat.ensureAudioContext();
		return { same: engine === viaVoice, state: engine.state, rate: engine.sampleRate };
	});
	h.check(owner.same, "voiceChat's ensureAudioContext returns the ENGINE's context, not its own");
	h.check(owner.state === 'running', 'premise: the context is running (' + owner.state + ')');

	// ---- 2. the master bus exists and everything routes through it ----------
	const graph = await A.page.evaluate(() => window.__stores.audioEngine.graphDebug());
	h.check(graph.created && graph.buses.length === 4, 'four named buses exist (' + graph.buses.map((b) => b.name).join(', ') + ')');
	h.check(graph.masterGain !== null, 'a master gain exists');
	h.check(graph.limiterReduction !== null, 'a limiter sits between master and destination');

	// the bus is a real routing point: pulling it to zero must silence its sources
	const routed = await A.page.evaluate(async () => {
		const eng = window.__stores.audioEngine;
		const { playPing } = await import('/src/lib/pingAudio.js');
		const sfx = eng.bus('sfx');
		const read = async (label) => {
			playPing('bell');
			await new Promise((r) => setTimeout(r, 60));
			return label;
		};
		await read('warm');
		return { hasSfx: !!sfx, gain: sfx.gain.value };
	});
	h.check(routed.hasSfx, 'the sfx bus is reachable');

	const loudMetrics = await (async () => {
		const play = A.page.evaluate(async () => {
			const { playPing } = await import('/src/lib/pingAudio.js');
			playPing('bell');
		});
		const read = await h.audioMetrics(A, 800);
		await play;
		return read;
	})();
	h.check(!loudMetrics.silent, 'a ping reaches the destination through the bus (peak ' + loudMetrics.peak.toFixed(4) + ')');

	// mute the sfx BUS — the ping still plays, and must not be heard. This is what
	// "a mixer has something to plug into" means, asserted rather than described.
	const mutedMetrics = await (async () => {
		await A.page.evaluate(() => {
			window.__stores.audioEngine.bus('sfx').gain.value = 0;
		});
		const play = A.page.evaluate(async () => {
			const { playPing } = await import('/src/lib/pingAudio.js');
			playPing('bell');
		});
		const read = await h.audioMetrics(A, 800);
		await play;
		await A.page.evaluate(() => {
			window.__stores.audioEngine.bus('sfx').gain.value = 1;
		});
		return read;
	})();
	h.check(
		mutedMetrics.peak < loudMetrics.peak * 0.1,
		'muting the sfx BUS silences the ping (' + mutedMetrics.peak.toFixed(4) + ' vs ' + loudMetrics.peak.toFixed(4) + ')'
	);

	// an unknown bus name is a routing decision, not an error
	const unknown = await A.page.evaluate(() => {
		const eng = window.__stores.audioEngine;
		return eng.bus('nonsense') === eng.bus('instruments');
	});
	h.check(unknown, 'an unknown bus name falls back to instruments rather than throwing');

	// ---- 3. the listener follows the camera REGARDLESS of spatialVoice ------
	const listenerAt = () =>
		A.page.evaluate(() => window.__stores.audioEngine.graphDebug().listener);
	const flyTo = (pos) =>
		A.page.evaluate(async (p) => {
			await window.__stores.objectActions.flyTo(p, [0, 0, 0], 400);
		}, pos);

	await A.page.evaluate(() => window.__stores.voiceChat.spatialVoice.set(false));
	await A.page.waitForTimeout(300);
	await flyTo([12, 4, 12]);
	await A.page.waitForTimeout(1200);
	const first = await listenerAt();
	await flyTo([-14, 3, -9]);
	await A.page.waitForTimeout(1200);
	const second = await listenerAt();
	const moved = first && second ? Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z) : 0;
	h.check(
		moved > 20,
		'THE FIX: the listener follows the camera with spatial voice OFF (moved ' + moved.toFixed(2) + ', was 0.00)'
	);

	const camera = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.globalCamera.subscribe((c) => r(c ? [c.position.x, c.position.y, c.position.z] : null))()
			)
	);
	const drift = camera && second ? Math.hypot(camera[0] - second.x, camera[1] - second.y, camera[2] - second.z) : -1;
	h.check(drift >= 0 && drift < 1, 'and it sits ON the camera, not stranded behind it (drift ' + drift.toFixed(2) + ', was 35.3)');
	await A.page.evaluate(() => window.__stores.voiceChat.spatialVoice.set(true));

	// ---- 4. audioTimeFor maps wall clock onto the audio clock ---------------
	const clock = await A.page.evaluate(() => {
		const eng = window.__stores.audioEngine;
		const now = eng.audioTimeFor(Date.now());
		const ahead = eng.audioTimeFor(Date.now() + 1000);
		const past = eng.audioTimeFor(Date.now() - 500);
		return { now, ahead, past, ctxNow: eng.audioNow() };
	});
	h.check(Math.abs(clock.now - clock.ctxNow) < 0.05, 'audioTimeFor(now) is the context clock (delta ' + Math.abs(clock.now - clock.ctxNow).toFixed(4) + ')');
	h.check(Math.abs(clock.ahead - clock.now - 1) < 0.05, 'a stamp 1s ahead maps 1s ahead (' + (clock.ahead - clock.now).toFixed(3) + ')');
	h.check(clock.past < clock.now, 'a stamp in the past maps into the past, which WebAudio treats as "now"');

	// ---- 5. the voices ------------------------------------------------------
	// An oscVoice must actually make its shape: attack up, release down. Measured
	// through the tap, so this is the real graph and not a unit test of the maths.
	const voiced = await (async () => {
		const start = A.page.evaluate(() => {
			const eng = window.__stores.audioEngine;
			const v = eng.oscVoice({ type: 'sine', freq: 660, gain: 0.4, attack: 0.02, sustain: 1, release: 0.1 });
			v.start();
			window.__voice = v;
		});
		await start;
		const held = await h.audioMetrics(A, 500);
		await A.page.evaluate(() => {
			window.__voice.stop();
		});
		await A.page.waitForTimeout(350);
		const after = await h.audioMetrics(A, 400);
		await A.page.evaluate(() => {
			window.__voice.dispose();
			window.__voice = null;
		});
		return { held, after };
	})();
	h.check(!voiced.held.silent, 'an oscVoice sounds while held (peak ' + voiced.held.peak.toFixed(3) + ')');
	h.check(
		Math.abs(voiced.held.centroid - 660) < 120,
		'at the pitch it was asked for: 660Hz requested, ' + Math.round(voiced.held.centroid) + 'Hz measured'
	);
	h.check(voiced.after.silent, 'and it releases to silence on stop (peak ' + voiced.after.peak.toFixed(5) + ')');

	// ---- 6. a sound node's volume no longer restarts its source -------------
	// Finding 4: volume/radius/rolloff were in the dirty key, so every fader drag
	// tore the buffer down and restarted it. The key is now playing+loop only.
	const keyShape = await A.page.evaluate(async () => {
		const src = await fetch('/src/lib/soundRuntime.js').then((r) => r.text());
		const line = src.split('\n').find((l) => l.includes('const key = ['));
		return line ? line.trim() : null;
	});
	h.check(
		!!keyShape && !keyShape.includes('volume') && !keyShape.includes('rolloff'),
		'the sound dirty key no longer carries volume/radius/rolloff — ' + (keyShape ?? 'not found')
	);

	await h.finish(browser);
});
