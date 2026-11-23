<script module>
	/** 89 I2: the old Account words still find the way to Connected apps */
	export const keywords = ['connected apps', 'connector', 'revoke', 'claude', 'chatgpt', 'ai apps', 'disconnect', 'oauth', 'mcp'];
</script>

<script>
	// 89 I2 — Settings ▸ Account ▸ Connected apps is a LINK now: the list itself moved to Settings ▸ AI ▸ "AI apps that work
	// in your scene" (ConnectedAppsSettings.svelte, unchanged), beside the rest of AI. Shown only while the cloud plugin
	// installs a connector provider, as the list was. Its id is the old group's, so a deep link to it still lands here
	// when it names the Account page, and openSettingsAt sends the moved anchors on to the AI page.
	import Section from '../../ui/Section.svelte';
	import NavRow from '../../ui/NavRow.svelte';
	import { connectorProvider } from '$lib/cloudHooks';
	import { openSettingsAt } from '$lib/settings/openSettingsAt.js';
</script>

{#if $connectorProvider}
	<div class="contents" data-keywords={keywords.join(' ')} id="account-connected-apps-link">
		<Section variant="card" label="Connected apps" badge="Your account">
			<NavRow
				id="row-account-connected-apps"
				icon="link"
				label="Connected apps"
				description="The AI apps you allowed — Claude, ChatGPT and others — and Revoke, in Settings ▸ AI."
				onclick={() => openSettingsAt('ai', 'connected-apps-settings')}
			/>
		</Section>
	</div>
{/if}

