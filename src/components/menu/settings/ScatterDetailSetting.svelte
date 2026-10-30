<script module>
	// I4 settings search: the labels + keywords this section answers to
	export const keywords = ['scatter', 'foliage', 'trees', 'rocks', 'instances', 'distance', 'thin', 'budget', 'performance', 'quest', 'phone'];
</script>

<script>
	// 51 — Settings ▸ Scene ▸ Performance: how far this device draws scattered models. LOCAL (a fact
	// about this device, never saved or sent). Auto reads the device (headset / phone / desktop);
	// thinning fades out FAR instances only, never near ones or colliders. Its own file so the
	// settings index stays a one-line union.
	import SettingRow from '../../ui/SettingRow.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import { scatterDetail } from '$lib/scatterThin';

	const OPTIONS = [
		{ value: 'auto', label: 'Auto' },
		{ value: 'quest', label: 'Headset' },
		{ value: 'phone', label: 'Phone' },
		{ value: 'desktop', label: 'Desktop' },
		{ value: 'off', label: 'All' }
	];
</script>

<div class="contents" data-keywords={keywords.join(' ')}>
	<SettingRow
		id="row-scatter-detail"
		label="Distant scatter"
		description="Far scattered models fade out to keep this device inside its budget. Near ones and their colliders never change. Auto follows this device; All draws everything."
		wide
	>
		<Segmented id="scatter-detail" label="Distant scatter" options={OPTIONS} value={$scatterDetail} onchange={(v) => scatterDetail.set(String(v))} />
	</SettingRow>
</div>

<style>
	.contents {
		display: contents;
	}
</style>
