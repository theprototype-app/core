<script lang="ts">
	// 86 B1/B2 — CONNECT CLAUDE, in the AI assistant window. A signed-in cloud build only: with no
	// connector provider (the OSS build) this renders nothing. One row: what the state is in words (a dot
	// is never the only signal), the one button that fits it, and the hint that matters — the tab must
	// stay open, because the tools run HERE.
	// 86-fix N1: `welcome` = the same control as the first choice of the AI window's welcome (no AI provider set
	// up): a card with a title and what it means, and — signed out on a cloud build (cloudHooks.connectorSignInSlot)
	// — "Sign in to connect" in place of the button. One instance at a time, so the ids hold.
	// FW-AI (76): that press opens the top-right profile pop-up; no login buttons live in this window.
	import { onDestroy } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import Button from '../ui/Button.svelte';
	import { connectorState, connectorAvailable, connectorLine, connectClaude, disconnectClaude } from '$lib/connector/connectorStore';
	import { CONNECTOR_DIRECTORY_URL, CONNECTOR_DOCS_URL, CONNECTOR_MCP_URL } from '$lib/connector/connectorLinks.js';
	import { connectorSignInSlot } from '$lib/cloudHooks';
	import { settingsOpen, settingsSection, showToast } from '../../stores/appStore';
	import { requestSignIn } from '$lib/connector/connectorSignIn.js';

	let { welcome = false }: { welcome?: boolean } = $props();
	const signIn = $derived(welcome && !$connectorAvailable && !!$connectorSignInSlot);

	const s = $derived($connectorState);
	const live = $derived(s.phase === 'connected' || s.phase === 'reconnecting' || s.phase === 'pairing' || s.phase === 'connecting');
	const tone = $derived(s.phase === 'connected' ? 'ok' : s.phase === 'reconnecting' || s.throttled ? 'warn' : s.phase === 'closed' || s.phase === 'error' ? 'bad' : 'idle');

	let copied = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;
	onDestroy(() => clearTimeout(copiedTimer));

	async function copyMcpLink() {
		try {
			await navigator.clipboard.writeText(CONNECTOR_MCP_URL);
			copied = true;
			clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => (copied = false), 2000);
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
					Sign in from your profile, top right.
				{:else}
					Use this tab from claude.ai — chat or voice.
				{/if}
			</span>
			{#if signIn}
				<Button id="connect-claude-signin" variant="secondary" size="sm" onclick={requestSignIn}>Sign in to connect</Button>
			{:else if live}
				<Button id="connect-claude-disconnect" variant="outline" size="sm" icon="unlink" onclick={disconnectClaude}>Disconnect</Button>
			{:else}
				<Button id="connect-claude-button" variant="secondary" size="sm" icon="link" onclick={connectClaude}>Connect Claude</Button>
			{/if}
		</div>
		{#if welcome && !live}
			<!-- what to do on the claude.ai side: the directory first, the manual way under it -->
			<ol id="connect-claude-steps" class="cc-steps">
				<li id="connect-claude-step-1">
					<span class="cc-step-title">Add theprototype to Claude</span>
					<div class="cc-add">
						<Button id="connect-claude-add" variant="secondary" size="sm" icon="plus" iconRight="external-link" href={CONNECTOR_DIRECTORY_URL} target="_blank" rel="noopener noreferrer">Add to Claude</Button>
					</div>
					<p class="cc-manual">or add it by hand: Settings ▸ Connectors ▸ Add custom connector</p>
					<div class="cc-address">
						<code class="cc-url">{CONNECTOR_MCP_URL}</code>
						<Button id="connect-claude-copy" variant="icon" size="sm" icon={copied ? 'check' : 'copy'} label="Copy connector address" onclick={copyMcpLink} />
					</div>
					<span class="sr-only" role="status" aria-live="polite">{copied ? 'Copied' : ''}</span>
					<a id="connect-claude-how" class="cc-link cc-how" href={CONNECTOR_DOCS_URL} target="_blank" rel="noopener noreferrer"><Icon name="circle-help" size={16} aria-hidden="true" />How it works</a>
				</li>
				<li id="connect-claude-step-2">
					{#if signIn}Then sign in from your profile, press Connect Claude here and keep this tab open.{:else}Then press Connect Claude here and keep this tab open.{/if}
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
	.cc-step-title {
		display: block;
		color: var(--text);
		font-weight: 600;
	}
	.cc-add {
		margin-top: 4px;
	}
	.cc-manual {
		margin: 8px 0 4px;
	}
	.cc-address {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		padding-left: 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
		background: var(--surface-1);
	}
	.cc-url {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--text);
	}
	/* a thumb-sized copy button wherever people use a thumb, whatever the kit's own size is at this width */
	@media (pointer: coarse), (max-width: 900px) {
		.cc-address :global(#connect-claude-copy) {
			min-width: 44px;
			min-height: 44px;
		}
	}
	.cc-how {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-top: 4px;
		min-height: 32px;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
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
