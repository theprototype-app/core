<script>
	// Roadmap 98 P2 (lane 98-photo) — the PHOTO window: a path-traced still of the current view. Samples /
	// time sliders, denoise, size; Start / Stop; the still so far while it renders; Download PNG and Save to
	// scene shots. Mounted by App only while open (`{#if $photoOpen}`), so it and photoMode are a lazy chunk.
	// Kit primitives + tokens only. Nothing here is shared: a photo is this person's picture of the scene.
	import { onDestroy } from 'svelte';
	import ModalDialog from '../ui/ModalDialog.svelte';
	import Button from '../ui/Button.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import { photoOpen, photoPrefs, photoState, startPhoto, stopPhoto, downloadPhoto, savePhotoToScene, photoWhere } from '$lib/photo/photoMode.js';
	import { PHOTO_SAMPLES, PHOTO_SECONDS, PHOTO_PARITY } from '$lib/photo/photoCore.js';

	/** @type {HTMLCanvasElement | null} */
	let preview = $state(null);
	let where = $state(/** @type {{place: string, why: string, peer?: string, peerName?: string} | null} */ (null));
	let saving = $state(false);
	let showParity = $state(false);

	async function refreshWhere() {
		where = await photoWhere().catch(() => null);
	}
	refreshWhere();

	const rendering = $derived($photoState.status === 'rendering');
	const pct = $derived(Math.round(($photoState.fraction ?? 0) * 100));
	const phoneOnly = $derived(where?.place === 'raster' && /phone/.test(where?.why ?? ''));

	function start() {
		startPhoto({ preview });
	}

	async function save() {
		saving = true;
		try {
			await savePhotoToScene();
		} finally {
			saving = false;
		}
	}

	const reasonText = /** @type {Record<string, string>} */ ({
		samples: 'All samples done.',
		time: 'Time limit reached.',
		stopped: 'Stopped: this is the still so far.',
		peer: 'Rendered on a PC in this session.',
		raster: 'A normal (not path-traced) still.'
	});

	// closing the window stops a render that is still running (the last still stays for the next open)
	onDestroy(() => {
		if ($photoState.status === 'rendering') stopPhoto();
	});
</script>

<ModalDialog
	id="photo-dialog"
	class="photo-dialog"
	title="Photo"
	width="md"
	modal={false}
	bind:open={() => $photoOpen, (v) => photoOpen.set(!!v)}
	aria-label="Photo: a path-traced still of this view"
>
	<div class="flex flex-col gap-2">
		<p id="photo-where" class="text-xs text-text-muted" data-place={where?.place ?? ''}>
			{#if !where}
				Checking this device…
			{:else if where.place === 'here'}
				A path-traced still of your current view. It renders while you keep working; the view itself does not move.
			{:else}
				{where.why}
			{/if}
		</p>
		{#if phoneOnly}
			<Toggle
				id="photo-force"
				label="Try here anyway (slow, may heat the phone)"
				checked={$photoPrefs.force}
				onchange={(v) => {
					photoPrefs.update((p) => ({ ...p, force: v }));
					refreshWhere();
				}}
			/>
		{/if}

		<SliderRow
			id="photo-samples"
			label="Samples"
			min={PHOTO_SAMPLES.min}
			max={PHOTO_SAMPLES.max}
			step={1}
			value={$photoPrefs.samples}
			resetValue={PHOTO_SAMPLES.default}
			onchange={(v) => photoPrefs.update((p) => ({ ...p, samples: Math.round(v) }))}
		/>
		<SliderRow
			id="photo-seconds"
			label="Time limit (s)"
			min={PHOTO_SECONDS.min}
			max={PHOTO_SECONDS.max}
			step={1}
			value={$photoPrefs.seconds}
			resetValue={PHOTO_SECONDS.default}
			onchange={(v) => photoPrefs.update((p) => ({ ...p, seconds: Math.round(v) }))}
		/>
		<div class="flex flex-wrap items-center gap-3">
			<Toggle id="photo-denoise" label="Denoise" checked={$photoPrefs.denoise} onchange={(v) => photoPrefs.update((p) => ({ ...p, denoise: v }))} />
			<Segmented
				id="photo-scale"
				label="Size"
				value={String($photoPrefs.scale)}
				options={[
					{ value: '0.5', label: 'Half', title: 'Half the view size: fastest' },
					{ value: '1', label: 'View', title: 'The size of your 3D view' },
					{ value: '2', label: '2x', title: 'Twice the view size (up to 4096 px)' }
				]}
				onchange={(v) => photoPrefs.update((p) => ({ ...p, scale: Number(v) }))}
			/>
		</div>

		<div class="flex items-center gap-2">
			{#if rendering}
				<Button id="photo-stop" variant="danger" icon="square" text="Stop" onclick={() => stopPhoto()} />
			{:else}
				<Button id="photo-start" variant="primary" icon="camera" text={$photoState.status === 'done' ? 'Render again' : 'Render photo'} onclick={start} />
			{/if}
			<span id="photo-progress-text" class="text-xs text-text-muted" aria-live="polite">
				{#if rendering}
					{#if $photoState.compiling}Preparing the renderer…{:else if $photoState.place === 'raster'}Taking the still…{:else}{$photoState.samples} / {$photoState.target} samples · {pct}%{/if}
				{:else if $photoState.status === 'done'}
					{reasonText[$photoState.reason] ?? ''}
					{#if $photoState.samples}{$photoState.samples} samples{/if}{#if $photoState.ms} in {($photoState.ms / 1000).toFixed(1)} s{/if}.
				{:else if $photoState.status === 'error'}
					<span id="photo-error" class="text-warn">{$photoState.error}</span>
				{/if}
			</span>
		</div>
		{#if rendering}
			<div
				class="photo-bar"
				role="progressbar"
				aria-label="Photo progress"
				aria-valuemin="0"
				aria-valuemax="100"
				aria-valuenow={pct}
			>
				<div class="photo-bar-fill" style:width={pct + '%'}></div>
			</div>
		{/if}

		<div class="photo-frame">
			{#if $photoState.status === 'done' && $photoState.url}
				<img id="photo-result" src={$photoState.url} alt="Path-traced still of the view" data-width={$photoState.width} data-height={$photoState.height} />
			{:else}
				<canvas id="photo-preview" bind:this={preview} aria-label="The photo so far"></canvas>
			{/if}
		</div>

		{#if $photoState.notes.length}
			<ul id="photo-notes" class="text-xs text-text-muted">
				{#each $photoState.notes as n (n.kind)}
					<li>{n.note} ({n.count})</li>
				{/each}
			</ul>
		{/if}

		<div class="flex flex-wrap items-center gap-2">
			<Button id="photo-download" icon="download" text="Download PNG" disabled={!$photoState.blob} onclick={() => downloadPhoto()} />
			<Button id="photo-save" icon="image" text="Save to scene shots" disabled={!$photoState.blob || saving} onclick={save} />
			{#if $photoState.saved}<span id="photo-saved" class="text-xs text-text-muted">In the Library: {$photoState.saved}</span>{/if}
			<span class="grow"></span>
			<Button id="photo-parity-toggle" variant="ghost" size="sm" text={showParity ? 'Hide what photos cannot show' : 'What photos cannot show'} pressed={showParity} onclick={() => (showParity = !showParity)} />
		</div>
		{#if showParity}
			<ul id="photo-parity" class="text-xs text-text-muted">
				{#each PHOTO_PARITY.filter((r) => r.shows !== 'yes') as r (r.kind)}
					<li><span class="text-text-2">{r.label}</span>: {r.fallback}.</li>
				{/each}
			</ul>
		{/if}
	</div>
</ModalDialog>

<style>
	.photo-frame {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 120px;
		max-height: 50vh;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
		overflow: hidden;
	}
	.photo-frame img,
	.photo-frame canvas {
		max-width: 100%;
		max-height: 50vh;
		object-fit: contain;
	}
	.photo-bar {
		height: 4px;
		background: var(--surface-3);
		border-radius: 2px;
		overflow: hidden;
	}
	.photo-bar-fill {
		height: 100%;
		background: var(--accent);
	}
	@media (prefers-reduced-motion: no-preference) {
		.photo-bar-fill {
			transition: width 0.2s linear;
		}
	}
	@media (min-width: 641px) {
		:global(dialog.md.photo-dialog) {
			width: min(640px, 94vw);
		}
	}
</style>
