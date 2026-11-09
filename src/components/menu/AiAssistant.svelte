<script lang="ts">
	// AI Assistant (roadmap #10, A6): a floating chat window modeled on Chat.svelte
	// plus a shortcut-toggled quick prompt pill. The pill is hidden by default and
	// opened with the backquote (`) key; submitting from it opens the window. Edits
	// go out as normal replicated edits from this peer, undoable as one step.
	// 56 C1/C11: the target picker also lists the AI AGENTS in the session; with one picked the
	// body is that agent's conversation (AgentThread), the composer sends `agentchat` requests and
	// Stop cancels the running one; the history icon lists the scene's chats, New chat starts one,
	// and a `.tpchat` dropped on the window (or double-clicked in the Explorer) opens it here.
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import {
		aiAssistantHidden,
		aiPromptBarOpen,
		showToast
	} from '../../stores/appStore';
	import WindowChrome from '../ui/WindowChrome.svelte';
	import { connectorSignInSlot } from '$lib/cloudHooks';
	import { connectorAvailable } from '$lib/connector/connectorStore';
	import { requestSignIn } from '$lib/connector/connectorSignIn.js';
	import Icon from '../ui/Icon.svelte';
	import Button from '../ui/Button.svelte';
	import EmptyState from '../ui/EmptyState.svelte';
	import AgentLog from './AgentLog.svelte'; // 55 A8
	import ChatAttach from './ChatAttach.svelte'; // 56 C8
	import AgentThread from './AgentThread.svelte'; // 56 C1
	import ChatHistory from './ChatHistory.svelte'; // 56 C11
	import {
		chatTarget,
		activeChatId,
		agentTargets,
		agentChatState,
		agentStatusOf,
		sendToAgent,
		stopAgentRequest,
		canStop,
		iAmViewer,
		newChat,
		openChatInAssistant,
		peerLabel
	} from '$lib/agentChat';
	import { runningRequest, samePeer } from '$lib/agentChatCore';
	import { chatIdOfItem } from '$lib/chat/tpchatStore.js';
	import { rolesInfo } from '$lib/cloudHooks';
	import ConnectClaude from './ConnectClaude.svelte'; // 86 B1/B2
	import AiWelcome from './AiWelcome.svelte'; // 86-fix N1
	import { aiEnabled, aiProviders, aiActiveProvider, setAiActiveProvider, aiReady } from '$lib/ai/providers';
	import { visionSupport } from '$lib/ai/visionLimits.js'; // 73 AI8 + AI11
	import { aiMessages, aiBusy, aiStatus, runPrompt, stopAi, resetAiConversation } from '$lib/ai/assistant';
	import { dragWindow } from '$lib/dragWindow';
	import { bottomDockable } from '$lib/bottomDockDrop';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable } from '$lib/windowTabs';
	import { sttConfig, sttReady } from '$lib/ai/stt';
	import { explainMissing, openToolRow } from '$lib/tools/toolLinks.js'; // 59 T5
	import { derived } from 'svelte/store';
	import { dictation, startDictation, stopDictation } from '$lib/ai/sttCapture';
	import { panelAway } from '$lib/windows/panelPlaces.js';
	import { phoneFirstDetents } from '$lib/ui/phoneShell.js';

	let prompt = $state('');
	/** 56 C8: pictures for the next message, ready for a request's `images` (56-chat's send path reads it) */
	let pending: any[] = $state([]);
	let pillPrompt = $state('');
	let scroller: any = $state(null);
	let pillInput: any = $state(null);
	let promptInput: any = $state(null);

	/** 59 T5: the mic's tooltip says what is missing (the press opens its row) */
	const voiceReady = derived(sttConfig, (c) => sttReady(c));
	const hasProvider = $derived($aiProviders.length > 0 && !!$aiActiveProvider);

	// 56 C1: the agent this window talks to (null = the configured provider, as before)
	const agentId = $derived($chatTarget?.kind === 'agent' ? $chatTarget.id : null);
	const agentRow = $derived(agentId ? $agentTargets.find((t) => samePeer(t.id, agentId)) ?? null : null);
	const agentInfo = $derived(agentId ? { id: agentId, name: agentRow?.name ?? peerLabel(agentId) } : null);
	const agentChat = $derived($activeChatId ? $agentChatState.chats[$activeChatId] ?? null : null);
	const running = $derived(agentId ? runningRequest(agentChat) : null);
	const agentMuted = $derived(agentId ? !!agentStatusOf($agentChatState, agentId)?.muted : false);
	// re-read on a roles change (the argument is the dependency)
	const viewerNow = (_roles: any) => iAmViewer();
	const amViewer = $derived(viewerNow($rolesInfo));
	const mayStop = $derived(!!running && canStop(running));
	/** the picker's value: `p:<provider id>` or `a:<agent peer id>` */
	// 73 AI8 + AI11: what the assistant's model takes (an agent answers for itself: null)
	const vision = $derived(agentId ? null : visionSupport($aiProviders.find((p) => p.id === $aiActiveProvider) ?? null));
	const pickValue = $derived(agentId ? 'a:' + agentId : $aiActiveProvider ? 'p:' + $aiActiveProvider : '');
	let historyOpen = $state(false);
	let historyBtn: any = $state(null);
	const pillVisible = $derived($aiPromptBarOpen && $aiEnabled && hasProvider && $aiAssistantHidden !== '');
	// 86-fix N1: no provider ready → the window opens on the welcome (Connect Claude / your own provider)
	const needsSetup = $derived.by(() => {
		void [$aiEnabled, $aiProviders, $aiActiveProvider];
		return !aiReady();
	});
	const welcome = $derived(needsSetup && !$aiMessages.length && !agentId);
	const headerSignIn = $derived(!!$connectorSignInSlot && !$connectorAvailable && !welcome);
	// 54i: the welcome fits without an inner scroll — the floating window grows to it (h-auto, capped by the
	// room below its top), and on a phone the sheet opens at full height until the person moves it
	$effect(() => {
		const want = welcome ? 'full' : '';
		phoneFirstDetents.update((m) => {
			if ((m.ai ?? '') === want) return m;
			const next = { ...m };
			if (want) next.ai = want;
			else delete next.ai;
			return next;
		});
	});

	function submit() {
		const text = prompt.trim();
		if (agentId) {
			if ((!text && !pending.length) || !agentRow || agentMuted) return;
			if (!sendToAgent(text, { agentId, images: pending })) {
				showToast('Not connected — your message was not sent.');
				return;
			}
			prompt = '';
			pending = [];
			return;
		}
		// 73 AI2: the pictures go to the provider too. Not set up yet: runPrompt only sends you to Settings, keep what you wrote
		if ((!text && !pending.length) || $aiBusy) return;
		// 73 AI11: a model that can't see them never receives them; the tray stays for a model that can
		if (pending.length && vision?.ok === false) return showToast(vision.reason);
		const images = pending;
		if (aiReady()) {
			prompt = '';
			pending = [];
		}
		runPrompt(text, images);
	}

	/** pick an agent: its newest chat in this scene, else a fresh one @param {string} id */
	function pickAgent(id: string) {
		chatTarget.set({ kind: 'agent', id });
		const chats = Object.values($agentChatState.chats).filter((c: any) => samePeer(c.agent, id));
		const newest: any = chats.sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
		if (newest) activeChatId.set(newest.id);
		else newChat();
	}

	function startNewChat() {
		historyOpen = false;
		if (agentId) newChat();
		else resetAiConversation(); // the provider chat (F3, as it was): a fresh conversation
		requestAnimationFrame(() => promptInput?.focus());
	}

	function closeHistory() {
		historyOpen = false;
		requestAnimationFrame(() => historyBtn?.focus());
	}

	/** C11: a chat dragged onto the window opens it here — a Scene ▸ chats card, a Library `.tpchat`, or a desktop file */
	const isTpchatName = (name: unknown) => /\.tpchat$/i.test(String(name ?? ''));
	function chatDragOver(e: DragEvent) {
		const types = e.dataTransfer?.types;
		if (types?.includes('application/x-explorer-item') || types?.includes('Files')) {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		}
	}
	async function chatDrop(e: DragEvent) {
		const file = [...(e.dataTransfer?.files ?? [])].find((f) => isTpchatName(f.name));
		const raw = e.dataTransfer?.getData('application/x-explorer-item');
		let item: any = file ?? null;
		if (!item && raw) {
			try {
				item = JSON.parse(raw);
			} catch {
				return;
			}
		}
		// images and other files are the composer's (56-media)
		if (!item || !(file || item.kind === 'tpchat' || item.kind === 'chat' || item.chatId || isTpchatName(item.name))) return;
		e.preventDefault();
		e.stopPropagation();
		const id = await chatIdOfItem(item);
		if (id) openChatInAssistant(id);
		else showToast('That file is not a chat this scene knows.');
	}

	// 36-vr-ai (F2): voice typing — click to listen, click again to stop; the transcript lands in the input,
	// EDITABLE (nothing is sent until you press Send). The VR panel's mic sends instead.
	async function toggleMic() {
		if ($dictation.state === 'recording') {
			const text = await stopDictation();
			if (text) {
				prompt = prompt.trim() ? prompt.trimEnd() + ' ' + text : text;
				requestAnimationFrame(() => promptInput?.focus());
			} else if ($dictation.error) showToast('Voice typing: ' + $dictation.error);
			return;
		}
		if ($dictation.state !== 'idle') return;
		if (explainMissing('voiceTyping')) return; // 59 T5: says what is missing, opens its row
		const ok = await startDictation('desktop');
		if (!ok && $dictation.error) showToast('Voice typing: ' + $dictation.error);
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
		const v = (e.currentTarget as HTMLSelectElement).value;
		if (v.startsWith('a:')) {
			pickAgent(v.slice(2));
			return;
		}
		chatTarget.set(null);
		const id = v.startsWith('p:') ? v.slice(2) : v;
		setAiActiveProvider(id || null);
	}

	const placeholder = $derived.by(() => {
		if ($dictation.state === 'recording') return 'Listening… click the mic to stop';
		if ($dictation.state === 'transcribing') return 'Transcribing…';
		if (agentId) {
			if (!agentRow) return (agentInfo?.name ?? 'The agent') + ' has left this session';
			if (agentMuted) return (agentInfo?.name ?? 'The agent') + ' is muted by the host';
			return 'Message ' + (agentInfo?.name ?? 'the agent') + '…';
		}
		return 'Ask the assistant…';
	});
	const inputDisabled = $derived(agentId ? !agentRow || agentMuted : $aiBusy);
	// 70 W2: `popped` = the instance in a pop-out window (the window only); the main one keeps the pill
	// and draws no window while the assistant is away
	let { popped = false }: { popped?: boolean } = $props();
</script>

<!-- Quick prompt pill (backquote-toggled) -->
{#if pillVisible && !popped}
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
			placeholder="Ask the assistant to build or change the scene…"
			onkeydown={(e) => {
				if (e.key === 'Enter') submitPill();
				else if (e.key === 'Escape') aiPromptBarOpen.set(false);
			}}
		/>
		<Button variant="primary" size="sm" onclick={submitPill}>Send</Button>
	</div>
{/if}

<!-- Floating window. dock-fixes: its height cap is the viewport's (never the window's own top — see .ai-fit) -->
{#if popped || !$panelAway.aiAssistant}
<div id="ai-assistant" class={$aiAssistantHidden}>
	<div
		id="ai-assistant-window"
		use:dragWindow={{ key: 'aiAssistant', defaultRect: { right: 15, bottom: 460 } }}
		use:bottomDockable={{ key: 'aiAssistant' }}
		use:focusStack
		use:tabbable={{ key: 'aiAssistant', title: 'AI assistant', openStore: aiAssistantHidden, isOpen: (v: string) => v === '', close: () => aiAssistantHidden.set('hidden') }}
		class="ui-panel tp-ui tp-window flex w-[min(500px,90vw)] flex-col overflow-hidden {welcome ? '' : 'h-[440px]'}"
		class:ai-fit={welcome}
		style="z-index: var(--z-window); max-height: calc(100dvh - 76px)"
		data-target={agentId ? 'agent' : 'provider'}
		role="region"
		aria-label="AI assistant"
		ondragover={chatDragOver}
		ondrop={chatDrop}
	>
		<!-- 38 R6: the one window header (ui/WindowChrome) -->
		<WindowChrome
			size="tool"
			bare
			body={false}
			title="AI assistant"
			headerClass="ui-panel-header move-handle cursor-move select-none ai-head"
			onclose={() => aiAssistantHidden.set('hidden')}
		>
			{#snippet actions()}
				<!-- FW-AI (76): signed out on a cloud build, working with a provider of your own: connecting stays one press away.
				     With no provider the welcome below carries this button instead. -->
				{#if headerSignIn}
					<!-- 54i: a narrow window (the folded N6 sheet) says "Sign in", so the title keeps its words; the name stays whole -->
					<Button id="ai-header-signin" variant="secondary" size="sm" aria-label="Sign in to connect" title="Sign in to connect" onclick={requestSignIn}
						><span class="ai-signin-long">Sign in to connect</span><span class="ai-signin-short">Sign in</span></Button
					>
				{/if}
				<!-- 56 C11: the scene's chats, and a fresh one -->
				<button
					type="button"
					id="ai-history-btn"
					class="wc-act"
					bind:this={historyBtn}
					aria-label="Chat history"
					title="Chat history"
					aria-expanded={historyOpen}
					aria-controls="ai-chat-history"
					onclick={() => (historyOpen = !historyOpen)}><Icon name="history" size={16} /></button
				>
				<button type="button" id="ai-new-chat" class="wc-act" aria-label="New chat" title="New chat" onclick={startNewChat}
					><Icon name="plus" size={16} /></button
				>
			{/snippet}
		</WindowChrome>
		<!-- 86 B1/B2: Connect Claude (signed-in cloud builds only); the welcome carries it while no provider is set up -->
		{#if !welcome}<ConnectClaude />{/if}
		<div class="ai-body relative flex min-h-0 flex-1 flex-col">
		{#if historyOpen}
			<ChatHistory
				activeId={agentId ? $activeChatId : null}
				onnew={startNewChat}
				onclose={closeHistory}
				onpick={(id) => {
					historyOpen = false;
					openChatInAssistant(id);
				}}
			/>
		{/if}
		{#if agentId}
			<!-- 56 C1: the conversation with the agent, its A8 steps interleaved -->
			<AgentThread chatId={$activeChatId} agent={agentInfo} visible={$aiAssistantHidden === '' && !historyOpen} />
		{:else}
		<!-- 55 A8: what the AI agents in the session did, on every peer -->
		<AgentLog />

		<div bind:this={scroller} class="min-h-0 flex-1 overflow-y-auto px-2 py-2" use:minimalScroll>
			{#if welcome}
				<AiWelcome />
			{:else if !$aiMessages.length}
				<EmptyState
					icon="sparkles"
					title="Describe a scene and I'll build it"
					description={'For example: "a small campfire ring with 6 rocks and a cone flame".'}
				/>
			{/if}
			<ul class="flex flex-col gap-1.5">
				{#each $aiMessages as m, i (i)}
					{#if m.role === 'user'}
						<li class="ai-msg ai-user max-w-[85%] self-end">
							{#if m.images?.length}
								<!-- 73 AI2: local to this window; the provider chat is not replicated -->
								<span class="ai-pics">
									{#each m.images as pic, k (k)}
										<img class="ai-pic" src={pic.url} alt={pic.name} />
									{/each}
								</span>
							{/if}
							{m.content}
						</li>
					{:else if m.role === 'assistant'}
						<li class="ai-msg ai-reply max-w-[90%] self-start whitespace-pre-wrap">
							{m.content}{#if m.streaming}<span class="ai-caret">▋</span>{/if}
						</li>
					{:else if m.role === 'tool-status'}
						<li class="ai-note self-center text-center"><Icon name="cog" size={16} class="inline-block shrink-0 align-[-2px]" /> {m.content}</li>
					{:else if m.role === 'summary'}
						<li class="ai-note ai-ok self-center text-center">{m.content}</li>
					{:else if m.role === 'error'}
						<li class="ai-msg ai-err max-w-[90%] self-start">
							<Icon name="triangle-alert" size={16} class="inline-block shrink-0 align-[-2px]" /> {m.content}
						</li>
					{/if}
				{/each}
				{#if $aiBusy && $aiStatus}
					<li class="ai-note self-center text-center">{$aiStatus}</li>
				{/if}
			</ul>
		</div>
		{/if}
		</div>

		<div class="ai-composer shrink-0">
			<div class="mb-1.5 flex items-center gap-1.5">
				{#if $aiProviders.length || $agentTargets.length || agentId}
					<select id="ai-target" class="tp-field flex-1" aria-label="Talk to" value={pickValue} onchange={onActiveChange}>
						{#if $aiProviders.length}
							<optgroup label="Assistant">
								{#each $aiProviders as p (p.id)}
									<option value={'p:' + p.id}>{p.label} · {p.model}</option>
								{/each}
							</optgroup>
						{:else}
							<option value="" disabled>No assistant set up (Settings ▸ Tools & connections)</option>
						{/if}
						{#if $agentTargets.length || agentId}
							<optgroup label="AI agents in this session">
								{#each $agentTargets as t (t.id)}
									<option value={'a:' + t.id}>{t.label}</option>
								{/each}
								{#if agentId && !agentRow}
									<option value={'a:' + agentId}>{agentInfo?.name ?? 'AI agent'} · left</option>
								{/if}
							</optgroup>
						{/if}
					</select>
				{:else}
					<!-- 38 NOTES-38 #24 (design page): the hint is the way there — 59 T5: the Chat providers
					     row in Settings › Tools & connections, the same place the provider toast opens -->
					<span class="ai-hint flex-1"
						>No chat provider yet. <button
							type="button"
							id="ai-hint-setup"
							class="ai-hint-link"
							onclick={() => openToolRow('chat')}>Set one up in Tools &amp; connections</button
						></span
					>
				{/if}
			</div>
			<div class="flex items-center gap-1.5">
				<input
					bind:this={promptInput}
					type="text"
					class="tp-field flex-1"
					{placeholder}
					aria-label={agentId ? 'Message ' + (agentInfo?.name ?? 'the agent') : 'Ask the assistant'}
					bind:value={prompt}
					disabled={inputDisabled}
					onkeydown={(e) => {
						if (e.key === 'Enter') submit();
					}}
				/>
				<!-- 56 C8: pictures for the next message (+ menu, paste, drop, Explorer drag) -->
				<ChatAttach bind:pending disabled={inputDisabled} {vision} />
				<button
					id="ai-mic"
					class="ai-mic shrink-0"
					class:ai-mic-on={$dictation.state === 'recording'}
					aria-label={$dictation.state === 'recording' ? 'Stop voice typing' : 'Voice typing'}
					aria-pressed={$dictation.state === 'recording'}
					title={$dictation.state === 'recording' ? 'Stop and type what was said' : $voiceReady ? 'Voice typing' : 'Voice typing needs a voice typing server — set one up in Settings ▸ Tools & connections'}
					disabled={inputDisabled || $dictation.state === 'transcribing'}
					onclick={toggleMic}
				>
					<Icon name={$dictation.state === 'recording' ? 'square' : 'mic'} size={16} />
				</button>
				{#if agentId && running && mayStop}
					<!-- 56 C6: Stop the running request — `{cancel}` to the agent -->
					<Button id="ai-agent-stop" variant="outline" size="sm" onclick={() => stopAgentRequest($activeChatId ?? '')}>Stop</Button>
				{:else if !agentId && $aiBusy}
					<Button variant="outline" size="sm" onclick={stopAi}>Stop</Button>
				{:else}
					<Button id="ai-send" variant="primary" size="sm" disabled={agentId ? inputDisabled : false} onclick={submit}>Send</Button>
				{/if}
			</div>
			{#if agentId && amViewer}
				<!-- 56 C5: a viewer can ask; the agent will not change the scene for them -->
				<p id="ai-viewer-hint" class="ai-hint mt-1">You can ask — the agent won’t change the scene for a viewer.</p>
			{/if}
		</div>
	</div>
</div>
{/if}

<style>
	#ai-assistant.hidden {
		display: none;
	}
	/* 54i: the header measures its own width (a sheet, a docked column or a floating window alike) */
	:global(#ai-assistant-window .ai-head) {
		container-type: inline-size;
	}
	.ai-signin-short {
		display: none;
	}
	/* 54i: the welcome's height is its content, never taller than the screen below the top chrome.
	   dock-fixes (owner 2026-11-08): capped by the VIEWPORT, not by the window's own top (`--dw-top`) —
	   that cap followed the drag, so the window SHRANK as it was dragged partly off the bottom, where
	   the Object list keeps its size. dragWindow's clamps keep the header reachable, and a load or a
	   reveal brings the whole window back on screen. */
	.ai-fit {
		height: auto;
		max-height: calc(100dvh - 76px);
	}
	@container (max-width: 440px) {
		.ai-signin-long {
			display: none;
		}
		.ai-signin-short {
			display: inline;
		}
	}
	/* 38 R6: the body in the tokens — your prompt on the accent tint, replies on surface-2 */
	.ai-msg {
		padding: 6px 10px;
		border-radius: var(--radius-card);
		font-size: var(--fs-desc);
		color: var(--text);
	}
	.ai-user {
		border-bottom-right-radius: 4px;
		background: var(--accent-soft);
		color: var(--accent-soft-text);
	}
	.ai-pics {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.ai-pics:not(:last-child) {
		margin-bottom: 4px;
	}
	.ai-pic {
		max-width: 120px;
		max-height: 120px;
		border-radius: var(--radius-input);
		object-fit: cover;
	}
	.ai-reply {
		border-bottom-left-radius: 4px;
		background: var(--surface-2);
		border: 1px solid var(--border);
	}
	.ai-err {
		background: color-mix(in srgb, var(--danger) 18%, transparent);
		color: var(--warn-text);
	}
	.ai-note {
		font-size: var(--fs-section);
		color: var(--text-faint);
	}
	.ai-ok {
		color: var(--accent-text);
	}
	.ai-composer {
		padding: 10px;
		border-top: 1px solid var(--border);
	}
	.ai-hint {
		font-size: var(--fs-section);
		color: var(--text-muted);
	}
	.ai-hint-link {
		padding: 0 2px;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--accent-text);
		font: inherit;
		cursor: pointer;
	}
	.ai-hint-link:hover {
		background: var(--surface-hover);
	}
	.ai-mic {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--icon-button);
		height: var(--icon-button);
		border: 0;
		border-radius: var(--radius-button);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.ai-mic:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text);
	}
	.ai-mic:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.ai-pill-icon {
		display: inline-flex;
		color: var(--accent-text);
	}
	.ai-mic-on {
		color: var(--ink-bad);
		animation: ai-blink 1.2s step-end infinite;
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
