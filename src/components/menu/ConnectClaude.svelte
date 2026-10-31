<script lang="ts">
	// 86 B1/B2 — CONNECT CLAUDE, in the AI assistant window. A signed-in cloud build only: with no
	// connector provider (the OSS build) this renders nothing. One row: what the state is in words (a dot
	// is never the only signal), the one button that fits it, and the hint that matters — the tab must
	// stay open, because the tools run HERE.
	// 86-fix N1: `welcome` = the same control as the first choice of the AI window's welcome (no AI provider set
	// up): a card with a title and what it means, and — signed out on a cloud build — the plugin's "Sign in to
	// connect" (cloudHooks.connectorSignInSlot) in place of the button. One instance at a time, so the ids hold.
	import Icon from '../ui/Icon.svelte';
	import Button from '../ui/Button.svelte';
	import CloudSlot from '../CloudSlot.svelte';
	import { connectorState, connectorAvailable, connectorLine, connectClaude, disconnectClaude } from '$lib/connector/connectorStore';
	import { CONNECTOR_DIRECTORY_URL, CONNECTOR_DOCS_URL, CONNECTOR_MCP_URL } from '$lib/connector/connectorLinks.js';
	import { connectorSignInSlot } from '$lib/cloudHooks';
	import { settingsOpen, settingsSection, showToast } from '../../stores/appStore';

	let { welcome = false }: { welcome?: boolean } = $props();
	const signIn = $derived(welcome && !$connectorAvailable && !!$connectorSignInSlot);

	const s = $derived($connectorState);
	const live = $derived(s.phase === 'connected' || s.phase === 'reconnecting' || s.phase === 'pairing' || s.phase === 'connecting');
	const tone = $derived(s.phase === 'connected' ? 'ok' : s.phase === 'reconnecting' || s.throttled ? 'warn' : s.phase === 'closed' || s.phase === 'error' ? 'bad' : 'idle');

	async function copyMcpLink() {
		try {
			await navigator.clipboard.writeText(CONNECTOR_MCP_URL);
			showToast('Link copied');
		} catch {
			showToast('Copy did not work here: the link is ' + CONNECTOR_MCP_URL);
		}
	}

	function openConnectedApps() {
		settingsSection.set('connectedapps');
		settingsOpen.set(true);
	}
</script>

{#if $connectorAvailable || signIn}
	<section
		id="connect-claude"
		class="cc"
		class:cc-card={welcome}
		data-phase={s.phase}
		data-tone={tone}
		aria-label={welcome ? undefined : 'Claude connector'}
		aria-labelledby={welcome ? 'connect-claude-title' : undefined}
	>
		{#if welcome}
			<h3 id="connect-claude-title" class="cc-title"><span class="cc-mark" aria-hidden="true">★</span> Connect Claude</h3>
			<p class="cc-desc">Use your Claude account (chat or voice), no API key.</p>
		{/if}
		<div class="cc-row">
			<span class="cc-dot" aria-hidden="true"></span>
			<span class="cc-text" role="status" aria-live="polite">
				{#if live}
					{connectorLine(s)}{#if s.busy}<span class="cc-busy"> · working</span>{/if}
				{:else if s.message}
					{s.message}
				{:else if signIn}
					Sign in to your theprototype account first.
				{:else}
					Use this tab from claude.ai — chat or voice.
				{/if}
			</span>
			{#if signIn}
				<CloudSlot mount={$connectorSignInSlot} />
			{:else if live}
				<Button id="connect-claude-disconnect" variant="outline" size="sm" icon="unlink" onclick={disconnectClaude}>Disconnect</Button>
			{:else}
				<Button id="connect-claude-button" variant="secondary" size="sm" icon="link" onclick={connectClaude}>Connect Claude</Button>
			{/if}
		</div>
		{#if welcome && !live}
			<!-- what to do on the claude.ai side; a directory listing turns step 1 into one link -->
			<ol id="connect-claude-steps" class="cc-steps">
				<li id="connect-claude-step-1">
					{#if CONNECTOR_DIRECTORY_URL}
						In claude.ai:
						<a id="connect-claude-add" class="cc-link" href={CONNECTOR_DIRECTORY_URL} target="_blank" rel="noopener noreferrer">Add to Claude</a>
					{:else}
						In claude.ai: Settings ▸ Connectors ▸ Add custom connector, paste
						<code class="cc-url">{CONNECTOR_MCP_URL}</code>
						<button type="button" id="connect-claude-copy" class="cc-link" onclick={copyMcpLink}>Copy link</button>
						<a id="connect-claude-how" class="cc-link" href={CONNECTOR_DOCS_URL} target="_blank" rel="noopener noreferrer">How?</a>
					{/if}
				</li>
				<li id="connect-claude-step-2">
					{#if signIn}Then sign in here, press Connect Claude and keep this tab open.{:else}Then press Connect Claude here and keep this tab open.{/if}
				</li>
			</ol>
		{/if}
		{#if s.phase === 'connected' && s.throttled}
			<p class="cc-hint cc-warn" id="connect-claude-throttled">
				<Icon name="triangle-alert" size={16} aria-hidden="true" />
				This tab was in the background long enough for the browser to slow it down. Keep it in front while Claude works.
			</p>
		{:else if live}
			<p class="cc-hint" id="connect-claude-keep-open">
				Keep this tab open — Claude builds through it, with your access in this session.
				{#if s.phase === 'connected' && !s.connections.length}
					Add theprototype as a connector in claude.ai (Settings ▸ Connectors) to talk to it.
				{/if}
				<button type="button" class="cc-link" onclick={openConnectedApps}>Connected apps</button>
			</p>
		{/if}
	</section>
{/if}

<style>
	.cc {
		padding: 6px 10px;
		border-bottom: 1px solid var(--border);
	}
	/* 86-fix N1: the welcome's first choice */
	.cc-card {
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-2);
	}
	.cc-title {
		margin: 0;
		font-size: var(--fs-body);
		font-weight: 600;
		color: var(--text);
	}
	.cc-mark {
		color: var(--accent-text);
	}
	.cc-desc {
		margin: 2px 0 8px;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.cc-steps {
		margin: 8px 0 0;
		padding-left: 18px;
		list-style: decimal;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.cc-steps li + li {
		margin-top: 4px;
	}
	.cc-url {
		overflow-wrap: anywhere;
		color: var(--text);
	}
	.cc-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.cc-dot {
		flex-shrink: 0;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-faint);
	}
	/* shape as well as colour: connected is a filled dot, the others rings */
	.cc[data-tone='ok'] .cc-dot {
		background: var(--ink-good);
	}
	.cc[data-tone='warn'] .cc-dot {
		background: transparent;
		border: 2px solid var(--ink-warn);
	}
	.cc[data-tone='bad'] .cc-dot {
		background: transparent;
		border: 2px solid var(--ink-bad);
	}
	.cc-text {
		flex: 1;
		min-width: 0;
		font-size: var(--fs-desc);
		color: var(--text);
	}
	.cc-busy {
		color: var(--text-muted);
	}
	.cc-hint {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		margin: 4px 0 0 16px;
		font-size: var(--fs-section);
		color: var(--text-muted);
	}
	.cc-warn {
		color: var(--warn-text);
	}
	.cc-link {
		padding: 0 2px;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--accent-text);
		font: inherit;
		cursor: pointer;
	}
	.cc-link:hover {
		background: var(--surface-hover);
	}
	.cc-link:focus-visible {
		outline: 2px solid var(--focus-ring, var(--accent));
		outline-offset: 1px;
	}
</style>
