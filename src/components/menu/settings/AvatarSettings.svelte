<script context="module">
	/** 36-avatars/I4: what the settings search matches beyond the row names */
	export const keywords = ['avatar', 'avatars', 'character', 'body', 'outfit', 'hat', 'head', 'peers', 'ping', 'customize', 'customise'];
</script>

<script>
	// 36-avatars — Settings ▸ Interface ▸ Avatars. Its own file so the settings index stays a one-line
	// union. "Customize character…" opens the side panel (the profile menu's entry, from here too);
	// "Show everyone as classic heads" is a LOCAL fallback for a headset with many peers.
	import { Toggle, Button } from 'flowbite-svelte';
	import SettingRow from '../SettingRow.svelte';
	import { settingsOpen, characterModalOpen } from '../../../stores/appStore.js';
	import { peersAsClassic } from '$lib/avatars/avatarState';
</script>

<div data-keywords={keywords.join(' ')}>
	<p class="ui-section-label">Avatars</p>
	<SettingRow name="Your character">
		<svelte:fragment slot="control">
			<Button
				id="settings-customize-character"
				size="xs"
				color="alternative"
				onclick={() => {
					settingsOpen.set(false);
					characterModalOpen.set(true);
				}}>Customize character…</Button
			>
		</svelte:fragment>
		Pick your character, head, hat, outfit colour and ping, with a live preview on yourself.
	</SettingRow>
	<SettingRow name="Show everyone as classic heads">
		<svelte:fragment slot="control">
			<Toggle id="avatars-peers-classic" bind:checked={$peersAsClassic} />
		</svelte:fragment>
		On this device only: draws other people as the floating head instead of their animated character
		(lighter on a headset with many people). They still see your character.
	</SettingRow>
</div>
