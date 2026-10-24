<script>
	// 64-2d: Inspector ▸ Sprite — the image, the sheet grid, the flipbook clips and how it draws.
	// Its own component (one Inspector line, the settings merge rule). Writes go through
	// spriteActions: replicated, one undo entry each. The image is the material map (lossless
	// PNG); the Preview button plays a clip HERE only (a node plays it for everyone).
	import InsToggle from '../menu/inspector/InsToggle.svelte';
	import Section from '../ui/Section.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import { sceneRevision } from '../../stores/sceneStore';
	import { normalizeSprite, compactSprite, parseFramesText, framesText, parseEventsText, eventsText, MAX_SHEET_SIDE } from '$lib/sprite2d/spriteCore.js';
	import { setSpriteFor, setSpriteImage } from '$lib/sprite2d/spriteActions.js';
	import { playSpriteClip, resetSpritePlayback, spriteStatus } from '$lib/sprite2d/spriteRuntime.js';

	/** @type {{object: any}} */
	let { object } = $props();
	// $sceneRevision: an edit (ours, a peer's, an undo) replaces userData.sprite on the same object
	const s = $derived.by(() => ($sceneRevision >= 0 ? normalizeSprite(object?.userData?.sprite) : normalizeSprite({})));
	const thumb = $derived.by(() => ($sceneRevision >= 0 ? (object?.material?.userData?.mapDataUrl ?? '') : ''));
	const clipItems = $derived([{ value: '', name: 'None (static frame)' }, ...s.clips.map((c) => ({ value: c.name, name: c.name }))]);
	const keywords = 'sprite sheet flipbook frames animation pixel art 2d clip fps loop ping pong events nearest filter snap';

	/** @type {HTMLInputElement | null} */
	let fileInput = $state(null);
	/** what is showing, refreshed a few times a second while the section is open */
	let status = $state(/** @type {any} */ (null));
	$effect(() => {
		const o = object;
		const id = setInterval(() => (status = spriteStatus(o)), 250);
		return () => clearInterval(id);
	});

	/** @param {any} patch */
	function set(patch) {
		setSpriteFor(object.uuid, patch);
	}
	/** @param {any} e */
	async function pickImage(e) {
		const file = e.currentTarget.files?.[0];
		e.currentTarget.value = '';
		if (file) await setSpriteImage([object.uuid], file);
	}
	/** the clip list as stored, with one clip patched @param {number} i @param {any} patch */
	function setClip(i, patch) {
		const clips = compactSprite(s).clips?.slice() ?? [];
		const next = { ...clips[i], ...patch };
		if ('frames' in patch && !patch.frames) delete next.frames;
		if (patch.frames) {
			delete next.from;
			delete next.to;
		}
		clips[i] = next;
		const renamed = patch.name !== undefined && s.clips[i].name !== patch.name;
		set({ clips, ...(renamed && s.play === s.clips[i].name ? { play: patch.name } : {}) });
	}
	function addClip() {
		const clips = compactSprite(s).clips?.slice() ?? [];
		let n = clips.length + 1;
		while (s.clips.some((c) => c.name.toLowerCase() === 'clip ' + n)) n++;
		clips.push({ name: 'Clip ' + n, from: 0, to: Math.max(0, s.sheet.count - 1), fps: 12 });
		set({ clips });
	}
	/** @param {number} i */
	function removeClip(i) {
		const clips = compactSprite(s).clips?.slice() ?? [];
		const [gone] = clips.splice(i, 1);
		set({ clips, ...(s.play === gone?.name ? { play: '' } : {}) });
	}
	/** @param {number} i @param {string} text */
	function setFrames(i, text) {
		const parsed = parseFramesText(text);
		if (parsed) setClip(i, parsed.frames ? { frames: parsed.frames } : { frames: null, from: parsed.from, to: parsed.to });
	}
</script>

<div data-keywords={keywords} class="contents">
	<Section variant="panel" label="Sprite">
		<div data-tour="sprite" class="contents">
			<div class="ui-row items-center gap-2">
				<span class="w-20 shrink-0 text-xs text-text-muted">Image</span>
				{#if thumb}
					<img id="sprite-thumb" src={thumb} alt="Sprite sheet" class="h-8 max-w-24 rounded-sm border border-border-strong object-contain" style="image-rendering: pixelated" />
				{/if}
				<button id="sprite-image" class="ui-chip bg-surface-active text-text-2 hover:bg-surface-hover" onclick={() => fileInput?.click()}>
					{thumb ? 'Replace…' : 'Choose image…'}
				</button>
				<input bind:this={fileInput} type="file" accept="image/*" class="hidden" aria-label="Sprite image" onchange={pickImage} />
			</div>
			<div class="ui-row items-center gap-2" title="Nearest keeps pixel art crisp; Linear smooths painted art">
				<span class="w-20 shrink-0 text-xs text-text-muted">Filter</span>
				<ThemedSelect
					id="sprite-filter"
					items={[
						{ value: 'nearest', name: 'Pixel (nearest)' },
						{ value: 'linear', name: 'Smooth (linear)' }
					]}
					value={s.filter}
					onchange={(/** @type {any} */ v) => set({ filter: v })}
				/>
			</div>
			<SliderRow id="sprite-ppu" label="Pixels / m" min={1} max={256} step={1} decimals={0} value={s.ppu} onchange={(v) => set({ ppu: v })} />
			<InsToggle id="sprite-snap" checked={s.snap} onchange={(/** @type {any} */ e) => set({ snap: e.currentTarget.checked })}>Pixel snap</InsToggle>

			<p class="text-[length:var(--fs-badge)] font-semibold uppercase tracking-wide text-text-muted">Sheet</p>
			<SliderRow id="sprite-cols" label="Columns" min={1} max={MAX_SHEET_SIDE} step={1} decimals={0} value={s.sheet.cols} onchange={(v) => set({ sheet: { cols: v, count: Math.round(v) * s.sheet.rows } })} />
			<SliderRow id="sprite-rows" label="Rows" min={1} max={MAX_SHEET_SIDE} step={1} decimals={0} value={s.sheet.rows} onchange={(v) => set({ sheet: { rows: v, count: s.sheet.cols * Math.round(v) } })} />
			<SliderRow id="sprite-count" label="Frames" min={1} max={s.sheet.cols * s.sheet.rows} step={1} decimals={0} value={s.sheet.count} onchange={(v) => set({ sheet: { count: v } })} />
			<SliderRow id="sprite-margin" label="Margin px" min={0} max={64} step={1} decimals={0} value={s.sheet.margin} onchange={(v) => set({ sheet: { margin: v } })} />
			<SliderRow id="sprite-spacing" label="Spacing px" min={0} max={64} step={1} decimals={0} value={s.sheet.spacing} onchange={(v) => set({ sheet: { spacing: v } })} />
			<SliderRow id="sprite-frame" label="Frame" min={0} max={Math.max(0, s.sheet.count - 1)} step={1} decimals={0} value={s.frame} onchange={(v) => set({ frame: v })} />
			<InsToggle id="sprite-flip-x" checked={s.flipX} onchange={(/** @type {any} */ e) => set({ flipX: e.currentTarget.checked })}>Flip horizontally</InsToggle>
			<InsToggle id="sprite-flip-y" checked={s.flipY} onchange={(/** @type {any} */ e) => set({ flipY: e.currentTarget.checked })}>Flip vertically</InsToggle>

			<p class="text-[length:var(--fs-badge)] font-semibold uppercase tracking-wide text-text-muted">Clips</p>
			{#each s.clips as clip, i (clip.name + ':' + i)}
				<div class="sprite-clip flex flex-col gap-1 rounded-sm border border-border p-1.5" data-clip={clip.name}>
					<div class="ui-row items-center gap-1">
						<input class="ui-input sprite-clip-name min-w-0 flex-1" aria-label="Clip name" value={clip.name} onchange={(e) => e.currentTarget.value.trim() && setClip(i, { name: e.currentTarget.value.trim() })} />
						<button
							class="sprite-clip-preview ui-chip bg-surface-active text-text-2 hover:bg-surface-hover"
							title="Play this clip here (only you see the preview)"
							onclick={() => playSpriteClip(object, clip.name, { action: 'restart' })}>Preview</button
						>
						<button class="sprite-clip-remove ui-chip text-text-muted hover:bg-surface-hover" title="Remove clip" aria-label={'Remove clip ' + clip.name} onclick={() => removeClip(i)}>✕</button>
					</div>
					<div class="ui-row items-center gap-1">
						<span class="w-12 shrink-0 text-xs text-text-muted">Frames</span>
						<input class="ui-input sprite-clip-frames min-w-0 flex-1" aria-label="Clip frames" title="0-3 = a range (3-0 plays backwards), 0,1,2,1 = these frames" value={framesText(clip)} onchange={(e) => setFrames(i, e.currentTarget.value)} />
						<span class="text-xs text-text-muted">fps</span>
						<input class="ui-input sprite-clip-fps w-12" type="number" min="0.1" max="120" step="1" aria-label="Clip frames per second" value={clip.fps} onchange={(e) => setClip(i, { fps: Number(e.currentTarget.value) })} />
					</div>
					<div class="ui-row items-center gap-1">
						<span class="w-12 shrink-0 text-xs text-text-muted">Plays</span>
						<ThemedSelect
							class="sprite-clip-loop"
							items={[
								{ value: 'loop', name: 'Loop' },
								{ value: 'once', name: 'Once' },
								{ value: 'pingpong', name: 'Ping-pong' }
							]}
							value={clip.loop}
							onchange={(/** @type {any} */ v) => setClip(i, { loop: v })}
						/>
						{#if clip.loop === 'once'}
							<ThemedSelect
								class="sprite-clip-next"
								title="The clip that plays when this one ends"
								items={[{ value: '', name: 'then hold' }, ...s.clips.filter((c) => c.name !== clip.name).map((c) => ({ value: c.name, name: 'then ' + c.name }))]}
								value={clip.next}
								onchange={(/** @type {any} */ v) => setClip(i, { next: v })}
							/>
						{/if}
					</div>
					<div class="ui-row items-center gap-1">
						<span class="w-12 shrink-0 text-xs text-text-muted">Events</span>
						<input
							class="ui-input sprite-clip-events min-w-0 flex-1"
							aria-label="Clip events"
							placeholder="2:footstep, 5:footstep"
							title="frame:name pairs — the frame counts inside the clip; an Animation Marker node hears the name"
							value={eventsText(clip.events)}
							onchange={(e) => setClip(i, { events: parseEventsText(e.currentTarget.value) })}
						/>
					</div>
				</div>
			{/each}
			<button id="sprite-add-clip" class="ui-chip bg-surface-active text-text-2 hover:bg-surface-hover" onclick={addClip}>Add clip</button>
			<div class="ui-row items-center gap-2" title="Plays on its own for everyone; a Play Animation node can switch clips">
				<span class="w-20 shrink-0 text-xs text-text-muted">Autoplay</span>
				<ThemedSelect id="sprite-autoplay" items={clipItems} value={s.play} onchange={(/** @type {any} */ v) => (resetSpritePlayback(object.uuid), set({ play: v }))} />
			</div>
			<p id="sprite-status" class="mt-1 text-[length:var(--fs-badge)] text-text-muted">
				{#if status?.clip}Showing {status.clip}, frame {status.frame}{status.playing ? '' : ' (ended)'}{status.explicit ? '' : ' · autoplay'}{:else if status}Static frame {status.frame}{/if}
			</p>
		</div>
	</Section>
</div>
