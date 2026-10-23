<script>
	// 56 C1/C4/C5/C6 — ONE CONVERSATION WITH AN AI AGENT, inside the AI assistant window. The
	// thread is the replicated `agentchat` messages (everyone in the session reads it, F1)
	// interleaved with the agent's 55 A8 action lines, so what it SAID and what it DID read as
	// one log. Requests are people's bubbles (yours on the right, with the sender's name and a
	// viewer chip otherwise), replies stream in like the assistant's own, a turn typed in the
	// agent's terminal says "via terminal" (C4), an ask's options are buttons, a stopped request
	// says who stopped it. The status line says whether anyone is there to answer (C2's badge).
	import { get } from 'svelte/store';
	import Icon from '../ui/Icon.svelte';
	import EmptyState from '../ui/EmptyState.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { agentLog } from '$lib/agentLog';
	import { threadItems, samePeer } from '$lib/agentChatCore';
	import { agentChatState, agentStatusOf, peerLabel, roleOfPeer, myPeerId, sendToAgent, markChatSeen } from '$lib/agentChat';
	import { rolesInfo } from '$lib/cloudHooks';
	import { showToast } from '../../stores/appStore';
	import { objectsGroup } from '../../stores/sceneStore';
	import { applySelectionSet } from '$lib/objectActions';

	/** @type {{chatId: string | null, agent: {id: string, name: string} | null, visible?: boolean}} */
	let { chatId, agent, visible = true } = $props();

	let scroller = $state(/** @type {HTMLElement | null} */ (null));

	const chat = $derived(chatId ? $agentChatState.chats[chatId] ?? null : null);
	const items = $derived(threadItems(chat, $agentLog));
	const st = $derived(agent ? agentStatusOf($agentChatState, agent.id) : null);
	// re-read names/roles when the roles bridge changes (the argument is the dependency)
	const roleOf = $derived.by(() => {
		void $rolesInfo;
		return (/** @type {string} */ id) => roleOfPeer(id);
	});
	const me = $derived.by(() => {
		void $agentChatState;
		return myPeerId();
	});

	const statusText = $derived.by(() => {
		const who = agent?.name || 'The agent';
		if (!st) return who + ' has not said whether it is listening yet';
		if (st.muted) return who + ' is muted by the host — messages are not delivered';
		if (st.status === 'listening') return who + ' is listening';
		if (st.status === 'working') return who + ' is working…';
		return who + ' is away — it reads your message when it is back';
	});

	// autoscroll on new content (a streamed reply grows the last bubble)
	$effect(() => {
		void items;
		if (!scroller) return;
		requestAnimationFrame(() => {
			if (scroller) scroller.scrollTop = scroller.scrollHeight;
		});
	});
	// the history list's unread dot: what this window has shown
	$effect(() => {
		if (visible && chat) markChatSeen(chat.id, chat.messages.length);
	});

	/** @param {any} e */
	function selectLine(e) {
		/** @type {any} */
		const group = get(objectsGroup);
		const here = (e.uuids ?? []).filter((/** @type {string} */ u) => !!group?.getObjectByProperty?.('uuid', u));
		if (!here.length) {
			showToast(e.uuids?.length ? 'Those objects are no longer in the scene.' : 'Nothing to select for this step.');
			return;
		}
		applySelectionSet(here);
	}

	/** @param {any} m @param {string} option */
	function answer(m, option) {
		if (!sendToAgent(option, { agentId: m.from, chatId: m.chatId, answers: m.id })) showToast('Not connected — the answer was not sent.');
	}

	/** @param {any} m */
	const mine = (m) => samePeer(m.from, me);
	/** @param {number} at */
	const clock = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
</script>

<div class="ath flex min-h-0 flex-1 flex-col" data-chat={chatId ?? ''} data-agent={agent?.id ?? ''}>
	<div class="ath-status" data-status={st?.muted ? 'muted' : st?.status ?? 'unknown'} role="status">
		<span class="ath-dot" aria-hidden="true"></span>
		<span class="ath-status-text">{statusText}</span>
	</div>
	<div bind:this={scroller} class="ath-scroll min-h-0 flex-1 overflow-y-auto px-2 py-2" use:minimalScroll>
		{#if !items.length}
			<EmptyState
				icon="bot"
				title={'Talk to ' + (agent?.name || 'the agent')}
				description="Everyone in the session sees this conversation and every step the agent takes."
			/>
		{/if}
		<ul class="flex flex-col gap-1.5" aria-label="Conversation with {agent?.name || 'the agent'}">
			{#each items as it (it.key)}
				{#if it.type === 'log'}
					<li class="ath-log self-start" class:undone={it.e.undone} class:failed={!it.e.ok} data-entry={it.e.id}>
						<button type="button" class="ath-log-btn" title={it.e.uuids?.length ? 'Select what this step touched' : it.e.text} onclick={() => selectLine(it.e)}>
							<Icon name="wand-sparkles" size={16} aria-hidden="true" />
							<span class="ath-log-text">{it.e.text}</span>
						</button>
					</li>
				{:else if it.m.kind === 'request' || it.m.kind === 'cli'}
					{@const m = it.m}
					<li
						class="ai-msg ai-user ath-req max-w-[85%]"
						class:self-end={mine(m) && m.kind === 'request'}
						class:self-start={!(mine(m) && m.kind === 'request')}
						class:ath-other={!mine(m) || m.kind === 'cli'}
						class:ath-cancelled={m.cancelled}
						data-msg={m.id}
						data-kind={m.kind}
					>
						{#if m.kind === 'cli'}
							<span class="ath-who"><Icon name="terminal" size={16} aria-hidden="true" /> via terminal</span>
						{:else if !mine(m)}
							<span class="ath-who"
								>{m.name || peerLabel(m.from)}{#if roleOf(m.from) === 'viewer'}<span class="ath-role" data-role="viewer">viewer</span>{/if}</span
							>
						{/if}
						<span class="whitespace-pre-wrap">{m.text}</span>
						<!-- 56-media: ChatImages — 56-int swaps in <ChatImages msg={m} /> here -->
						{#if m.images?.length}
							<span class="ath-imgs">
								{#each m.images as img, ii (ii)}
									{#if img.data}<img class="ath-img" src={'data:' + img.mimeType + ';base64,' + img.data} alt={img.name || 'Attached image'} />{:else}<span class="ath-img ath-img-missing">{img.name || 'image'}</span>{/if}
								{/each}
							</span>
						{/if}
						{#if m.cancelled}
							<span class="ath-note-inline">Stopped{m.cancelledBy && !samePeer(m.cancelledBy, m.from) ? ' by ' + peerLabel(m.cancelledBy) : ''}</span>
						{/if}
					</li>
				{:else if it.m.kind === 'ask'}
					{@const m = it.m}
					<li class="ai-msg ai-reply ath-ask max-w-[90%] self-start" data-msg={m.id} data-kind="ask">
						<span class="whitespace-pre-wrap">{m.ask.question}</span>
						{#if !m.answered && m.ask.options.length}
							<span class="ath-options" role="group" aria-label="Answer">
								{#each m.ask.options as o (o)}
									<button type="button" class="ath-option" onclick={() => answer(m, o)}>{o}</button>
								{/each}
							</span>
						{:else if m.answered}
							<span class="ath-note-inline">Answered</span>
						{/if}
					</li>
				{:else}
					{@const m = it.m}
					<li class="ai-msg ai-reply max-w-[90%] self-start whitespace-pre-wrap" data-msg={m.id} data-kind="reply" class:ath-streaming={m.partial} title={clock(m.at)}>
						{m.text}{#if m.partial}<span class="ai-caret" aria-hidden="true">▋</span>{/if}
					</li>
				{/if}
			{/each}
		</ul>
	</div>
</div>

<style>
	.ath-status {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border-bottom: 1px solid var(--border);
		font-size: var(--fs-section);
		color: var(--text-muted);
	}
	.ath-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-faint);
		flex-shrink: 0;
	}
	.ath-status[data-status='listening'] .ath-dot {
		background: var(--ink-good);
	}
	.ath-status[data-status='working'] .ath-dot {
		background: var(--accent);
		animation: ath-pulse 1.2s ease-in-out infinite;
	}
	.ath-status[data-status='muted'] .ath-dot {
		background: var(--status-warn);
	}
	@keyframes ath-pulse {
		50% {
			opacity: 0.35;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.ath-status[data-status='working'] .ath-dot,
		.ai-caret {
			animation: none;
		}
	}
	.ai-msg {
		padding: 6px 10px;
		border-radius: var(--radius-card);
		font-size: var(--fs-desc);
		color: var(--text);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.ai-user {
		border-bottom-right-radius: 4px;
		background: var(--accent-soft);
		color: var(--accent-soft-text);
	}
	.ath-other {
		border-bottom-right-radius: var(--radius-card);
		border-bottom-left-radius: 4px;
		background: var(--surface-1);
		color: var(--text);
		border: 1px solid var(--border);
	}
	.ai-reply {
		border-bottom-left-radius: 4px;
		background: var(--surface-2);
		border: 1px solid var(--border);
	}
	.ath-who {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-badge);
		color: var(--text-muted);
	}
	.ath-role {
		margin-left: 4px;
		padding: 0 5px;
		border-radius: 6px;
		border: 1px solid var(--border);
		font-size: var(--fs-badge);
		color: var(--text-muted);
	}
	.ath-cancelled > :not(.ath-note-inline) {
		opacity: 0.7;
	}
	.ath-note-inline {
		font-size: var(--fs-badge);
		color: var(--text-muted);
	}
	.ath-log {
		max-width: 95%;
	}
	.ath-log-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 2px 6px;
		border-radius: 6px;
		font-size: var(--fs-section);
		color: var(--text-muted);
		text-align: left;
	}
	.ath-log-btn:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.ath-log.undone .ath-log-text {
		text-decoration: line-through;
	}
	.ath-log.failed .ath-log-text {
		color: var(--warn-text);
	}
	.ath-options {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 4px;
	}
	.ath-option {
		padding: 2px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-button);
		background: transparent;
		color: var(--accent-text);
		font-size: var(--fs-desc);
		cursor: pointer;
	}
	.ath-option:hover {
		background: var(--surface-hover);
	}
	.ath-imgs {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.ath-img {
		max-width: 96px;
		max-height: 96px;
		border-radius: 6px;
		object-fit: cover;
	}
	.ath-img-missing {
		display: inline-flex;
		align-items: center;
		padding: 4px 6px;
		border: 1px dashed var(--border);
		font-size: var(--fs-badge);
		color: var(--text-muted);
	}
	.ai-caret {
		animation: ath-blink 1s step-end infinite;
	}
	@keyframes ath-blink {
		50% {
			opacity: 0;
		}
	}
</style>
