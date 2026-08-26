<script lang="ts">
	import { Pause, Play, Repeat, Volume2, VolumeX } from '@lucide/svelte';
	import { itemBlob } from '$lib/explorer';
	import { formatClock } from '$lib/filePreview';

	/**
	 * R22 round 11 (user): "I should be able to double click to open audio preview in a
	 * window, make fancy player for this with draggable slider and it should be slim wide
	 * even if height of a window will be big, play/pause with space" — and, separately,
	 * "plus same preview in properties as 3d preview for objects", which is what makes
	 * this a COMPONENT rather than markup inside the window. It is the AudioPlayer the
	 * ModelPreview canvas already is for objects: one implementation, two consumers (the
	 * preview window and the Properties pane), so the two cannot drift.
	 *
	 * IT IS AN `<audio>` ELEMENT, not a Web Audio graph, and that is a decision. Duration,
	 * seeking, buffering and loop are the element's job and it does them correctly for a
	 * file of any length; the same player built on an AudioBufferSourceNode would have to
	 * decode the WHOLE file before it could say how long it is, and would re-implement
	 * seeking. The `muted`/`volume` values are set as PROPERTIES through an action, never
	 * as attributes — the documented rule for media elements in this app.
	 *
	 * WHERE THE SOUND GOES, and this is the seam to change: today the element plays
	 * straight to the system output, which is what every media element in a browser does
	 * and what this app has always done for previews. `feat/22-audio-engine` adds a master
	 * bus (audioEngine.js), and once it lands a preview should ride the `sfx` bus so the
	 * master fader and the limiter reach it. That is ONE call in `routeOutput` below —
	 * `createMediaElementSource(el).connect(bus('sfx'))` — deliberately isolated here so
	 * the merge is a line rather than an argument. It is NOT done speculatively: the
	 * module does not exist on this branch, and a dynamic import of a missing file is a
	 * build hazard rather than a graceful fallback.
	 */
	let {
		itemId = '',
		src = '',
		name = '',
		compact = false,
		autoFocus = false
	}: {
		itemId?: string;
		src?: string;
		name?: string;
		/** the Properties pane's version: no loop button, tighter padding */
		compact?: boolean;
		autoFocus?: boolean;
	} = $props();

	let el: HTMLAudioElement | undefined = $state();
	let url = $state('');
	let ownsUrl = false;
	let error = $state('');
	let playing = $state(false);
	let at = $state(0);
	let duration = $state(0);
	let volume = $state(1);
	let muted = $state(false);
	let loop = $state(false);
	/** while the slider is held the READOUT follows the pointer, not the element */
	let scrubbing = $state(false);

	// resolve the bytes. An Explorer item is a blob in idb; `src` is for a caller that
	// already has a URL (the Scene view's derived audio rows).
	$effect(() => {
		const id = itemId;
		const direct = src;
		let stale = false;
		error = '';
		if (direct) {
			url = direct;
			ownsUrl = false;
			return;
		}
		if (!id) {
			url = '';
			return;
		}
		(async () => {
			const blob = await itemBlob(id);
			if (stale) return;
			if (!blob) {
				error = 'The bytes for this file are not on this device.';
				url = '';
				return;
			}
			if (ownsUrl && url) URL.revokeObjectURL(url);
			url = URL.createObjectURL(blob);
			ownsUrl = true;
		})();
		return () => {
			stale = true;
		};
	});

	// the object URL is ours to release, and the element is ours to stop — a player left
	// running behind a closed window is the oldest bug in media UI
	$effect(() => () => {
		try {
			el?.pause();
		} catch {}
		if (ownsUrl && url) URL.revokeObjectURL(url);
	});

	/**
	 * Volume and mute are set as PROPERTIES, the documented media-element rule — from an
	 * EFFECT, not from the action below.
	 *
	 * An action with no parameter never has its `update` called: svelte runs it once on
	 * mount and only re-runs it when the parameter changes, and there is no parameter here.
	 * So the first version wrote both values exactly once and the fader and the mute button
	 * were dead controls that looked perfectly alive.
	 */
	$effect(() => {
		if (!el) return;
		el.volume = volume;
		el.muted = muted;
	});

	/** the mount hook: focus, and the seam the audio-engine merge changes (see the header) */
	function routeOutput(node: HTMLAudioElement) {
		node.volume = volume;
		node.muted = muted;
		if (autoFocus) setTimeout(() => node.focus?.(), 0);
	}

	export function toggle() {
		if (!el) return;
		if (el.paused) void el.play().catch(() => (error = 'This file could not be played.'));
		else el.pause();
	}
	export function isPlaying() {
		return playing;
	}

	function seekTo(fraction: number) {
		if (!el || !duration) return;
		const t = Math.max(0, Math.min(duration, fraction * duration));
		el.currentTime = t;
		at = t;
	}
	/** the slider is a real range input, so a drag, a click on the track and the arrow keys
	 * all come for free — and it is what a screen reader can operate */
	function onSeekInput(e: Event) {
		const v = Number((e.currentTarget as HTMLInputElement).value);
		at = (v / 1000) * (duration || 0);
		if (!scrubbing) seekTo(v / 1000);
	}
	function onSeekCommit(e: Event) {
		scrubbing = false;
		seekTo(Number((e.currentTarget as HTMLInputElement).value) / 1000);
	}
</script>

<!--
	SLIM AND WIDE WHATEVER THE WINDOW DOES. The user asked for exactly this: "it should be
	slim wide even if height of a window will be big". So the controls are a fixed-height
	strip and the space above them is empty rather than stretched — a transport scaled to
	400px tall is not a better transport, it is a worse one.
-->
<div class="ap-root {compact ? 'ap-compact' : ''}" data-playing={playing}>
	{#if url}
		<!-- svelte-ignore a11y_media_has_caption -->
		<audio
			bind:this={el}
			src={url}
			{loop}
			use:routeOutput
			onplay={() => (playing = true)}
			onpause={() => (playing = false)}
			onended={() => (playing = false)}
			ontimeupdate={() => {
				if (!scrubbing) at = el?.currentTime ?? 0;
			}}
			onloadedmetadata={() => (duration = Number.isFinite(el?.duration) ? (el?.duration ?? 0) : 0)}
			onerror={() => (error = 'This file could not be played.')}
		></audio>
	{/if}
	<div class="ap-strip">
		<button
			id="audio-toggle"
			class="ap-btn ap-play"
			title={playing ? 'Pause (Space)' : 'Play (Space)'}
			aria-label={playing ? 'Pause' : 'Play'}
			disabled={!url}
			onclick={toggle}
		>
			{#if playing}<Pause size={16} aria-hidden="true" />{:else}<Play size={16} aria-hidden="true" />{/if}
		</button>
		<span class="ap-time" id="audio-at">{formatClock(at)}</span>
		<input
			id="audio-seek"
			class="ap-seek"
			type="range"
			min="0"
			max="1000"
			step="1"
			aria-label="Position"
			disabled={!duration}
			value={duration ? Math.round((at / duration) * 1000) : 0}
			onpointerdown={() => (scrubbing = true)}
			oninput={onSeekInput}
			onchange={onSeekCommit}
			onpointerup={onSeekCommit}
		/>
		<span class="ap-time" id="audio-duration">{formatClock(duration)}</span>
		<button
			id="audio-mute"
			class="ap-btn"
			aria-pressed={muted}
			title={muted ? 'Unmute' : 'Mute'}
			aria-label={muted ? 'Unmute' : 'Mute'}
			onclick={() => (muted = !muted)}
		>
			{#if muted}<VolumeX size={14} aria-hidden="true" />{:else}<Volume2 size={14} aria-hidden="true" />{/if}
		</button>
		<input
			id="audio-volume"
			class="ap-vol"
			type="range"
			min="0"
			max="100"
			step="1"
			aria-label="Volume"
			value={Math.round(volume * 100)}
			oninput={(e) => ((volume = Number((e.currentTarget as HTMLInputElement).value) / 100), (muted = false))}
		/>
		{#if !compact}
			<button
				id="audio-loop"
				class="ap-btn {loop ? 'ap-on' : ''}"
				aria-pressed={loop}
				title="Loop"
				aria-label="Loop"
				onclick={() => (loop = !loop)}
			>
				<Repeat size={14} aria-hidden="true" />
			</button>
		{/if}
	</div>
	{#if error}
		<p id="audio-error" class="ap-error">{error}</p>
	{:else if !compact && name}
		<p class="ap-name" title={name}>{name}</p>
	{/if}
</div>

<style>
	.ap-root {
		display: flex;
		width: 100%;
		flex-direction: column;
		gap: 4px;
	}
	.ap-strip {
		display: flex;
		height: 30px;
		flex: 0 0 auto;
		align-items: center;
		gap: 6px;
		border: 1px solid var(--border, #374151);
		border-radius: 4px;
		background: var(--surface, #1f2937);
		padding: 0 8px;
	}
	.ap-compact .ap-strip {
		height: 26px;
		gap: 4px;
		padding: 0 6px;
	}
	.ap-btn {
		display: flex;
		height: 20px;
		width: 20px;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		border-radius: 3px;
		color: #d1d5db;
	}
	.ap-btn:hover {
		background: rgb(255 255 255 / 8%);
		color: #fff;
	}
	.ap-btn:disabled {
		opacity: 0.4;
	}
	.ap-play {
		color: var(--accent, #3b82f6);
	}
	.ap-on {
		background: var(--accent, #3b82f6);
		color: #fff;
	}
	.ap-time {
		flex: 0 0 auto;
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		color: #9ca3af;
	}
	/* the seek bar is the one thing that grows; everything beside it is fixed, which is
	   what keeps the strip the same height in a tall window */
	.ap-seek {
		min-width: 0;
		flex: 1;
	}
	.ap-vol {
		flex: 0 0 56px;
	}
	.ap-seek,
	.ap-vol {
		height: 4px;
		appearance: none;
		border-radius: 2px;
		background: #4b5563;
		cursor: pointer;
	}
	.ap-seek::-webkit-slider-thumb,
	.ap-vol::-webkit-slider-thumb {
		height: 11px;
		width: 11px;
		appearance: none;
		border-radius: 50%;
		background: var(--accent, #3b82f6);
	}
	.ap-seek::-moz-range-thumb,
	.ap-vol::-moz-range-thumb {
		height: 11px;
		width: 11px;
		border: 0;
		border-radius: 50%;
		background: var(--accent, #3b82f6);
	}
	.ap-seek:disabled,
	.ap-vol:disabled {
		opacity: 0.5;
	}
	.ap-name,
	.ap-error {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 10px;
	}
	.ap-name {
		color: #6b7280;
	}
	.ap-error {
		color: #f87171;
	}
</style>
