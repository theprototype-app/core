<script context="module">
	/** 36 F10: what the settings search matches beyond the row name (I4 indexes labels + keywords) */
	export const keywords = ['node editor', 'graph', 'open', 'opens', 'frame', 'framed', 'fit', 'view', 'zoom', 'pan', 'where it was left', 'centre', 'center'];
</script>

<script>
	// 36 F10 — Settings ▸ Input ▸ Node editor: where the node editor opens. Its own file so
	// the settings index stays a one-line union. LOCAL (this device), persisted through
	// safeStorage by flowView.
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import SettingRow from '../SettingRow.svelte';
	import { nodeEditorOpens, NODE_EDITOR_OPENS } from '$lib/flowView';
</script>

<div class="contents" data-keywords={keywords.join(' ')}>
	<SettingRow name="Node editor opens">
		<svelte:fragment slot="control">
			<ThemedSelect id="flow-opens" items={NODE_EDITOR_OPENS} bind:value={$nodeEditorOpens} />
		</svelte:fragment>
		<span>Where it was left (the default): a graph opens on the view its creator — or you — last panned or zoomed to, and every other graph (a template, an example, anything nobody moved) opens framed with all its nodes in view. Framed: every graph always opens with all its nodes in view, the same as pressing <kbd>A</kbd></span>
	</SettingRow>
</div>
