<script>
	// 95 SM2 — SHARE A MOMENT: the last seconds of Play (the moment buffer, frozen while this is
	// open), a preview that loops the trim, a 3-10 s trim, GIF or MP4 written by the 68-V9 encoders
	// with the shared export progress pill, then Download / the system share sheet / Copy picture.
	// Mounted by MomentHost while `momentOpen`. It is a MENU in Play (HudLayer frees the pointer while
	// it is open), so Escape closes it instead of leaving Play.
	import { onMount, onDestroy } from 'svelte';
	import ModalDialog from '../ui/ModalDialog.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import UiButton from '../ui/Button.svelte';
	import ExportProgress from '../ui/ExportProgress.svelte';
	import Icon from '../ui/Icon.svelte';
	import { momentOpen } from '$lib/moment/momentStores.js';
	import { clampTrim, defaultTrim, MOMENT_SECONDS } from '$lib/moment/momentCore.js';
	import { embedMode } from '$lib/playMode';
	import { formatBytes } from '$lib/recording/videoExportCore.js';

	/** @type {{t: number, bytes: number, data: Blob}[]} */
	let frames = $state.raw([]);
	/** @type {string[]} */
	let urls = $state.raw([]);
	let size = $state({ w: 0, h: 0 });
	let fps = $state(15);
	let ready = $state(false);
	/** the buffer module (returnMoment on close) @type {any} */
	let buffer = null;

	const first = $derived(frames[0]?.t ?? 0);
	const times = $derived(frames.map((f) => f.t - first));
	const total = $derived(frames.length ? Math.min(MOMENT_SECONDS, times[times.length - 1] + 1 / fps) : 0);
	let trim = $state({ start: 0, end: 0 });
	const length = $derived(Math.max(0, trim.end - trim.start));

	let format = $state('gif');
	/** @type {Record<string, string>} */
	let blockers = $state({ gif: '', mp4: '' });
	const formats = $derived([
		{ value: 'gif', label: 'GIF', disabled: !!blockers.gif },
		{ value: 'mp4', label: 'MP4', disabled: !!blockers.mp4 }
	]);

	// ---- the preview: loops the trim at the game's speed --------------------------------------
	let playhead = $state(0);
	let playing = $state(typeof window === 'undefined' || !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
	const shownIndex = $derived.by(() => {
		let j = 0;
		while (j + 1 < times.length && times[j + 1] <= playhead + 1e-6) j++;
		return j;
	});
	/** @type {ReturnType<typeof setInterval> | null} */
	let ticker = null;

	// ---- the file --------------------------------------------------------------------------------
	/** @type {'trim' | 'encoding' | 'done'} */
	let phase = $state('trim');
	let progress = $state({ done: 0, total: 0 });
	let error = $state('');
	let note = $state('');
	/** @type {AbortController | null} */
	let abort = null;
	/** @type {null | {blob: Blob, url: string, name: string, mime: string, frames: number, fps: number, durationMs: number, width: number, height: number, encoder: string}} */
	let result = $state(null);
	let canShare = $state(false);

	onMount(async () => {
		buffer = await import('$lib/moment/momentBuffer.js');
		const m = buffer.takeMoment();
		frames = m.frames;
		size = m.size;
		fps = m.fps || 15;
		urls = m.frames.map((/** @type {any} */ f) => URL.createObjectURL(f.data));
		trim = defaultTrim(total);
		playhead = trim.start;
		ready = true;
		ticker = setInterval(() => {
			if (!playing || phase === 'encoding' || length <= 0) return;
			let next = playhead + 1 / fps;
			if (next >= trim.end - 1e-6 || next < trim.start) next = trim.start;
			playhead = next;
		}, 1000 / fps);
		if (frames.length) {
			const ex = await import('$lib/moment/momentExport.js');
			blockers = { gif: ex.momentFormatBlocker('gif', size), mp4: ex.momentFormatBlocker('mp4', size) };
			if (blockers[format] && !blockers.mp4) format = 'mp4';
		}
	});

	onDestroy(() => {
		if (ticker) clearInterval(ticker);
		abort?.abort();
		for (const u of urls) URL.revokeObjectURL(u);
		if (result) URL.revokeObjectURL(result.url);
		// the moment goes back to the buffer, so pressing again reaches back the full 10 s
		buffer?.returnMoment(frames);
	});

	/** @param {'start'|'end'} which @param {number} value */
	function setTrim(which, value) {
		trim = clampTrim(total, which === 'start' ? value : trim.start, which === 'end' ? value : trim.end, which);
		playhead = which === 'start' ? trim.start : Math.max(trim.start, trim.end - 1);
	}

	function close() {
		momentOpen.set(false);
	}

	async function make() {
		if (phase === 'encoding' || !frames.length) return;
		error = '';
		note = '';
		phase = 'encoding';
		progress = { done: 0, total: Math.max(1, Math.round(length * 15)) };
		abort = new AbortController();
		try {
			const ex = await import('$lib/moment/momentExport.js');
			const out = await ex.encodeMoment({
				frames,
				start: trim.start,
				end: trim.end,
				format,
				size,
				fps,
				signal: abort.signal,
				onProgress: (done, totalFrames) => (progress = { done, total: totalFrames })
			});
			if (result) URL.revokeObjectURL(result.url);
			result = { ...out, url: URL.createObjectURL(out.blob) };
			phase = 'done';
			canShare = shareable(out.blob, out.name);
			// in the editor the file also lands in Explorer ▸ Recordings (the Share as video rule); a
			// published game's player has no library, so nothing is kept for them
			if (!$embedMode) {
				const { saveToExplorer } = await import('$lib/recording/recorder.js');
				const saved = await saveToExplorer(new Uint8Array(await out.blob.arrayBuffer()), out.name, null, out.mime, out.mime.startsWith('video/') ? 'video' : 'image');
				note = saved.note;
			}
		} catch (e) {
			const err = /** @type {any} */ (e);
			if (err?.name === 'AbortError') phase = 'trim';
			else {
				error = `Could not make the ${format.toUpperCase()}: ` + (err?.message || String(err));
				phase = 'trim';
			}
		} finally {
			abort = null;
		}
	}

	/** @param {Blob} blob @param {string} name */
	function shareable(blob, name) {
		try {
			const file = new File([blob], name, { type: blob.type });
			return typeof navigator !== 'undefined' && typeof navigator.share === 'function' && !!navigator.canShare?.({ files: [file] });
		} catch {
			return false;
		}
	}

	function download() {
		if (!result) return;
		const a = document.createElement('a');
		a.href = result.url;
		a.download = result.name;
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	async function share() {
		if (!result) return;
		try {
			const file = new File([result.blob], result.name, { type: result.mime });
			await navigator.share({ files: [file], title: 'A moment from my game' });
		} catch (e) {
			if (/** @type {any} */ (e)?.name !== 'AbortError') note = 'Could not open the share sheet: download the file instead.';
		}
	}

	/** the frame on screen as a PNG (the clipboard takes pictures, not GIFs or videos) */
	async function copyPicture() {
		const url = urls[shownIndex];
		if (!url) return;
		try {
			const bitmap = await createImageBitmap(frames[shownIndex].data);
			const c = document.createElement('canvas');
			c.width = bitmap.width;
			c.height = bitmap.height;
			c.getContext('2d')?.drawImage(bitmap, 0, 0);
			bitmap.close?.();
			const png = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('no picture'))), 'image/png'));
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': /** @type {Blob} */ (png) })]);
			note = 'The picture on screen is on the clipboard.';
		} catch {
			note = 'This browser would not copy a picture: download the file instead.';
		}
	}

	/** Escape closes the preview and nothing else (in Play it would otherwise also leave Play) */
	function onKey(/** @type {KeyboardEvent} */ e) {
		if (e.key !== 'Escape') return;
		e.preventDefault();
		e.stopPropagation();
		if (phase === 'encoding') abort?.abort();
		else close();
	}

	const fmtS = (/** @type {number} */ s) => s.toFixed(1) + ' s';
	const percent = $derived(progress.total ? Math.round((progress.done / progress.total) * 100) : 0);
</script>

<svelte:window onkeydowncapture={onKey} />

<ModalDialog title="Share a moment" open={$momentOpen} modal outsideclose={phase !== 'encoding'} width="md" onclose={close} oncancel={(/** @type {Event} */ e) => {
		e.preventDefault();
		if (phase !== 'encoding') close();
	}}>
	<div id="moment-dialog" class="mo-wrap" data-phase={phase} data-frames={frames.length} data-total={total.toFixed(2)} data-start={trim.start} data-end={trim.end}>
		{#if !ready}
			<p class="mo-dim">Getting the moment…</p>
		{:else if !frames.length}
			<p id="moment-empty" class="mo-dim">Nothing recorded yet: play a few seconds, then try again.</p>
			<div class="mo-actions"><UiButton id="moment-close" variant="secondary" onclick={close}>Close</UiButton></div>
		{:else if phase === 'done' && result}
			<div id="moment-result" class="mo-result" data-mime={result.mime} data-bytes={result.blob.size} data-frames={result.frames} data-fps={result.fps} data-duration-ms={result.durationMs}>
				{#if result.mime.startsWith('video/')}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video id="moment-video" class="mo-view" src={result.url} controls loop muted playsinline autoplay={playing}></video>
				{:else}
					<img id="moment-image" class="mo-view" src={result.url} alt="The moment, looping" />
				{/if}
				<div class="mo-dim">{(result.durationMs / 1000).toFixed(1)} s · {result.width} × {result.height} · {result.fps} fps · {formatBytes(result.blob.size)}</div>
				<div class="mo-actions">
					<UiButton id="moment-download" variant="primary" icon="download" onclick={download}>Download</UiButton>
					{#if canShare}
						<UiButton id="moment-share-sheet" variant="secondary" icon="share-2" onclick={share}>Share…</UiButton>
					{/if}
					<UiButton id="moment-copy" variant="secondary" icon="copy" title="Copy the picture on screen (the clipboard takes pictures, not GIFs or videos)" onclick={copyPicture}>Copy picture</UiButton>
					<UiButton id="moment-again" variant="ghost" onclick={() => (phase = 'trim')}>Trim again</UiButton>
				</div>
			</div>
		{:else}
			<div class="mo-stage">
				<img id="moment-preview" class="mo-view" src={urls[shownIndex]} alt="The last seconds of play" data-index={shownIndex} />
				<button
					id="moment-play"
					type="button"
					class="mo-play"
					aria-label={playing ? 'Pause the preview' : 'Play the preview'}
					aria-pressed={playing}
					onclick={() => (playing = !playing)}
				>
					<Icon name={playing ? 'pause' : 'play'} size={16} aria-hidden="true" />
				</button>
			</div>
			<div class="mo-trim">
				<label class="mo-row">
					<span>Start</span>
					<input id="moment-trim-start" type="range" min="0" max={total} step="0.1" value={trim.start} disabled={phase === 'encoding'} oninput={(e) => setTrim('start', Number(e.currentTarget.value))} />
					<span class="mo-num">{fmtS(trim.start)}</span>
				</label>
				<label class="mo-row">
					<span>End</span>
					<input id="moment-trim-end" type="range" min="0" max={total} step="0.1" value={trim.end} disabled={phase === 'encoding'} oninput={(e) => setTrim('end', Number(e.currentTarget.value))} />
					<span class="mo-num">{fmtS(trim.end)}</span>
				</label>
				<div id="moment-length" class="mo-dim">{fmtS(length)} of the last {fmtS(total)} (3 to 10 s)</div>
			</div>
			<div class="mo-row">
				<span>Format</span>
				<Segmented id="moment-format" label="Format" options={formats} value={format} disabled={phase === 'encoding'} onchange={(v) => (format = v)} />
			</div>
			{#if blockers[format]}<p class="mo-warn">{blockers[format]}</p>{/if}
			{#if error}<p id="moment-error" class="mo-warn" role="alert">{error}</p>{/if}
			{#if phase === 'encoding'}
				<ExportProgress
					idPrefix="moment"
					inline
					status="recording"
					{percent}
					label="Making the {format.toUpperCase()}"
					detail="frame {progress.done} / {progress.total}"
					frames={progress.done}
					total={progress.total}
					oncancel={() => abort?.abort()}
				/>
			{:else}
				<div class="mo-actions">
					<UiButton id="moment-make" variant="primary" disabled={!!blockers[format] || length <= 0} onclick={make}>Make {format.toUpperCase()}</UiButton>
					<UiButton id="moment-close" variant="ghost" onclick={close}>Close</UiButton>
				</div>
			{/if}
		{/if}
		{#if note}<p id="moment-note" class="mo-dim" role="status">{note}</p>{/if}
	</div>
</ModalDialog>

<style>
	.mo-wrap {
		display: flex;
		flex-direction: column;
		gap: 10px;
		font-size: var(--fs-desc);
		color: var(--text);
	}
	.mo-stage {
		position: relative;
	}
	.mo-view {
		display: block;
		width: 100%;
		max-height: 46vh;
		object-fit: contain;
		border-radius: 8px;
		background: var(--bg-app);
	}
	.mo-play {
		position: absolute;
		left: 8px;
		bottom: 8px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border: 1px solid var(--border);
		border-radius: 50%;
		background: var(--surface-1);
		color: var(--text);
		cursor: pointer;
	}
	.mo-play:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.mo-trim {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.mo-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.mo-row > span:first-child {
		width: 52px;
		flex: none;
		color: var(--text-muted);
	}
	.mo-row input[type='range'] {
		flex: 1;
		accent-color: var(--accent);
	}
	.mo-num {
		width: 48px;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.mo-dim {
		color: var(--text-muted);
		margin: 0;
	}
	.mo-warn {
		color: var(--warn-text);
		margin: 0;
	}
	.mo-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.mo-result {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	@media (pointer: coarse) {
		.mo-play {
			width: 44px;
			height: 44px;
		}
	}
</style>
