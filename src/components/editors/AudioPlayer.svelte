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

	/**
	 * R22 ROUND 17 (user): "for audio player also have , . and up/down shortcuts to select
	 * second to play from (maybe even play when holding, but don't play backwards)".
	 *
	 * THE WINDOW OWNS THE KEYBOARD (its listener is in capture phase on the window root —
	 * the documented rule for keys inside a panel), so the acts are published here and
	 * bound there. Same split as the animation transport one component over.
	 *
	 * A STEP HERE DOES NOT PAUSE, and that is the difference from the animation transport,
	 * where stepping a frame must pause or you cannot see the frame you stepped to. Sound
	 * is the opposite: holding "." while it plays IS the fast-forward the user asked for —
	 * each press jumps a second and the audio keeps running from there. Nothing can play
	 * backwards, because "." and "," both leave the element playing FORWARD from wherever
	 * they land; a media element has no reverse and pretending otherwise would mean
	 * decoding the file backwards by hand.
	 * @param {number} seconds
	 */
	export function nudge(seconds: number) {
		if (!el || !duration) return;
		const t = Math.max(0, Math.min(duration, (el.currentTime || 0) + seconds));
		el.currentTime = t;
		at = t;
	}
	/** @param {number} fraction */
	export function toFraction(fraction: number) {
		seekTo(fraction);
	}
	export function toggleMute() {
		muted = !muted;
	}
	export function toggleLoop() {
		loop = !loop;
	}
	export function nudgeVolume(by: number) {
		volume = Math.max(0, Math.min(1, volume + by));
		if (volume > 0) muted = false;
	}
	export function hasAudio() {
		return duration > 0;
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
	<div class="ap-strip tp-tr-strip">
		<button
			id="audio-toggle"
			class="ap-btn ap-play tp-tr-btn tp-tr-play"
			title={playing ? 'Pause (Space)' : 'Play (Space)'}
			data-keys=", . step 1s · up/down 5s · Home/End · 0-9 jump · M mute · L loop"
			aria-label={playing ? 'Pause' : 'Play'}
			disabled={!url}
			onclick={toggle}
		>
			{#if playing}<Pause size={16} aria-hidden="true" />{:else}<Play size={16} aria-hidden="true" />{/if}
		</button>
		<span class="ap-time tp-tr-time" id="audio-at">{formatClock(at)}</span>
		<input
			id="audio-seek"
			class="ap-seek tp-tr-range tp-tr-seek"
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
		<span class="ap-time tp-tr-time" id="audio-duration">{formatClock(duration)}</span>
		<button
			id="audio-mute"
			class="ap-btn tp-tr-btn"
			aria-pressed={muted}
			title={muted ? 'Unmute (M)' : 'Mute (M)'}
			aria-label={muted ? 'Unmute' : 'Mute'}
			onclick={() => (muted = !muted)}
		>
			{#if muted}<VolumeX size={14} aria-hidden="true" />{:else}<Volume2 size={14} aria-hidden="true" />{/if}
		</button>
		<input
			id="audio-volume"
			class="ap-vol tp-tr-range"
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
				class="ap-btn tp-tr-btn {loop ? 'ap-on tp-tr-on' : ''}"
				aria-pressed={loop}
				title="Loop (L)"
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
	/* R22 round 15: the strip's LOOK is `tp-tr-*` in ui.utilities.css now, shared with the
	   object preview's animation transport so "same player style" is a promise the code
	   keeps rather than two copies drifting. What stays here is what is this player's own:
	   the compact face, the volume slider's width, and the name/error lines. The `ap-*`
	   class names stay on the markup as hooks — several are load-bearing for the compact
	   override, and one is what the suite measures the strip's height with. */
	.ap-compact .ap-strip {
		height: 26px;
		gap: 4px;
		padding: 0 6px;
	}
	.ap-vol {
		flex: 0 0 56px;
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
