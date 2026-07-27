<script lang="ts">
	// AI Assistant (roadmap #10, A6): a floating chat window modeled on Chat.svelte
	// plus a shortcut-toggled quick prompt pill. The pill is hidden by default and
	// opened with the backquote (`) key; submitting from it opens the window. Edits
	// go out as normal replicated edits from this peer, undoable as one step.
	import {
		aiAssistantHidden,
		aiPromptBarOpen
	} from '../../stores/appStore';
	import { aiEnabled, aiProviders, aiActiveProvider, setAiActiveProvider } from '$lib/ai/providers';
	import { aiMessages, aiBusy, aiStatus, runPrompt, stopAi } from '$lib/ai/assistant';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable } from '$lib/windowTabs';

	let prompt = $state('');
	let pillPrompt = $state('');
	let scroller: any = $state(null);
	let pillInput: any = $state(null);

	const hasProvider = $derived($aiProviders.length > 0 && !!$aiActiveProvider);
	const pillVisible = $derived($aiPromptBarOpen && $aiEnabled && hasProvider && $aiAssistantHidden !== '');

	function submit() {
		const text = prompt.trim();
		if (!text || $aiBusy) return;
		prompt = '';
		runPrompt(text);
	}

	function submitPill() {
		const text = pillPrompt.trim();
		if (!text) return;
		pillPrompt = '';
		aiPromptBarOpen.set(false);
		aiAssistantHidden.set(''); // open the window so the answer streams somewhere
		runPrompt(text);
	}

	// focus the pill input the moment it appears
	$effect(() => {
		if (pillVisible && pillInput) requestAnimationFrame(() => pillInput?.focus());
	});

	// autoscroll the transcript on new content
	let lastLen = 0;
	$effect(() => {
		const len = $aiMessages.length;
		const busy = $aiBusy; // also retrigger while streaming grows the last bubble
		void busy;
		if (!scroller) return;
		if (len !== lastLen || busy) {
			lastLen = len;
			requestAnimationFrame(() => {
				if (scroller) scroller.scrollTop = scroller.scrollHeight;
			});
		}
	});

	function onActiveChange(e: Event) {
		const id = (e.currentTarget as HTMLSelectElement).value;
		setAiActiveProvider(id || null);
	}
</script>

<!-- Quick prompt pill (backquote-toggled) -->
{#if pillVisible}
	<div
		class="ai-pill ui-panel flex items-center gap-1.5 bg-gray-900/90 px-2 py-1.5 backdrop-blur"
		style="position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(var(--bottom-inset, 0px) + 72px); z-index: var(--z-hud); width: min(560px, 92vw);"
	>
		<span class="pl-1 text-sm">✨</span>
		<input
			bind:this={pillInput}
			bind:value={pillPrompt}
			type="text"
			class="ui-input min-w-0 flex-1"
			placeholder="Ask the assistant to build or change the scene…"
			onkeydown={(e) => {
				if (e.key === 'Enter') submitPill();
				else if (e.key === 'Escape') aiPromptBarOpen.set(false);
			}}
		/>
		<button
			class="shrink-0 rounded-lg bg-primary-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-600"
			onclick={submitPill}
		>
			Send
		</button>
	</div>
{/if}

<!-- Floating window -->
<div id="ai-assistant" class={$aiAssistantHidden}>
	<div
		id="ai-assistant-window"
		use:dragWindow={{ key: 'aiAssistant', defaultRect: { right: 15, bottom: 460 } }}
		use:focusStack
		use:tabbable={{ key: 'aiAssistant', title: '✨ AI Assistant', openStore: aiAssistantHidden, isOpen: (v: string) => v === '', close: () => aiAssistantHidden.set('hidden') }}
		class="ui-panel flex h-[440px] w-[min(500px,90vw)] flex-col overflow-hidden bg-gray-900/85 backdrop-blur"
		style="z-index: var(--z-window)"
	>
		<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
			<span>✨ AI Assistant</span>
			<span class="flex-1"></span>
			<button class="ui-button-quiet" title="Close" onclick={() => aiAssistantHidden.set('hidden')}>✕</button>
		</div>

		<div bind:this={scroller} class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
			{#if !$aiMessages.length}
				<p class="px-2 py-6 text-center text-sm text-gray-400">
					Describe a scene and I'll build it — e.g. "make a small campfire ring with 6 rocks and a
					cone flame".
				</p>
			{/if}
			<ul class="flex flex-col gap-1.5">
				{#each $aiMessages as m, i (i)}
					{#if m.role === 'user'}
						<li class="max-w-[85%] self-end rounded-lg rounded-br-sm bg-primary-800/80 px-2.5 py-1.5 text-sm text-primary-50">
							{m.content}
						</li>
					{:else if m.role === 'assistant'}
						<li class="max-w-[90%] self-start rounded-lg rounded-bl-sm bg-gray-700/80 px-2.5 py-1.5 text-sm text-gray-100 whitespace-pre-wrap">
							{m.content}{#if m.streaming}<span class="ai-caret">▋</span>{/if}
						</li>
					{:else if m.role === 'tool-status'}
						<li class="self-center text-center text-[11px] italic text-gray-400">⚙ {m.content}</li>
					{:else if m.role === 'summary'}
						<li class="self-center text-center text-[11px] text-emerald-400/90">{m.content}</li>
					{:else if m.role === 'error'}
						<li class="max-w-[90%] self-start rounded-lg bg-red-900/50 px-2.5 py-1.5 text-sm text-red-200">
							⚠ {m.content}
						</li>
					{/if}
				{/each}
				{#if $aiBusy && $aiStatus}
					<li class="self-center text-center text-[11px] italic text-gray-400">💭 {$aiStatus}</li>
				{/if}
			</ul>
		</div>

		<div class="shrink-0 border-t border-gray-700/60 p-2">
			<div class="mb-1.5 flex items-center gap-1.5">
				{#if $aiProviders.length}
					<select class="ui-input flex-1 text-xs" value={$aiActiveProvider ?? ''} onchange={onActiveChange}>
						{#each $aiProviders as p (p.id)}
							<option value={p.id}>{p.label} · {p.model}</option>
						{/each}
					</select>
				{:else}
					<span class="flex-1 text-xs text-gray-400">No provider configured — see Settings → AI</span>
				{/if}
			</div>
			<div class="flex items-center gap-1.5">
				<input
					type="text"
					class="ui-input min-w-0 flex-1"
					placeholder="Ask the assistant…"
					bind:value={prompt}
					disabled={$aiBusy}
					onkeydown={(e) => {
						if (e.key === 'Enter') submit();
					}}
				/>
				{#if $aiBusy}
					<button
						class="shrink-0 rounded-lg bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600"
						onclick={stopAi}
					>
						Stop
					</button>
				{:else}
					<button
						class="shrink-0 rounded-lg bg-primary-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-600"
						onclick={submit}
					>
						Send
					</button>
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	#ai-assistant.hidden {
		display: none;
	}
	.ai-caret {
		animation: ai-blink 1s step-end infinite;
	}
	@keyframes ai-blink {
		50% {
			opacity: 0;
		}
	}
</style>
