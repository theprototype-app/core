<script module>
	/** 48 O1: what the settings search matches beyond the row names */
	export const keywords = ['privacy', 'error reports', 'crash reports', 'telemetry', 'anonymous', 'opt out', 'diagnostics', 'bug', 'hide my ip', 'ip address', 'relay', 'turn'];
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
	import { peers } from '../../../stores/appStore';
	import { hideMyIp, relayStatus } from '$lib/hideMyIp';
	import { onMount } from 'svelte';

	// 71 TR4: the cloud plugin puts its relay credential on the Peer by itself, with no event to
	// listen to, so the status line reads the live config once a second while this is open
	let relay = $state(/** @type {'off'|'relay'|'no-relay'} */ ('off'));
	let connected = $state(false);
	const readRelay = () => {
		relay = relayStatus($hideMyIp, $peers?.peer?.options?.config);
		connected = ($peers?.openedPeers?.size ?? 0) > 0;
	};
	$effect(readRelay);
	onMount(() => {
		const t = setInterval(readRelay, 1000);
		return () => clearInterval(t);
	});
</script>

<div class="contents" data-keywords={keywords.join(' ')}>
	<Section variant="card" label="Connections" badge="This device">
		<SettingRow id="row-hide-my-ip" label="Hide my IP" keywords="ip address relay turn privacy">
			{#snippet desc()}
				Connect only through a relay server, so people in your session never see your IP address. The relay and the signaling server can still see it. Links can be a little slower.
				<a class="settings-link" href="/privacy" target="_blank" rel="noopener">Privacy</a>
			{/snippet}
			<Toggle id="hide-my-ip" label="Hide my IP" bind:checked={$hideMyIp} />
		</SettingRow>
		{#if relay === 'relay'}
			<p id="hide-my-ip-status" class="hide-ip-note" data-relay="relay">New connections go through the relay.{connected ? ' People you are already connected to keep the current link: leave and rejoin to switch it.' : ''}</p>
		{:else if relay === 'no-relay'}
			<p id="hide-my-ip-status" class="hide-ip-note hide-ip-warn" data-relay="no-relay">No relay server is available right now, so you cannot connect to anyone. A direct connection is not tried while this is on.</p>
		{/if}
	</Section>
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
</div>

<style>
	.hide-ip-note {
		margin: 0;
		padding: 0 12px 10px;
		font-size: var(--fs-badge);
		color: var(--text-muted);
	}
	.hide-ip-warn {
		color: var(--ink-warn);
	}
</style>
