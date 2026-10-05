<script context="module">
	/** 37 R14: what the settings search matches beyond the row name */
	export const keywords = ['layout', 'layouts', 'workspace', 'windows', 'dock', 'docked', 'panels', 'arrangement', 'save layout', 'restore layout', 'sizes'];
</script>

<script>
	// 37 R14 — Settings ▸ Interface ▸ Workspace layouts. Its own file so the settings index
	// stays a one-line union. LOCAL (this browser), persisted through safeStorage by uiLayouts.
	import SettingRow from '../SettingRow.svelte';
	import WorkspaceLayouts from '../WorkspaceLayouts.svelte';
</script>

<div class="contents" data-keywords={keywords.join(' ')}>
	<SettingRow name="Workspace layouts">
		<svelte:fragment slot="control">
			<WorkspaceLayouts idPrefix="settings-layouts" />
		</svelte:fragment>
		<span>Save the windows you have open — which panels, docked or floating, their sizes, the side and bottom docks — under a name, and switch between arrangements in one click (also in the menu ▸ Layouts). Kept on this device; a page reload still starts clean</span>
	</SettingRow>
</div>
