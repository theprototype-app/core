<script lang="ts">
	// uir-chat — THE SESSION TAB of the Chat window: what the people in this session say (phases 67+68,
	// 37 R15). Bubbles with author colour chips and times, Enter to send, autoscroll with a new-messages
	// pill, / commands, @mentions, :emoji: shortcodes. The lines are kept on this device per scene
	// ($lib/chat/chatSaves); History ▸ People opens another scene's saved log here READ-ONLY, with a way
	// back to the live chat.
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import Button from '../ui/Button.svelte';
	import EmptyState from '../ui/EmptyState.svelte';
	import Icon from '../ui/Icon.svelte';
	import PeerAvatar from '../ui/PeerAvatar.svelte'; // 78 PL33: one avatar everywhere
	import { peers, messages, username, userdata } from '../../stores/appStore';
	import { expandShortcodes, tokenizeChat, shortcodeSuggestions, mentionSuggestions } from '$lib/chatTokens';
	import { isLocked } from '../../stores/sceneStore';
	import { nameOf, peerColor } from '$lib/lockControl';
	import { archiveView, viewLog } from '$lib/chat/chatSaves.js';

	/** @type {{visible?: boolean}} */
	let { visible = true }: { visible?: boolean } = $props();

	let message = $state('');
	let scroller: any = $state(null);
	let atBottom = $state(true);
	let unread = $state(0);

	const COMMANDS = [
		{ cmd: '/create', help: 'add a primitive — /create box | sphere | cylinder …' },
		{ cmd: '/light', help: 'add a light — /light ambient | directional | hemisphere | point' },
		{ cmd: '/group', help: 'create a group — /group <name>' },
		{ cmd: '/clear', help: 'remove an object or everything — /clear <uuid> | all' },
		{ cmd: '/select', help: 'select an object — /select <uuid>' },
		{ cmd: '/transform', help: 'gizmo mode — /transform translate | rotate | scale' },
		{ cmd: '/grid', help: 'toggle the ground grid' },
		{ cmd: '/list', help: 'list scene objects here' }
	];
	const hints = $derived(
		message.startsWith('/') ? COMMANDS.filter((c) => c.cmd.startsWith(message.split(' ')[0].toLowerCase())) : []
	);

	// 37 R15: who can be @mentioned — the roster plus us (a name, else the peer id)
	const myId = $derived($peers?.peer?.id ?? '');
	const people = $derived.by(() => {
		const out = ($userdata ?? [])
			.filter((row: any) => Array.isArray(row) && row[0])
			.map((row: any) => ({ id: String(row[0]), name: row[1] ? String(row[1]) : undefined }));
		if (myId && !out.some((p: any) => p.id === myId)) out.push({ id: myId, name: $username ?? undefined });
		return out;
	});
	// the word being typed decides the suggestions: "@ad" -> people, ":thu" -> emoji
	const lastWord = $derived(message.startsWith('/') ? '' : (message.match(/(?:^|\s)([@:][^\s]*)$/)?.[1] ?? ''));
	const suggestions = $derived.by(() => {
		if (lastWord.startsWith('@'))
			return mentionSuggestions(lastWord.slice(1), people, myId).map((p) => ({ key: p.id, label: '@' + p.label, insert: '@' + p.label + ' ', color: peerColor(p.id) }));
		const code = lastWord.match(/^:([a-z0-9_+-]{1,32})$/i)?.[1];
		if (code) return shortcodeSuggestions(code).map((e) => ({ key: e.code, label: e.emoji + '  :' + e.code + ':', insert: e.emoji + ' ', color: '' }));
		return [];
	});
	function accept(pick: { insert: string }) {
		message = message.slice(0, message.length - lastWord.length) + pick.insert;
		document.getElementById('message')?.focus();
	}

	function send() {
		const text = message.trim();
		if (!text) return;
		$peers.sendMessage(text.startsWith('/') ? text : expandShortcodes(text));
		message = '';
	}
	// a line that @mentions us (and is not ours) is highlighted
	const mentionsMe = (tokens: any[]) => !!myId && tokens.some((t) => t.kind === 'mention' && t.id === myId);

	function onScroll() {
		if (!scroller) return;
		atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
		if (atBottom) unread = 0;
	}

	function scrollToBottom() {
		if (!scroller) return;
		scroller.scrollTop = scroller.scrollHeight;
		atBottom = true;
		unread = 0;
	}

	// what the list shows: the live chat, or a saved scene's log (read-only)
	const archive = $derived($archiveView);
	// one row per id: the list is keyed by id, and since chats are saved a line can reach the store twice
	// (a saved line and the same line pushed again by a caller that does not merge) — a repeated key would
	// throw the whole list away, so the later copy is dropped
	const lines = $derived.by(() => {
		const list = archive ? archive.lines : $messages;
		const seen = new Set();
		return list.filter((m: any) => {
			if (m?.id == null) return true;
			if (seen.has(m.id)) return false;
			seen.add(m.id);
			return true;
		});
	});

	// pin to bottom on new messages; count them as unread while scrolled up
	let lastCount = 0;
	$effect(() => {
		const count = lines.length;
		if (count === lastCount) return;
		const grew = count > lastCount;
		lastCount = count;
		if (!grew) return;
		if (atBottom) requestAnimationFrame(scrollToBottom);
		else unread++;
	});
	// coming back to the tab: start at the newest line
	$effect(() => {
		if (visible) requestAnimationFrame(() => atBottom && scrollToBottom());
	});

	const isMine = (m: any) => m.type === 'sent' || m.sender === $peers?.peer?.id;
	const isNote = (m: any) => m.type === 'info' || m.type === 'system' || m.type === '';
	// a saved line keeps the name its author had (they may have left, or come back under a new id)
	const authorName = (m: any) => (m.sender === $peers?.peer?.id ? $username || 'You' : m.name || nameOf(m.sender));
	const stamp = (m: any) => {
		const t = m.at ?? m.ts;
		if (!t) return '';
		const d = new Date(t);
		const today = new Date().toDateString() === d.toDateString();
		const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		return today ? time : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
	};
</script>

<div id="chat-session" class="chs relative flex min-h-0 flex-1 flex-col" role="tabpanel" aria-labelledby="chat-tab-session" hidden={!visible}>
	{#if archive}
		<div id="chat-archive-bar" class="chs-archive" role="status">
			<Icon name="history" size={16} aria-hidden="true" />
			<span class="min-w-0 flex-1 truncate">Saved chat · {archive.title} · read only</span>
			<Button id="chat-archive-back" variant="ghost" size="sm" onclick={() => viewLog(null)}>Back to live chat</Button>
		</div>
	{/if}
	<div class="relative min-h-0 flex-1">
		<div id="chat-messages" bind:this={scroller} onscroll={onScroll} class="h-full overflow-y-auto px-2 py-1" use:minimalScroll>
			<ul id="messages" class="flex flex-col gap-1" data-archive={archive ? archive.key : undefined}>
				{#each lines as m (m.id ?? m)}
					{#if isNote(m)}
						<li class="chat-message chat-note {m.type}">
							{m.sender === 'SYSTEM' ? '' : authorName(m) + ' '}{m.text}
						</li>
					{:else}
						{@const tokens = tokenizeChat(m.text, people)}
						<li
							class={'chat-message chat-msg ' + m.type}
							class:chat-mine={isMine(m)}
							class:chat-past={!!m.saved}
							class:chat-mentions-me={!isMine(m) && mentionsMe(tokens)}
						>
							<span class="chat-av"><PeerAvatar id={m.sender} row={($userdata ?? []).find((u: any) => u[0] === m.sender)} name={authorName(m)} size={22} /></span>
							<span class="min-w-0">
								<span class="chat-who">{authorName(m)}<small>{stamp(m)}</small></span>
								<!-- 37 R15: TEXT NODES ONLY — a peer's string never becomes markup -->
								<span class="chat-text wrap-break-word"
									>{#each tokens as t, i (i)}{#if t.kind === 'mention'}<span class="chat-mention" style:--peer={peerColor(t.id)}>{t.text}</span>{:else}{t.text}{/if}{/each}</span
								>
							</span>
						</li>
					{/if}
				{/each}
			</ul>
			{#if !lines.length}
				<EmptyState
					icon="message-square"
					title="No messages yet"
					description="Messages from everyone in this session appear here, and this device keeps them with the scene. Type / for commands."
				/>
			{/if}
		</div>

		{#if unread > 0 && !atBottom}
			<button class="chat-unread absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1" onclick={scrollToBottom}>
				{unread} new message{unread === 1 ? '' : 's'} <Icon name="chevron-down" size={16} aria-hidden="true" />
			</button>
		{/if}
	</div>

	{#if !$isLocked && !archive}
		<div id="chat-input" class="chat-composer shrink-0">
			{#if suggestions.length}
				<div id="chat-suggestions" class="chat-hints mb-1.5 flex flex-wrap gap-1">
					{#each suggestions as pick (pick.key)}
						<button class="chat-suggestion chat-hint" style:color={pick.color || null} onclick={() => accept(pick)}>{pick.label}</button>
					{/each}
				</div>
			{/if}
			{#if hints.length}
				<div class="chat-hints mb-1.5 flex flex-col">
					{#each hints as hint}
						<button
							class="chat-hint"
							onclick={() => {
								message = hint.cmd + ' ';
								document.getElementById('message')?.focus();
							}}
						>
							<span class="chat-cmd">{hint.cmd}</span>
							<span class="chat-help">{hint.help}</span>
						</button>
					{/each}
				</div>
			{/if}
			<div class="flex items-center gap-1.5">
				<input
					type="text"
					id="message"
					class="tp-field flex-1"
					aria-label="Message the session"
					placeholder="Message — / for commands, @ for people, : for emoji"
					bind:value={message}
					onkeydown={(e) => {
						// Tab takes the first suggestion (an @name or an emoji)
						if (e.key === 'Tab' && suggestions.length) {
							e.preventDefault();
							accept(suggestions[0]);
							return;
						}
						if (e.key === 'Enter') send();
					}}
				/>
				<Button id="send" variant="primary" size="sm" onclick={send}>Send</Button>
			</div>
		</div>
	{/if}
</div>

<style>
	.chs[hidden] {
		display: none;
	}
	.chs-archive {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px 6px 12px;
		border-bottom: 1px solid var(--border);
		background: var(--surface-2);
		font-size: var(--fs-section);
		color: var(--text-muted);
	}
	/* 38 R6: the chat body in the tokens — one message list (avatar · name · time · text),
	   your own lines marked by the accent avatar ring, not a second bubble colour */
	#messages {
		gap: 10px;
		padding: 10px 6px 4px;
	}
	.chat-msg {
		display: grid;
		grid-template-columns: 24px minmax(0, 1fr);
		gap: 8px;
		font-size: var(--fs-desc);
	}
	.chat-av {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: 50%;
	}
	.chat-who {
		display: block;
		font-size: var(--fs-section);
		font-weight: 600;
		color: var(--text);
	}
	.chat-who small {
		margin-left: 6px;
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
		font-weight: 400;
		color: var(--text-faint);
	}
	.chat-text {
		display: block;
		margin-top: 2px;
		color: var(--text-2);
	}
	.chat-note {
		align-self: center;
		text-align: center;
		font-size: var(--fs-section);
		color: var(--text-faint);
	}
	.chat-unread {
		height: 26px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--radius-pill);
		background: var(--accent-fill);
		color: var(--on-accent);
		font-size: var(--fs-section);
		font-weight: 500;
		box-shadow: var(--shadow-window);
		cursor: pointer;
	}
	.chat-composer {
		padding: 10px;
		border-top: 1px solid var(--border);
	}
	.chat-hints {
		padding: 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-2);
	}
	.chat-hint {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 4px 8px;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		font-size: var(--fs-section);
		text-align: left;
		cursor: pointer;
	}
	.chat-hint:hover {
		background: var(--surface-hover);
	}
	.chat-cmd {
		font-family: var(--font-ui-mono);
		font-weight: 500;
		color: var(--accent-text);
	}
	.chat-help {
		color: var(--text-muted);
	}
</style>
