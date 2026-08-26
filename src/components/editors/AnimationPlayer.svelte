<script lang="ts">
	import { Pause, Play, SkipBack, SkipForward } from '@lucide/svelte';
	import { formatClock, frameAt, frameCount, previewFps } from '$lib/filePreview';

	/**
	 * R22 ROUND 15 (user): "add to object preview window to automatically play animation
	 * and be able to pause and slide animation using same player style, sliding updates
	 * frames, it should also show amount of frames and current frame where paused".
	 *
	 * PRESENTATION ONLY. It owns no mixer, no clock and no three.js — every gesture goes
	 * out through a callback to ModelPreview, which owns the AnimationMixer because the
	 * mixer is advanced by that component's render loop and by nothing else. This half is
	 * the chrome; that half is the engine. It is the AudioPlayer/ModelPreview split one
	 * domain over.
	 *
	 * "SAME PLAYER STYLE" is kept by SHARING THE STYLESHEET, not by copying it: the strip's
	 * look is `tp-tr-*` in ui.utilities.css (the `tp-seg` / `tp-check` precedent), so the
	 * two transports cannot drift the way two copies would. What differs is what sits
	 * beside the seek bar, and it should differ — audio has volume, mute and loop; this has
	 * a frame counter and, when a file carries more than one, a clip picker.
	 *
	 * WHY FRAMES AND SECONDS ARE BOTH SHOWN. A glTF clip is keyed in seconds, so frames are
	 * a derived reading (see `frameCount`) — but frames are the unit an animator checks a
	 * file in, which is what the user asked for. Showing only frames would hide that the
	 * rate is an assumption; showing only seconds answers the wrong question. The rate is
	 * named in the tooltip so nobody has to guess which one it used.
	 */
	let {
		anim = null,
		onPlay,
		onSeek,
		onClip
	}: {
		/** `{clips, index, duration, playing, time}` from ModelPreview, or null for a still
		 * file — in which case this renders NOTHING, rather than a dead transport. */
		anim?: any;
		onPlay?: (on: boolean) => void;
		onSeek?: (t: number) => void;
		onClip?: (i: number) => void;
	} = $props();

	/**
	 * WHERE THE PLAYHEAD IS, ACCORDING TO US — null means "follow the mixer".
	 *
	 * R22 ROUND 16 (user): "using forward shortcut holding it sometimes hangs after ~150
	 * frames and do not proceed with a shortcut further". TWO causes, and this state fixes
	 * the first of them.
	 *
	 * A step used to be computed from the frame the READOUT was showing, and that reading
	 * comes back from ModelPreview through a callback. Under key repeat — 30-odd presses a
	 * second — several steps are computed from the same stale frame before the first
	 * answer arrives, so they all land on the same place and the counter stops climbing
	 * while the key is still down. Holding an accelerating key is exactly the case that
	 * outruns a round trip.
	 *
	 * So while we are driving, WE hold the position: each step advances our own number and
	 * tells the mixer where to go, and the mixer's reports are ignored until playback takes
	 * over again. The scrub uses the same field for the same reason it always did — a
	 * readout that follows the pointer rather than the engine cannot fight itself.
	 */
	let localAt: number | null = $state(null);
	let scrubbing = $state(false);

	const fps = previewFps();
	const duration = $derived(Number(anim?.duration) || 0);
	const playing = $derived(!!anim?.playing);
	const at = $derived(localAt ?? (Number(anim?.time) || 0));

	// once it is running again the mixer is the truth, so let go
	$effect(() => {
		if (playing && !scrubbing) localAt = null;
	});
	const total = $derived(frameCount(duration, fps));
	const frame = $derived(frameAt(at, duration, fps));
	const clips = $derived(Array.isArray(anim?.clips) ? anim.clips : []);

	/**
	 * A step is ONE FRAME, which is what the buttons either side of a frame counter mean
	 * anywhere else. Stepping pauses first: a nudge you cannot see because playback ran on
	 * past it is not a step.
	 *
	 * IT WRAPS, and that is the second half of the reported stall. A clip's last frame used
	 * to be a dead end — hold the key and the counter climbs to the end and simply stops,
	 * which is indistinguishable from the shortcut having died (the user reported it as
	 * "hangs after ~150 frames", which is the length of their clip). Playback loops here, so
	 * stepping loops: past the end is frame 1, before the start is the last frame.
	 */
	function step(by: number) {
		if (!duration) return;
		onPlay?.(false);
		const totalFrames = frameCount(duration, fps);
		const current = frameAt(at, duration, fps) - 1; // 0-based
		const next = (((current + by) % totalFrames) + totalFrames) % totalFrames;
		const t = Math.min(duration, next / fps);
		localAt = t;
		onSeek?.(t);
	}

	// the window owns the keyboard (its listener is in CAPTURE phase on the window root,
	// the documented rule for keys inside a panel), so the two gestures it binds are
	// published from here rather than reimplemented there with a second copy of the frame
	// arithmetic
	export function toggle() {
		onPlay?.(!playing);
	}
	export function stepFrame(by: number) {
		step(by);
	}
	export function hasClip() {
		return duration > 0;
	}

	function onSeekInput(e: Event) {
		const v = Number((e.currentTarget as HTMLInputElement).value);
		localAt = (v / 1000) * duration;
		// LIVE, as asked ("sliding updates frames"): the pose follows the handle rather
		// than waiting for the release, which is the whole point of scrubbing a clip
		onSeek?.(localAt);
	}
	function onSeekCommit(e: Event) {
		const v = Number((e.currentTarget as HTMLInputElement).value);
		localAt = (v / 1000) * duration;
		onSeek?.(localAt);
		scrubbing = false;
		// if it is still running, hand the playhead back to the mixer on the next report
		if (playing) localAt = null;
	}
</script>

{#if anim && duration > 0}
	<!--
		Over the canvas, at its foot, the way a video player's controls sit over the picture:
		a transport that reserved layout would shrink the model on every animated file and
		leave a gap on every still one.
	-->
	<div class="an-root" data-playing={playing}>
		<div class="tp-tr-strip an-strip">
			<button
				id="anim-toggle"
				class="tp-tr-btn tp-tr-play"
				title={playing ? 'Pause (Space)' : 'Play (Space)'}
				aria-label={playing ? 'Pause' : 'Play'}
				onclick={() => onPlay?.(!playing)}
			>
				{#if playing}<Pause size={16} aria-hidden="true" />{:else}<Play size={16} aria-hidden="true" />{/if}
			</button>
			<button
				id="anim-prev-frame"
				class="tp-tr-btn"
				title="Previous frame (,)"
				aria-label="Previous frame"
				onclick={() => step(-1)}
			>
				<SkipBack size={13} aria-hidden="true" />
			</button>
			<button
				id="anim-next-frame"
				class="tp-tr-btn"
				title="Next frame (.)"
				aria-label="Next frame"
				onclick={() => step(1)}
			>
				<SkipForward size={13} aria-hidden="true" />
			</button>
			<input
				id="anim-seek"
				class="tp-tr-range tp-tr-seek"
				type="range"
				min="0"
				max="1000"
				step="1"
				aria-label="Animation position"
				value={duration ? Math.round((at / duration) * 1000) : 0}
				onpointerdown={() => (scrubbing = true)}
				oninput={onSeekInput}
				onchange={onSeekCommit}
				onpointerup={onSeekCommit}
			/>
			<!-- the reading the user asked for: where you are, and how much there is -->
			<span
				id="anim-frames"
				class="tp-tr-time an-frames"
				title="Frame {frame} of {total}, counted at {fps} fps">{frame}/{total}</span
			>
			<span class="tp-tr-time an-clock" id="anim-clock">{formatClock(at)} / {formatClock(duration)}</span>
			{#if clips.length > 1}
				<!-- only when there is a choice to make. A picker showing one item is a label
				     pretending to be a control. -->
				<select
					id="anim-clip"
					class="an-clip"
					aria-label="Clip"
					value={String(anim.index ?? 0)}
					onchange={(e) => onClip?.(Number((e.currentTarget as HTMLSelectElement).value))}
				>
					{#each clips as c, i (i)}
						<option value={String(i)}>{c.name}</option>
					{/each}
				</select>
			{/if}
		</div>
	</div>
{/if}

<style>
	.an-root {
		position: absolute;
		right: 6px;
		bottom: 6px;
		left: 6px;
		z-index: 2;
	}
	.an-strip {
		/* it sits over a rendered picture rather than a panel, so it carries its own
		   backdrop — the surface token alone is opaque enough to lose the model behind it
		   in light themes and too transparent to read against a bright one */
		border-color: rgb(255 255 255 / 12%);
		background: rgb(17 24 39 / 82%);
		backdrop-filter: blur(4px);
	}
	.an-frames {
		min-width: 46px;
		text-align: right;
		color: #e5e7eb;
	}
	.an-clock {
		flex: 0 0 auto;
	}
	.an-clip {
		max-width: 92px;
		flex: 0 0 auto;
		border: 1px solid var(--border, #374151);
		border-radius: 3px;
		background: var(--surface, #1f2937);
		padding: 1px 4px;
		font-size: 10px;
		color: #d1d5db;
	}
	/* the two readings are the first thing to go when there is no room for them: the
	   transport itself has to survive a narrow window, the numbers beside it need not */
	@media (max-width: 420px) {
		.an-clock {
			display: none;
		}
	}
</style>
