import { get } from 'svelte/store';
import { ensureAudioContext, spatialVoice } from './voiceChat';

// Ping chimes (phase 87): a bundled set of synthesized sounds — no audio
// assets, deterministic on every client. With spatial voice on, the chime
// plays through a PannerNode at the ping position (same AudioContext and
// listener the voice pipeline updates each frame).

export const PING_SOUNDS = [
	{ id: 'ding', name: 'Ding' },
	{ id: 'chime', name: 'Chime' },
	{ id: 'pluck', name: 'Pluck' },
	{ id: 'pop', name: 'Pop' },
	{ id: 'bell', name: 'Bell' }
];

/** @param {any} ctx @param {any} dest @param {{freq: number, type?: any, t0: number, dur: number, peak?: number}} note */
function tone(ctx, dest, { freq, type = 'sine', t0, dur, peak = 0.22 }) {
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = type;
	osc.frequency.value = freq;
	gain.gain.setValueAtTime(0.0001, t0);
	gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
	gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
	osc.connect(gain).connect(dest);
	osc.start(t0);
	osc.stop(t0 + dur + 0.05);
}

/** Play a ping chime, spatialized when possible.
 * @param {string=} sound @param {number[] | null=} pos */
export function playPing(sound = 'ding', pos = null) {
	let ctx;
	try {
		ctx = ensureAudioContext();
	} catch {
		return;
	}
	if (ctx.state === 'suspended') ctx.resume().catch(() => {});
	let dest = ctx.destination;
	if (pos && get(spatialVoice)) {
		const panner = ctx.createPanner();
		panner.panningModel = 'HRTF';
		panner.distanceModel = 'inverse';
		panner.refDistance = 3;
		if (panner.positionX) {
			panner.positionX.value = pos[0];
			panner.positionY.value = pos[1];
			panner.positionZ.value = pos[2];
		} else panner.setPosition(pos[0], pos[1], pos[2]);
		panner.connect(ctx.destination);
		dest = panner;
	}
	const t = ctx.currentTime;
	switch (sound) {
		case 'chime':
			tone(ctx, dest, { freq: 880, t0: t, dur: 0.5 });
			tone(ctx, dest, { freq: 1318.5, t0: t + 0.12, dur: 0.6 });
			break;
		case 'pluck':
			tone(ctx, dest, { freq: 520, type: 'triangle', t0: t, dur: 0.25, peak: 0.3 });
			break;
		case 'pop':
			tone(ctx, dest, { freq: 300, type: 'square', t0: t, dur: 0.09, peak: 0.12 });
			break;
		case 'bell':
			tone(ctx, dest, { freq: 660, t0: t, dur: 0.9 });
			tone(ctx, dest, { freq: 1650, t0: t, dur: 0.5, peak: 0.07 });
			break;
		default:
			tone(ctx, dest, { freq: 987.8, t0: t, dur: 0.45 }); // ding
	}
}
