<script lang="ts">
	// 77 K1-K3 — the Timeline inspector's cut half: a clip's source / fit / slip, a title's text
	// and preset, and the transition IN + fade OUT every shot, clip and title can carry. Loaded
	// with the first such item selected (the editor's {#await}), so a scene that never cuts video
	// never fetches it. Fields write through the editor's patch (one undo step per scrub).
	import DragRow from '../ui/DragRow.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import Button from '../ui/Button.svelte';
	import { showToast } from '../../stores/appStore.js';
	import { explorerItems } from '$lib/explorer';
	import { sendAsset } from '$lib/assetShare';
	import { TRANSITIONS, WIPE_DIRS, MIN_ITEM } from '$lib/sequenceCore';
	import { maxDur } from '$lib/cutCore';
	import { TITLE_PRESETS } from '$lib/cut/titlePresets.js';

	let {
		kind,
		item,
		patch,
		scrubStart,
		scrubEnd
	}: {
		kind: string;
		item: any;
		patch: (p: any) => void;
		scrubStart: () => void;
		scrubEnd: () => void;
	} = $props();

	const TRANS_NAMES: Record<string, string> = {
		crossfade: 'Crossfade',
		fade: 'Fade in',
		dip: 'Dip to colour',
		wipe: 'Wipe'
	};
	const clips = $derived(
		($explorerItems as any[]).filter((i) => i.kind === 'video' || i.kind === 'image')
	);
	let importing = $state(false);
	let fileInput: HTMLInputElement | null = $state(null);

	function pickClip(hash: string) {
		const it = clips.find((x: any) => x.hash === hash);
		if (!it) return;
		sendAsset(hash);
		const media = it.kind === 'image' ? 'image' : 'video';
		patch({ src: hash, name: it.name, media, in: 0, srcDur: 0 });
		if (media === 'video') probe(hash);
	}
	async function probe(hash: string) {
		const { clipFacts } = await import('$lib/cut/clipMedia.js');
		const f = await clipFacts(hash);
		if (f.ok && f.duration > 0 && item.src === hash)
			patch({ srcDur: f.duration, dur: Math.min(item.dur, f.duration) });
	}
	async function importFile(file: File) {
		importing = true;
		try {
			const { importClip } = await import('$lib/cut/clipImport.js');
			const r = await importClip(file, file.name);
			if (!r.ok) {
				showToast(r.error ?? `${file.name} could not be imported`);
				return;
			}
			if (r.warn) showToast(r.warn);
			const p: any = { src: r.item.hash, name: r.item.name ?? file.name, media: r.media, in: 0 };
			if (r.media === 'video' && (r.duration ?? 0) > 0) {
				p.srcDur = r.duration;
				p.dur = r.duration;
			} else p.srcDur = 0;
			patch(p);
		} finally {
			importing = false;
		}
	}

	const trans = $derived(item.trans ?? null);
	function setTrans(k: string) {
		if (!k) patch({ trans: null });
		else patch({ trans: { ...(trans ?? {}), kind: k, dur: trans?.dur ?? Math.min(0.5, item.dur) } });
	}
	const transItems = $derived([
		{ value: '', name: 'Cut (no transition)' },
		...TRANSITIONS.filter((k) => kind !== 'title' || k !== 'crossfade').map((k) => ({
			value: k,
			name: TRANS_NAMES[k]
		}))
	]);
	const TITLE_WHITE = '#ffffff'; // tokens-ok: a title's colour is DATA (the picker's default)
	const presetItems = TITLE_PRESETS.map((p) => ({ value: p.id, name: p.name }));
	const stop = (e: KeyboardEvent) => {
		if (e.key === 'Enter' && (e.currentTarget as HTMLElement).tagName === 'INPUT')
			(e.currentTarget as HTMLElement).blur();
		e.stopPropagation();
	};
</script>

{#if kind === 'video'}
	<div class="ci-pick" title="Clip or still (Explorer video / image)">
		<ThemedSelect
			id="timeline-item-clip-src"
			clip={false}
			placeholder={item.name || 'Clip'}
			items={clips.map((c: any) => ({ value: c.hash, name: c.name }))}
			value={item.src || undefined}
			onchange={(v: any) => pickClip(v)}
		/>
	</div>
	<Button
		size="sm"
		variant="secondary"
		icon="upload"
		text={importing ? 'Importing…' : 'Import clip…'}
		id="timeline-import-clip"
		disabled={importing}
		title="Import a video (MP4, WebM, MOV — up to 200 MB) or an image into the Explorer and use it here"
		onclick={() => fileInput?.click()}
	/>
	<input
		bind:this={fileInput}
		type="file"
		accept="video/*,image/*,.webm,.mkv,.mov,.m4v"
		hidden
		id="timeline-import-clip-file"
		onchange={(e) => {
			const f = e.currentTarget.files?.[0];
			e.currentTarget.value = '';
			if (f) importFile(f);
		}}
	/>
	<div class="ci-pick ci-narrow" title="How the frame fills the picture">
		<ThemedSelect
			id="timeline-item-fit"
			clip={false}
			items={[
				{ value: 'cover', name: 'Fill' },
				{ value: 'contain', name: 'Fit' }
			]}
			value={item.fit}
			onchange={(v: any) => patch({ fit: v })}
		/>
	</div>
	<div class="ci-field">
		<DragRow
			id="timeline-item-opacity"
			label="Opacity"
			value={item.opacity}
			step={0.01}
			decimals={2}
			min={0}
			max={1}
			onscrubstart={scrubStart}
			onscrubend={scrubEnd}
			onchange={(v: number) => patch({ opacity: v })}
		/>
	</div>
	{#if item.media !== 'image'}
		<div class="ci-field" title="Where in the clip this item starts (slip: Alt+Shift drag the item)">
			<DragRow
				id="timeline-item-in"
				label="In"
				value={item.in ?? 0}
				step={1 / 30}
				decimals={2}
				min={0}
				max={item.srcDur > 0 ? Math.max(0, item.srcDur - item.dur) : 36000}
				onscrubstart={scrubStart}
				onscrubend={scrubEnd}
				onchange={(v: number) => patch({ in: v })}
			/>
		</div>
		<div class="ci-field">
			<DragRow
				id="timeline-item-clip-gain"
				label="Sound"
				value={item.gain}
				step={0.01}
				decimals={2}
				min={0}
				max={2}
				onscrubstart={scrubStart}
				onscrubend={scrubEnd}
				onchange={(v: number) => patch({ gain: v })}
			/>
		</div>
		{#if item.srcDur > 0}
			<span class="ci-hint" id="timeline-item-srcdur"
				>source {item.srcDur.toFixed(2)} s{maxDur(kind, item, item.in ?? 0) <= item.dur + MIN_ITEM
					? ' · at its end'
					: ''}</span
			>
		{/if}
	{/if}
{:else if kind === 'title'}
	<input
		class="ci-text"
		id="timeline-item-title-text"
		value={item.text}
		maxlength="500"
		placeholder="Title"
		aria-label="Title text"
		onkeydown={stop}
		onchange={(e) => patch({ text: e.currentTarget.value })}
	/>
	<input
		class="ci-text"
		id="timeline-item-title-sub"
		value={item.sub ?? ''}
		maxlength="500"
		placeholder="Second line"
		aria-label="Second line"
		onkeydown={stop}
		onchange={(e) => patch({ sub: e.currentTarget.value })}
	/>
	<div class="ci-pick" title="Where the title sits and how it looks">
		<ThemedSelect
			id="timeline-item-title-preset"
			clip={false}
			items={presetItems}
			value={item.preset}
			onchange={(v: any) => patch({ preset: v })}
		/>
	</div>
	<div class="ci-field">
		<DragRow
			id="timeline-item-title-size"
			label="Size"
			value={item.size ?? 1}
			step={0.01}
			decimals={2}
			min={0.25}
			max={4}
			onscrubstart={scrubStart}
			onscrubend={scrubEnd}
			onchange={(v: number) => patch({ size: v })}
		/>
	</div>
	<label class="ci-color" title="Text colour">
		<input
			type="color"
			id="timeline-item-title-color"
			aria-label="Text colour"
			value={item.color || TITLE_WHITE}
			onchange={(e) => patch({ color: e.currentTarget.value })}
		/>
	</label>
{/if}

<!-- the transition INTO this item (a cut when none) and its fade out -->
<div class="ci-pick" title="How this item comes in">
	<ThemedSelect
		id="timeline-item-trans"
		clip={false}
		items={transItems}
		value={trans?.kind ?? ''}
		onchange={(v: any) => setTrans(v)}
	/>
</div>
{#if trans}
	<div class="ci-field">
		<DragRow
			id="timeline-item-trans-dur"
			label="Over"
			value={trans.dur}
			step={0.02}
			decimals={2}
			min={MIN_ITEM}
			max={item.dur}
			onscrubstart={scrubStart}
			onscrubend={scrubEnd}
			onchange={(v: number) => patch({ trans: { ...trans, dur: v } })}
		/>
	</div>
	{#if trans.kind === 'dip'}
		<div class="ci-pick ci-narrow">
			<ThemedSelect
				id="timeline-item-trans-color"
				clip={false}
				items={[
					{ value: 'black', name: 'Black' },
					{ value: 'white', name: 'White' }
				]}
				value={trans.color}
				onchange={(v: any) => patch({ trans: { ...trans, color: v } })}
			/>
		</div>
	{:else if trans.kind === 'wipe'}
		<div class="ci-pick ci-narrow">
			<ThemedSelect
				id="timeline-item-trans-dir"
				clip={false}
				items={WIPE_DIRS.map((d) => ({ value: d, name: d[0].toUpperCase() + d.slice(1) }))}
				value={trans.dir}
				onchange={(v: any) => patch({ trans: { ...trans, dir: v } })}
			/>
		</div>
	{/if}
{/if}
{#if kind !== 'camera'}
	<div class="ci-field" title="Seconds of fade at the end">
		<DragRow
			id="timeline-item-fadeout"
			label="Fade out"
			value={item.fadeOut ?? 0}
			step={0.02}
			decimals={2}
			min={0}
			max={item.dur}
			onscrubstart={scrubStart}
			onscrubend={scrubEnd}
			onchange={(v: number) => patch({ fadeOut: v })}
		/>
	</div>
{/if}

<style>
	.ci-field {
		width: 120px;
	}
	.ci-pick {
		width: 170px;
	}
	.ci-pick.ci-narrow {
		width: 100px;
	}
	.ci-hint {
		color: var(--text-muted);
		font-size: var(--fs-desc);
	}
	.ci-text {
		width: 180px;
		min-width: 0;
		height: var(--control-h-sm);
		padding: 0 6px;
		border: 1px solid var(--border-input);
		border-radius: var(--radius-input, 6px);
		background: var(--surface-inset);
		color: var(--text);
		font: inherit;
	}
	.ci-color {
		display: inline-flex;
		align-items: center;
	}
	.ci-color input {
		width: 28px;
		height: var(--control-h-sm);
		padding: 0;
		border: 1px solid var(--border-input);
		border-radius: var(--radius-input, 6px);
		background: var(--surface-inset);
		cursor: pointer;
	}
	:global(:root.phone-shell) .ci-pick,
	:global(:root.phone-shell) .ci-field,
	:global(:root.phone-shell) .ci-text {
		width: calc(50% - 20px);
	}
</style>
