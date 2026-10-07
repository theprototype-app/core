<script module>
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
	import { registerSettingsKeywords } from '$lib/settingsSearch';
	// the old labels of the rows this redesign renamed (Decision C)
	registerSettingsKeywords('placeholder style', ['loading placeholders']);
	registerSettingsKeywords('grid size', ['grid size (m)']);
	registerSettingsKeywords('animation speed', ['placeholder animation speed']);
	registerSettingsKeywords('stuck after', ['stuck after (seconds)']);
</script>

<script>
	// 36 U9 — Settings ▸ Scene ▸ Loading placeholders: how a kit piece that is still on its way
	// looks, and when it counts as stuck. Its own file so the settings index stays a one-line union.
	// Every value is LOCAL (this device), persisted through safeStorage by loadStates.
	// 37-settings (R21): one card on the redesign kit; same stores / keys.
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import Slider from '../../ui/Slider.svelte';
	import { placeholderStyle, placeholderGrid, placeholderStuckSeconds, normalizeGrid, normalizeStuckSeconds, DEFAULT_GRID } from '$lib/loadStates';

	/** @param {Partial<import('$lib/loadStates').PlaceholderGrid>} patch */
	function setGrid(patch) {
		placeholderGrid.set(normalizeGrid({ ...$placeholderGrid, ...patch }));
	}
	const modern = $derived($placeholderStyle === 'modern');
	const STYLES = [
		{ value: 'modern', label: 'Modern' },
		{ value: 'boxes', label: 'Boxes' }
	];
</script>

<!-- 36-int-121: the I4 search reads a section's keywords from its root element -->
<div class="contents" data-keywords={keywords.join(' ')}>
	<Section variant="card" label="Loading placeholders" badge="This device">
		<SettingRow id="row-placeholder-style" label="Placeholder style" description="What a kit piece shows while its file loads. It turns amber when stuck and red when it failed." data-tour="settings-loading">
			<Segmented id="placeholder-style" label="Placeholder style" options={STYLES} value={$placeholderStyle} onchange={(v) => placeholderStyle.set(/** @type {any} */ (v))} />
		</SettingRow>
		<SettingRow id="row-placeholder-grid" label="Placeholder grid texture" description={'A grid in world metres on the modern boxes' + (modern ? '.' : ' (Modern style only).')} disabled={!modern}>
			<Toggle id="placeholder-grid-on" label="Placeholder grid texture" disabled={!modern} checked={$placeholderGrid.on} onchange={(on) => setGrid({ on })} />
		</SettingRow>
		<SettingRow id="row-placeholder-grid-size" label="Grid size" description={'One grid cell, in metres (default ' + DEFAULT_GRID.size + ').'} disabled={!modern || !$placeholderGrid.on}>
			<input
				id="placeholder-grid-size"
				class="settings-num"
				type="number"
				min="0.05"
				max="10"
				step="0.05"
				aria-label="Grid size in metres"
				disabled={!modern || !$placeholderGrid.on}
				value={$placeholderGrid.size}
				onchange={(e) => setGrid({ size: Number(e.currentTarget.value) })}
			/>
		</SettingRow>
		<SettingRow id="row-placeholder-grid-color" label="Grid colour" disabled={!modern || !$placeholderGrid.on}>
			<input
				id="placeholder-grid-color"
				class="settings-color"
				type="color"
				aria-label="Grid colour"
				disabled={!modern || !$placeholderGrid.on}
				value={$placeholderGrid.color}
				oninput={(e) => setGrid({ color: e.currentTarget.value })}
			/>
		</SettingRow>
		<SettingRow id="row-placeholder-grid-opacity" label="Grid opacity" description="How strongly the grid shows on the boxes." disabled={!modern || !$placeholderGrid.on}>
			<Slider
				id="placeholder-grid-opacity"
				label="Placeholder grid opacity"
				min={0}
				max={1}
				step={0.05}
				disabled={!modern || !$placeholderGrid.on}
				value={$placeholderGrid.opacity}
				format={(v) => Math.round(v * 100) + '%'}
				onchange={(v) => setGrid({ opacity: v })}
			/>
		</SettingRow>
		<SettingRow id="row-placeholder-speed" label="Animation speed" description="The pulse and scan of the modern boxes (0 = still)." disabled={!modern}>
			<Slider
				id="placeholder-anim-speed"
				label="Placeholder animation speed"
				min={0}
				max={4}
				step={0.25}
				disabled={!modern}
				value={$placeholderGrid.speed}
				format={(v) => v.toFixed(2) + '×'}
				onchange={(v) => setGrid({ speed: v })}
			/>
		</SettingRow>
		<SettingRow id="row-placeholder-stuck" label="Stuck after" description="With no new data for this long a piece turns amber; at three times it re-downloads (three tries).">
			<span class="settings-unit">
				<input
					id="placeholder-stuck-seconds"
					class="settings-num"
					type="number"
					min="1"
					max="120"
					step="1"
					aria-label="Stuck after, seconds"
					value={$placeholderStuckSeconds}
					onchange={(e) => placeholderStuckSeconds.set(normalizeStuckSeconds(e.currentTarget.value))}
				/>s</span
			>
		</SettingRow>
	</Section>
</div>

<style>
	.contents {
		display: contents;
	}
</style>
