<script>
	// 36-share (B13) — Tools ▸ Recording…: the options, then a slim progress bar over the viewport
	// while it records (a modal would cover the very thing being filmed), then the finished file.
	// App mounts this lazily while the dialog is open OR a recording is under way.
	import { Modal } from 'flowbite-svelte';
	import { get } from 'svelte/store';
	import { untrack } from 'svelte';
	import { recordingOpen, recordingState, recordingPrefs, setRecordingPrefs } from '$lib/recording/recordingStores.js';
	import { startRecording, cancelRecording, resetRecording, downloadRecording, recordingBlocker } from '$lib/recording/recorder.js';
	import { RESOLUTIONS, FPS_CHOICES, MIN_DURATION, MAX_DURATION, outputSize, bitrateFor, estimateBytes } from '$lib/recording/recordingCore.js';
	import { bookmarks } from '$lib/cameraBookmarks';
	import { selectedObjects, globalRenderer } from '../../stores/sceneStore';
	import { explorerClose } from '../../stores/appStore';
	import { revealItem } from '$lib/explorer';

	const QUALITIES = [
		{ id: 'low', label: 'Low (small file)' },
		{ id: 'medium', label: 'Medium' },
		{ id: 'high', label: 'High (large file)' }
	];

	const p = $derived($recordingPrefs);
	const st = $derived($recordingState);
	const busy = $derived(st.status === 'preparing' || st.status === 'recording' || st.status === 'finishing');
	const views = $derived(/** @type {any[]} */ ($bookmarks));
	const hasSelection = $derived((/** @type {string[]} */ ($selectedObjects) || []).length > 0);
	// re-read on every pref change and every views/selection change (the blocker reads them)
	const blocker = $derived((void views.length, void p, busy ? '' : recordingBlocker(p)));
	const estimate = $derived.by(() => {
		const dom = /** @type {any} */ ($globalRenderer)?.domElement;
		const out = outputSize(p.resolution, { w: dom?.width || 1280, h: dom?.height || 720 });
		return { out, bytes: estimateBytes(bitrateFor(out, p.fps, p.quality), p.duration) };
	});

	/** @param {number} b */
	function fmt(b) {
		return b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
	}

	// the dialog steps aside while recording and comes back with the result (or the reason)
	let wasBusy = false;
	$effect(() => {
		const now = busy;
		const status = st.status;
		untrack(() => {
			if (wasBusy && !now && (status === 'done' || status === 'error')) recordingOpen.set(true);
			wasBusy = now;
		});
	});

	async function start() {
		const ok = await startRecording();
		if (ok) recordingOpen.set(false);
	}

	function close() {
		recordingOpen.set(false);
		if (!busy) resetRecording();
	}

	function reveal() {
		const id = get(recordingState).result?.itemId;
		if (!id) return;
		explorerClose.set(false);
		revealItem(id);
	}
</script>

{#if busy}
	<div id="recording-bar" class="rec-bar" role="status" aria-live="polite" data-status={st.status}>
		<span class="rec-dot" aria-hidden="true"></span>
		<span class="rec-label"
			>{st.status === 'preparing' ? 'Getting ready…' : st.status === 'finishing' ? 'Finishing the file…' : 'Recording'}</span
		>
		<div class="rec-track"><div class="rec-fill" style:width="{Math.round(st.progress * 100)}%"></div></div>
		<span id="recording-time" class="rec-time">{st.elapsed.toFixed(1)} / {st.duration.toFixed(1)} s</span>
		{#if st.status !== 'finishing'}
			<button id="recording-cancel" type="button" class="rec-cancel" onclick={cancelRecording}>Cancel</button>
		{/if}
	</div>
{/if}

<Modal
	title="Recording"
	open={$recordingOpen && !busy}
	modal={false}
	outsideclose
	size="sm"
	onclose={close}
	onkeydown={(/** @type {KeyboardEvent} */ e) => {
		if (e.key === 'Escape') close();
	}}
	class="tp-modal-frame"
	classes={{ header: 'tp-modal-header', body: 'tp-modal-body' }}
>
	{#if $recordingOpen && !busy}
		<div id="recording-dialog" class="rec-wrap" data-mode={p.mode}>
			{#if st.status === 'done' && st.result}
				{@const r = st.result}
				<div id="recording-result" class="rec-result" data-bytes={r.bytes} data-duration-ms={r.durationMs} data-item={r.itemId ?? ''}>
					<!-- svelte-ignore a11y_media_has_caption -->
					<video id="recording-video" class="rec-video" src={r.url} controls loop muted playsinline></video>
					<div class="rec-name"><strong>{r.name}</strong></div>
					<div class="rec-dim">{(r.durationMs / 1000).toFixed(1)} s · {r.width} × {r.height} · {r.fps} fps · {fmt(r.bytes)}</div>
					<div class="rec-dim">{r.savedNote}</div>
					<div class="rec-actions">
						<button id="recording-download" type="button" class="rec-go" onclick={downloadRecording}>Download</button>
						{#if r.itemId}
							<button id="recording-reveal" type="button" class="rec-ghost" onclick={reveal}>Show in Explorer</button>
						{/if}
						<button id="recording-again" type="button" class="rec-ghost" onclick={resetRecording}>Record again</button>
					</div>
				</div>
			{:else}
				<div class="rec-label-row">What to film</div>
				<div class="tp-seg rec-seg" role="radiogroup" aria-label="Recording mode">
					<button id="recording-mode-turntable" type="button" class="tp-seg-btn" aria-pressed={p.mode === 'turntable'} onclick={() => setRecordingPrefs({ mode: 'turntable' })}>Turntable</button>
					<button id="recording-mode-flythrough" type="button" class="tp-seg-btn" aria-pressed={p.mode === 'flythrough'} onclick={() => setRecordingPrefs({ mode: 'flythrough' })}>Flythrough</button>
				</div>

				{#if p.mode === 'turntable'}
					<p class="rec-note">The camera circles {p.target === 'selection' && hasSelection ? 'the selection' : 'the whole scene'}, starting from where you are looking now.</p>
					<div class="rec-grid">
						<label for="recording-target">Orbit</label>
						<select id="recording-target" class="ui-input" value={p.target} onchange={(e) => setRecordingPrefs({ target: /** @type {any} */ (e.currentTarget).value })}>
							<option value="selection">The selection{hasSelection ? '' : ' (nothing selected: the scene)'}</option>
							<option value="scene">The whole scene</option>
						</select>
						<label for="recording-revolutions">Turns</label>
						<select id="recording-revolutions" class="ui-input" value={String(p.revolutions)} onchange={(e) => setRecordingPrefs({ revolutions: Number(/** @type {any} */ (e.currentTarget).value) })}>
							{#each [0.25, 0.5, 1, 2, 3] as n (n)}<option value={String(n)}>{n === 1 ? '1 turn' : n + ' turns'}</option>{/each}
						</select>
						<label for="recording-direction">Direction</label>
						<select id="recording-direction" class="ui-input" value={p.direction} onchange={(e) => setRecordingPrefs({ direction: /** @type {any} */ (e.currentTarget).value })}>
							<option value="ccw">Counter-clockwise</option>
							<option value="cw">Clockwise</option>
						</select>
					</div>
					<label class="rec-check"><input id="recording-frame" class="tp-check" type="checkbox" checked={p.frame} onchange={(e) => setRecordingPrefs({ frame: /** @type {any} */ (e.currentTarget).checked })} /> Frame it to fit (otherwise keep your distance)</label>
				{:else}
					<p id="recording-views" class="rec-note" data-count={views.length}>
						{#if views.length >= 2}
							Flies through your {views.length} saved camera views in order ({views.map((v) => v.name).join(' → ')}).
						{:else}
							Save at least two camera views first: right-click the viewport ▸ Camera bookmarks ▸ Save current view. The flythrough visits them in order.
						{/if}
					</p>
				{/if}

				<div class="rec-label-row">Output</div>
				<div class="rec-grid">
					<label for="recording-resolution">Size</label>
					<select id="recording-resolution" class="ui-input" value={p.resolution} onchange={(e) => setRecordingPrefs({ resolution: /** @type {any} */ (e.currentTarget).value })}>
						{#each RESOLUTIONS as r (r.id)}<option value={r.id}>{r.label}</option>{/each}
					</select>
					<label for="recording-fps">Frame rate</label>
					<select id="recording-fps" class="ui-input" value={String(p.fps)} onchange={(e) => setRecordingPrefs({ fps: Number(/** @type {any} */ (e.currentTarget).value) })}>
						{#each FPS_CHOICES as f (f)}<option value={String(f)}>{f} fps</option>{/each}
					</select>
					<label for="recording-duration">Length</label>
					<span class="rec-inline">
						<input id="recording-duration" class="ui-input rec-num" type="number" min={MIN_DURATION} max={MAX_DURATION} step="0.5" value={p.duration} onchange={(e) => setRecordingPrefs({ duration: Number(/** @type {any} */ (e.currentTarget).value) })} />
						<span class="rec-dim">seconds</span>
					</span>
					<label for="recording-quality">Quality</label>
					<select id="recording-quality" class="ui-input" value={p.quality} onchange={(e) => setRecordingPrefs({ quality: /** @type {any} */ (e.currentTarget).value })}>
						{#each QUALITIES as q (q.id)}<option value={q.id}>{q.label}</option>{/each}
					</select>
				</div>
				<label class="rec-check"><input id="recording-hide-helpers" class="tp-check" type="checkbox" checked={p.hideHelpers} onchange={(e) => setRecordingPrefs({ hideHelpers: /** @type {any} */ (e.currentTarget).checked })} /> Hide editor helpers (grid, gizmo, outlines, light and camera helpers)</label>
				<div id="recording-estimate" class="rec-dim">{estimate.out.w} × {estimate.out.h} · about {fmt(estimate.bytes)} as webm</div>

				{#if st.status === 'error' && st.error}<p id="recording-error" class="rec-warn">{st.error}</p>{/if}
				{#if blocker}<p id="recording-blocked" class="rec-warn">{blocker}</p>{/if}
				<button id="recording-start" type="button" class="rec-go" disabled={!!blocker} onclick={start}>Start recording</button>
				<p class="rec-note">The camera is yours while it records: nothing is sent to anyone in the session. The file goes to Explorer ▸ Recordings and can be downloaded.</p>
			{/if}
		</div>
	{/if}
</Modal>

<style>
	.rec-wrap {
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 13px;
		color: var(--text, #e5e7eb);
	}
	.rec-label-row {
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-2, #d1d5db);
		margin-top: 4px;
	}
	.rec-seg {
		align-self: flex-start;
	}
	.rec-grid {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 6px 10px;
		align-items: center;
	}
	.rec-inline {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.rec-num {
		width: 84px;
	}
	.rec-check {
		display: flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
	}
	.rec-note,
	.rec-dim {
		margin: 0;
		font-size: 11px;
		color: var(--text-2, #d1d5db);
		line-height: 1.4;
	}
	.rec-warn {
		margin: 0;
		font-size: 12px;
		color: var(--ink-bad, #fca5a5);
	}
	.rec-go,
	.rec-ghost {
		padding: 8px 12px;
		border-radius: 8px;
		font-weight: 700;
		cursor: pointer;
	}
	.rec-go {
		border: 0;
		background: var(--accent-fill, var(--accent, #2563eb));
		color: var(--on-accent, #fff);
	}
	.rec-go:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.rec-ghost {
		border: 1px solid var(--border, rgb(75 85 99 / 0.6));
		background: transparent;
		color: var(--text, #e5e7eb);
	}
	.rec-result {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.rec-video {
		width: 100%;
		max-height: 50vh;
		border-radius: 8px;
		background: var(--surface-3, #111);
	}
	.rec-name {
		word-break: break-all;
	}
	.rec-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	/* the progress pill: above the Controls HUD, under modals/toasts */
	.rec-bar {
		position: fixed;
		left: 50%;
		bottom: calc(var(--controls-inset, 0px) + 72px);
		transform: translateX(-50%);
		z-index: var(--z-hud, 45);
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px;
		border-radius: 999px;
		background: var(--surface, #1f2937);
		border: 1px solid var(--border, rgb(75 85 99 / 0.6));
		color: var(--text, #e5e7eb);
		font-size: 12px;
		box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);
		max-width: calc(100vw - 32px);
	}
	.rec-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--ink-bad, #ef4444);
		animation: rec-pulse 1.2s ease-in-out infinite;
		flex: none;
	}
	@media (prefers-reduced-motion: reduce) {
		.rec-dot {
			animation: none;
		}
	}
	@keyframes rec-pulse {
		50% {
			opacity: 0.35;
		}
	}
	.rec-track {
		width: 140px;
		height: 6px;
		border-radius: 3px;
		background: var(--surface-3, #374151);
		overflow: hidden;
		flex: 1 1 80px;
	}
	.rec-fill {
		height: 100%;
		background: var(--accent, #2563eb);
	}
	.rec-time {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.rec-cancel {
		border: 1px solid var(--border, rgb(75 85 99 / 0.6));
		background: transparent;
		color: var(--text, #e5e7eb);
		border-radius: 999px;
		padding: 3px 10px;
		cursor: pointer;
	}
</style>
