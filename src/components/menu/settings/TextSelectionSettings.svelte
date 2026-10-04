<script context="module">
	/** 36 U6/I4: what the settings search matches beyond the row name */
	export const keywords = ['select', 'selection', 'text', 'copy', 'highlight', 'drag'];
</script>

<script>
	// 36 U6 — Settings ▸ Interface ▸ "Allow text selection everywhere". Its own file so the
	// settings index stays a one-line union. LOCAL (this device), persisted by textSelection.js.
	import { Toggle } from 'flowbite-svelte';
	import SettingRow from '../SettingRow.svelte';
	import { allowTextSelection } from '$lib/textSelection';
</script>

<div data-keywords={keywords.join(' ')}>
	<SettingRow name="Allow text selection everywhere">
		<svelte:fragment slot="control">
			<Toggle id="allow-text-select" bind:checked={$allowTextSelection} />
		</svelte:fragment>
		Off: only text fields, code, chat, logs and help text can be selected, so a drag across a
		menu or a panel never paints a selection. The viewport and the node editor never start one.
	</SettingRow>
</div>
