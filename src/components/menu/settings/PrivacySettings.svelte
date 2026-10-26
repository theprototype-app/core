<script module>
	/** 48 O1: what the settings search matches beyond the row names */
	export const keywords = ['privacy', 'error reports', 'crash reports', 'telemetry', 'anonymous', 'opt out', 'diagnostics', 'bug', 'usage counts', 'analytics', 'do not track'];
</script>

<script>
	// 48 O1 — Settings ▸ Privacy: the anonymous error-report switch (default ON, LOCAL). Its own
	// file so the settings index stays a one-line union. Without an error-report endpoint in the
	// build (an OSS build, a dev server) nothing is ever sent, and the row says so instead of
	// offering a switch that controls nothing.
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import { errorReportsOn, errorReportsAvailable } from '$lib/errorReports';
	// 76 FW2: the anonymous first-visit counts (onboarding/funnel.js), offered when a plugin counts them
	import { funnelOn } from '$lib/onboarding/funnel.js';
	import { funnelListening } from '$lib/cloudHooks';
</script>

<div class="contents" data-keywords={keywords.join(' ')}>
	<Section variant="card" label="Error reports" badge="This device">
		{#if $errorReportsAvailable}
			<SettingRow
				id="row-error-reports"
				label="Send anonymous error reports"
				keywords="crash telemetry privacy"
			>
				{#snippet desc()}
					When something breaks, sends what went wrong — the error, where in the app, this app version, the device type and browser. No account, no IP address, no scene content. Up to five per visit.
					<a class="settings-link" href="/privacy" target="_blank" rel="noopener">Privacy</a>
				{/snippet}
				<Toggle id="send-error-reports" label="Send anonymous error reports" bind:checked={$errorReportsOn} />
			</SettingRow>
		{:else}
			<SettingRow id="row-error-reports" label="Error reports" description="This build sends no error reports — nothing leaves this device." keywords="crash telemetry privacy" />
		{/if}
	</Section>
	<Section variant="card" label="Usage counts" badge="This device">
		{#if $funnelListening}
			<SettingRow id="row-usage-counts" label="Count my visits anonymously" keywords="analytics telemetry privacy funnel">
				{#snippet desc()}
					Counts a few first-visit steps (the welcome card, a first change, a first Play, a first share) and whether you come back — each once, with no ID, account or IP address. Off whenever your browser asks not to be tracked.
					<a class="settings-link" href="/privacy" target="_blank" rel="noopener">Privacy</a>
				{/snippet}
				<Toggle id="send-usage-counts" label="Count my visits anonymously" bind:checked={$funnelOn} />
			</SettingRow>
		{:else}
			<SettingRow id="row-usage-counts" label="Usage counts" description="This build counts nothing — nothing leaves this device." keywords="analytics telemetry privacy" />
		{/if}
	</Section>
</div>
