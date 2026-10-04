<script context="module">
	// what the I4 settings search matches this section by, beyond its row names
	export const keywords = ['export', 'publish', 'itch', 'itch.io', 'zip', 'html', 'badge', 'made with', 'fullscreen', 'fps', 'quality', 'vr', 'cdn', 'packs', 'embed', 'static host'];
</script>

<script>
	// 36-export — THE EXPORT DEFAULTS, one section in its own file: the Publish / Export
	// modal's Settings tab renders it, and Settings ▸ Export registers it with one line. Every
	// row persists per device (exportStores.exportPrefs, safeStorage) and seeds the next export;
	// the build reads them, so changing one here changes what the next zip does.
	//
	// The badge row is checked and DISABLED on purpose — there is no way to switch it off, here
	// or anywhere (see MadeWithBadge.svelte); the row exists so the rule is visible where a
	// person would look for the switch.
	import SettingRow from './SettingRow.svelte';
	import { exportPrefs, setExportPrefs } from '$lib/export/exportStores.js';

	/** @param {Event} e */
	const checked = (e) => /** @type {HTMLInputElement} */ (e.currentTarget).checked;
</script>

<div id="export-settings-section">
	<SettingRow name="Show Made with ThePrototype badge">
		<svelte:fragment slot="control"
			><input id="export-badge" class="tp-check" type="checkbox" checked disabled aria-label="Show Made with ThePrototype badge (always on)" /></svelte:fragment
		>
		Always on in play links, embeds and exported games: a small logo in the bottom-right corner that opens
		theprototype.app. An exported file is yours to edit, so this is a request, not DRM — please keep it.
	</SettingRow>
	<SettingRow name="Start fullscreen">
		<svelte:fragment slot="control"
			><input
				id="export-start-fullscreen"
				class="tp-check"
				type="checkbox"
				checked={$exportPrefs.startFullscreen}
				on:change={(e) => setExportPrefs({ startFullscreen: checked(e) })}
			/></svelte:fragment
		>
		The first Play press also asks the browser for fullscreen (a page may only go fullscreen on a click).
	</SettingRow>
	<SettingRow name="Show FPS">
		<svelte:fragment slot="control"
			><input id="export-show-fps" class="tp-check" type="checkbox" checked={$exportPrefs.showFps} on:change={(e) => setExportPrefs({ showFps: checked(e) })} /></svelte:fragment
		>
		The game starts with its frame counter on. Players can still switch it in the game's own menu.
	</SettingRow>
	<SettingRow name="Quality">
		<svelte:fragment slot="control">
			<select
				id="export-quality"
				class="ui-input w-full"
				value={$exportPrefs.quality}
				on:change={(e) => setExportPrefs({ quality: /** @type {HTMLSelectElement} */ (e.currentTarget).value })}
			>
				<option value="auto">Auto</option>
				<option value="high">High</option>
				<option value="medium">Medium</option>
				<option value="low">Low</option>
			</select>
		</svelte:fragment>
		The quality a player starts at. Auto steps down by itself when frames run slow.
	</SettingRow>
	<SettingRow name="Include VR button">
		<svelte:fragment slot="control"
			><input id="export-vr-button" class="tp-check" type="checkbox" checked={$exportPrefs.vrButton} on:change={(e) => setExportPrefs({ vrButton: checked(e) })} /></svelte:fragment
		>
		On a headset browser the start card offers Enter VR. Off = the game always plays on the screen.
	</SettingRow>
	<SettingRow name="Use CDN for packs">
		<svelte:fragment slot="control"
			><input
				id="export-cdn-packs"
				class="tp-check"
				type="checkbox"
				checked={$exportPrefs.useCdnForPacks}
				on:change={(e) => setExportPrefs({ useCdnForPacks: checked(e) })}
			/></svelte:fragment
		>
		Smaller zip: kit pieces load from the packs CDN when the game starts, so it needs internet. Off = every pack
		file the scene uses is copied into the zip.
	</SettingRow>
	<SettingRow name="Compress textures">
		<svelte:fragment slot="control"
			><input id="export-compress-textures" class="tp-check" type="checkbox" disabled aria-label="Compress textures (not available yet)" /></svelte:fragment
		>
		Not in this release: textures go into the export exactly as authored.
	</SettingRow>
</div>
