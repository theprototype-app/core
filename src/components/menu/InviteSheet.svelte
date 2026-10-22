<script>
	// 55 A4 — THE INVITE SHEET (Connect ▸ Request AI). ONE mechanism, two tabs: *AI agent*
	// and *Person* mint the same signed, host-verified invite (inviteCore/inviteStore). The
	// host picks the role (View preselected for people, Edit for agents — hidden in the OSS
	// build, where every peer edits), the expiry and how many may use it; then copies the
	// link, the ready MCP command (agents) or one sentence for any chat. Once used, the sheet
	// says "used by <name> (<id>)", live from the record. No typed join code (owner's call).
	import { get } from 'svelte/store';
	import ModalDialog from '../ui/ModalDialog.svelte';
	import Tabs from '../ui/Tabs.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import Button from '../ui/Button.svelte';
	import Icon from '../ui/Icon.svelte';
	import { peers, showToast } from '../../stores/appStore';
	import { rolesInfo } from '$lib/cloudHooks';
	import { peerServerStatus, inviteServerParam } from '$lib/peerServer';
	import { invites, inviteSheet, createInvite, revokeInvite, listInvites, handover, tokenOf } from '$lib/inviteStore';

	/** @type {'agent'|'person'} */
	let tab = $state(get(inviteSheet) === 'person' ? 'person' : 'agent');
	let open = $state(true);
	$effect(() => {
		if (!open) inviteSheet.set(null);
	});

	let now = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 15000);
		return () => clearInterval(t);
	});

	// the settings per tab — the defaults the owner chose (View for people, Edit for agents)
	let role = $state(/** @type {'view'|'edit'} */ (get(inviteSheet) === 'person' ? 'view' : 'edit'));
	let expiry = $state('30m');
	let uses = $state('1');
	/** the invite minted in this sheet, per tab @type {Record<string, string>} */
	let minted = $state({});

	const rolesOn = $derived(!!$rolesInfo);
	const myId = $derived(String($peers?.peer?.id || ''));

	/** @param {string} next */
	function switchTab(next) {
		tab = next === 'person' ? 'person' : 'agent';
		role = tab === 'agent' ? 'edit' : 'view';
	}

	const current = $derived(minted[tab] ? listInvites($invites, now).find((r) => r.id === minted[tab]) ?? null : null);
	const strings = $derived.by(() => {
		if (!current) return null;
		const token = tokenOf(current.id);
		return token ? handover(myId, token, current.kind, inviteServerParam($peerServerStatus)) : null;
	});

	function create() {
		if (!myId || !$peers?.peer?.open) {
			showToast('Not connected to the signaling server yet — try again in a moment.');
			return;
		}
		const { record } = createInvite({
			hostId: myId,
			kind: tab,
			// the OSS build has no roles: an invite simply admits (everyone edits)
			role: rolesOn ? role : tab === 'agent' ? 'edit' : 'view',
			expiry,
			maxUses: Number(uses),
			srvTail: inviteServerParam($peerServerStatus)
		});
		minted = { ...minted, [tab]: record.id };
	}

	/** @param {string} text @param {string} what */
	async function copyText(text, what) {
		try {
			await navigator.clipboard.writeText(text);
			showToast(what + ' copied.');
		} catch {
			showToast('Could not reach the clipboard — select the text and copy it.');
		}
	}

	/** @param {number} ms */
	function left(ms) {
		if (ms <= 0) return 'expired';
		const m = Math.round(ms / 60000);
		return m >= 90 ? 'expires in ' + Math.round(m / 60) + ' h' : 'expires in ' + Math.max(1, m) + ' min';
	}
	const stateText = $derived.by(() => {
		if (!current) return '';
		const n = current.maxUses;
		const head = n === 1 ? 'Single use' : 'Up to ' + n + ' people';
		const tail =
			current.state === 'revoked' ? 'revoked'
			: current.state === 'expired' ? 'expired'
			: current.state === 'used' ? 'all uses taken'
			: left(current.expiresAt - now);
		return head + ' · ' + tail + (rolesOn ? ' · ' + (current.role === 'edit' ? 'Edit' : 'View') : '');
	});
</script>

<ModalDialog
	title="Invite to this session"
	bind:open
	modal={false}
	outsideclose
	width="sm"
	desktopWidth="440px"
	onkeydown={(/** @type {KeyboardEvent} */ e) => {
		if (e.key === 'Escape') open = false;
	}}
>
	{#snippet bar()}
		<Tabs
			tabs={[
				{ id: 'agent', label: 'AI agent', icon: 'bot' },
				{ id: 'person', label: 'Person', icon: 'user-plus' }
			]}
			value={tab}
			idPrefix="invite"
			label="Who the invite is for"
			onchange={switchTab}
		/>
	{/snippet}
	<div id="invite-sheet" class="inv" data-tab={tab}>
		<p class="inv-lead">
			{#if tab === 'agent'}
				A link an AI agent (Claude Code, Claude Desktop) uses to join — no approval card. It joins as an AI, with no character.
			{:else}
				A link a friend opens to join straight away — no approval card.
			{/if}
		</p>

		{#if !current}
			{#if rolesOn}
				<div class="inv-row">
					<span class="inv-label" id="invite-role-label">Role</span>
					<Segmented
						id="invite-role"
						labelledby="invite-role-label"
						options={[
							{ value: 'view', label: 'View' },
							{ value: 'edit', label: 'Edit' }
						]}
						bind:value={role}
					/>
				</div>
			{/if}
			<div class="inv-row">
				<span class="inv-label" id="invite-expiry-label">Expires</span>
				<Segmented
					id="invite-expiry"
					labelledby="invite-expiry-label"
					options={[
						{ value: '10m', label: '10 min' },
						{ value: '30m', label: '30 min' },
						{ value: '24h', label: '24 h' }
					]}
					bind:value={expiry}
				/>
			</div>
			<div class="inv-row">
				<span class="inv-label" id="invite-uses-label">Can be used by</span>
				<Segmented
					id="invite-uses"
					labelledby="invite-uses-label"
					options={[
						{ value: '1', label: '1' },
						{ value: '5', label: '5' },
						{ value: '10', label: '10' },
						{ value: '25', label: '25' }
					]}
					bind:value={uses}
				/>
			</div>
			<div class="inv-actions">
				<Button variant="primary" id="invite-create" icon="link" onclick={create}>Create invite link</Button>
			</div>
		{:else}
			<p id="invite-state" class="inv-state" data-state={current.state}>{stateText}</p>
			{#if strings && current.state === 'active'}
				<div class="inv-field">
					<span class="inv-label">Link</span>
					<div class="inv-copy">
						<input id="invite-link" class="ui-input inv-text" readonly value={strings.link} aria-label="Invite link" />
						<Button variant="secondary" size="sm" id="invite-copy-link" icon="copy" onclick={() => copyText(strings.link, 'Invite link')}>Copy</Button>
					</div>
				</div>
				{#if tab === 'agent'}
					<div class="inv-field">
						<span class="inv-label">MCP command</span>
						<div class="inv-copy">
							<input id="invite-mcp" class="ui-input inv-text" readonly value={strings.mcp} aria-label="MCP command" />
							<Button variant="secondary" size="sm" id="invite-copy-mcp" icon="terminal" onclick={() => copyText(strings.mcp, 'MCP command')}>Copy</Button>
						</div>
					</div>
				{/if}
				<div class="inv-field">
					<span class="inv-label">For a chat</span>
					<div class="inv-copy">
						<input id="invite-chat" class="ui-input inv-text" readonly value={strings.sentence} aria-label="Chat sentence" />
						<Button variant="secondary" size="sm" id="invite-copy-chat" icon="message-square" onclick={() => copyText(strings.sentence, 'Sentence')}>Copy</Button>
					</div>
				</div>
			{/if}
			{#if current.usedBy.length}
				<ul id="invite-used-by" class="inv-used">
					{#each current.usedBy as who (who)}
						<li>Used by {who}</li>
					{/each}
				</ul>
			{/if}
			<div class="inv-actions">
				<Button variant="ghost" id="invite-new" onclick={() => (minted = { ...minted, [tab]: '' })}>New invite</Button>
				{#if current.state === 'active' || current.state === 'used'}
					<Button variant="warn-text" id="invite-revoke" onclick={() => revokeInvite(current.id)}>Revoke</Button>
				{/if}
			</div>
		{/if}
		<p class="inv-note">
			<Icon name="info" size={16} aria-hidden="true" />
			<span>The link holds a one-off key in the part after <code>#</code>, which browsers never send to a server. Anyone you forward it to can use it — revoke it in Users.</span>
		</p>
	</div>
</ModalDialog>

<style>
	.inv {
		display: flex;
		flex-direction: column;
		gap: 12px;
		font-size: var(--fs-body);
	}
	.inv-lead,
	.inv-note {
		color: var(--text-muted);
		margin: 0;
	}
	.inv-note {
		display: flex;
		gap: 6px;
		align-items: flex-start;
		font-size: var(--fs-desc);
	}
	.inv-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
	.inv-label {
		color: var(--text-muted);
		font-size: var(--fs-desc);
	}
	.inv-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.inv-copy {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.inv-text {
		flex: 1;
		min-width: 0;
		font-family: var(--font-ui-mono);
		font-size: var(--fs-desc);
	}
	.inv-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.inv-state {
		margin: 0;
		font-weight: 600;
	}
	.inv-state[data-state='revoked'],
	.inv-state[data-state='expired'] {
		color: var(--ink-warn);
	}
	.inv-used {
		margin: 0;
		padding-left: 18px;
		color: var(--text-muted);
	}
</style>
