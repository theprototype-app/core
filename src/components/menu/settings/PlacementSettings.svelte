<script module>
	// I4 settings search: the labels + keywords this section answers to
	export const keywords = ['placement', 'preview', 'ghost', 'drag', 'drop', 'place', 'dimensions', 'size', 'triangles', 'budget', 'bounding box', 'performance'];
	import { registerSettingsKeywords } from '$lib/settingsSearch';
	registerSettingsKeywords('placement preview', ['drag to place', 'ghost', 'preview complexity']);
	registerSettingsKeywords('preview triangle budget', ['triangles', 'budget', 'ghost']);
	registerSettingsKeywords('show dimensions', ['size', 'width', 'height', 'depth', 'metres']);
</script>

<script>
	// 39 P3 — Settings ▸ Scene ▸ Performance: how complex the ghost of an item dragged in from
	// the Explorer may be. LOCAL (this device), persisted by placementPrefs.js. Its own file so the
	// settings index stays a one-line union.
	import SettingRow from '../../ui/SettingRow.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import { placementPreview, placementTriBudget, placementShowDims, normalizeTriBudget, defaultTriBudget } from '$lib/placementPrefs';

	const MODES = [
		{ value: 'full', label: 'Full model' },
		{ value: 'budget', label: 'Within budget' },
		{ value: 'box', label: 'Box only' }
	];
	const budgetOn = $derived($placementPreview === 'budget');
</script>

<!-- the I4 search reads a section's keywords from its root element -->
<div class="contents" data-keywords={keywords.join(' ')}>
	<SettingRow id="row-placement-preview" label="Placement preview" description="What an item dragged in from the Explorer shows before you drop it. A file not loaded yet is always its box." wide>
		<Segmented id="placement-preview" label="Placement preview" options={MODES} value={$placementPreview} onchange={(v) => placementPreview.set(/** @type {any} */ (v))} />
	</SettingRow>
	<SettingRow id="row-placement-budget" label="Preview triangle budget" description={'Above this a loaded model previews as its box (default ' + defaultTriBudget().toLocaleString() + ' here).'} disabled={!budgetOn}>
		<span class="settings-unit">
			<input
				id="placement-tri-budget"
				class="settings-num"
				type="number"
				min="0"
				step="1000"
				aria-label="Preview triangle budget"
				disabled={!budgetOn}
				value={$placementTriBudget}
				onchange={(e) => placementTriBudget.set(normalizeTriBudget(e.currentTarget.value))}
			/>tris</span
		>
	</SettingRow>
	<SettingRow id="row-placement-dims" label="Show dimensions" description="Width × depth × height in metres, and the triangles and download size, beside the pointer.">
		<Toggle id="placement-show-dims" label="Show dimensions" bind:checked={$placementShowDims} />
	</SettingRow>
</div>

<style>
	.contents {
		display: contents;
	}
</style>
