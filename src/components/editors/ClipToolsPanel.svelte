<script>
	// 57 M3 + M8 — the CLIP TOOLS under the Animation window's clip list, for a model with clip
	// assets (.tpanim) and/or clips of its own:
	//  · per clip (a ref setting, no new file): In place / Moving, loop or play once, speed, rename,
	//    remove; its fps · frames · length and the LOOP SEAM check;
	//  · motion edits (a NEW file, the model switches to it in one undo step): Loop it, Trim to the
	//    in/out markers, Split at the playhead, Join picked clips with a crossfade;
	//  · Extract clips: the model's own clips become .tpanim files (optionally used instead).
	// The playhead here is a LOCAL preview (a held pose driver): scrubbing is never sent.
	import { onDestroy, untrack } from 'svelte';
	import { clipRefsOf, embeddedClipsOf, setPoseDriver, clearPoseDriver } from '$lib/animatedImports';
	import { objectsGroup } from '../../stores/sceneStore';
	import AnimStatesWindow from './AnimStatesWindow.svelte';

	/** @type {{uuid: string, clips: {name: string, duration: number, asset?: string}[], clipState: any}} */
	let { uuid, clips, clipState } = $props();

	/** @type {any} */
	let edit = $state(null);
	const loadEdit = () => (edit ??= import('$lib/tpanim/clipEdit.js'));
	/** @type {any} */
	let assetsMod = null;
	const loadAssets = () => (assetsMod ??= import('$lib/tpanim/clipAssets.js'));

	const refs = $derived.by(() => {
		clips; // re-read when the clip list changes (refs ride the same updates)
		return clipRefsOf($objectsGroup?.getObjectByProperty('uuid', uuid));
	});
	const embedded = $derived.by(() => {
		clips;
		return embeddedClipsOf(uuid);
	});
	const active = $derived(clipState?.clip ?? null);
	const activeRef = $derived(refs.find((r) => r.name === active) ?? null);
	const activeInfo = $derived(clips.find((c) => c.name === active) ?? null);
	const duration = $derived(activeInfo?.duration ?? 0);

	/** hash -> facts (fps, frames, seam …), filled lazily @type {Record<string, any>} */
	let facts = $state({});
	$effect(() => {
		const hash = activeRef?.hash;
		if (!hash || facts[hash]) return;
		void loadEdit().then((/** @type {any} */ m) => m.clipFactsFor(hash)).then((/** @type {any} */ f) => {
			if (f) facts = { ...facts, [hash]: f };
		});
	});
	const fact = $derived(activeRef ? facts[activeRef.hash] ?? null : null);

	// ---- in / out markers + the local preview playhead ------------------------------------
	let markIn = $state(0);
	let markOut = $state(0);
	let head = $state(0);
	let previewing = $state(false);
	$effect(() => {
		// a new active clip resets the markers to its whole length
		const d = duration;
		active;
		untrack(() => {
			markIn = 0;
			markOut = d;
			head = 0;
			stopPreview();
		});
	});
	/** @param {number} t */
	function scrub(t) {
		head = Math.min(Math.max(t, 0), duration);
		if (!active) return;
		previewing = true;
		setPoseDriver(uuid, { [active]: 1 }, {}, { hold: true, times: { [active]: head } });
	}
	function stopPreview() {
		if (!previewing) return;
		previewing = false;
		clearPoseDriver(uuid);
	}
	onDestroy(stopPreview);

	// ---- per-clip settings (ref fields) ---------------------------------------------------
	/** @param {any} patch */
	async function update(patch) {
		if (!activeRef) return;
		const m = await loadAssets();
		m.updateClipRef(uuid, activeRef.name, patch);
	}
	let renaming = $state(false);

	// ---- join ---------------------------------------------------------------------------
	/** @type {string[]} */
	let picked = $state([]);
	let joinFade = $state(0.25);
	/** @param {string} name */
	function togglePick(name) {
		picked = picked.includes(name) ? picked.filter((n) => n !== name) : [...picked, name];
	}
	let busy = $state(false);
	/** @param {() => Promise<any>} job */
	async function run(job) {
		if (busy) return;
		busy = true;
		stopPreview();
		try {
			await job();
		} finally {
			busy = false;
		}
	}
	let useFiles = $state(true);
	let statesOpen = $state(false);
	const fmt = (/** @type {number} */ t) => t.toFixed(2) + ' s';
</script>

<div id="clip-tools" class="flex flex-col gap-1.5 border-b border-border px-2 py-1.5 text-xs">
	{#if embedded.names.length && !embedded.off}
		<div class="flex flex-wrap items-center gap-2">
			<button
				id="clip-extract"
				class="ui-button-quiet text-accent-text"
				disabled={busy}
				title="Turn this model's own clips into .tpanim files in the Explorer, so they play on other characters too"
				onclick={() => run(async () => (await loadEdit()).extractClips(uuid, { useFiles }))}
			>
				Extract clips
			</button>
			<label class="flex items-center gap-1 text-text-muted" title="Play the files instead of the clips inside the model (the model file is not changed)">
				<input type="checkbox" class="tp-check" bind:checked={useFiles} /> use the files instead
			</label>
		</div>
	{/if}

	{#if activeRef}
		<!-- facts + the loop seam -->
		<div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-text-muted" id="clip-facts">
			{#if fact}
				<span class="tabular-nums">{fact.fps} fps · {fact.frames} f · {fmt(fact.duration)}</span>
				{#if fact.humanoid}<span class="rounded-sm bg-accent-soft px-1 text-accent-soft-text" title="Stored on the standard humanoid bones: plays on any mapped character">humanoid</span>{/if}
				<span
					id="clip-seam"
					class={fact.seam.ok ? 'text-ink-good' : 'text-ink-warn'}
					title={fact.seam.ok ? 'The last frame meets the first: it loops without a jump' : 'The loop jumps ' + fact.seam.angle.toFixed(1) + '° at ' + fact.seam.node + ' — Loop it blends the end into the start'}
				>
					{fact.seam.ok ? 'seamless loop' : 'loop seam ' + fact.seam.angle.toFixed(1) + '°'}
				</span>
			{:else}
				<span>reading the clip…</span>
			{/if}
		</div>

		<!-- per-clip settings: ref fields, no new file -->
		<div class="flex flex-wrap items-center gap-2">
			<span class="tp-seg" role="group" aria-label="Root motion">
				<button
					id="clip-mode-inplace"
					class="tp-seg-btn"
					aria-pressed={(activeRef.mode ?? fact?.rootMotion) === 'inplace'}
					title="In place: the clip keeps its height but not its travel — the controller moves the character"
					onclick={() => update({ mode: 'inplace' })}>In place</button
				>
				<button
					id="clip-mode-moving"
					class="tp-seg-btn"
					aria-pressed={(activeRef.mode ?? fact?.rootMotion ?? 'moving') === 'moving'}
					title="Moving: the clip carries the character forward (root motion)"
					onclick={() => update({ mode: 'moving' })}>Moving</button
				>
			</span>
			<label class="flex items-center gap-1 text-text-muted" title="Off = play once and hold the last frame">
				<input id="clip-loop" type="checkbox" class="tp-check" checked={activeRef.loop !== false} onchange={(e) => update({ loop: e.currentTarget.checked })} /> loop
			</label>
			<label class="flex items-center gap-1 text-text-muted" title="This clip's own speed on this model (× the transport speed)">
				speed
				<input
					id="clip-ref-speed"
					type="number"
					min="0.05"
					max="8"
					step="0.05"
					class="w-14 rounded-sm border border-border bg-surface-inset px-1 py-0.5 text-text"
					value={activeRef.speed ?? 1}
					onchange={(e) => update({ speed: Number(e.currentTarget.value) || 1 })}
				/>
			</label>
			{#if renaming}
				<!-- svelte-ignore a11y_autofocus -->
				<input
					id="clip-rename-input"
					class="min-w-0 flex-1 rounded-sm border border-accent bg-surface-inset px-1 py-0.5 text-text"
					aria-label="Clip name"
					autofocus
					value={activeRef.name}
					onblur={(e) => {
						renaming = false;
						void update({ name: e.currentTarget.value });
					}}
					onkeydown={(e) => {
						if (e.key === 'Enter') e.currentTarget.blur();
						if (e.key === 'Escape') renaming = false;
					}}
				/>
			{:else}
				<button id="clip-rename" class="ui-button-quiet" onclick={() => (renaming = true)}>Rename</button>
			{/if}
			<button
				id="clip-loop-it"
				class="ui-button-quiet text-accent-text"
				disabled={busy}
				title="Make a new file whose last frames blend into the first, so it loops without a jump"
				onclick={() => run(async () => (await loadEdit()).loopClipAsset(uuid, activeRef.name))}>Loop it</button
			>
			<button
				id="clip-remove"
				class="ui-button-quiet text-ink-warn"
				title="Take this clip off the model (the file stays in the Explorer)"
				onclick={() => loadAssets().then((/** @type {any} */ m) => m.removeClipAsset(uuid, activeRef.name))}>Remove</button
			>
		</div>

		<!-- in/out markers + the local preview playhead -->
		{#if duration > 0}
			<div class="flex flex-col gap-1" id="clip-trim">
				<label class="flex items-center gap-2">
					<span class="w-14 shrink-0 text-text-muted">playhead</span>
					<input
						id="clip-head"
						type="range"
						class="min-w-0 flex-1 accent-accent"
						min="0"
						max={duration}
						step={1 / (fact?.fps ?? 30)}
						aria-label="Preview playhead"
						value={head}
						oninput={(e) => scrub(Number(e.currentTarget.value))}
					/>
					<span class="w-12 shrink-0 text-right tabular-nums text-text-muted">{fmt(head)}</span>
				</label>
				<div class="flex items-center gap-2">
					<span class="w-14 shrink-0 text-text-muted">in / out</span>
					<input id="clip-in" type="range" class="min-w-0 flex-1 accent-accent" min="0" max={duration} step={1 / (fact?.fps ?? 30)} aria-label="In marker" bind:value={markIn} />
					<input id="clip-out" type="range" class="min-w-0 flex-1 accent-accent" min="0" max={duration} step={1 / (fact?.fps ?? 30)} aria-label="Out marker" bind:value={markOut} />
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<span class="tabular-nums text-[10px] text-text-muted">{fmt(Math.min(markIn, markOut))} – {fmt(Math.max(markIn, markOut))}</span>
					<button class="ui-button-quiet" onclick={() => (markIn = head)}>Mark in</button>
					<button class="ui-button-quiet" onclick={() => (markOut = head)}>Mark out</button>
					<button
						id="clip-trim-go"
						class="ui-button-quiet text-accent-text"
						disabled={busy}
						title="A new clip from the in marker to the out marker; the model plays it"
						onclick={() => run(async () => (await loadEdit()).trimClipAsset(uuid, activeRef.name, markIn, markOut))}>Trim</button
					>
					<button
						id="clip-split"
						class="ui-button-quiet text-accent-text"
						disabled={busy}
						title="Two clips, cut at the playhead"
						onclick={() => run(async () => (await loadEdit()).splitClipAsset(uuid, activeRef.name, head))}>Split at playhead</button
					>
					{#if previewing}
						<button class="ui-button-quiet" onclick={stopPreview} title="Stop previewing and go back to the transport">Done</button>
					{/if}
				</div>
			</div>
		{/if}
	{/if}

	<!-- 57 M11: the Animation states window (Locomotion preset, states, transitions, parameters) -->
	<div class="flex items-center gap-2">
		<button
			id="anim-states-open"
			class="ui-button-quiet text-accent-text"
			title="States, transitions and parameters for this character — or the one-click Locomotion preset"
			onclick={() => (statesOpen = !statesOpen)}>{statesOpen ? 'Close animation states' : 'Animation states…'}</button
		>
	</div>
	{#if statesOpen}
		<AnimStatesWindow {uuid} onclose={() => (statesOpen = false)} />
	{/if}

	<!-- join: pick two or more clip files, in order -->
	{#if refs.length > 1}
		<details id="clip-join">
			<summary class="cursor-pointer text-text-muted">Join clips…</summary>
			<div class="flex flex-col gap-1 pt-1">
				{#each refs as r (r.name)}
					<label class="flex items-center gap-1">
						<input type="checkbox" class="tp-check" checked={picked.includes(r.name)} onchange={() => togglePick(r.name)} />
						<span class="truncate">{r.name}</span>
						{#if picked.includes(r.name)}<span class="text-[10px] text-text-faint">#{picked.indexOf(r.name) + 1}</span>{/if}
					</label>
				{/each}
				<label class="flex items-center gap-2">
					<span class="text-text-muted">crossfade</span>
					<input type="range" class="min-w-0 flex-1 accent-accent" min="0" max="1" step="0.05" aria-label="Join crossfade" bind:value={joinFade} />
					<span class="tabular-nums text-text-muted">{fmt(joinFade)}</span>
				</label>
				<button
					id="clip-join-go"
					class="ui-button-quiet self-start text-accent-text"
					disabled={busy || picked.length < 2}
					onclick={() =>
						run(async () => {
							if (await (await loadEdit()).joinClipAssets(uuid, picked, joinFade)) picked = [];
						})}>Join {picked.length || ''} clips</button
				>
			</div>
		</details>
	{/if}
</div>
