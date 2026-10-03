// Module SDK — api.quality — the adaptive quality level (31-perf K4).
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { qualityState, xrQualityDebug } from '../qualityGovernor';
import { get } from 'svelte/store';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkQuality(ctx) {
	const { owned } = ctx;
	return {
		/**
		 * 31-perf K4: the ADAPTIVE QUALITY LEVEL on this device, so a module can cut its own
		 * effects/particles/draw distance when the frame rate cannot hold. `level` is 0 (best)
		 * … `max` (every step taken); a headset session starts at 1 (shadows off) in auto mode
		 * and a game's Quality setting can pin it. `labels` names the steps in force.
		 * `onChange(fn)` calls `fn(level, {max, labels, reason, vr})` on every level CHANGE and
		 * returns `off()` (also released when the module is disabled). LOCAL: a fact about this
		 * machine right now — never make it change shared state.
		 */
		quality: {
			get level() {
				return get(qualityState).level;
			},
			get max() {
				return get(qualityState).max;
			},
			get labels() {
				return get(qualityState).labels.slice();
			},
			get vr() {
				return xrQualityDebug().active;
			},
			/** @param {(level: number, info: {max: number, labels: string[], reason: string, vr: boolean}) => void} fn */
			onChange(fn) {
				let last = get(qualityState).level;
				const off = qualityState.subscribe((q) => {
					if (q.level === last) return;
					last = q.level;
					try {
						fn(q.level, { max: q.max, labels: q.labels.slice(), reason: q.reason, vr: xrQualityDebug().active });
					} catch (error) {
						console.log('module quality listener failed', error);
					}
				});
				return owned('quality.onChange', off);
			}
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkQuality.surface = {
	'quality.level': 'value',
	'quality.max': 'value',
	'quality.labels': 'value',
	'quality.vr': 'value',
	'quality.onChange': 'registers'
};
