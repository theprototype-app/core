<script lang="ts">
	// Chat (phases 67+68): floating draggable window on the --z-window tier —
	// never underneath the flow drawer. Bubbles with author color chips and
	// timestamps, Enter to send, autoscroll with a new-messages pill, /hints.
	import '../../styles/chat.css';
	import { peers, messages, chatHidden, username } from '../../stores/appStore';
	import { isLocked } from '../../stores/sceneStore';
	import { nameOf, peerColor } from '$lib/lockControl';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable } from '$lib/windowTabs';

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
		message.startsWith('/')
			? COMMANDS.filter((c) => c.cmd.startsWith(message.split(' ')[0].toLowerCase()))
			: []
	);

	function send() {
		const text = message.trim();
		if (!text) return;
		$peers.sendMessage(text);
		message = '';
	}

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

	// pin to bottom on new messages; count them as unread while scrolled up
	let lastCount = 0;
	$effect(() => {
		const count = $messages.length;
		if (count === lastCount) return;
		const grew = count > lastCount;
		lastCount = count;
		if (!grew) return;
		if (atBottom) requestAnimationFrame(scrollToBottom);
		else unread++;
	});

	const isMine = (m: any) => m.type === 'sent' || m.sender === $peers?.peer?.id;
	const isNote = (m: any) => m.type === 'info' || m.type === 'system' || m.type === '';
	const authorName = (m: any) =>
		m.sender === $peers?.peer?.id ? $username || 'You' : nameOf(m.sender);
	const stamp = (m: any) =>
		m.ts
			? new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
			: '';
</script>

<div id="chat" class={$chatHidden}>
	<div
		id="chat-window"
		use:dragWindow={{ key: 'chat', defaultRect: { right: 15, bottom: 15 } }}
		use:focusStack
		use:tabbable={{ key: 'chat', title: 'Chat', openStore: chatHidden, isOpen: (v) => v === '', close: () => chatHidden.set('hidden') }}
		class="ui-panel flex h-[420px] w-[min(500px,90vw)] flex-col overflow-hidden bg-gray-900/85 backdrop-blur"
		style="z-index: var(--z-window)"
	>
		<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
			<span><i class="fa-solid fa-message mr-1"></i>Chat</span>
			<span class="flex-1"></span>
			<button class="ui-button-quiet" title="Close (C)" onclick={() => chatHidden.set('hidden')}>✕</button>
		</div>

		<div class="relative min-h-0 flex-1">
			<div id="chat-messages" bind:this={scroller} onscroll={onScroll} class="h-full overflow-y-auto px-2 py-1">
				<ul id="messages" class="flex flex-col gap-1">
					{#each $messages as m (m)}
						{#if isNote(m)}
							<li class="chat-message {m.type} self-center text-center text-[11px] italic text-gray-400">
								{m.sender === 'SYSTEM' ? '' : authorName(m) + ' '}{m.text}
							</li>
						{:else}
							<li class={'chat-message ' + m.type + ' max-w-[85%] rounded-lg px-2 py-1 text-sm ' +
								(isMine(m)
									? 'self-end rounded-br-sm bg-primary-800/80 text-primary-50'
									: 'self-start rounded-bl-sm bg-gray-700/80 text-gray-100')}>
								<span class="flex items-baseline gap-1.5">
									<span class="h-2 w-2 shrink-0 self-center rounded-full" style={'background:' + peerColor(m.sender)}></span>
									<span class="text-[11px] font-semibold opacity-90">{authorName(m)}</span>
									<span class="text-[9px] text-gray-400">{stamp(m)}</span>
								</span>
								<span class="break-words">{m.text}</span>
							</li>
						{/if}
					{/each}
				</ul>
			</div>

			{#if unread > 0 && !atBottom}
				<button
					class="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-primary-700 px-3 py-0.5 text-xs text-white shadow-lg hover:bg-primary-600"
					onclick={scrollToBottom}
				>
					{unread} new message{unread === 1 ? '' : 's'} ↓
				</button>
			{/if}
		</div>

		{#if !$isLocked}
			<div id="chat-input" class="shrink-0 border-t border-gray-700/60 p-2">
				{#if hints.length}
					<div class="mb-1 flex flex-col gap-0.5 rounded-md border border-gray-700/60 bg-gray-800/95 p-1 text-xs">
						{#each hints as hint}
							<button
								class="flex items-baseline gap-2 rounded px-1.5 py-0.5 text-left hover:bg-gray-700"
								onclick={() => {
									message = hint.cmd + ' ';
									document.getElementById('message')?.focus();
								}}
							>
								<span class="font-mono font-semibold text-primary-300">{hint.cmd}</span>
								<span class="text-gray-400">{hint.help}</span>
							</button>
						{/each}
					</div>
				{/if}
				<div class="flex items-center gap-1.5">
					<input
						type="text"
						id="message"
						class="ui-input min-w-0 flex-1"
						placeholder="Message — / for commands"
						bind:value={message}
						onkeydown={(e) => {
							if (e.key === 'Enter') send();
						}}
					/>
					<button
						id="send"
						class="shrink-0 rounded-lg bg-primary-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-600"
						onclick={send}
					>
						Send
					</button>
				</div>
			</div>
		{/if}
	</div>
</div>
