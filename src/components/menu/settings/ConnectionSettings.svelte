<script module>
	import { registerSettingsKeywords } from '$lib/settingsSearch';
	const ROW_WORDS = {
		'session size': ['peers', 'people', 'cap', 'limit', 'bandwidth'],
		'signaling server': ['peerjs', 'network', 'server', 'self-hosted', 'public cloud', 'local dev'],
		'custom server': ['host', 'port', 'path', 'wss', 'turn', 'stun', 'relay', 'nat', 'firewall'],
		'apply changes': ['reconnect', 'reload', 'switch server']
	};
	for (const [row, words] of Object.entries(ROW_WORDS)) registerSettingsKeywords(row, words);
	registerSettingsKeywords('turn urls', ['relay', 'nat', 'firewall', 'network']);
	registerSettingsKeywords('stun urls', ['nat', 'network']);
</script>

<script>
	// 37-settings (R21) — Settings ▸ Connection on the redesign kit (docs/settings-inventory.md §3.12):
	// the server choice as a segmented control, the Custom server's fields on their own SUB-PAGE
	// ("Connection › Custom server", one field per row — Port + path and the TURN credentials were
	// two inputs in one row). Same store / key (peerServerConfig, connect:softPeerCap).
	// 24-D2: Apply switches WITHOUT a reload (PeerConnection.switchServer keeps the session id).
	import { getContext } from 'svelte';
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import NavRow from '../../ui/NavRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import Button from '../../ui/Button.svelte';
	import { NAV_CONTEXT } from '$lib/settingsNav';
	import { peers, showToast } from '../../../stores/appStore.js';
	import { softPeerCap, HARD_PEER_CAP, SOFT_PEER_CAP_DEFAULT } from '$lib/connectionState';
	import { peerServerConfig, HAS_SELF_HOSTED, SELF_HOSTED_HOST, peerServerStatus } from '$lib/peerServer';

	const nav = /** @type {any} */ (getContext(NAV_CONTEXT));
	const sub = nav?.sub;
	const customPage = $derived($sub?.id === 'conn:custom');

	let applyingServer = $state(false);
	async function applyPeerServer() {
		const p = /** @type {any} */ ($peers);
		if (!p?.switchServer) {
			location.reload();
			return;
		}
		applyingServer = true;
		const ok = await p.switchServer(null);
		applyingServer = false;
		if (ok) showToast('Connected to ' + ($peerServerStatus?.label ?? 'the peer server') + ' — your session id is unchanged.');
	}
	/** @param {any} v */
	function setPeerMode(v) {
		peerServerConfig.update((c) => ({ ...c, mode: v }));
	}
	/** @param {string} k @param {any} v */
	function setPeerCustom(k, v) {
		peerServerConfig.update((c) => ({ ...c, custom: { ...c.custom, [k]: v } }));
	}
	/** @param {Event} e */
	const value = (e) => /** @type {HTMLInputElement} */ (e.currentTarget).value;

	const MODES = [
		{ value: 'default', label: 'Default', title: HAS_SELF_HOSTED ? 'Self-hosted, with the public cloud as fallback' : 'The public PeerJS cloud' },
		{ value: 'public', label: 'Public', title: 'The public PeerJS cloud' },
		{ value: 'custom', label: 'Custom', title: 'Your own server (no fallback)' },
		{ value: 'local', label: 'Local dev', title: 'npm run peer on this machine (localhost:9001)' }
	];
	const modeNote = $derived(
		$peerServerConfig.mode === 'default'
			? HAS_SELF_HOSTED
				? 'Uses ' + SELF_HOSTED_HOST + ' and falls back to the public PeerJS cloud.'
				: 'The public PeerJS cloud.'
			: $peerServerConfig.mode === 'public'
				? 'The public PeerJS cloud.'
				: $peerServerConfig.mode === 'custom'
					? 'Your own server, no fallback.'
					: 'The npm run peer server on this machine.'
	);
</script>

<div class="settings-page-body" data-keywords="peer network server invite room session">
	{#if customPage}
		<Section variant="card" label="Server" badge="This device">
			<SettingRow id="row-peer-host" label="Host" description="Your PeerJS server, no https:// and no path." wide>
				<input class="settings-text" id="peer-custom-host" placeholder="peer.example.com" value={$peerServerConfig.custom.host} onchange={(e) => setPeerCustom('host', value(e))} />
			</SettingRow>
			<SettingRow id="row-peer-port" label="Port" description="443 behind Caddy / TLS.">
				<input class="settings-num" id="peer-custom-port" placeholder="443" value={$peerServerConfig.custom.port} onchange={(e) => setPeerCustom('port', value(e))} />
			</SettingRow>
			<SettingRow id="row-peer-path" label="Path" description="/peerjs behind Caddy / TLS.">
				<input class="settings-text" id="peer-custom-path" placeholder="/peerjs" value={$peerServerConfig.custom.path} onchange={(e) => setPeerCustom('path', value(e))} />
			</SettingRow>
			<SettingRow id="row-peer-secure" label="Secure (wss)" description="Use TLS. Leave on unless testing a plain-ws server.">
				<Toggle id="peer-custom-secure" label="Secure (wss)" checked={!!$peerServerConfig.custom.secure} onchange={(on) => setPeerCustom('secure', on)} />
			</SettingRow>
		</Section>
		<Section variant="card" label="Relays">
			<SettingRow id="row-peer-turn" label="TURN URLs" description="The NAT relay, comma-separated. Blank allows direct connections only." wide>
				<input class="settings-text" id="peer-custom-turn" placeholder="turn:host:3478?transport=udp,…" value={$peerServerConfig.custom.turnUrls} onchange={(e) => setPeerCustom('turnUrls', value(e))} />
			</SettingRow>
			<SettingRow id="row-peer-turn-user" label="TURN username" wide>
				<input class="settings-text" id="peer-custom-turn-user" placeholder="turn user" value={$peerServerConfig.custom.turnUsername} onchange={(e) => setPeerCustom('turnUsername', value(e))} />
			</SettingRow>
			<SettingRow id="row-peer-turn-credential" label="TURN credential" wide>
				<input class="settings-text" id="peer-custom-turn-credential" placeholder="turn credential" value={$peerServerConfig.custom.turnCredential} onchange={(e) => setPeerCustom('turnCredential', value(e))} />
			</SettingRow>
			<SettingRow id="row-peer-stun" label="STUN URLs" description="Optional, comma-separated." wide>
				<input class="settings-text" id="peer-custom-stun" placeholder="stun:host:3478" value={$peerServerConfig.custom.stunUrls} onchange={(e) => setPeerCustom('stunUrls', value(e))} />
			</SettingRow>
		</Section>
	{:else}
		<Section variant="card" label="Session" badge="This device">
			<SettingRow id="row-session-size" label="Session size" description={'How many people you expect. Past this an approval warns; the hard limit is ' + HARD_PEER_CAP + '.'}>
				<input
					id="soft-peer-cap"
					class="settings-num"
					type="number"
					min="2"
					max={HARD_PEER_CAP}
					aria-label="Session size"
					value={$softPeerCap}
					onchange={(e) => {
						const n = Number(e.currentTarget.value);
						softPeerCap.set(Number.isFinite(n) ? Math.min(HARD_PEER_CAP, Math.max(2, Math.round(n))) : SOFT_PEER_CAP_DEFAULT);
					}}
				/>
			</SettingRow>
		</Section>
		<Section variant="card" label="Signaling server" badge="This device">
			<SettingRow id="row-peer-mode" label="Signaling server" description={'Where peers find each other. ' + modeNote} wide>
				<Segmented id="peer-server-mode" label="Signaling server" options={MODES} value={$peerServerConfig.mode} onchange={(v) => setPeerMode(v)} />
			</SettingRow>
			{#if $peerServerConfig.mode === 'custom'}
				<NavRow id="peer-custom-open" label="Custom server" value={$peerServerConfig.custom.host || 'not set'} onclick={() => nav.openSub('conn:custom', 'Custom server', 'connection')} />
			{/if}
			<SettingRow id="row-peer-apply" label="Apply changes" description="Switches the server now and keeps your session id; an open session is left first.">
				<Button id="peer-server-reload" size="sm" variant="ghost" onclick={() => location.reload()}>Reload</Button>
				<Button id="peer-server-apply" size="sm" variant="outline" disabled={applyingServer} onclick={applyPeerServer}>{applyingServer ? 'Switching…' : 'Apply'}</Button>
			</SettingRow>
		</Section>
	{/if}
</div>

<style>
	.settings-page-body {
		display: contents;
	}
</style>
