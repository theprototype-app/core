<script>
	// 34 PF (profiler-xr) — THE LIVE VIEW: a peer's frames (a headset, usually) drawn on this
	// desktop as they arrive. A MINIMAL viewer until the Profiler tab (34-profiler-ui) hosts the
	// stream: the room's peers with Watch / Detailed, live numbers, a frame-time and a draw-call
	// graph against the Quest budget lines, the latest detailed capture's heaviest objects, and
	// Save (the stream becomes one of this device's recordings).
	//
	// Presentation only: the stream, the document it builds and the bandwidth figure all live
	// in perf/liveSink.js.
	import { X, Activity } from '@lucide/svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { peers, userdata } from '../../stores/appStore';
	import { peerHands } from '../../stores/sceneStore';
	import { peerScenes, sameRoomOrUnknown } from '$lib/peerScenes';
	import { perfLive, profilerLiveOpen, watchPeer, unwatchPeer, requestCapture, saveLive, forgetPeer, liveDoc } from '$lib/perf/liveSink';
	import { LIGHT_BUDGET_BPS } from '$lib/perf/liveWire';

	/** the Quest budget lines (roadmap 34 PF): 72 Hz frame time and 150 draw calls */
	const MS_BUDGET = 13.9;
	const CALLS_BUDGET = 150;
	/** the graphs show the last GRAPH_MS of the stream */
	const GRAPH_MS = 10000;

	/** the room's other peers (a stream is for the room you are in) */
	const roomPeers = $derived.by(() => {
		void $peerScenes;
		/** @type {any} */
		const p = $peers;
		const opened = p?.openedPeers ? [...p.openedPeers] : [];
		return opened
			.filter((id) => sameRoomOrUnknown(id))
			.map((id) => {
				const row = ($userdata ?? []).find((/** @type {any[]} */ u) => u[0] === id);
				return { id, name: (row && row[1]) || id, vr: !!(/** @type {any} */ ($peerHands)?.[id]?.active) };
			});
	});
	const sessions = $derived(Object.values($perfLive.sessions));
	/** @type {Record<string, string>} peerId -> a status line after Save */
	let saved = $state({});

	/** @param {number | null | undefined} n */
	function num(n) {
		if (n == null || !Number.isFinite(n)) return '—';
		if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
		if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
		return n % 1 === 0 ? String(n) : n.toFixed(1);
	}

	/** @param {string} peerId */
	async function save(peerId) {
		const id = await saveLive(peerId);
		saved = { ...saved, [peerId]: id ? 'Saved to your recordings' : 'Nothing to save yet' };
	}

	/**
	 * Draw one series of the last GRAPH_MS against a budget line. Re-runs when the session's
	 * frame count moves (2x a second), never per frame.
	 * @param {HTMLCanvasElement} canvas
	 * @param {{peerId: string, key: 'ms' | 'calls', budget: number, frames: number}} arg
	 */
	function graph(canvas, arg) {
		const draw = (/** @type {typeof arg} */ a) => {
			const g = canvas.getContext('2d');
			if (!g) return;
			const W = canvas.width;
			const H = canvas.height;
			g.clearRect(0, 0, W, H);
			const doc = liveDoc(a.peerId);
			const frames = doc?.frames ?? [];
			if (!frames.length) return;
			const end = frames[frames.length - 1].t;
			const from = end - GRAPH_MS;
			let lo = frames.length - 1;
			while (lo > 0 && frames[lo - 1].t > from) lo--;
			let max = a.budget * 1.5;
			for (let i = lo; i < frames.length; i++) {
				const v = /** @type {number | null} */ (frames[i][a.key]);
				if (v != null && v > max) max = v;
			}
			const y = (/** @type {number} */ v) => H - (v / max) * (H - 2) - 1;
			g.strokeStyle = 'rgba(248, 113, 113, 0.8)';
			g.setLineDash([4, 3]);
			g.beginPath();
			g.moveTo(0, y(a.budget));
			g.lineTo(W, y(a.budget));
			g.stroke();
			g.setLineDash([]);
			g.strokeStyle = a.key === 'ms' ? '#60a5fa' : '#a7f3d0';
			g.lineWidth = 1;
			g.beginPath();
			let started = false;
			for (let i = lo; i < frames.length; i++) {
				const v = /** @type {number | null} */ (frames[i][a.key]);
				if (v == null) continue;
				const x = ((frames[i].t - from) / GRAPH_MS) * W;
				if (!started) g.moveTo(x, y(v));
				else g.lineTo(x, y(v));
				started = true;
			}
			g.stroke();
		};
		draw(arg);
		return { update: draw };
	}
</script>

{#if $profilerLiveOpen}
	<div
		id="profiler-live"
		class="ui-panel fixed flex flex-col overflow-hidden outline-hidden"
		tabindex="-1"
		use:dragWindow={{ key: 'profilerLiveWindow', defaultRect: { left: 140, top: 110 }, resizable: true }}
		use:focusStack={'profilerLive'}
		style="z-index: var(--z-window); width: 420px; height: 520px"
	>
		<div class="ui-panel-header move-handle flex shrink-0 cursor-move select-none items-center gap-2 py-1.5">
			<Activity size={16} aria-hidden="true" />
			<span class="flex-1 text-sm font-semibold">Live profiler</span>
			<button id="profiler-live-close" class="rounded-sm p-1 hover:brightness-150" title="Close" aria-label="Close live profiler" onclick={() => profilerLiveOpen.set(false)}
				><X size={16} aria-hidden="true" /></button
			>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 text-xs">
			<p class="mb-1.5 text-[11px] text-gray-400">
				Watch a peer in your room — a headset, usually — and see its frame time and draw calls here as it plays.
				<strong>Detailed</strong> also asks for CPU phases and per-object captures; it costs that device frame time.
			</p>

			{#if roomPeers.length === 0}
				<p id="profiler-live-empty" class="italic text-gray-500">Nobody else is in this room yet. Connect a headset to watch it.</p>
			{/if}
			<ul id="profiler-live-peers" class="mb-2">
				{#each roomPeers as p (p.id)}
					{@const s = $perfLive.sessions[p.id]}
					{@const rec = s?.rec ?? $perfLive.recording[p.id]}
					<li class="live-peer" data-peer={p.id}>
						<span class="flex-1 truncate" title={p.id}>{p.name}</span>
						{#if s?.xr || p.vr}<span class="chip">VR</span>{/if}
						{#if rec}<span class="chip rec" title="Recording on that device">● REC{rec.mode === 'detailed' ? ' detailed' : ''}</span>{/if}
						{#if s?.watching}
							<button class="live-btn" data-act="stop" onclick={() => unwatchPeer(p.id)}>Stop</button>
						{:else}
							<button class="live-btn" data-act="watch" onclick={() => watchPeer(p.id, 'light')}>Watch</button>
							<button class="live-btn" data-act="detailed" title="CPU phases + captures (costs that device frame time)" onclick={() => watchPeer(p.id, 'detailed')}
								>Detailed</button
							>
						{/if}
					</li>
				{/each}
			</ul>

			{#each sessions as s (s.peerId)}
				<section class="live-session" data-peer={s.peerId} data-mode={s.mode} data-watching={s.watching}>
					<header class="flex items-center gap-2">
						<span class="flex-1 font-semibold">{s.name}{s.ended ? ' (left)' : ''}</span>
						<span class="text-gray-400" title="Measured on this device">{s.watching ? (s.waiting ? 'waiting…' : 'live') : 'stopped'}</span>
					</header>
					<div class="live-nums font-mono tabular-nums">
						<span>{num(s.latest?.fps)} fps</span>
						<span>{num(s.latest?.ms)} ms</span>
						<span data-tier={s.latest?.calls != null && s.latest.calls > CALLS_BUDGET ? 'over' : 'ok'}>{num(s.latest?.calls)} calls</span>
						<span>{num(s.latest?.tris)} tris</span>
						<span>Q{num(s.latest?.quality)}</span>
					</div>
					<canvas class="live-graph" width="380" height="54" aria-label="Frame time, last 10 seconds" use:graph={{ peerId: s.peerId, key: 'ms', budget: MS_BUDGET, frames: s.frames }}></canvas>
					<canvas class="live-graph" width="380" height="40" aria-label="Draw calls, last 10 seconds" use:graph={{ peerId: s.peerId, key: 'calls', budget: CALLS_BUDGET, frames: s.frames }}></canvas>
					<p class="live-meta text-gray-400">
						<span class="live-frames">{s.frames} frames</span> · {s.mode} ·
						<span class="live-bw" data-over={s.mode === 'light' && s.bytesPerSec > LIGHT_BUDGET_BPS}>{(s.bytesPerSec / 1024).toFixed(1)} KB/s</span>
						{#if s.dropped}· {s.dropped} dropped{/if}
						{#if s.device}· <span title={s.device}>{s.xr ? 'in VR' : 'not in VR'}</span>{/if}
					</p>
					{#if s.cpu}
						<p class="live-cpu font-mono text-[11px]">
							CPU {#each Object.entries(s.cpu) as [k, v] (k)}<span class="mr-1.5">{k} {v}</span>{/each}
						</p>
					{/if}
					{#if s.lastCapture}
						<div class="live-capture">
							<p class="text-gray-300">Capture at {(s.lastCapture.t / 1000).toFixed(1)} s — {s.lastCapture.objects} objects, who draws most:</p>
							<ol>
								{#each s.lastCapture.top as o, i (i)}
									<li class="font-mono text-[11px]" title={o.path}>{o.name} — {num(o.calls)} calls · {num(o.tris)} tris</li>
								{/each}
							</ol>
						</div>
					{/if}
					<div class="flex flex-wrap gap-1.5 pt-1">
						{#if s.watching}<button class="live-btn" data-act="capture" onclick={() => requestCapture(s.peerId)}>Capture now</button>{/if}
						<button class="live-btn" data-act="save" disabled={!s.frames} onclick={() => save(s.peerId)}>Save recording</button>
						<button class="live-btn" data-act="forget" onclick={() => forgetPeer(s.peerId)}>Clear</button>
						{#if saved[s.peerId]}<span class="live-saved text-gray-400">{saved[s.peerId]}</span>{/if}
					</div>
				</section>
			{/each}
		</div>
	</div>
{/if}

<style>
	.live-peer {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 0;
		border-bottom: 1px solid rgba(107, 114, 128, 0.25);
	}
	.chip {
		font-size: 10px;
		padding: 0 5px;
		border-radius: 9999px;
		background: rgba(96, 165, 250, 0.18);
		color: #93c5fd;
	}
	.chip.rec {
		background: rgba(248, 113, 113, 0.18);
		color: #fca5a5;
	}
	.live-btn {
		font-size: 11px;
		padding: 1px 8px;
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.08);
	}
	.live-btn:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.16);
	}
	.live-btn:disabled {
		opacity: 0.45;
	}
	.live-session {
		margin-top: 6px;
		padding: 6px;
		border-radius: 8px;
		background: rgba(0, 0, 0, 0.18);
	}
	.live-nums {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin: 3px 0;
	}
	.live-nums [data-tier='over'] {
		color: #f87171;
	}
	.live-graph {
		display: block;
		width: 100%;
		height: auto;
		margin-top: 3px;
		background: rgba(0, 0, 0, 0.25);
		border-radius: 4px;
	}
	.live-meta {
		margin-top: 3px;
	}
	.live-bw[data-over='true'] {
		color: #fbbf24;
	}
	.live-capture ol {
		margin: 2px 0 0 16px;
		list-style: decimal;
	}
</style>
