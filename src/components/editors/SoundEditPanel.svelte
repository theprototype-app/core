<script>
	// 102b-sound (row 3) — TRIM, FADE AND NORMALISE a sound, in the audio player window. Lazy (the
	// preview window imports it only for a sound). NON-DESTRUCTIVE: the edit is a setting on the sound as
	// this scene uses it (soundEdits.js), the library file is never rewritten, Reset brings the original
	// back. Every player in the scene (sound nodes, timeline clips, the music track, exports) plays the
	// edit; this panel previews it by handing the window a WAV of the edited sound.
	//
	// Keyboard: the Start / End / fade fields are real inputs (Tab, arrows); in the window, I sets the
	// start and O the end at the playhead. Dragging on the waveform moves the nearer handle.
	import { onDestroy } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import { itemBlob } from '$lib/explorer';
	import { ensureAudioContext } from '$lib/audioEngine';
	import { soundEdits, MAX_FADE } from '$lib/soundEdits';
	import { formatClock } from '$lib/filePreview';

	let {
		itemId = '',
		hash = '',
		/** the playhead of the window's player, seconds (I / O mark there) */
		playhead = () => 0,
		/** the URL the player should play: a WAV of the edit, or '' for the file itself */
		onpreview = (/** @type {string} */ _url) => {}
	} = $props();

	let buffer = $state.raw(/** @type {AudioBuffer | null} */ (null));
	let error = $state('');
	let peaks = $state.raw(/** @type {Float32Array | null} */ (null));
	/** @type {any} */
	let sync = null;
	/** @type {HTMLCanvasElement | undefined} */
	let canvas = $state();
	let width = $state(0);
	let hear = $state(true);
	/** a field being dragged shows its value before it is committed @type {Record<string, number> | null} */
	let draft = $state(null);
	let previewUrl = '';

	const saved = $derived($soundEdits.edits[hash] ?? null);
	const duration = $derived(buffer?.duration ?? 0);
	const NO_EDIT = { start: 0, end: 0, fadeIn: 0, fadeOut: 0, normalize: false };
	const e = $derived({ ...NO_EDIT, ...(saved ?? {}), ...(draft ?? {}) });
	const endAt = $derived(e.end || duration);
	const length = $derived(Math.max(0, endAt - e.start));

	// the sound, decoded once per file
	$effect(() => {
		const id = itemId;
		let stale = false;
		buffer = null;
		peaks = null;
		error = '';
		(async () => {
			try {
				const blob = await itemBlob(id);
				if (!blob) throw new Error('The bytes for this file are not on this device.');
				const decoded = await ensureAudioContext().decodeAudioData(await blob.arrayBuffer());
				sync ??= await import('$lib/soundEditSync.js');
				if (stale) return;
				buffer = decoded;
				peaks = sync.waveformPeaks(decoded, 600);
			} catch (err) {
				if (!stale) error = 'This sound could not be read for editing.';
			}
		})();
		return () => {
			stale = true;
		};
	});

	// what the window plays: the edit (when there is one and Hear the edit is on), else the file
	$effect(() => {
		const b = buffer;
		const s = saved;
		const on = hear;
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrl = '';
		if (b && s && on && sync) {
			const wav = sync.previewWav(b, s);
			if (wav) previewUrl = URL.createObjectURL(wav);
		}
		onpreview(previewUrl);
	});
	onDestroy(() => {
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		onpreview('');
	});

	// the waveform
	$effect(() => {
		const c = canvas;
		const p = peaks;
		const w = width;
		const { start, fadeIn, fadeOut } = e;
		const end = endAt;
		if (!c || !p || !w || !duration) return;
		const dpr = window.devicePixelRatio || 1;
		const h = c.clientHeight || 72;
		c.width = Math.round(w * dpr);
		c.height = Math.round(h * dpr);
		const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		const css = getComputedStyle(c);
		const accent = css.getPropertyValue('--accent').trim() || 'currentColor';
		const faint = css.getPropertyValue('--text-faint').trim() || 'currentColor';
		const shade = css.getPropertyValue('--surface-2').trim() || 'transparent';
		g.clearRect(0, 0, w, h);
		const x = (/** @type {number} */ t) => (t / duration) * w;
		const n = p.length / 2;
		for (let k = 0; k < n; k++) {
			const t = (k / n) * duration;
			const inside = t >= start && t <= end;
			g.fillStyle = inside ? accent : faint;
			const px = (k / n) * w;
			const lo = p[k * 2];
			const hi = p[k * 2 + 1];
			g.fillRect(px, h / 2 - hi * (h / 2), Math.max(1, w / n), Math.max(1, (hi - lo) * (h / 2)));
		}
		// outside the kept part is dimmed
		g.globalAlpha = 0.6;
		g.fillStyle = shade;
		g.fillRect(0, 0, x(start), h);
		g.fillRect(x(end), 0, w - x(end), h);
		g.globalAlpha = 1;
		// the fades as ramps, the handles as lines
		g.strokeStyle = accent;
		g.lineWidth = 1.5;
		g.beginPath();
		g.moveTo(x(start), h);
		g.lineTo(x(start + fadeIn), 0);
		g.lineTo(x(end - fadeOut), 0);
		g.lineTo(x(end), h);
		g.stroke();
		g.lineWidth = 2;
		for (const t of [start, end]) {
			g.beginPath();
			g.moveTo(x(t), 0);
			g.lineTo(x(t), h);
			g.stroke();
		}
	});

	/** commit a change as one undo step (and to the room) @param {Record<string, any> | null} patch */
	async function commit(patch) {
		draft = null;
		sync ??= await import('$lib/soundEditSync.js');
		if (patch && 'end' in patch && duration && patch.end >= duration - 1e-3) patch = { ...patch, end: 0 };
		sync.commitSoundEdit(hash, patch);
	}

	/** @param {string} key @param {number} v */
	function preview(key, v) {
		draft = { ...(draft ?? {}), [key]: v };
	}

	const clampStart = (/** @type {number} */ v) => Math.max(0, Math.min(v, endAt - 0.05));
	const clampEnd = (/** @type {number} */ v) => Math.min(duration, Math.max(v, e.start + 0.05));

	/** the playhead in FILE time: while the edit plays, the player's clock starts at the edit's start */
	function fileTime() {
		const t = playhead();
		return previewUrl && saved ? saved.start + t : t;
	}
	/** I / O in the window: the start or the end at the playhead */
	export function markStart() {
		if (duration) void commit({ start: clampStart(fileTime()) });
	}
	export function markEnd() {
		if (duration) void commit({ end: clampEnd(fileTime()) });
	}
	export function ready() {
		return !!buffer;
	}

	// drag on the waveform: the nearer handle follows the pointer
	/** @type {'start' | 'end' | null} */
	let grabbing = null;
	/** @param {PointerEvent} ev */
	function timeAt(ev) {
		const r = /** @type {HTMLCanvasElement} */ (canvas).getBoundingClientRect();
		return Math.max(0, Math.min(duration, ((ev.clientX - r.left) / r.width) * duration));
	}
	/** @param {PointerEvent} ev */
	function down(ev) {
		if (!duration) return;
		const t = timeAt(ev);
		grabbing = Math.abs(t - e.start) <= Math.abs(t - endAt) ? 'start' : 'end';
		/** @type {HTMLCanvasElement} */ (canvas).setPointerCapture(ev.pointerId);
		move(ev);
	}
	/** @param {PointerEvent} ev */
	function move(ev) {
		if (!grabbing) return;
		const t = timeAt(ev);
		preview(grabbing, grabbing === 'start' ? clampStart(t) : clampEnd(t));
	}
	function up() {
		if (!grabbing) return;
		const key = grabbing;
		grabbing = null;
		const v = draft?.[key];
		if (typeof v === 'number') void commit({ [key]: v });
	}

	const fmt = (/** @type {number} */ s) => (Math.round(s * 100) / 100).toFixed(2);
</script>

<div id="sound-edit" class="se-root" data-edited={saved ? 'yes' : ''} data-start={e.start} data-end={e.end} data-fade-in={e.fadeIn} data-fade-out={e.fadeOut} data-normalize={e.normalize ? 'yes' : ''}>
	{#if error}
		<p class="se-error">{error}</p>
	{:else if !buffer}
		<p class="se-dim">Reading the sound…</p>
	{:else}
		<div class="se-wave" bind:clientWidth={width}>
			<canvas
				bind:this={canvas}
				id="sound-edit-wave"
				class="se-canvas"
				title="Drag to move the nearer handle: the start or the end of the part that plays"
				aria-label="Waveform: the kept part is between the two handles"
				onpointerdown={down}
				onpointermove={move}
				onpointerup={up}
				onpointercancel={up}
			></canvas>
		</div>
		<div class="se-grid">
			<label class="se-field" title="Where the sound starts playing (I sets it at the playhead)">
				<span>Start</span>
				<input id="sound-edit-start" class="ui-input se-num" type="number" min="0" max={duration} step="0.01" value={fmt(e.start)} onchange={(ev) => commit({ start: clampStart(Number(ev.currentTarget.value)) })} />
			</label>
			<label class="se-field" title="Where it stops (O sets it at the playhead)">
				<span>End</span>
				<input id="sound-edit-end" class="ui-input se-num" type="number" min="0" max={duration} step="0.01" value={fmt(endAt)} onchange={(ev) => commit({ end: clampEnd(Number(ev.currentTarget.value)) })} />
			</label>
			<label class="se-field" title="Fade in over this many seconds from the start">
				<span>Fade in</span>
				<input id="sound-edit-fade-in" class="tp-tr-range se-range" type="range" min="0" max={Math.min(MAX_FADE, length)} step="0.05" value={e.fadeIn} oninput={(ev) => preview('fadeIn', Number(ev.currentTarget.value))} onchange={(ev) => commit({ fadeIn: Number(ev.currentTarget.value) })} />
				<span class="se-val">{fmt(e.fadeIn)} s</span>
			</label>
			<label class="se-field" title="Fade out over this many seconds before the end">
				<span>Fade out</span>
				<input id="sound-edit-fade-out" class="tp-tr-range se-range" type="range" min="0" max={Math.min(MAX_FADE, length)} step="0.05" value={e.fadeOut} oninput={(ev) => preview('fadeOut', Number(ev.currentTarget.value))} onchange={(ev) => commit({ fadeOut: Number(ev.currentTarget.value) })} />
				<span class="se-val">{fmt(e.fadeOut)} s</span>
			</label>
		</div>
		<div class="se-row">
			<label class="se-check" title="Make the loudest moment reach -1 dB, so a quiet recording plays as loud as the rest">
				<input id="sound-edit-normalize" class="tp-check" type="checkbox" checked={e.normalize} onchange={(ev) => commit({ normalize: ev.currentTarget.checked })} /> Normalise
			</label>
			<label class="se-check" title="Play the edit here (off: the original file)">
				<input id="sound-edit-hear" class="tp-check" type="checkbox" bind:checked={hear} /> Hear the edit
			</label>
			<span class="se-dim se-len">{formatClock(length)} of {formatClock(duration)}</span>
			<button
				id="sound-edit-reset"
				type="button"
				class="se-btn"
				disabled={!saved}
				title="Back to the original sound (the file was never changed)"
				onclick={() => commit(null)}
			>
				<Icon name="rotate-ccw" size={16} aria-hidden="true" /> Reset
			</button>
		</div>
		<p class="se-dim">Applies wherever this scene plays the sound: sound nodes, timeline clips, the music track and videos. The file in the library stays as it is.</p>
	{/if}
</div>

<style>
	.se-root {
		display: flex;
		width: 100%;
		flex-direction: column;
		gap: 6px;
		font-size: 11px;
	}
	.se-wave {
		width: 100%;
	}
	.se-canvas {
		display: block;
		width: 100%;
		height: 72px;
		border-radius: 4px;
		background: var(--surface-1);
		cursor: ew-resize;
		touch-action: none;
	}
	.se-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: 4px 12px;
	}
	.se-field,
	.se-row,
	.se-check {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.se-field > span:first-child {
		width: 52px;
		flex: none;
		color: var(--text-muted);
	}
	.se-num {
		width: 76px;
	}
	.se-range {
		flex: 1;
		min-width: 60px;
	}
	.se-val {
		width: 44px;
		text-align: right;
		color: var(--text-muted);
	}
	.se-row {
		flex-wrap: wrap;
		gap: 12px;
	}
	.se-len {
		margin-left: auto;
	}
	.se-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: transparent;
		color: var(--text);
		cursor: pointer;
	}
	.se-btn:disabled {
		cursor: default;
		opacity: 0.5;
	}
	.se-dim {
		margin: 0;
		color: var(--text-muted);
	}
	.se-error {
		margin: 0;
		color: var(--ink-bad);
	}
</style>
