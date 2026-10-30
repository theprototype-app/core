<script lang="ts">
	// 86-fix N1 — THE AI WINDOW WITH NO PROVIDER SET UP. The AI button always opens the window (it used to
	// toast and jump to Settings ▸ AI, so Connect Claude — which needs no provider — could not be reached).
	// Two choices: Connect Claude (a cloud build: the connector's own control, or the plugin's "Sign in to
	// connect" while signed out; absent in the OSS build) and your own provider (Settings ▸ AI).
	import Button from '../ui/Button.svelte';
	import ConnectClaude from './ConnectClaude.svelte';
	import { settingsOpen, settingsSection } from '../../stores/appStore';

	function openAiSettings() {
		settingsSection.set('ai');
		settingsOpen.set(true);
	}
</script>

<section id="ai-welcome" class="aw" aria-labelledby="ai-welcome-title">
	<h2 id="ai-welcome-title" class="aw-title">Choose how the assistant thinks</h2>
	<ConnectClaude welcome />
	<div id="ai-welcome-own" class="aw-card" role="group" aria-labelledby="ai-welcome-own-title">
		<h3 id="ai-welcome-own-title" class="aw-card-title"><span class="aw-mark" aria-hidden="true">○</span> Use your own AI provider</h3>
		<p class="aw-desc">API key or local model.</p>
		<Button id="ai-welcome-settings" variant="outline" size="sm" icon="settings" onclick={openAiSettings}>Open settings</Button>
	</div>
</section>

<style>
	.aw {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 4px 2px;
	}
	.aw-title {
		margin: 0 0 2px;
		font-size: var(--fs-section);
		font-weight: 600;
		color: var(--text-muted);
	}
	.aw-card {
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
	}
	.aw-card-title {
		margin: 0;
		font-size: var(--fs-body);
		font-weight: 600;
		color: var(--text);
	}
	.aw-mark {
		color: var(--text-muted);
	}
	.aw-desc {
		margin: 2px 0 8px;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
</style>
