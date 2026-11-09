<script lang="ts">
	// The AI assistant's QUICK PROMPT PILL (roadmap #10, A6): hidden by default, toggled with the
	// backquote (`) key; submitting from it opens the Chat window on its Assistant tab so the answer
	// streams somewhere. uir-chat: the assistant's window itself is the Assistant tab of the one Chat
	// window (Chat.svelte + ChatAssistant.svelte).
	import { aiAssistantHidden, aiPromptBarOpen } from '../../stores/appStore';
	import Icon from '../ui/Icon.svelte';
	import Button from '../ui/Button.svelte';
	import { aiEnabled, aiProviders, aiActiveProvider } from '$lib/ai/providers';
	import { runPrompt } from '$lib/ai/assistant';

	let pillPrompt = $state('');
	let pillInput: any = $state(null);

	const hasProvider = $derived($aiProviders.length > 0 && !!$aiActiveProvider);
	const pillVisible = $derived($aiPromptBarOpen && $aiEnabled && hasProvider && $aiAssistantHidden !== '');

	function submitPill() {
		const text = pillPrompt.trim();
		if (!text) return;
		pillPrompt = '';
		aiPromptBarOpen.set(false);
		aiAssistantHidden.set(''); // open the Assistant tab so the answer streams somewhere
		runPrompt(text);
	}

	// focus the pill input the moment it appears
	$effect(() => {
		if (pillVisible && pillInput) requestAnimationFrame(() => pillInput?.focus());
	});
</script>

{#if pillVisible}
	<div
		class="ai-pill ui-panel tp-ui tp-window flex items-center gap-1.5 px-2 py-1.5"
		style="position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(var(--bottom-inset, 0px) + 72px); z-index: var(--z-hud); width: min(560px, 92vw);"
	>
		<span class="ai-pill-icon pl-1" aria-hidden="true"><Icon name="sparkles" size={16} /></span>
		<input
			bind:this={pillInput}
			bind:value={pillPrompt}
			type="text"
			class="tp-field flex-1"
			aria-label="Ask the assistant"
			placeholder="Ask the assistant to build or change the scene…"
			onkeydown={(e) => {
				if (e.key === 'Enter') submitPill();
				else if (e.key === 'Escape') aiPromptBarOpen.set(false);
			}}
		/>
		<Button variant="primary" size="sm" onclick={submitPill}>Send</Button>
	</div>
{/if}

<style>
	.ai-pill-icon {
		display: inline-flex;
		color: var(--accent-text);
	}
</style>
