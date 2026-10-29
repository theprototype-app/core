<script>
	// 86 B1/B2 — CONNECT CLAUDE, in the AI assistant window. A signed-in cloud build only: with no
	// connector provider (the OSS build) this renders nothing. One row: what the state is in words (a dot
	// is never the only signal), the one button that fits it, and the hint that matters — the tab must
	// stay open, because the tools run HERE.
	import Icon from '../ui/Icon.svelte';
	import Button from '../ui/Button.svelte';
	import { connectorState, connectorAvailable, connectorLine, connectClaude, disconnectClaude } from '$lib/connector/connectorStore';
	import { settingsOpen, settingsSection } from '../../stores/appStore';

	const s = $derived($connectorState);
	const live = $derived(s.phase === 'connected' || s.phase === 'reconnecting' || s.phase === 'pairing' || s.phase === 'connecting');
	const tone = $derived(s.phase === 'connected' ? 'ok' : s.phase === 'reconnecting' || s.throttled ? 'warn' : s.phase === 'closed' || s.phase === 'error' ? 'bad' : 'idle');

	function openConnectedApps() {
		settingsSection.set('connectedapps');
		settingsOpen.set(true);
	}
</script>

{#if $connectorAvailable}
	<section id="connect-claude" class="cc" data-phase={s.phase} data-tone={tone} aria-label="Claude connector">
		<div class="cc-row">
			<span class="cc-dot" aria-hidden="true"></span>
			<span class="cc-text" role="status" aria-live="polite">
				{#if live}
					{connectorLine(s)}{#if s.busy}<span class="cc-busy"> · working</span>{/if}
				{:else if s.message}
					{s.message}
				{:else}
					Use this tab from claude.ai — chat or voice.
				{/if}
			</span>
			{#if live}
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
