<script>
	// 37 R14 — Settings ▸ Interface ▸ Windows & chrome ▸ Workspace layouts. Its own file so the
	// settings page stays a one-line union. LOCAL (this browser), persisted through safeStorage by
	// uiLayouts. Search words: InterfaceSettings' ROW_WORDS ('workspace layouts').
	import SettingRow from '../../ui/SettingRow.svelte';
	import WorkspaceLayouts from '../WorkspaceLayouts.svelte';
</script>

<SettingRow
	id="row-workspace-layouts"
	label="Workspace layouts"
	description="Save the windows you have open — which panels, docked or floating, their sizes, the side and bottom docks — under a name, and switch in one click (also in the menu ▸ Layouts). A reload still starts clean."
	badge="This device"
	wide
	stack
>
	<WorkspaceLayouts idPrefix="settings-layouts" />
</SettingRow>
