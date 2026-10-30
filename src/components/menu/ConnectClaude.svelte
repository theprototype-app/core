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
	import { connectorSignInSlot } from '$lib/cloudHooks';
	import { settingsOpen, settingsSection } from '../../stores/appStore';

	let { welcome = false }: { welcome?: boolean } = $props();
	const signIn = $derived(welcome && !$connectorAvailable && !!$connectorSignInSlot);

	const s = $derived($connectorState);
	const live = $derived(s.phase === 'connected' || s.phase === 'reconnecting' || s.phase === 'pairing' || s.phase === 'connecting');
	const tone = $derived(s.phase === 'connected' ? 'ok' : s.phase === 'reconnecting' || s.throttled ? 'warn' : s.phase === 'closed' || s.phase === 'error' ? 'bad' : 'idle');

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
