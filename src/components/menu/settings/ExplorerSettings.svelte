<script module>
	import { registerSettingsKeywords } from '$lib/settingsSearch';
	const ROW_WORDS = {
		'when you add files during a session': ['share', 'sharing', 'ask', 'files', 'library'],
		'download shared files automatically': ['download', 'auto download', 'metered'],
		'offer to merge unsaved work on connect': ['merge', 'stash', 'share', 'connect'],
		'who can unshare a file': ['unshare', 'owner', 'permissions'],
		'keep versions per scene': ['versions', 'history', 'auto-versioning'],
		'when importing files already in your library': ['import', 'duplicate', 'duplicates', 'copies', 'skip'],
		'save name': ['file name', 'filename', 'download name', 'template', 'date'],
		'keep a recycle bin': ['trash', 'bin', 'recycle', 'restore'],
		'delete without asking': ['confirm', 'confirmation', 'delete'],
		'keep deleted files after a reload': ['bin', 'trash', 'reload'],
		'deleted files log': ['log', 'deleted', 'record'],
		'storage used': ['disk', 'space', 'quota', 'storage']
	};
	for (const [row, words] of Object.entries(ROW_WORDS)) registerSettingsKeywords(row, words);
</script>

<script>
	// 37-settings (R21) — Settings ▸ Explorer on the redesign kit (docs/settings-inventory.md §3.7).
	// Same stores / keys as 1.25.0 (shared:*, connect:mergeOnConnect, project:keepVersions …).
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import Button from '../../ui/Button.svelte';
	import { settingsOpen } from '../../../stores/appStore.js';
	import { unshareAuthority, shareNewFiles, autoDownload, recycleBinEnabled, keepRecycleBin, deletedLogEnabled, deleteWithoutConfirm } from '$lib/sharedLibrary';
	import { mergeOnConnect } from '$lib/connectionState';
	import { keepVersionsSetting } from '$lib/projectManifest';
	import { duplicateImportMode } from '$lib/importDuplicates';
	import { saveNameTemplate } from '$lib/saveName';
	import { openStorageModal } from '$lib/storageUsage';

	const SHARE_NEW = [
		{ value: 'ask', label: 'Ask', title: 'Ask each time, above the files in the Explorer' },
		{ value: 'always', label: 'Share', title: 'Share automatically' },
		{ value: 'never', label: 'Keep local', title: 'Keep them local, ask nothing' }
	];
	const UNSHARE = [
		{ value: 'anyone', label: 'Anyone' },
		{ value: 'owner', label: 'Who shared it' }
	];
	const IMPORT_DUP = [
		{ value: 'ask', label: 'Ask' },
		{ value: 'skip', label: 'Skip' },
		{ value: 'copy', label: 'Copy' }
	];
</script>

<div class="settings-page-body" data-keywords="files library storage">
	<Section variant="card" label="Sharing" badge="This device">
		<SettingRow id="row-share-new-files" label="When you add files during a session" description="Ask puts the question in the Explorer; a file you explicitly unshared stays unshared whatever this says." wide>
			<Segmented id="share-new-files" label="When you add files during a session" options={SHARE_NEW} value={$shareNewFiles} onchange={(v) => shareNewFiles.set(/** @type {any} */ (v))} />
		</SettingRow>
		<SettingRow id="row-auto-download" label="Download shared files automatically" description="Fetches what others share straight away. Off on a metered connection: files appear greyed and download when opened.">
			<Toggle id="auto-download" label="Download shared files automatically" bind:checked={$autoDownload} />
		</SettingRow>
		<SettingRow id="row-merge-on-connect" label="Offer to merge unsaved work on connect" description="Asks Share or Stash for a never-saved scene, instead of Save or Dismiss.">
			<Toggle id="merge-on-connect" label="Offer to merge unsaved work on connect" bind:checked={$mergeOnConnect} />
		</SettingRow>
		<SettingRow id="row-unshare-authority" label="Who can unshare a file" description="Nobody loses a copy they already downloaded. This sets your own menus, not a session rule.">
			<Segmented id="unshare-authority" label="Who can unshare a file" options={UNSHARE} value={$unshareAuthority} onchange={(v) => unshareAuthority.set(v === 'owner' ? 'owner' : 'anyone')} />
		</SettingRow>
	</Section>

	<Section variant="card" label="Files">
		<SettingRow id="row-keep-versions" label="Keep versions per scene" description="Past versions of each scene kept on this device; pinned ones always stay. 0 turns auto-versioning off.">
			<input
				id="keep-versions"
				class="settings-num"
				type="number"
				min="0"
				max="200"
				step="1"
				aria-label="Keep versions per scene"
				value={$keepVersionsSetting}
				onchange={(e) => keepVersionsSetting.set(Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)))}
			/>
		</SettingRow>
		<SettingRow id="row-import-duplicate" label="When importing files already in your library" description="Ask decides file by file; Skip keeps what you have; Copy brings them in beside the originals." wide>
			<Segmented id="import-duplicate-mode" label="When importing files already in your library" options={IMPORT_DUP} value={$duplicateImportMode} onchange={(v) => duplicateImportMode.set(/** @type {any} */ (v))} />
		</SettingRow>
		<SettingRow id="row-save-name" label="Save name" wide>
			{#snippet desc()}What a download is called: <code>[name]</code> plus date parts like <code>[YYYY]</code> <code>[MM]</code> <code>[DD]</code> (UTC).{/snippet}
			<input
				id="save-name-template"
				class="settings-text"
				type="text"
				aria-label="Save name"
				value={$saveNameTemplate}
				onchange={(e) => saveNameTemplate.set(String(e.currentTarget.value ?? ''))}
			/>
		</SettingRow>
	</Section>

	<Section variant="card" label="Deleted files" badge="This device">
		<SettingRow id="row-recycle-bin" label="Keep a recycle bin" description="A delete keeps a copy in Deleted files where it can be restored. Peers always keep their own.">
			<Toggle id="recycle-bin" label="Keep a recycle bin" bind:checked={$recycleBinEnabled} />
		</SettingRow>
		<SettingRow id="row-delete-no-confirm" label="Delete without asking" description="Skips the confirmation. With the bin off too, a delete is immediate and final.">
			<Toggle id="delete-no-confirm" label="Delete without asking" bind:checked={$deleteWithoutConfirm} />
		</SettingRow>
		<SettingRow id="row-keep-recycle-bin" label="Keep deleted files after a reload" description="Off, the bin is emptied the next time you load; the log keeps the record.">
			<Toggle id="keep-recycle-bin" label="Keep deleted files after a reload" bind:checked={$keepRecycleBin} />
		</SettingRow>
		<SettingRow id="row-deleted-log" label="Deleted files log" description="A record of what was deleted, by whom and when. Off hides it; it never erases the project’s record.">
			<Toggle id="deleted-log" label="Deleted files log" bind:checked={$deletedLogEnabled} />
		</SettingRow>
	</Section>

	<Section variant="card" label="Disk">
		<SettingRow id="row-storage-used" label="Storage used" wide description="What uses this device’s storage, with ticks to reclaim what you no longer want.">
			<Button
				id="settings-storage"
				size="sm"
				variant="outline"
				onclick={() => {
					settingsOpen.set(false);
					openStorageModal();
				}}>Show breakdown</Button
			>
		</SettingRow>
	</Section>
</div>

<style>
	.settings-page-body {
		display: contents;
	}
</style>
