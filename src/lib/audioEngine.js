// The audio ENGINE (roadmap #22 A1, cloud plans-core/pending/22-a-audio-engine.md).
//
// A deliberate LEAF: it imports nothing of ours, so `peerHandler` / `sessions` /
// `autosave` can all reach it and so its maths is testable with no GL context and
// no scene. That is the `scenePost` rule, and it is what keeps the whole audio
// stack out of the TDZ cycle family around `history`.
//
// WHY THIS MODULE EXISTS. Before it, three things were true and each of them
// blocked the music playground:
//   1. the one AudioContext was owned by `voiceChat.js`, so the entire audio
//      architecture hung off the voice-chat feature and its settings gates;
//   2. every source connected straight to `ctx.destination` — sound nodes, scene
//      music, ping chimes and voices alike — so there was no master bus, no
//      submix and no limiter, which means A MIXER HAD NOTHING TO PLUG INTO;
//   3. the only AudioListener updater lived behind the `spatialVoice` gate, so a
//      user who turned spatial VOICE off froze the listener and silently broke
//      positional audio for everything else too.
//
// `voiceChat.ensureAudioContext` is kept as a thin re-export, so every existing
// caller of it is byte-unchanged and the diff stays reviewable.

// ---- the context -------------------------------------------------------------

/** @type {AudioContext|null} */
let context = null;
/** @type {GainNode|null} */
let masterGain = null;
/** @type {DynamicsCompressorNode|null} */
let limiter = null;
/** @type {Record<string, GainNode>} */
const buses = {};

/** The bus names the app ships with. A device asking for anything else lands on
 * `instruments` rather than erroring — an unknown bus is a routing decision, not
 * a failure (the `postBackends` fallback rule, one domain over). */
export const BUS_NAMES = ['music', 'sfx', 'voice', 'instruments'];

/**
 * The one shared AudioContext, created on first use.
 *
 * Everything in the app must go through this: a second context has its own
 * listener and its own clock, so anything in it is unspatialised relative to the
 * camera and unmixable with everything else.
 * @returns {AudioContext}
 */
export function ensureAudioContext() {
	context ??= new (window.AudioContext || /** @type {any} */ (window).webkitAudioContext)();
	buildBuses();
	return /** @type {AudioContext} */ (context);
}

/** Build master + limiter + the named buses, once. */
function buildBuses() {
	const ctx = /** @type {AudioContext} */ (context);
	if (masterGain) return;
	masterGain = ctx.createGain();
	masterGain.gain.value = 1;
	// A limiter matters more than it looks: the moment several instruments run at
	// once an un-limited master clips, and clipping sounds like the instruments
	// are broken rather than like the mix is too hot.
	limiter = ctx.createDynamicsCompressor();
	limiter.threshold.value = -6;
	limiter.knee.value = 6;
	limiter.ratio.value = 12;
	limiter.attack.value = 0.003;
	limiter.release.value = 0.25;
	masterGain.connect(limiter);
	limiter.connect(ctx.destination);
	// a suspended-then-resumed context moves currentTime differently from the wall
	// clock, so the clock filter below starts over rather than trusting stale pairs
	ctx.addEventListener?.('statechange', () => {
		clockPairs.length = 0;
		primeAudioClock();
	});
	primeAudioClock();
	// the engine's own sampler: one cheap read per 25 ms for the life of the context,
	// so the clock filter is warm for whoever asks first (see the clock section)
	if (typeof setInterval !== 'undefined') setInterval(sampleAudioClock, 25);
	for (const name of BUS_NAMES) {
		const gain = ctx.createGain();
		gain.gain.value = 1;
		gain.connect(masterGain);
		buses[name] = gain;
	}
}

/**
 * A named sub-bus to connect a source to, instead of `ctx.destination`.
 * @param {string} [name] @returns {GainNode}
 */
export function bus(name = 'instruments') {
	ensureAudioContext();
	return buses[name] ?? buses.instruments;
}

/** The master gain, for a global volume or a meter tap. @returns {GainNode} */
export function master() {
	ensureAudioContext();
	return /** @type {GainNode} */ (masterGain);
}

/** Resume a context the autoplay policy left suspended. Safe to call often. */
export function resumeAudio() {
	if (context && context.state === 'suspended') context.resume().catch(() => {});
}

// ---- the clock ---------------------------------------------------------------
//
// `ctx.currentTime` is NOT a continuous clock as seen from the main thread. MEASURED
// 2026-09-03 (headless Chromium, 48 kHz): it advances in steps of 10.67 ms — 512
// frames, the device callback, `baseLatency` exactly — never per 128-frame quantum,
// so `currentTime - performance.now()/1000` is a sawtooth 12 ms tall
// (`getOutputTimestamp()` is the same shape, 7 ms tall). A2's first scheduler
// build mapped each beat through a single raw read and consecutive beats landed up
// to 5.3 ms apart from where they belonged — audible jitter on a drum machine.
//
// The filter: keep the last CLOCK_WINDOW_MS of (performance.now, offset) pairs and
// take the MAXIMUM. The offset is highest the instant after currentTime steps —
// that is the one moment the two clocks are read "fresh" — and decays until the
// next step, so the max over a window that sees several steps is the true
// correspondence to within the sampling phase. (A dense 1 ms dump over three runs
// showed the per-100 ms peak stable within +-0.7 ms and no spikes, so the max is
// unbiased and a percentile would only add a bias and an order-statistic wobble.)
//
// THE WINDOW MUST BE WARM BEFORE ANYONE ASKS, which is why the engine runs its OWN
// 25 ms sampler from the moment the context exists (25 mod 10.67 walks the phase;
// a 1 ms burst primes it on creation and on resume). The first build sampled only
// from the scheduler's ticks, so the first mapping after a quiet spell went through
// a window holding ONE stale sample at a random phase — beat 0 landed anywhere from
// 0 to 10.67 ms off beat 1, and the suite read 3.5 / 8.9 / 3.3 / 6.8 / 4.7 ms across
// five runs. Warm, the same check reads under 1.5 ms. 2 s is long enough to hold
// ~80 phases and far too short for two crystal oscillators to drift apart (ppm).

const CLOCK_WINDOW_MS = 2000;
/** @type {{t: number, off: number}[]} */
const clockPairs = [];

/**
 * Take one (performance.now, currentTime) pair into the clock filter. Cheap; the
 * scheduler calls it every tick, and `audioTimeFor` calls it on every use. Returns
 * the performance.now() it read.
 */
export function sampleAudioClock() {
	const ctx = ensureAudioContext();
	const t = performance.now();
	clockPairs.push({ t, off: ctx.currentTime - t / 1000 });
	while (clockPairs.length && clockPairs[0].t < t - CLOCK_WINDOW_MS) clockPairs.shift();
	return t;
}

/**
 * Fill the window FAST: one sample per millisecond for a little over one device
 * callback, so the max is within ~1 ms of the true correspondence before anything
 * is scheduled. Without this the first mapping after the context is created goes
 * through a one-sample window at a random phase — measured: beat 0 landed up to
 * 5.3 ms off beat 1 on a cold filter, and fine once the ticks had filled it.
 * Called on context creation, on resume, and when the scheduler starts.
 */
export function primeAudioClock() {
	if (typeof setTimeout === 'undefined') return;
	for (let i = 0; i < 14; i++) setTimeout(sampleAudioClock, i);
}

/** The filtered audio-minus-performance offset, in seconds. */
function audioClockOffset() {
	sampleAudioClock();
	let best = -Infinity;
	for (const pair of clockPairs) if (pair.off > best) best = pair.off;
	return best;
}

/**
 * Map a WALL-CLOCK stamp (a `Date.now()` value, which is what every replicated
 * message carries) onto this context's `currentTime`, so a "play at beat 4"
 * message can become an `osc.start(t)`.
 *
 * Through the clock filter above, so two stamps a beat apart map to audio times a
 * beat apart to within a render quantum. NOT a long-lived cached offset —
 * that would drift, the two clocks being different oscillators — but a 2 s
 * window over which drift is nil and the device-callback sawtooth averages out.
 *
 * A stamp already in the past returns a time already gone, which WebAudio treats
 * as "start now"; that is the correct behaviour for a late-arriving note.
 * @param {number} wallMs @returns {number}
 */
export function audioTimeFor(wallMs) {
	const off = audioClockOffset();
	return off + (performance.now() + (wallMs - Date.now())) / 1000;
}

/** This context's own clock. @returns {number} */
export function audioNow() {
	return ensureAudioContext().currentTime;
}

// ---- the listener ------------------------------------------------------------

let lastListenerUpdate = 0;

/**
 * Aim the AudioListener at the camera. Called every frame from the scene and
 * throttled to ~10/s, which is plenty for a head that moves at human speeds.
 *
 * NOT gated on `spatialVoice`. That store gates whether VOICES are positional and
 * always did; it used to gate the only listener updater in the app as a side
 * effect, so switching it off froze the listener and every positioned sound —
 * sound nodes, ping chimes, a module's `api.playSound` — panned from wherever the
 * camera happened to be at the time. Measured before the fix: 0.00 movement
 * across a 33-unit camera flight, finishing 35.3 units from the camera.
 *
 * Reads `camera.matrixWorld.elements` by column rather than using three helpers,
 * which keeps this module three-free AND follows the headset for free: WebXR
 * writes the HMD pose into that same matrix.
 * @param {any} camera
 */
export function updateListener(camera) {
	if (!context || !camera) return;
	const now = performance.now();
	if (now - lastListenerUpdate < 100) return;
	lastListenerUpdate = now;
	const world = camera.matrixWorld?.elements;
	if (!world) return;
	const listener = context.listener;
	const px = world[12], py = world[13], pz = world[14];
	const fx = -world[8], fy = -world[9], fz = -world[10]; // -Z column = forward
	const ux = world[4], uy = world[5], uz = world[6];
	if (listener.positionX) {
		listener.positionX.value = px;
		listener.positionY.value = py;
		listener.positionZ.value = pz;
		listener.forwardX.value = fx;
		listener.forwardY.value = fy;
		listener.forwardZ.value = fz;
		listener.upX.value = ux;
		listener.upY.value = uy;
		listener.upZ.value = uz;
	} else {
		listener.setPosition(px, py, pz);
		listener.setOrientation(fx, fy, fz, ux, uy, uz);
	}
}

// ---- voices ------------------------------------------------------------------
//
// Generalised out of `pingAudio.tone()`, which was one oscillator plus an
// exponential envelope. A voice is an OBJECT rather than a map entry, which is
// what makes polyphony a list instead of a rewrite.

/**
 * @typedef {object} Voice
 * @property {AudioNode} output      connect this where you want it heard
 * @property {(t?: number) => void} start   note-on at an audio-clock time
 * @property {(t?: number) => void} stop    note-off; release runs from here
 * @property {() => void} dispose
 */

/** Exponential ramps cannot reach 0, so silence is this instead. */
const FLOOR = 0.0001;

/**
 * An oscillator voice with an ADSR and an optional filter.
 *
 * @param {object} [opts]
 * @param {OscillatorType} [opts.type]
 * @param {number} [opts.freq]
 * @param {number} [opts.detune]
 * @param {number} [opts.gain] peak level after the attack
 * @param {number} [opts.attack] @param {number} [opts.decay]
 * @param {number} [opts.sustain] fraction of `gain` held until stop()
 * @param {number} [opts.release]
 * @param {{type?: BiquadFilterType, freq?: number, q?: number}|null} [opts.filter]
 * @param {AudioNode|string|null} [opts.destination] a node, a bus NAME, or null for the default bus
 * @returns {Voice}
 */
export function oscVoice(opts = {}) {
	const ctx = ensureAudioContext();
	const {
		type = 'sine',
		freq = 440,
		detune = 0,
		gain = 0.3,
		attack = 0.01,
		decay = 0.08,
		sustain = 0.7,
		release = 0.2,
		filter = null,
		destination = null
	} = opts;
	const osc = ctx.createOscillator();
	osc.type = type;
	osc.frequency.value = freq;
	osc.detune.value = detune;
	const amp = ctx.createGain();
	amp.gain.value = FLOOR;
	/** @type {AudioNode} */
	let tail = osc;
	/** @type {BiquadFilterNode|null} */
	let biquad = null;
	if (filter) {
		biquad = ctx.createBiquadFilter();
		biquad.type = filter.type ?? 'lowpass';
		biquad.frequency.value = filter.freq ?? 1200;
		biquad.Q.value = filter.q ?? 1;
		osc.connect(biquad);
		tail = biquad;
	}
	tail.connect(amp);
	amp.connect(resolveDestination(destination));
	let started = false;
	let stopped = false;
	return {
		output: amp,
		start(t) {
			if (started) return;
			started = true;
			const at = t ?? ctx.currentTime;
			amp.gain.cancelScheduledValues(at);
			amp.gain.setValueAtTime(FLOOR, at);
			amp.gain.exponentialRampToValueAtTime(Math.max(gain, FLOOR), at + attack);
			amp.gain.exponentialRampToValueAtTime(
				Math.max(gain * sustain, FLOOR),
				at + attack + decay
			);
			osc.start(at);
		},
		stop(t) {
			if (!started || stopped) return;
			stopped = true;
			const at = t ?? ctx.currentTime;
			amp.gain.cancelScheduledValues(at);
			// hold whatever the envelope had reached, then release from there —
			// setValueAtTime(current) first, or the ramp starts from the last
			// SCHEDULED value and jumps
			amp.gain.setValueAtTime(Math.max(amp.gain.value, FLOOR), at);
			amp.gain.exponentialRampToValueAtTime(FLOOR, at + release);
			osc.stop(at + release + 0.02);
		},
		dispose() {
			try {
				osc.stop();
			} catch {
				/* never started */
			}
			osc.disconnect();
			biquad?.disconnect();
			amp.disconnect();
		}
	};
}

/**
 * A sample voice over an already-decoded buffer.
 *
 * `offset` exists so a looping sample can be started IN PHASE from the shared
 * clock — the trick `soundRuntime` already uses to keep peers hearing the same
 * moment of a loop without streaming a byte.
 *
 * @param {object} opts
 * @param {AudioBuffer} opts.buffer
 * @param {number} [opts.rate] @param {number} [opts.offset]
 * @param {boolean} [opts.loop] @param {number} [opts.gain]
 * @param {AudioNode|string|null} [opts.destination]
 * @returns {Voice}
 */
export function sampleVoice(opts) {
	const ctx = ensureAudioContext();
	const { buffer, rate = 1, offset = 0, loop = false, gain = 1, destination = null } = opts;
	const source = ctx.createBufferSource();
	source.buffer = buffer;
	source.playbackRate.value = rate;
	source.loop = loop;
	const amp = ctx.createGain();
	amp.gain.value = gain;
	source.connect(amp);
	amp.connect(resolveDestination(destination));
	let started = false;
	return {
		output: amp,
		start(t) {
			if (started) return;
			started = true;
			source.start(t ?? ctx.currentTime, buffer ? offset % buffer.duration : 0);
		},
		stop(t) {
			if (!started) return;
			try {
				source.stop(t ?? ctx.currentTime);
			} catch {
				/* already stopped */
			}
		},
		dispose() {
			try {
				source.stop();
			} catch {
				/* never started */
			}
			source.disconnect();
			amp.disconnect();
		}
	};
}

/** @param {AudioNode|string|null|undefined} destination @returns {AudioNode} */
function resolveDestination(destination) {
	if (!destination) return bus('instruments');
	return typeof destination === 'string' ? bus(destination) : destination;
}

/**
 * Decode a blob just far enough to describe it — duration and channel count for a
 * file-details line. Uses the SHARED context, so the two call sites that each used
 * to spin up a throwaway AudioContext for this now create none at all.
 * @param {Blob} blob @returns {Promise<{duration:number, channels:number}>}
 */
export async function decodeMeta(blob) {
	const decoded = await ensureAudioContext().decodeAudioData(await blob.arrayBuffer());
	return { duration: decoded.duration, channels: decoded.numberOfChannels };
}

// ---- debug -------------------------------------------------------------------

/**
 * What the engine currently holds — the `soundEntries()` / `spatialDebug()`
 * precedent, for `window.__stores` and the e2e suites.
 */
export function graphDebug() {
	if (!context) return { created: false, state: 'none', buses: [], sampleRate: 0 };
	return {
		created: true,
		state: context.state,
		sampleRate: context.sampleRate,
		currentTime: context.currentTime,
		buses: BUS_NAMES.map((name) => ({ name, gain: buses[name]?.gain.value ?? null })),
		masterGain: masterGain?.gain.value ?? null,
		limiterReduction: limiter?.reduction ?? null,
		listener: context.listener?.positionX
			? {
					x: context.listener.positionX.value,
					y: context.listener.positionY.value,
					z: context.listener.positionZ.value
				}
			: null
	};
}
