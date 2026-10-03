// 34 PF (profiler-xr) — boot for the live perf stream: both halves behind the routing seam
// peerHandler calls (`perf/liveWire.js`). Requests addressed to us as a SOURCE (watch, unwatch,
// detail) go to liveSource; everything a source sends goes to liveSink.
import { registerPerfLive } from './liveWire.js';
import { sourceMessage, sourcePeerGone, startLiveSource } from './liveSource.js';
import { sinkMessage, sinkPeerGone } from './liveSink.js';

const SOURCE_OPS = new Set(['watch', 'unwatch', 'detail']);

let started = false;
export function startPerfLive() {
	if (started) return;
	started = true;
	startLiveSource();
	registerPerfLive({
		message: (peerId, data) => (SOURCE_OPS.has(data.op) ? sourceMessage(peerId, data) : sinkMessage(peerId, data)),
		gone: (peerId) => {
			sourcePeerGone(peerId);
			sinkPeerGone(peerId);
		}
	});
}
