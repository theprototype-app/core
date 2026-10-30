<script>
	// 56 C11 — THE SCENE'S CHATS, from the AI assistant window's history icon: every chat this
	// peer holds plus the saved `.tpchat` ones (the store, 56-media), newest first, with a
	// search, which agent or provider it was with, and an unread dot for a chat whose last
	// messages this window has not shown. Picking one opens it in the window; New chat starts an
	// empty one with the current target. A panel over the window body, not a menu: it holds a
	// text field, and Escape / the close button hand focus back to the history icon.
	import { onMount } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import SearchField from '../ui/SearchField.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { historyRows, samePeer } from '$lib/agentChatCore';
	import { agentChatState, chatList, seenCounts, peerLabel, myPeerId, agentTargets } from '$lib/agentChat';

	/** @type {{onpick: (id: string) => void, onnew: () => void, onclose: () => void, activeId?: string | null}} */
	let { onpick, onnew, onclose, activeId = null } = $props();

	let query = $state('');
	let inputEl = $state(/** @type {HTMLInputElement | null} */ (null));

	const labelOf = $derived.by(() => {
		const targets = $agentTargets;
		return (/** @type {string} */ id) => targets.find((t) => samePeer(t.id, id))?.label ?? (id ? peerLabel(id) : '');
	});
	const rows = $derived(historyRows($agentChatState, $chatList, query, labelOf));
	/** a chat with something from somebody else this window has not shown @param {any} r */
	function unread(r) {
		const chat = $agentChatState.chats[r.id];
		if (!chat || r.id === activeId) return false;
		const me = myPeerId();
		const seen = $seenCounts[r.id] ?? 0;
		return chat.messages.slice(seen).some((/** @type {any} */ m) => !samePeer(m.from, me));
	}
	/** @param {number} at */
	function when(at) {
		if (!at) return '';
		const d = new Date(at);
		const today = new Date().toDateString() === d.toDateString();
		return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}

	onMount(() => {
		requestAnimationFrame(() => inputEl?.focus());
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
	id="ai-chat-history"
	class="chist"
	aria-label="Chats in this scene"
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			e.stopPropagation();
			onclose();
		}
	}}
>
	<div class="chist-head">
		<SearchField bind:value={query} bind:inputEl placeholder="Search chats" label="Search chats" size="sm" id="ai-chat-search" />
		<button type="button" id="ai-chat-history-new" class="chist-new" onclick={onnew}>
			<Icon name="plus" size={16} aria-hidden="true" /> New chat
		</button>
		<button type="button" class="chist-close" aria-label="Close chat history" title="Close" onclick={onclose}>
			<Icon name="x" size={16} />
		</button>
	</div>
	<div class="chist-list" use:minimalScroll>
		{#if !rows.length}
			<p class="chist-empty">{query ? 'No chat matches “' + query + '”.' : 'No chats in this scene yet.'}</p>
		{/if}
		<ul role="list">
			{#each rows as r (r.id)}
				<li>
					<button type="button" class="chist-row" class:active={r.id === activeId} data-chat={r.id} aria-current={r.id === activeId ? 'true' : undefined} onclick={() => onpick(r.id)}>
						<Icon name={r.agent ? 'bot' : 'sparkles'} size={16} aria-hidden="true" />
						<span class="chist-main">
							<span class="chist-title">{r.title}</span>
							<span class="chist-sub">{r.label || (r.agent ? 'AI agent' : 'Assistant')} · {r.count} message{r.count === 1 ? '' : 's'}</span>
						</span>
						<span class="chist-when">{when(r.updatedAt)}</span>
						{#if unread(r)}<span class="chist-unread" title="New messages" aria-label="New messages"></span>{/if}
					</button>
				</li>
			{/each}
		</ul>
	</div>
</section>

<style>
	.chist {
		position: absolute;
		inset: 0;
		z-index: 2;
		display: flex;
		flex-direction: column;
		background: var(--surface-1);
	}
	.chist-head {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 10px;
		border-bottom: 1px solid var(--border);
	}
	.chist-head :global(.tp-search),
	.chist-head :global(label) {
		flex: 1;
		min-width: 0;
	}
	.chist-new {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
		height: 28px;
		padding: 0 8px;
		border-radius: var(--radius-input);
		color: var(--accent-text);
		font-size: var(--fs-desc);
	}
	.chist-new:hover,
	.chist-close:hover,
	.chist-row:hover {
		background: var(--surface-hover);
	}
	.chist-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius-input);
		color: var(--text-muted);
	}
	.chist-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 4px 6px 8px;
	}
	.chist-list ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.chist-empty {
		padding: 16px 8px;
		text-align: center;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.chist-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 8px;
		border-radius: 8px;
		text-align: left;
		color: var(--text-muted);
	}
	.chist-row.active {
		background: var(--surface-active);
	}
	.chist-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.chist-title,
	.chist-sub {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chist-title {
		font-size: var(--fs-desc);
		color: var(--text);
	}
	.chist-sub,
	.chist-when {
		font-size: var(--fs-badge);
		color: var(--text-faint);
	}
	.chist-when {
		flex-shrink: 0;
	}
	.chist-unread {
		width: 8px;
		height: 8px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--accent);
	}
</style>
