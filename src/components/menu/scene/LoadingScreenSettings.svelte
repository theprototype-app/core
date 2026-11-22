<script>
	// 93 LP2: Configure Scene ▸ Levels ▸ Loading screen — the game's one loading screen (a portal may pick its
	// own later). Shown while a level's scene loads, and over an exported game's first load. The author's
	// colours are data; the defaults are the app's theme.
	import Segmented from '../../ui/Segmented.svelte';
	import UiButton from '../../ui/Button.svelte';
	import HudImagePicker from '../../hud/HudImagePicker.svelte';
	import { normalizeLoading } from '$lib/gameLevels/loadingConfig.js';

	/** @type {{value: any, disabled?: boolean, onchange: (next: any) => void}} */
	let { value, disabled = false, onchange } = $props();
	const on = $derived(!!value);
	const c = $derived(normalizeLoading(value));

	const PRESETS = [
		{ value: 'fade', label: 'Fade', title: 'No screen: the level change fades out and in' },
		{ value: 'bar', label: 'Bar', title: 'A thin progress bar' },
		{ value: 'logo', label: 'Logo', title: 'Your logo, a spinner and the bar' },
		{ value: 'image', label: 'Image', title: 'A background picture, tips and the bar' },
		{ value: 'item', label: 'Item', title: 'A game item, its name and the bar' }
	];
	// the colour pickers' starting values (user data once picked; an <input type=color> needs a literal)
	const START = { background: '#0b0e14', text: '#ffffff', bar: '#3b82f6' }; // tokens-ok: colour-picker starting values (author data)
	const BARS = [
		{ value: 'thin', label: 'Thin' },
		{ value: 'thick', label: 'Thick' }
	];

	/** @param {any} patch */
	function set(patch) {
		const next = { ...c, ...patch, bar: { ...c.bar, ...(patch.bar ?? {}) } };
		for (const [k, v] of Object.entries(patch)) if (v === '' || v === null) delete next[k];
		onchange(normalizeLoading(next));
	}
	/** @param {string} text */
	function setTips(text) {
		const tips = text
			.split('\n')
			.map((t) => t.trim())
			.filter(Boolean);
		set({ tips: tips.length ? tips : null });
	}
</script>

<fieldset id="levels-loading" class="flex flex-col gap-2 rounded border border-border p-2" data-keywords="loading screen progress bar logo tips">
	<legend class="px-1 text-xs text-text-muted">Loading screen</legend>
	{#if !on}
		<p class="text-[length:var(--fs-desc)] text-text-muted">A plain bar shows while a level's scene loads. Pick your own look:</p>
		<UiButton id="levels-loading-add" size="sm" {disabled} onclick={() => onchange(normalizeLoading({ preset: 'bar' }))}>Customize the loading screen</UiButton>
	{:else}
		<Segmented id="levels-loading-preset" label="Style" full options={PRESETS} value={c.preset} {disabled} onchange={(v) => set({ preset: v })} />
		{#if c.preset !== 'fade'}
			<label class="flex items-center gap-2 text-xs text-text-muted">
				<span class="w-20 shrink-0">Title</span>
				<input id="levels-loading-title" class="ui-input min-w-0 flex-1 px-1 py-0.5 text-xs" placeholder="None" value={c.title ?? ''} {disabled} onchange={(e) => set({ title: e.currentTarget.value.trim() || null })} />
			</label>
			<div class="flex flex-wrap items-center gap-3 text-xs text-text-muted">
				<label class="flex items-center gap-1">
					<input id="levels-loading-bg" type="color" value={c.background ?? START.background} {disabled} onchange={(e) => set({ background: e.currentTarget.value })} />
					Background
				</label>
				<label class="flex items-center gap-1">
					<input id="levels-loading-text" type="color" value={c.textColor ?? START.text} {disabled} onchange={(e) => set({ textColor: e.currentTarget.value })} />
					Text
				</label>
				<label class="flex items-center gap-1">
					<input id="levels-loading-barcolor" type="color" value={c.bar.color ?? START.bar} {disabled} onchange={(e) => set({ bar: { color: e.currentTarget.value } })} />
					Bar
				</label>
			</div>
			<Segmented id="levels-loading-bar" label="Bar" options={BARS} value={c.bar.style} {disabled} onchange={(v) => set({ bar: { style: v } })} />
			{#if c.preset === 'logo' || c.preset === 'item'}
				<div class="flex items-center gap-2 text-xs text-text-muted">
					<span class="w-20 shrink-0">Logo</span>
					<HudImagePicker hash={c.logo ?? ''} onpick={(h) => set({ logo: h || null })} />
				</div>
			{/if}
			{#if c.preset === 'image'}
				<div class="flex items-center gap-2 text-xs text-text-muted">
					<span class="w-20 shrink-0">Picture</span>
					<HudImagePicker hash={c.image ?? ''} onpick={(h) => set({ image: h || null })} />
				</div>
			{/if}
			{#if c.preset === 'item'}
				<label class="flex items-center gap-2 text-xs text-text-muted">
					<span class="w-20 shrink-0">Item name</span>
					<input id="levels-loading-item" class="ui-input min-w-0 flex-1 px-1 py-0.5 text-xs" value={c.item ?? ''} {disabled} onchange={(e) => set({ item: e.currentTarget.value.trim() || null })} />
				</label>
			{/if}
			<label class="flex flex-col gap-1 text-xs text-text-muted">
				<span>Tips (one per line, shown in turn)</span>
				<textarea id="levels-loading-tips" class="ui-input min-h-[3.5rem] px-1 py-0.5 text-xs" value={(c.tips ?? []).join('\n')} {disabled} onchange={(e) => setTips(e.currentTarget.value)}></textarea>
			</label>
		{/if}
		<UiButton id="levels-loading-reset" size="sm" variant="ghost" {disabled} onclick={() => onchange(null)}>Back to the plain bar</UiButton>
	{/if}
</fieldset>
