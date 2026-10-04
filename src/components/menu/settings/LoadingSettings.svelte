<script context="module">
	/** 36 U9: what the settings search matches beyond the row names (I4 indexes labels + keywords) */
	export const keywords = [
		'loading',
		'placeholder',
		'placeholders',
		'preload',
		'hologram',
		'modern',
		'boxes',
		'progress',
		'stuck',
		'retry',
		'grid',
		'checker',
		'uv grid',
		'prototype'
	];
</script>

<script>
	// 36 U9 — Settings ▸ Scene ▸ Loading: how a kit piece that is still on its way looks, and
	// when it counts as stuck. Its own file so the settings index stays a one-line union.
	// Every value is LOCAL (this device), persisted through safeStorage by loadStates.
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import { Toggle } from 'flowbite-svelte';
	import SettingRow from '../SettingRow.svelte';
	import { placeholderStyle, placeholderGrid, placeholderStuckSeconds, normalizeGrid, normalizeStuckSeconds, DEFAULT_GRID } from '$lib/loadStates';

	/** @param {Partial<import('$lib/loadStates').PlaceholderGrid>} patch */
	function setGrid(patch) {
		placeholderGrid.set(normalizeGrid({ ...$placeholderGrid, ...patch }));
	}
	$: modern = $placeholderStyle === 'modern';
</script>

<!-- 36-int-121: the I4 search reads a section's keywords from its root element -->
<div class="contents" data-keywords={keywords.join(' ')}>
<p class="ui-section-label" data-tour="settings-loading">Loading</p>
<SettingRow name="Loading placeholders">
	<svelte:fragment slot="control">
		<ThemedSelect
			id="placeholder-style"
			items={[
				{ value: 'boxes', name: 'Colored boxes' },
				{ value: 'modern', name: 'Modern' }
			]}
			bind:value={$placeholderStyle}
		/>
	</svelte:fragment>
	What a kit piece shows while its file is still loading. Modern = a translucent blue box that fills up as the bytes arrive; both turn amber when stuck and red when the file failed (right-click it to retry or replace it)
</SettingRow>
<SettingRow name="Placeholder grid texture">
	<svelte:fragment slot="control"><Toggle id="placeholder-grid-on" disabled={!modern} checked={$placeholderGrid.on} onchange={(/** @type {any} */ e) => setGrid({ on: e.currentTarget.checked })} /></svelte:fragment>
	A prototype grid on the modern boxes, sized in world metres so every box reads at the same scale{modern ? '' : ' (Modern style only)'}
</SettingRow>
<SettingRow name="Grid size (m)">
	<svelte:fragment slot="control">
		<input
			id="placeholder-grid-size"
			type="number"
			min="0.05"
			max="10"
			step="0.05"
			disabled={!modern || !$placeholderGrid.on}
			class="w-full rounded-sm bg-gray-700 px-1 py-0.5 text-xs text-white disabled:opacity-40"
			value={$placeholderGrid.size}
			on:change={(e) => setGrid({ size: Number(e.currentTarget.value) })}
		/>
	</svelte:fragment>
	One grid cell, in metres (default {DEFAULT_GRID.size})
</SettingRow>
<SettingRow name="Grid color">
	<svelte:fragment slot="control">
		<input
			id="placeholder-grid-color"
			type="color"
			disabled={!modern || !$placeholderGrid.on}
			class="h-7 w-full cursor-pointer rounded-sm border border-gray-500 bg-transparent disabled:opacity-40"
			value={$placeholderGrid.color}
			on:input={(e) => setGrid({ color: e.currentTarget.value })}
		/>
	</svelte:fragment>
	The grid lines' colour
</SettingRow>
<SettingRow name="Grid opacity">
	<svelte:fragment slot="control">
		<input
			id="placeholder-grid-opacity"
			type="range"
			style="width: 100%"
			min="0"
			max="1"
			step="0.05"
			disabled={!modern || !$placeholderGrid.on}
			value={$placeholderGrid.opacity}
			aria-label="Placeholder grid opacity"
			on:input={(e) => setGrid({ opacity: Number(e.currentTarget.value) })}
		/>
	</svelte:fragment>
	How strongly the grid shows on the boxes
</SettingRow>
<SettingRow name="Placeholder animation speed">
	<svelte:fragment slot="control">
		<input
			id="placeholder-anim-speed"
			type="range"
			style="width: 100%"
			min="0"
			max="4"
			step="0.25"
			disabled={!modern}
			value={$placeholderGrid.speed}
			aria-label="Placeholder animation speed"
			on:input={(e) => setGrid({ speed: Number(e.currentTarget.value) })}
		/>
	</svelte:fragment>
	The pulse and the scan sweep of the modern boxes (0 = still)
</SettingRow>
<SettingRow name="Stuck after (seconds)">
	<svelte:fragment slot="control">
		<input
			id="placeholder-stuck-seconds"
			type="number"
			min="1"
			max="120"
			step="1"
			class="w-full rounded-sm bg-gray-700 px-1 py-0.5 text-xs text-white"
			value={$placeholderStuckSeconds}
			on:change={(e) => placeholderStuckSeconds.set(normalizeStuckSeconds(e.currentTarget.value))}
		/>
	</svelte:fragment>
	A loading piece with no new data for this long turns amber; three times this long and the download is restarted (up to three retries, then it turns red)
</SettingRow>
</div>
