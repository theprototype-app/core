// 102b-sound (row 2) — THE FRAME-EXACT EXPORT'S SOUND, rendered offline (exportAudioCore.js says where each
// sound lands). Loaded LAZILY by offlineRender.js when an MP4 / WebM export with "Scene sound" starts.
//
// The mix is the live one's shape: the clips on the sfx bus, the music on the music bus, each at its
// bus level here, through a copy of the master limiter. Rendered in an OfflineAudioContext as fast as
// the machine can, before the first frame; the frames are then rendered against it.
import { get } from 'svelte/store';
import { planTimelineAudio, planMusicBed } from './exportAudioCore.js';
import { sessionNow } from '../sessionClock';

export const EXPORT_SAMPLE_RATE = 48000;

/**
 * The take's sound as planar PCM, or null when nothing in it makes a sound (then the file is silent,
 * exactly as before this lane).
 * @param {{mode: string, seq: any, ranges?: number[][] | null, seconds: number}} o
 * @returns {Promise<{sampleRate: number, channels: Float32Array[], sounds: number} | null>}
 */
export async function renderExportAudio(o) {
	const placed = o.mode === 'timeline' && o.seq ? planTimelineAudio(o.seq, o.seconds, o.ranges) : [];
	const [sm, ae, sr] = await Promise.all([import('../sceneMusic'), import('../audioEngine'), import('../soundRuntime')]);
	const state = get(sm.music);
	const musicGain = (state.volume ?? 0.8) * (get(sm.musicMuted) ? 0 : (get(sm.musicLocalVolume) ?? 1)) * ae.busLevel('music');
	const wantsMusic = !!(state.hash && state.playing && musicGain > 0);
	if (!placed.length && !wantsMusic) return null;

	/** @type {Map<string, AudioBuffer | null>} */
	const buffers = new Map();
	const hashes = new Set(placed.map((p) => p.sound));
	if (wantsMusic) hashes.add(/** @type {string} */ (state.hash));
	await Promise.all(
		[...hashes].map(async (hash) => {
			try {
				buffers.set(hash, await sr.sampleBuffer(hash, { timeoutMs: 10000 }));
			} catch {
				buffers.set(hash, null);
			}
		})
	);
	const edit = await soundEditor();

	const Offline = /** @type {any} */ (globalThis).OfflineAudioContext || /** @type {any} */ (globalThis).webkitOfflineAudioContext;
	if (!Offline) return null;
	const length = Math.max(1, Math.ceil(o.seconds * EXPORT_SAMPLE_RATE));
	/** @type {OfflineAudioContext} */
	const ctx = new Offline(2, length, EXPORT_SAMPLE_RATE);
	const limiter = ctx.createDynamicsCompressor();
	limiter.threshold.value = -6;
	limiter.knee.value = 6;
	limiter.ratio.value = 12;
	limiter.attack.value = 0.003;
	limiter.release.value = 0.25;
	limiter.connect(ctx.destination);
	const sfx = ctx.createGain();
	sfx.gain.value = ae.busLevel('sfx');
	sfx.connect(limiter);
	const musicBus = ctx.createGain();
	musicBus.gain.value = 1; // musicGain already holds the bus level
	musicBus.connect(limiter);

	let sounds = 0;
	for (const p of placed) {
		const raw = buffers.get(p.sound);
		if (!raw) continue;
		const buffer = edit ? edit(p.sound, raw, ctx) : raw;
		if (p.offset >= buffer.duration) continue;
		const src = ctx.createBufferSource();
		src.buffer = buffer;
		const g = ctx.createGain();
		g.gain.value = p.gain;
		src.connect(g).connect(sfx);
		src.start(p.at, p.offset, Math.min(p.dur, buffer.duration - p.offset));
		sounds++;
	}
	if (wantsMusic) {
		const raw = buffers.get(/** @type {string} */ (state.hash));
		if (raw) {
			const buffer = edit ? edit(/** @type {string} */ (state.hash), raw, ctx) : raw;
			const bed = planMusicBed(state, musicGain, sessionNow(), buffer.duration);
			if (bed) {
				const src = ctx.createBufferSource();
				src.buffer = buffer;
				src.loop = true;
				const g = ctx.createGain();
				g.gain.value = bed.gain;
				src.connect(g).connect(musicBus);
				src.start(0, bed.offset);
				sounds++;
			}
		}
	}
	if (!sounds) return null;
	const out = await ctx.startRendering();
	return { sampleRate: out.sampleRate, channels: [new Float32Array(out.getChannelData(0)), new Float32Array(out.getChannelData(1))], sounds };
}

/**
 * 102b-sound row 3: a sound's trim / fade / normalise, the same edit the scene plays it with.
 * @returns {Promise<((hash: string, buffer: AudioBuffer, ctx: BaseAudioContext) => AudioBuffer) | null>}
 */
async function soundEditor() {
	return (await (await import('../soundEdits')).soundEditDsp()).editedBuffer;
}
