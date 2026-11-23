<script>
	// 102-splats: Inspector ▸ Splat — a Gaussian splat object (a captured scene drawn as soft points):
	// what it is (splats, colour bands, file), whether it draws on THIS device and why not, its
	// opacity, and a crop box that trims it. Writes go through splatEdit (replicated, one undo step
	// per scrub); every peer redraws from the record.
	import Section from '../ui/Section.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import UiButton from '../ui/Button.svelte';
	import { objectsGroup } from '../../stores/sceneStore';
	import { explorerItems } from '$lib/explorer';
	import { normalizeSplat, splatCountText, mbText } from '$lib/splat/splatCore.js';
	import { splatStatus } from '$lib/splat/splatStatus.js';
	import { setSplatFor, startCrop } from '$lib/splat/splatEdit.js';

	/** @type {{object: any}} */
	let { object } = $props();
	const r = $derived.by(() => {
		$objectsGroup; // a remote edit or an undo pokes this store
		return normalizeSplat(object?.userData?.splat);
	});
	const item = $derived((/** @type {any[]} */ ($explorerItems) ?? []).find((it) => it?.hash === r.hash) ?? null);
	const status = $derived($splatStatus[object?.uuid] ?? null);
	const statusText = $derived.by(() => {
		if (!status) return 'Starting...';
		if (status.state === 'loading') return 'Loading the splats...';
		if (status.state === 'waiting') return 'Waiting for the file from a peer...';
		if (status.state === 'error') return 'Could not draw it here: ' + (status.error || 'unknown error');
		if (status.state === 'off') return 'Not drawn on Meta Quest for now: splats slow the headset down too much. A desktop or phone shows it.';
		if (!status.shown) return 'Not drawn right now (hidden, in Cinematic view, or over this device’s splat budget).';
		return '';
	});
	const AXES = ['X', 'Y', 'Z'];

	/** @param {number} k index 0-5 into the crop box @param {number} v */
	function setCrop(k, v) {
		if (!r.crop) return;
		const crop = [...r.crop];
		crop[k] = v;
		// a face cannot pass its opposite one (normalizeBox would swap them under the pointer)
		if (k < 3) crop[k] = Math.min(crop[k], crop[k + 3]);
		else crop[k] = Math.max(crop[k], crop[k - 3]);
		setSplatFor(object.uuid, { crop });
	}

	const keywords = 'splat gaussian splatting 3dgs scan capture photogrammetry point cloud ply spz radiance field crop trim opacity';
</script>

<div data-keywords={keywords} class="contents">
	<Section variant="panel" label="Splat">
		<p id="splat-facts" class="text-xs text-text-2">
			{[splatCountText(r.count), r.sh ? `view-dependent colour (band ${r.sh})` : '', item ? mbText(item.size) : ''].filter(Boolean).join(' · ')}
		</p>
		<p class="truncate text-[length:var(--fs-badge)] text-text-faint" title={r.file}>{r.file || 'Splat file'}</p>
		{#if statusText}
			<p id="splat-status" class="text-[length:var(--fs-badge)] {status?.state === 'error' ? 'text-warn-text' : 'text-text-muted'}" role="status">{statusText}</p>
		{/if}
		<SliderRow id="splat-opacity" label="Opacity" min={0} max={1} step={0.01} value={r.opacity} onchange={(v) => setSplatFor(object.uuid, { opacity: v })} />
		{#if r.crop}
			<p class="mt-1 text-[length:var(--fs-badge)] font-semibold uppercase tracking-wide text-text-muted">Crop box</p>
			{#each AXES as axis, i (axis)}
				<DragRow id={'splat-crop-min-' + axis.toLowerCase()} label={axis + ' from'} value={r.crop[i]} step={0.01} decimals={2} unit="length" onchange={(v) => setCrop(i, v)} />
				<DragRow id={'splat-crop-max-' + axis.toLowerCase()} label={axis + ' to'} value={r.crop[i + 3]} step={0.01} decimals={2} unit="length" onchange={(v) => setCrop(i + 3, v)} />
			{/each}
			<div class="flex flex-wrap gap-2">
				<UiButton id="splat-crop-reset" size="sm" variant="outline" title="Put the crop box back around the whole scan" onclick={() => setSplatFor(object.uuid, { crop: [...r.bounds] })}>Reset box</UiButton>
				<UiButton id="splat-crop-clear" size="sm" variant="outline" title="Show the whole scan again" onclick={() => setSplatFor(object.uuid, { crop: null })}>Remove crop</UiButton>
			</div>
			<p class="text-[length:var(--fs-badge)] text-text-faint">Splats outside the box are hidden for everyone. The file keeps them, so you can widen the box again.</p>
		{:else}
			<UiButton id="splat-crop-start" size="sm" variant="outline" title="Trim the scan to a box: hide the floaters and the background you do not want" onclick={() => startCrop(object.uuid)}>Crop...</UiButton>
		{/if}
	</Section>
</div>
