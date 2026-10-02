// Module SDK — api.audio — voices, buses, samples, the transport, devices, cables, the mic.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { audioEngineRef, musicClockRef, audioDevicesRef, audioPatchRef, soundRuntimeRef } from './refs.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkAudio(ctx) {
	const { moduleId, scheduledCancels } = ctx;
	return {
		/**
		 * 23-A5: the audio engine, the musical clock and the patch, for a device's own
		 * code. Everything here is reached through primed dynamic imports and is a no-op
		 * (null / false) for the few frames before they resolve at boot.
		 */
		audio: {
			/** an engine voice: `sampleVoice` when `opts.buffer` is set, else `oscVoice` —
			 * `{output, start(at), stop(at), dispose()}`; connect `output` where you want
			 * it heard, or pass `destination` (a node or a bus name). @param {any} [opts] */
			voice: (opts = {}) => (opts.buffer ? audioEngineRef?.sampleVoice(opts) : audioEngineRef?.oscVoice(opts)) ?? null,
			/** a named bus (music / sfx / voice / instruments) to connect a source to,
			 * instead of `ctx.destination` @param {string} [name] */
			bus: (name = 'instruments') => audioEngineRef?.bus(name) ?? null,
			/** the shared AudioContext (create your nodes on THIS one, never `new AudioContext()`) */
			context: () => audioEngineRef?.ensureAudioContext() ?? null,
			/** a decoded AudioBuffer for an Explorer CONTENT HASH, pulled from a peer when
			 * missing; null after `timeoutMs` (default 30 s) if nobody has the bytes; rejects
			 * only when the bytes will not decode. @param {string} hash @param {{timeoutMs?: number}} [opts] */
			sample: (hash, opts) => (soundRuntimeRef ? soundRuntimeRef.sampleBuffer(hash, opts) : import('../soundRuntime').then((m) => m.sampleBuffer(hash, opts))),
			/** the audio-clock time of a wall-clock stamp (a replicated `at`) — hand it to
			 * `voice.start(t)` @param {number} wallMs */
			timeFor: (wallMs) => audioEngineRef?.audioTimeFor(wallMs) ?? 0,
			/**
			 * schedule through the look-ahead scheduler: `fn({beat, at, late, bpm, bar})` is
			 * called up to 100 ms EARLY with the exact audio time — start voices at `at`,
			 * never at call time. `opts.every` repeats every N beats. fn MUST be a pure
			 * function of its arguments (every peer runs it against the same transport).
			 * Returns a cancel; everything still scheduled is cancelled at teardown.
			 * @param {number} beat @param {(e: any) => void} fn @param {{every?: number, swing?: boolean}} [opts]
			 */
			schedule: (beat, fn, opts) => {
				if (!musicClockRef) return () => {};
				const cancel = musicClockRef.schedule(beat, fn, opts);
				scheduledCancels.add(cancel);
				return () => {
					scheduledCancels.delete(cancel);
					cancel();
				};
			},
			/** the transport now: `{bpm, beat, bar, step, phase, playing, loopBeats, swing}` */
			transport: () => musicClockRef?.transportNow() ?? { bpm: 120, beat: 0, bar: 0, step: 0, phase: 0, playing: false, loopBeats: 16, swing: 0 },
			/** press Play / Stop on the shared transport (replicated) @param {boolean} [playing] */
			play: (playing = true) => (playing ? musicClockRef?.playTransport() : musicClockRef?.stopTransport()),
			/** set the shared tempo (replicated; the beat you are on stays the beat you are on) @param {number} bpm */
			setBpm: (bpm) => musicClockRef?.setBpm(bpm),
			/** create a device object of a kind YOU registered (`'osc'` -> `mod-<you>-osc`),
			 * or of any full kind id; replicated, undoable @param {string} kind @param {any} [opts] */
			addDevice: (kind, opts) => audioDevicesRef?.addDevice(kind.startsWith('mod-') || audioDevicesRef.deviceSpec(kind) ? kind : `mod-${moduleId}-${kind}`, opts) ?? null,
			/** a device object's document `{kind, params}` or null @param {string} uuid */
			device: (uuid) => audioDevicesRef?.deviceOf(audioDevicesRef.findDeviceObject(uuid)) ?? null,
			/** write a device's params (merge; replicated; one undo step). After a run of
			 * previewParams the document ALREADY holds the values, so pass the document you
			 * captured at the start of the gesture (`api.audio.device(uuid)`) as `opts.before`:
			 * the entry records that as its undo state instead of skipping as a no-op.
			 * @param {string} uuid @param {Record<string, any>} params @param {{before?: any}} [opts] */
			setParams: (uuid, params, opts) => audioDevicesRef?.setDeviceFor(uuid, { params }, opts?.before ? { before: opts.before } : undefined) ?? null,
			/** 23-C4: a live-gesture PREVIEW of params - replicated, applied, NO history entry.
			 * Scrub with this (throttled), then commit once with setParams: the knob/toolbox
			 * pattern, and the only way a scrub is one undo step. @param {string} uuid @param {Record<string, any>} params */
			previewParams: (uuid, params) => audioDevicesRef?.previewDeviceParams?.(uuid, params, { broadcast: true }) ?? null,
			/** play a note on a device — locally through its onNote and to every peer as a
			 * stamped message @param {string} uuid @param {{note?: number, velocity?: number, at?: number}} [note] */
			note: (uuid, note) => audioDevicesRef?.noteDevice(uuid, note) ?? null,
			/** plug a cable between two device ports (replicated; one undo step); returns
			 * the cable id @param {{from: {uuid: string, port?: string}, to: {uuid: string, port?: string}, gain?: number}} spec */
			cable: (spec) => audioPatchRef?.addCable(spec) ?? null,
			/** unplug a cable @param {string} id */
			uncable: (id) => audioPatchRef?.removeCable(id),
			/** 23-D1: the RAW microphone as a MediaStream - a separate capture from voice chat
			 * (no echo cancellation / noise suppression / auto gain, and never gated by
			 * push-to-talk). Rejects when the browser refuses. @param {MediaTrackConstraints} [constraints] */
			captureMic: (constraints) => import('../micCapture').then((m) => m.captureMicStream(constraints)),
			/** record a take from the raw mic into the Explorer and share it by hash; resolves to
			 * the item, or null when refused BEFORE starting (over the visible cap, over the share
			 * limit, no recorder). `opts.stream` bounces THAT stream instead of the mic (a
			 * MediaStreamAudioDestinationNode's, for a looper). @param {{maxSeconds?: number, name?: string, stream?: MediaStream}} [opts] */
			record: (opts) => import('../micCapture').then((m) => m.startRecording(opts)),
			/** end the running take (the record() promise resolves with the item) */
			stopRecording: () => import('../micCapture').then((m) => m.stopRecording()),
			/** the recorder's state `{active, startedAt, maxSeconds, name}` as a store */
			recording: () => import('../micCapture').then((m) => m.recording)
		}
	};
}
