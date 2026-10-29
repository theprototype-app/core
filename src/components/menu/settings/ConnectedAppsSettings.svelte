<script module>
	/** 86 B5: what the settings search matches beyond the row names */
	export const keywords = ['claude', 'connector', 'connected apps', 'mcp', 'revoke', 'oauth', 'voice', 'claude.ai', 'disconnect'];
</script>

<script>
	// 86 B5 — Settings ▸ Connected apps: the apps this ACCOUNT allowed to use theprototype (claude.ai,
	// Claude Code…), each with its last use and Revoke, plus this tab's own link. Rendered only while the
	// cloud plugin installs a connector provider (a signed-in cloud build); the plugin talks to the
	// connector service, core draws the rows. Its own file so the settings index stays a one-line union.
	import { onMount } from 'svelte';
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Button from '../../ui/Button.svelte';
	import { connectorProvider } from '$lib/cloudHooks';
	import { connectorState, connectorLine, connectClaude, disconnectClaude } from '$lib/connector/connectorStore';
	import { showConfirm } from '$lib/confirmDialog';
	import { showToast } from '../../../stores/appStore';

	/** @type {{id: string, client: string, redirectHost?: string, scopes?: string[], created?: number, lastUsed?: number}[]} */
	let apps = $state([]);
	let loading = $state(true);
	let failed = $state('');
	/** the row whose Revoke is running */
	let busy = $state('');

	const s = $derived($connectorState);
	const live = $derived(s.phase === 'connected' || s.phase === 'reconnecting' || s.phase === 'pairing' || s.phase === 'connecting');

	async function load() {
		const p = /** @type {any} */ ($connectorProvider);
		if (!p?.connections) return;
		loading = true;
		failed = '';
		try {
			const r = await p.connections();
			apps = Array.isArray(r?.connections) ? r.connections.slice(0, 50) : [];
		} catch (e) {
			failed = e instanceof Error ? e.message : 'Could not load your connected apps.';
		} finally {
			loading = false;
		}
	}
	onMount(load);

	/** @param {number|undefined} at */
	function when(at) {
		if (!at) return 'never used';
		const d = new Date(at);
		return 'last used ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	/** @param {string[]|undefined} scopes */
	const access = (scopes) => ((scopes ?? []).includes('session:edit') ? 'can build' : 'can look');

	/** @param {{id: string, client: string}} app */
	async function revoke(app) {
		const ok = await showConfirm({
			title: 'Revoke ' + app.client + '?',
			message: app.client + ' can no longer use theprototype for you. Adding the connector again in claude.ai asks you to sign in again.',
			confirmLabel: 'Revoke',
			cancelLabel: 'Cancel'
		});
		if (!ok) return;
		busy = app.id;
		try {
			await /** @type {any} */ ($connectorProvider).revoke(app.id);
			showToast(app.client + ' was revoked.');
		} catch (e) {
			showToast('Could not revoke: ' + (e instanceof Error ? e.message : String(e)));
		} finally {
			busy = '';
			void load();
		}
	}

	async function revokeAll() {
		const ok = await showConfirm({
			title: 'Disconnect every app?',
			message: 'Every connected app loses access, and this tab stops answering Claude.',
			confirmLabel: 'Disconnect all',
			cancelLabel: 'Cancel'
		});
		if (!ok) return;
		busy = '*';
		try {
			await /** @type {any} */ ($connectorProvider).revokeAll();
			void disconnectClaude();
			showToast('Every connected app was disconnected.');
		} catch (e) {
			showToast('Could not disconnect: ' + (e instanceof Error ? e.message : String(e)));
		} finally {
			busy = '';
			void load();
		}
	}
</script>

{#if $connectorProvider}
	<div class="contents" data-keywords={keywords.join(' ')} id="connected-apps-settings">
		<Section variant="card" label="This tab" badge="This device">
			<SettingRow id="row-connector-tab" label="Claude connector" keywords="claude connector tab voice">
				{#snippet desc()}
					{live ? connectorLine(s) : 'Press Connect Claude to let claude.ai — chat or voice — build in this tab, with your access. Keep the tab open while it works.'}
				{/snippet}
				{#if live}
					<Button id="connected-apps-disconnect" variant="outline" size="sm" icon="unlink" onclick={disconnectClaude}>Disconnect</Button>
				{:else}
					<Button id="connected-apps-connect" variant="secondary" size="sm" icon="link" onclick={connectClaude}>Connect Claude</Button>
				{/if}
			</SettingRow>
		</Section>
		<Section variant="card" label="Connected apps" badge="Your account">
			{#if loading && !apps.length}
				<SettingRow id="row-connected-apps-loading" label="Loading…" />
			{:else if failed}
				<SettingRow id="row-connected-apps-failed" label="Connected apps" description={failed}>
					<Button variant="outline" size="sm" onclick={load}>Retry</Button>
				</SettingRow>
			{:else if !apps.length}
				<SettingRow
					id="row-connected-apps-none"
					label="No connected apps"
					description="Add theprototype as a connector in claude.ai (Settings ▸ Connectors), sign in, and it appears here."
				/>
			{:else}
				{#each apps as app (app.id)}
					<SettingRow id={'row-connected-app-' + app.id} label={app.client} data-app={app.id} keywords="revoke connector">
						{#snippet desc()}
							{access(app.scopes)} · {app.redirectHost ? app.redirectHost + ' · ' : ''}{when(app.lastUsed)}
						{/snippet}
						<Button variant="warn-text" size="sm" disabled={!!busy} aria-label={'Revoke ' + app.client} onclick={() => revoke(app)}>Revoke</Button>
					</SettingRow>
				{/each}
				<SettingRow id="row-connected-apps-all" label="Disconnect everything" description="Every app above loses access and this tab’s link ends.">
					<Button id="connected-apps-revoke-all" variant="warn-text" size="sm" disabled={!!busy} onclick={revokeAll}>Disconnect all</Button>
				</SettingRow>
			{/if}
		</Section>
	</div>
{/if}
