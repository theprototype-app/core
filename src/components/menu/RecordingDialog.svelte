<script>
	// 36-share (B13) — Tools ▸ Recording…: the options, then a slim progress bar over the viewport
	// while it records (a modal would cover the very thing being filmed), then the finished file.
	// App mounts this lazily while the dialog is open OR a recording is under way.
	// 65 M4/M7: what to film grows a Timeline (a 48 sequence), the output a FORMAT (MP4 / WebM /
	// GIF / WebP / PNG sequence / Website section) rendered frame by frame (offlineRender.js); the
	// live MediaRecorder take stays as the fallback where WebCodecs is missing.
	import ModalDialog from '../ui/ModalDialog.svelte';
	import { get } from 'svelte/store';
	import { untrack } from 'svelte';
	import { recordingOpen, recordingState, recordingPrefs, setRecordingPrefs } from '$lib/recording/recordingStores.js';
	import { startRecording, cancelRecording, resetRecording, downloadRecording, recordingBlocker } from '$lib/recording/recorder.js';
	import { RESOLUTIONS, FPS_CHOICES, MIN_DURATION, MAX_DURATION, EXPORT_FORMATS, HERO_EASES } from '$lib/recording/recordingCore.js';
	import { exportPlan, estimateExportBytes, FORMAT_INFO, ALPHA_FORMATS, formatBytes } from '$lib/recording/videoExportCore.js';
	import { startExport, exportBlocker, exportCaps } from '$lib/recording/offlineRender.js';
	import { sequences } from '$lib/sequences';
	import { findSequence } from '$lib/sequenceCore';
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
	const seqList = $derived(Object.values(/** @type {Record<string, any>} */ ($sequences)).sort((a, b) => String(a.name).localeCompare(String(b.name))));
	const seq = $derived(p.mode === 'timeline' ? findSequence($sequences, p.sequence) : null);
	const caps = exportCaps();
	const plan = $derived.by(() => {
		const dom = /** @type {any} */ ($globalRenderer)?.domElement;
		return exportPlan(p, caps, { w: dom?.width || 1280, h: dom?.height || 720 }, seq);
	});
	const live = $derived(plan.path === 'mediarecorder');
	// re-read on every pref change and every views/selection/timeline change (the blockers read them)
	const blocker = $derived((void views.length, void seqList.length, void p, busy ? '' : live ? recordingBlocker(p) : exportBlocker(p)));
	const estimate = $derived(estimateExportBytes(plan, p.quality));
	const alphaOk = $derived(ALPHA_FORMATS.includes(p.format));
	/** what the progress pill counts while an exact export runs: frames, not seconds */
	let exportTotal = $state(0);

	const fmt = formatBytes;

	/** a timeline picked: the take follows its length @param {string} id */
	function pickSequence(id) {
		const s = findSequence(get(sequences), id);
		setRecordingPrefs({ sequence: id, ...(s ? { duration: Math.min(MAX_DURATION, Math.max(MIN_DURATION, s.duration)) } : {}) });
	}
	// entering Timeline mode with nothing picked picks the only (or first) timeline
	$effect(() => {
		if (p.mode === 'timeline' && !seq && seqList.length) untrack(() => pickSequence(seqList[0].id));
	});

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
		exportTotal = live ? 0 : plan.frames;
		recordingOpen.set(false);
		const ok = live ? await startRecording() : await startExport();
		if (!ok) recordingOpen.set(true);
	}

	let copied = $state(false);
	async function copySnippet() {
		const text = get(recordingState).result?.snippet;
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* the textarea is selectable: copy by hand */
		}
	}
	/** the website section's script alone (what a person uploads beside their page) */
	function downloadScript() {
		const r = get(recordingState).result;
		if (!r?.script) return;
		const url = URL.createObjectURL(new Blob([r.script], { type: 'text/javascript' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = r.scriptFile || 'section.js';
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 60000);
	}
	/** open the section in a plain page, the way a site would show it */
	async function previewSection() {
		const r = get(recordingState).result;
		if (!r?.script) return;
		const core = await import('$lib/recording/heroCore.js');
		const scriptUrl = URL.createObjectURL(new Blob([r.script], { type: 'text/javascript' }));
		const id = r.scriptFile?.replace(/\.js$/, '') || 'tp-hero-section';
		const page = core.heroDemoPage(id, scriptUrl, { w: r.width, h: r.height, label: r.name, trigger: p.heroTrigger, title: r.name });
		window.open(URL.createObjectURL(new Blob([page], { type: 'text/html' })), '_blank', 'noopener');
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
			>{st.status === 'preparing' ? 'Getting ready…' : st.status === 'finishing' ? 'Finishing the file…' : exportTotal ? 'Rendering' : 'Recording'}</span
		>
		<div class="rec-track"><div class="rec-fill" style:width="{Math.round(st.progress * 100)}%"></div></div>
		{#if exportTotal}
			<span id="recording-time" class="rec-time" data-frames={st.frames} data-total={exportTotal}>frame {st.frames} / {exportTotal}</span>
		{:else}
			<span id="recording-time" class="rec-time">{st.elapsed.toFixed(1)} / {st.duration.toFixed(1)} s</span>
		{/if}
		{#if st.status !== 'finishing'}
			<button id="recording-cancel" type="button" class="rec-cancel" onclick={cancelRecording}>Cancel</button>
		{/if}
	</div>
{/if}

<ModalDialog
	title="Recording"
	open={$recordingOpen && !busy}
	outsideclose
	width="sm"
	onclose={close}
	onkeydown={(/** @type {KeyboardEvent} */ e) => {
		if (e.key === 'Escape') close();
	}}
>
	{#if $recordingOpen && !busy}
		<div id="recording-dialog" class="rec-wrap" data-mode={p.mode}>
			{#if st.status === 'done' && st.result}
				{@const r = st.result}
				<div id="recording-result" class="rec-result" data-bytes={r.bytes} data-duration-ms={r.durationMs} data-item={r.itemId ?? ''} data-format={r.format ?? 'webm'} data-frames={r.frames ?? ''} data-mime={r.mime}>
					{#if r.mime.startsWith('video/')}
						<!-- svelte-ignore a11y_media_has_caption -->
						<video id="recording-video" class="rec-video" src={r.url} controls loop muted playsinline></video>
					{:else if r.mime.startsWith('image/')}
						<img id="recording-image" class="rec-video rec-checker" src={r.url} alt="The exported loop" />
					{/if}
					<div class="rec-name"><strong>{r.name}</strong></div>
					<div class="rec-dim">
						{(r.durationMs / 1000).toFixed(1)} s · {r.width} × {r.height} · {r.fps} fps{#if r.frames} · {r.frames} frames{/if} · {fmt(r.bytes)}{#if r.encoder} · {r.encoder}{/if}
					</div>
					{#if r.report}
						{@const rep = r.report}
						<div id="recording-size-report" class="rec-report" data-script-bytes={rep.scriptBytes} data-gzip-bytes={rep.gzipBytes}>
							<div><span>Script (one file)</span><strong>{fmt(rep.scriptBytes)}</strong></div>
							<div><span>Over the network (gzip)</span><strong>about {fmt(rep.gzipBytes)}</strong></div>
							<div><span>Frames</span><strong>{rep.frames} · {fmt(rep.averageFrameBytes)} each on average</strong></div>
							<div><span>Player (with anime.js)</span><strong>{fmt(rep.runtimeBytes)}</strong></div>
						</div>
						<label class="rec-label-row" for="recording-snippet">Paste into your page</label>
						<textarea id="recording-snippet" class="ui-input rec-snippet" readonly rows="5" value={r.snippet}></textarea>
						<p class="rec-note">Upload <strong>{r.scriptFile}</strong> beside the page. The .zip holds the script, a demo page and this size report.</p>
					{/if}
					<div class="rec-dim">{r.savedNote}</div>
					<div class="rec-actions">
						<button id="recording-download" type="button" class="rec-go" onclick={downloadRecording}>Download{r.mime === 'application/zip' ? ' .zip' : ''}</button>
						{#if r.report}
							<button id="recording-copy-snippet" type="button" class="rec-ghost" onclick={copySnippet}>{copied ? 'Copied' : 'Copy snippet'}</button>
							<button id="recording-download-script" type="button" class="rec-ghost" onclick={downloadScript}>Download script</button>
							<button id="recording-preview-section" type="button" class="rec-ghost" onclick={previewSection}>Preview page</button>
						{/if}
						{#if r.itemId}
							<button id="recording-reveal" type="button" class="rec-ghost" onclick={reveal}>Show in Explorer</button>
						{/if}
						<button id="recording-again" type="button" class="rec-ghost" onclick={resetRecording}>{r.exact ? 'Export again' : 'Record again'}</button>
					</div>
				</div>
			{:else}
				<div class="rec-label-row">What to film</div>
				<div class="tp-seg rec-seg" role="radiogroup" aria-label="Recording mode">
					<button id="recording-mode-turntable" type="button" class="tp-seg-btn" aria-pressed={p.mode === 'turntable'} onclick={() => setRecordingPrefs({ mode: 'turntable' })}>Turntable</button>
					<button id="recording-mode-flythrough" type="button" class="tp-seg-btn" aria-pressed={p.mode === 'flythrough'} onclick={() => setRecordingPrefs({ mode: 'flythrough' })}>Flythrough</button>
					<button id="recording-mode-timeline" type="button" class="tp-seg-btn" aria-pressed={p.mode === 'timeline'} onclick={() => setRecordingPrefs({ mode: 'timeline' })}>Timeline</button>
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
				{:else if p.mode === 'timeline'}
					{#if seqList.length}
						<div class="rec-grid">
							<label for="recording-sequence">Timeline</label>
							<select id="recording-sequence" class="ui-input" value={seq?.id ?? ''} onchange={(e) => pickSequence(/** @type {any} */ (e.currentTarget).value)}>
								{#each seqList as s (s.id)}<option value={s.id}>{s.name} ({s.duration.toFixed(1)} s)</option>{/each}
							</select>
						</div>
						<p class="rec-note">Films the timeline from its start, frame by frame: its camera shots (or your view where it has none), its clips at every frame. The length follows the timeline.</p>
					{:else}
						<p id="recording-no-timeline" class="rec-note">Make a timeline first (Windows ▸ Timeline): camera shots and clips on a track. Then film it here.</p>
					{/if}
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
					<label for="recording-format">Format</label>
					<select id="recording-format" class="ui-input" value={p.format} onchange={(e) => setRecordingPrefs({ format: /** @type {any} */ (e.currentTarget).value })}>
						{#each EXPORT_FORMATS as f (f)}<option value={f}>{/** @type {any} */ (FORMAT_INFO)[f].label}</option>{/each}
					</select>
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
				<p class="rec-note">{/** @type {any} */ (FORMAT_INFO)[p.format].note}</p>
				{#if p.format === 'hero'}
					<div class="rec-grid" id="recording-hero-options">
						<label for="recording-hero-trigger">Plays on</label>
						<select id="recording-hero-trigger" class="ui-input" value={p.heroTrigger} onchange={(e) => setRecordingPrefs({ heroTrigger: /** @type {any} */ (e.currentTarget).value })}>
							<option value="scroll">Scroll (the page scrubs the timeline)</option>
							<option value="hover">Hover (plays in, back out on leave)</option>
							<option value="click">Click (plays, a second click plays back)</option>
						</select>
						<label for="recording-hero-ease">Ease</label>
						<select id="recording-hero-ease" class="ui-input" value={p.heroEase} onchange={(e) => setRecordingPrefs({ heroEase: /** @type {any} */ (e.currentTarget).value })}>
							{#each HERO_EASES as e (e)}<option value={e}>{e}</option>{/each}
						</select>
						{#if p.heroTrigger === 'scroll'}
							<label for="recording-hero-smooth">Smoothing</label>
							<span class="rec-inline">
								<input id="recording-hero-smooth" class="ui-input rec-num" type="number" min="0" max="2000" step="50" value={p.heroSmooth} onchange={(e) => setRecordingPrefs({ heroSmooth: Number(/** @type {any} */ (e.currentTarget).value) })} />
								<span class="rec-dim">ms behind the scroll</span>
							</span>
						{/if}
						<label for="recording-hero-fit">Fit</label>
						<select id="recording-hero-fit" class="ui-input" value={p.heroFit} onchange={(e) => setRecordingPrefs({ heroFit: /** @type {any} */ (e.currentTarget).value })}>
							<option value="cover">Fill the box (crop the edges)</option>
							<option value="contain">Show it all (letterbox)</option>
						</select>
					</div>
					<p class="rec-note">Responsive (it fills its box at any width), and with reduced motion on it jumps instead of gliding.</p>
				{/if}
				<label class="rec-check"><input id="recording-hide-helpers" class="tp-check" type="checkbox" checked={p.hideHelpers} onchange={(e) => setRecordingPrefs({ hideHelpers: /** @type {any} */ (e.currentTarget).checked })} /> Hide editor helpers (grid, gizmo, outlines, light and camera helpers)</label>
				<label class="rec-check" class:rec-off={!alphaOk} title={alphaOk ? '' : 'Only WebP, PNG and website sections keep transparency'}
					><input id="recording-transparent" class="tp-check" type="checkbox" disabled={!alphaOk} checked={p.transparent && alphaOk} onchange={(e) => setRecordingPrefs({ transparent: /** @type {any} */ (e.currentTarget).checked })} /> Transparent background (no sky){alphaOk ? '' : ' — WebP, PNG and website sections only'}</label
				>
				<div id="recording-estimate" class="rec-dim" data-frames={plan.frames} data-path={plan.path}>
					{plan.size.w} × {plan.size.h} · {plan.frames} frames at {plan.fps} fps · about {fmt(estimate)} as .{plan.ext}{live ? ' (live recording)' : ''}
				</div>
				{#each plan.notes as note (note)}<p class="rec-note rec-plan-note">{note}</p>{/each}

				{#if st.status === 'error' && st.error}<p id="recording-error" class="rec-warn">{st.error}</p>{/if}
				{#if blocker}<p id="recording-blocked" class="rec-warn">{blocker}</p>{/if}
				<button id="recording-start" type="button" class="rec-go" disabled={!!blocker} onclick={start}>{live ? 'Start recording' : 'Export'}</button>
				<p class="rec-note">The camera is yours while it records: nothing is sent to anyone in the session. Videos and loops go to Explorer ▸ Recordings; everything can be downloaded.</p>
			{/if}
		</div>
	{/if}
</ModalDialog>

<style>
	.rec-wrap {
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 13px;
		color: var(--text);
	}
	.rec-label-row {
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-2);
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
		color: var(--text-2);
		line-height: 1.4;
	}
	.rec-warn {
		margin: 0;
		font-size: 12px;
		color: var(--ink-bad);
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
		background: var(--accent-fill);
		color: var(--on-accent);
	}
	.rec-go:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.rec-ghost {
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text);
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
		background: var(--bg-app);
	}
	.rec-name {
		word-break: break-all;
	}
	/* 65: a transparent loop shows its transparency */
	.rec-checker {
		object-fit: contain;
		background: repeating-conic-gradient(var(--surface-2) 0% 25%, var(--surface-1) 0% 50%) 50% / 16px 16px;
	}
	.rec-off {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.rec-report {
		display: grid;
		gap: 2px;
		font-size: 12px;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.rec-report div {
		display: flex;
		justify-content: space-between;
		gap: 12px;
	}
	.rec-report span {
		color: var(--text-2);
	}
	.rec-snippet {
		width: 100%;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 11px;
		resize: vertical;
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
		background: var(--surface-1);
		border: 1px solid var(--border);
		color: var(--text);
		font-size: 12px;
		box-shadow: var(--shadow-window);
		max-width: calc(100vw - 32px);
	}
	.rec-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--live);
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
		background: var(--border-strong);
		overflow: hidden;
		flex: 1 1 80px;
	}
	.rec-fill {
		height: 100%;
		background: var(--accent);
	}
	.rec-time {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.rec-cancel {
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text);
		border-radius: 999px;
		padding: 3px 10px;
		cursor: pointer;
	}
</style>
