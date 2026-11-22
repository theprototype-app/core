// 102b-sound (row 1) — THE SCENE'S OWN SOUND, for a video. Loaded LAZILY (recorder.js, momentBuffer.js,
// offlineRender.js), so none of it is in the boot graph and audioEngine.js is unchanged.
//
// WHAT IS RECORDED: the engine's non-voice buses (music, sfx, instruments), each tapped AFTER its level,
// summed and run through a copy of the master limiter. The `voice` bus is never connected, and the
// microphone never reaches any bus, so other people's voices and your own mic cannot get into a file
// by construction. Previews (the audio player window, the Explorer) play through an <audio> element
// straight to the speakers: they are not the scene and are not recorded either.
//
// WHEN: only while the shared AudioContext already exists and runs. A scene that has never made a
// sound has no context, and a take of it stays silent, byte for byte the file it was before this lane.
//
// Two consumers:
//   openSceneAudioTrack()   a MediaStreamTrack for MediaRecorder (the live recorder's fallback path)
//   createSceneAudioRing()  a rolling PCM ring of the last seconds (the moment buffer), stamped on the
//                           performance clock the moment's frames use
import { ensureAudioContext, bus, graphDebug, resumeAudio, BUS_NAMES } from '../audioEngine';

/** the buses a recording hears (never `voice`) */
export const SCENE_BUSES = Object.freeze(BUS_NAMES.filter((b) => b !== 'voice'));

/** the shared context when it already exists (never creates one) @returns {AudioContext | null} */
export function sceneAudioContext() {
	const g = graphDebug();
	if (!g.created) return null;
	return ensureAudioContext();
}

/**
 * Is there scene sound to record right now? The context exists and runs (a suspended one is asked to
 * resume first: a take starts from a click, which the autoplay policy accepts).
 * @returns {Promise<AudioContext | null>}
 */
export async function runningSceneAudio() {
	const ctx = sceneAudioContext();
	if (!ctx) return null;
	if (ctx.state === 'suspended') {
		resumeAudio();
		// the resume promise is not awaited by resumeAudio; give it a moment
		for (let i = 0; i < 10 && /** @type {string} */ (ctx.state) === 'suspended'; i++) await new Promise((r) => setTimeout(r, 20));
	}
	return ctx.state === 'running' ? ctx : null;
}

/**
 * The scene mix as one node: every non-voice bus -> a sum -> a limiter (the master's settings). The
 * caller connects `output` where it wants it and calls `dispose` when done, which unhooks the buses
 * from this tap only (their other connections stay).
 * @param {AudioContext} ctx @returns {{output: AudioNode, dispose: () => void}}
 */
export function tapSceneMix(ctx) {
	const sum = ctx.createGain();
	sum.gain.value = 1;
	const limiter = ctx.createDynamicsCompressor();
	limiter.threshold.value = -6;
	limiter.knee.value = 6;
	limiter.ratio.value = 12;
	limiter.attack.value = 0.003;
	limiter.release.value = 0.25;
	sum.connect(limiter);
	const sources = SCENE_BUSES.map((name) => bus(name));
	for (const s of sources) s.connect(sum);
	let done = false;
	return {
		output: limiter,
		dispose() {
			if (done) return;
			done = true;
			for (const s of sources) {
				try {
					s.disconnect(sum);
				} catch {
					/* already gone */
				}
			}
			sum.disconnect();
			limiter.disconnect();
		}
	};
}

/**
 * A live audio track of the scene mix, for MediaRecorder. Null when there is no scene sound.
 * @returns {Promise<{track: MediaStreamTrack, dispose: () => void} | null>}
 */
export async function openSceneAudioTrack() {
	const ctx = await runningSceneAudio();
	if (!ctx || typeof ctx.createMediaStreamDestination !== 'function') return null;
	const tap = tapSceneMix(ctx);
	const dest = ctx.createMediaStreamDestination();
	dest.channelCount = 2;
	tap.output.connect(dest);
	const track = dest.stream.getAudioTracks()[0];
	if (!track) {
		tap.dispose();
		return null;
	}
	return {
		track,
		dispose() {
			try {
				track.stop();
			} catch {
				/* stopped */
			}
			tap.dispose();
			dest.disconnect();
		}
	};
}

/* ------------------------------------------------------------------ the ring ---- */

/** how much sound the ring keeps past the frame window (a slice must never come up short) */
const RING_SLACK_S = 2;
/** frames the ScriptProcessor fallback hands over at a time */
const SP_BLOCK = 2048;

/** @typedef {{t: number, l: Float32Array, r: Float32Array}} PcmChunk  `t` = performance seconds of its first frame */

/**
 * The context-time -> performance-seconds map. getOutputTimestamp says which context time is being
 * HEARD at which performance time, which is what a frame on screen is compared against; without it,
 * currentTime against now.
 * @param {AudioContext} ctx @returns {number} add this to a context time to get performance seconds
 */
export function audioToPerfOffset(ctx) {
	const ts = /** @type {any} */ (ctx).getOutputTimestamp?.();
	if (ts && ts.contextTime > 0 && ts.performanceTime > 0) return ts.performanceTime / 1000 - ts.contextTime;
	return performance.now() / 1000 - ctx.currentTime;
}

/**
 * Pure: the samples of [t0, t1) (performance seconds) out of time-stamped chunks, gaps as silence.
 * @param {PcmChunk[]} chunks in time order @param {number} rate @param {number} t0 @param {number} t1
 * @returns {{sampleRate: number, channels: Float32Array[], frames: number, filled: number}}
 *   `filled` = how many output frames came from a chunk (the rest is silence)
 */
export function slicePcm(chunks, rate, t0, t1) {
	const frames = Math.max(0, Math.round((t1 - t0) * rate));
	const l = new Float32Array(frames);
	const r = new Float32Array(frames);
	let filled = 0;
	for (const c of chunks) {
		const n = c.l.length;
		const start = Math.round((c.t - t0) * rate); // where this chunk's frame 0 lands in the output
		if (start >= frames || start + n <= 0) continue;
		const from = Math.max(0, -start);
		const to = Math.min(n, frames - start);
		l.set(c.l.subarray(from, to), start + from);
		r.set(c.r.subarray(from, to), start + from);
		filled += to - from;
	}
	return { sampleRate: rate, channels: [l, r], frames, filled: Math.min(filled, frames) };
}

/**
 * A rolling ring of the scene mix. `start()` resolves true once it listens (false: no scene sound or no
 * way to tap it); `stop()` unhooks it and keeps what it has; `clear()` forgets it.
 * @param {{seconds: number}} o
 */
export function createSceneAudioRing(o) {
	const keep = o.seconds + RING_SLACK_S;
	/** @type {PcmChunk[]} */
	let chunks = [];
	let rate = 48000;
	/** @type {null | {dispose: () => void}} */
	let live = null;
	let starting = false;
	/** context time -> performance seconds, refreshed every chunk and smoothed (it jitters by a block) */
	let offset = NaN;
	let blocks = 0;
	/** @type {'worklet' | 'script' | 'none'} */
	let path = 'none';
	let lastError = '';
	/** @type {Set<AudioContext>} */
	const workletReady = new Set();

	/** @param {AudioContext} ctx @param {number} frame @param {Float32Array} l @param {Float32Array} r */
	function onBlock(ctx, frame, l, r) {
		const off = audioToPerfOffset(ctx);
		// the offset is the same number every block, give or take a callback's jitter: average it in
		offset = Number.isFinite(offset) && Math.abs(off - offset) < 0.25 ? offset + (off - offset) * 0.05 : off;
		const t = frame / rate + offset;
		const last = chunks[chunks.length - 1];
		// blocks arrive in order; one that would overlap the last (a clock step) is moved to abut it
		const at = last && t < last.t + last.l.length / rate ? last.t + last.l.length / rate : t;
		chunks.push({ t: at, l, r });
		blocks++;
		const cutoff = at - keep;
		while (chunks.length && chunks[0].t + chunks[0].l.length / rate < cutoff) chunks.shift();
	}

	/** @param {AudioContext} ctx @param {AudioNode} input */
	async function attachWorklet(ctx, input) {
		if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return null;
		if (!workletReady.has(ctx)) {
			await ctx.audioWorklet.addModule(new URL('./sceneAudioTap.worklet.js', import.meta.url).href);
			workletReady.add(ctx);
		}
		const node = new AudioWorkletNode(ctx, 'tp-scene-audio-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit' });
		node.port.onmessage = (e) => {
			const d = e.data || {};
			if (d.l && d.r) onBlock(ctx, d.frame, d.l, d.r);
		};
		input.connect(node);
		// a node the destination does not pull is not processed: a silent gain keeps it in the graph
		const mute = ctx.createGain();
		mute.gain.value = 0;
		node.connect(mute).connect(ctx.destination);
		return {
			dispose() {
				node.port.onmessage = null;
				try {
					input.disconnect(node);
				} catch {
					/* gone */
				}
				node.disconnect();
				mute.disconnect();
			}
		};
	}

	/** @param {AudioContext} ctx @param {AudioNode} input */
	function attachScript(ctx, input) {
		if (typeof ctx.createScriptProcessor !== 'function') return null;
		const node = ctx.createScriptProcessor(SP_BLOCK, 2, 1);
		let frame = -1;
		node.onaudioprocess = (e) => {
			const b = e.inputBuffer;
			// playbackTime = when this block is heard; the frame count keeps the blocks contiguous
			if (frame < 0) frame = Math.round(e.playbackTime * rate);
			const l = new Float32Array(b.getChannelData(0));
			const r = new Float32Array(b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0));
			onBlock(ctx, frame, l, r);
			frame += b.length;
		};
		input.connect(node);
		const mute = ctx.createGain();
		mute.gain.value = 0;
		node.connect(mute).connect(ctx.destination);
		return {
			dispose() {
				node.onaudioprocess = null;
				try {
					input.disconnect(node);
				} catch {
					/* gone */
				}
				node.disconnect();
				mute.disconnect();
			}
		};
	}

	return {
		/** @returns {Promise<boolean>} */
		async start() {
			if (live) return true;
			if (starting) return false;
			const ctx = sceneAudioContext();
			if (!ctx || ctx.state !== 'running') return false;
			starting = true;
			try {
				rate = ctx.sampleRate;
				offset = NaN;
				const tap = tapSceneMix(ctx);
				/** @type {null | {dispose: () => void}} */
				let sink = null;
				try {
					sink = await attachWorklet(ctx, tap.output);
					if (sink) path = 'worklet';
				} catch (e) {
					lastError = String(/** @type {any} */ (e)?.message || e);
				}
				if (!sink) {
					sink = attachScript(ctx, tap.output);
					if (sink) path = 'script';
				}
				if (!sink) {
					tap.dispose();
					path = 'none';
					return false;
				}
				const s = sink;
				live = {
					dispose() {
						s.dispose();
						tap.dispose();
					}
				};
				return true;
			} finally {
				starting = false;
			}
		},
		stop() {
			live?.dispose();
			live = null;
		},
		clear() {
			chunks = [];
		},
		listening: () => !!live,
		/** has the ring any sound of [t0, t1)? */
		covers: (/** @type {number} */ t0, /** @type {number} */ t1) => chunks.some((c) => c.t < t1 && c.t + c.l.length / rate > t0),
		/** @param {number} t0 @param {number} t1 performance seconds */
		slice: (t0, t1) => slicePcm(chunks, rate, t0, t1),
		debug: () => ({ listening: !!live, path, rate, chunks: chunks.length, blocks, span: chunks.length ? chunks[chunks.length - 1].t + chunks[chunks.length - 1].l.length / rate - chunks[0].t : 0, offset, lastError })
	};
}

/* ----------------------------------------------------------------- analysis ---- */

/** peak and RMS of planar PCM (a suite's "is there sound in it") @param {Float32Array[]} channels */
export function pcmLevel(channels) {
	let peak = 0;
	let sum = 0;
	let n = 0;
	for (const ch of channels) {
		for (let i = 0; i < ch.length; i++) {
			const v = ch[i];
			const a = v < 0 ? -v : v;
			if (a > peak) peak = a;
			sum += v * v;
		}
		n += ch.length;
	}
	return { peak, rms: n ? Math.sqrt(sum / n) : 0 };
}
