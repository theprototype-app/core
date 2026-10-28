<script module>
	// what the I4 settings search matches this section by, beyond its row names
	export const keywords = ['save', 'save project', 'ctrl+s', 'libraries', 'library', 'session', 'host', 'save on host', 'mounted', 'several', 'ask'];
</script>

<script>
	// 56 C13 (addendum 2026-10-28f) — Settings ▸ Save options ▸ "When several libraries are open": what
	// Save project and Ctrl+S do while more than one library is open (my Library, a host's session, a
	// mounted project with changes). Ask (the default) shows one dialog; the other two save without
	// asking. Per device (saveOptions, safeStorage). The Save project dialog's "Remember my choice"
	// writes this same row and links here.
	import SettingRow from '../ui/SettingRow.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import { saveOptions, setSaveOptions } from '$lib/saveOptions';
	import { SAVE_MANY_OPTIONS, SAVE_MANY_LABELS } from '$lib/sessionVolumeCore';

	const OPTIONS = SAVE_MANY_OPTIONS.map((value) => ({ value, label: SAVE_MANY_LABELS[value] }));
</script>

<div id="save-options-settings-section" class="contents" data-keywords={keywords.join(' ')}>
	<SettingRow
		id="row-save-many"
		label="When several libraries are open"
		description="Save project and Ctrl+S, while your Library and another one (a session you joined, a mounted project with changes) are open. With one library open they always save it straight away."
		wide
	>
		<Segmented
			id="save-many-setting-seg"
			label="When several libraries are open"
			options={OPTIONS}
			value={$saveOptions.saveMany}
			onchange={(/** @type {string} */ v) => setSaveOptions({ saveMany: /** @type {any} */ (v) })}
		/>
	</SettingRow>
</div>
