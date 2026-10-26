<script lang="ts">
	// RW/B1: first-visit welcome overlay. The app IS the landing page, so this is the
	// only thing between the click and the canvas. Shown once ever (hasSeenWelcome) unless
	// the user ticks "Show this on start", which also has a Settings toggle.
	//
	// 76 FW1: ONE QUESTION — "What do you want to do?" — with four answers (Play a game, Remix a
	// game, Start from a template, Describe it) and a quiet "Empty scene". Every answer except Play
	// ends in the three-step first-win quest (change something → Play → share, $lib/onboarding);
	// Play opens a game straight in Play and offers the same quest as a remix once the game ends.
	// The answer is remembered locally and only branches the flow.
	import { untrack } from 'svelte';
	import { welcomeOpen, closeWelcome, showWelcomeOnStart, openWhatsNew } from '$lib/whatsNew';
	import { templatesModalOpen, templatesModalTab, aiAssistantHidden, settingsOpen, settingsSection } from '../../stores/appStore.js';
	import { versionString } from '$lib/version';
	import { githubStars, loadGithubStars } from '$lib/githubStars';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import Icon from '../ui/Icon.svelte';
	import { templates, games, templatesState, loadTemplatesIndex, loadRemoteScene, loadingSlug } from '$lib/sceneTemplates';
	import { chooseOnboarding } from '$lib/onboarding/firstWin.js';
	import { requestPlay } from '$lib/playMode';
	import { aiEnabled, aiProviders, aiActiveProvider } from '$lib/ai/providers';
	import { aiBusy, runPrompt } from '$lib/ai/assistant';

	loadGithubStars(); // cached 12h, no-ops after the first call
	/** compact star count (1234 -> 1.2k) */
	const starLabel = (n: number) =>
		n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);

	// The 60s demo/tour video. Points at the channel playlist until a dedicated
	// release clip exists.
	const DEMO_URL = 'https://www.youtube.com/watch?v=yR21_x4jV7g&list=PLBSyotD7wAZvjCW3ZSKQbNpb-9_f7Q3YM';
	const REPO_URL = 'https://github.com/theprototype-app/core';

	/** the three example prompts Describe it offers as chips */
	const EXAMPLES = [
		'A small obstacle course: five platforms in a row and a goal flag at the end',
		'A cosy room with a table, two chairs and a lamp',
		'A target range: three targets on posts and a ball to throw'
	];

	type View = 'ask' | 'play' | 'remix' | 'template' | 'prompt';
	let view = $state<View>('ask');
	let prompt = $state('');
	let cardEl: HTMLElement | null = $state(null);

	const hasAi = $derived($aiEnabled && $aiProviders.length > 0 && !!$aiActiveProvider);
	const listed = $derived(view === 'template' ? $templates : $games);
	const listLoading = $derived($templatesState === 'idle' || $templatesState === 'loading');

	// a fresh question every time it opens; the index is fetched up front so the lists are ready
	$effect(() => {
		const open = $welcomeOpen;
		untrack(() => {
			if (!open) return;
			view = 'ask';
			loadTemplatesIndex();
		});
	});
	// focus follows the view (keyboard users land on the first answer, then the first list item)
	$effect(() => {
		void view;
		if (!$welcomeOpen) return;
		const frame = requestAnimationFrame(() => {
			const first = cardEl?.querySelector('[data-welcome-first]') as HTMLElement | null;
			(first ?? cardEl)?.focus({ preventScroll: true });
		});
		return () => cancelAnimationFrame(frame);
	});

	function start() {
		closeWelcome();
		chooseOnboarding('empty');
	}
	/** @param {View} next */
	function go(next: View) {
		view = next;
	}
	function allTemplates() {
		closeWelcome();
		chooseOnboarding(view === 'remix' ? 'remix' : 'template');
		templatesModalTab.set(view === 'template' ? 'general' : 'games');
		templatesModalOpen.set(true);
	}
	/** @param {any} entry */
	async function pick(entry: any) {
		const choice = view;
		closeWelcome();
		if (choice === 'play') {
			chooseOnboarding('play', { entry });
			const applied = await loadRemoteScene(entry, { origin: 'games' });
			// straight into Play — the export / embed autoplay path (no gesture survives the download)
			if (applied) requestPlay({ flat: true });
			return;
		}
		chooseOnboarding(choice === 'remix' ? 'remix' : 'template');
		await loadRemoteScene(entry, { origin: choice === 'remix' ? 'games' : 'general' });
	}
	async function build() {
		const text = prompt.trim();
		if (!text || !hasAi || $aiBusy) return;
		closeWelcome();
		aiAssistantHidden.set(''); // the answer streams into the assistant window
		await runPrompt(text);
		// the quest's first step is the user's own change to what was built
		chooseOnboarding('prompt');
	}
	function openAiSettings() {
		closeWelcome();
		settingsSection.set('ai');
		settingsOpen.set(true);
	}
	function openDemo() {
		window.open(DEMO_URL, '_blank', 'noopener');
	}
	function openRepo() {
		window.open(REPO_URL, '_blank', 'noopener');
	}
	function onKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		e.preventDefault();
		if (view !== 'ask') view = 'ask';
		else closeWelcome();
	}

	const LIST_TITLE: Record<string, string> = {
		play: 'Pick a game to play',
		remix: 'Pick a game to remix',
		template: 'Pick a starting scene'
	};
	const LIST_SUB: Record<string, string> = {
		play: 'It opens straight in Play. When you are done, you can make it yours.',
		remix: 'It opens in the editor with a small task: change it, play it, share it.',
		template: 'A level, a room or a playground to build on.'
	};
</script>

{#if $welcomeOpen}
	<!-- Own backdrop + card rather than a flowbite Modal: this must sit above every
	     panel at the modal tier and needs no accordion/scroll chrome. -->
	<div class="welcome-backdrop" style="z-index: calc(var(--z-onboarding) - 1)"></div>
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		id="welcome-overlay"
		class="welcome-card"
		bind:this={cardEl}
		use:minimalScroll
		style="z-index: var(--z-onboarding)"
		role="dialog"
		aria-modal="true"
		aria-label="Welcome to theprototype.app"
		aria-describedby="welcome-question"
		tabindex="-1"
		data-view={view}
		onkeydown={onKeydown}
	>
		<div class="welcome-head">
			<img src="logo.svg" alt="" class="h-8 w-8" />
			<div>
				<h2 class="welcome-title">theprototype<span class="welcome-dim">.app</span></h2>
				<p class="welcome-ver">{versionString()}</p>
			</div>
			<button class="welcome-x" title="Close" aria-label="Close welcome" onclick={closeWelcome}>✕</button>
		</div>

		{#if view === 'ask'}
			<p class="welcome-lead">
				Build 3D games in your browser — alone or together. Sessions are
				<strong>peer&#8209;to&#8209;peer</strong>: share your link and friends join you, no account needed.
			</p>
			<h3 id="welcome-question" class="welcome-q">What do you want to do?</h3>
			<div class="welcome-choices" role="group" aria-labelledby="welcome-question">
				<button id="welcome-play" class="welcome-choice" data-choice="play" data-welcome-first onclick={() => go('play')}>
					<span class="welcome-ico"><Icon name="gamepad-2" size={20} aria-hidden="true" /></span>
					<span class="welcome-choice-title">Play a game</span>
					<span class="welcome-choice-sub">Jump into a game and play it now.</span>
				</button>
				<button id="welcome-remix" class="welcome-choice" data-choice="remix" onclick={() => go('remix')}>
					<span class="welcome-ico"><Icon name="git-branch-plus" size={20} aria-hidden="true" /></span>
					<span class="welcome-choice-title">Remix a game</span>
					<span class="welcome-choice-sub">Open a game in the editor and make it yours.</span>
				</button>
				<button id="welcome-template" class="welcome-choice" data-choice="template" onclick={() => go('template')}>
					<span class="welcome-ico"><Icon name="layout-template" size={20} aria-hidden="true" /></span>
					<span class="welcome-choice-title">Start from a template</span>
					<span class="welcome-choice-sub">A level, a room or a playground.</span>
				</button>
				<button id="welcome-prompt" class="welcome-choice" data-choice="prompt" onclick={() => go('prompt')}>
					<span class="welcome-ico"><Icon name="wand-sparkles" size={20} aria-hidden="true" /></span>
					<span class="welcome-choice-title">Describe it</span>
					<span class="welcome-choice-sub">Tell the AI assistant what to build.</span>
				</button>
			</div>
			<p class="welcome-quiet">
				<!-- the pre-76 id: "Start building" became the quiet way to an empty scene -->
				<button id="welcome-start" class="welcome-link" onclick={start}>Empty scene</button>
			</p>
		{:else if view === 'prompt'}
			<div class="welcome-subhead">
				<button id="welcome-back" class="welcome-back" aria-label="Back to the question" onclick={() => go('ask')}><Icon name="chevron-left" size={16} aria-hidden="true" /></button>
				<h3 id="welcome-question" class="welcome-q">Describe what to build</h3>
			</div>
			{#if hasAi}
				<label class="welcome-sr" for="welcome-prompt-input">Describe your scene</label>
				<textarea
					id="welcome-prompt-input"
					class="tp-field welcome-prompt"
					rows="3"
					placeholder="A small island with a lighthouse and three boats…"
					bind:value={prompt}
					data-welcome-first
					onkeydown={(e) => {
						if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) build();
					}}
				></textarea>
				<p class="welcome-sub">Or start from one of these:</p>
				<div class="welcome-chips" role="group" aria-label="Example prompts">
					{#each EXAMPLES as ex, i (i)}
						<button class="welcome-chip" data-example={i} onclick={() => (prompt = ex)}>{ex}</button>
					{/each}
				</div>
				<div class="welcome-row">
					<button id="welcome-prompt-go" class="welcome-btn welcome-btn-primary" disabled={!prompt.trim() || $aiBusy} onclick={build}>Build it</button>
				</div>
			{:else}
				<p id="welcome-no-ai" class="welcome-sub">
					Describe it uses the AI assistant, and it needs an AI provider first — your own key or a
					local model.
				</p>
				<div class="welcome-row">
					<button id="welcome-ai-setup" class="welcome-btn welcome-btn-primary" data-welcome-first onclick={openAiSettings}>Set up in Settings ▸ AI</button>
					<button class="welcome-btn" onclick={() => go('template')}>Start from a template instead</button>
				</div>
			{/if}
		{:else}
			<div class="welcome-subhead">
				<button id="welcome-back" class="welcome-back" aria-label="Back to the question" onclick={() => go('ask')}><Icon name="chevron-left" size={16} aria-hidden="true" /></button>
				<h3 id="welcome-question" class="welcome-q">{LIST_TITLE[view]}</h3>
			</div>
			<p class="welcome-sub">{LIST_SUB[view]}</p>
			{#if listLoading}
				<div class="welcome-list" aria-busy="true">
					{#each [0, 1, 2, 3] as i (i)}
						<div class="welcome-item welcome-skel"></div>
					{/each}
				</div>
			{:else if listed.length}
				<div id="welcome-list" class="welcome-list">
					{#each listed as entry, i (entry.slug)}
						<button
							class="welcome-item"
							data-scene-slug={entry.slug}
							data-welcome-first={i === 0 ? '' : undefined}
							disabled={$loadingSlug === entry.slug}
							title={entry.description || entry.title}
							onclick={() => pick(entry)}
						>
							{#if entry.thumbUrl}
								<img src={entry.thumbUrl} alt="" class="welcome-thumb" loading="lazy" />
							{:else}
								<span class="welcome-thumb welcome-thumb-ph"><Icon name="image" size={20} aria-hidden="true" /></span>
							{/if}
							<span class="welcome-item-title">{entry.title}</span>
						</button>
					{/each}
				</div>
			{:else}
				<p id="welcome-list-empty" class="welcome-sub">
					{view === 'template'
						? "The templates couldn't be reached — check your connection."
						: 'Games are online content — reconnect to browse them.'}
				</p>
			{/if}
			<p class="welcome-quiet">
				<button id="welcome-all" class="welcome-link" onclick={allTemplates}>{view === 'template' ? 'All templates…' : 'All games…'}</button>
			</p>
		{/if}

		<div class="welcome-foot">
			<label class="welcome-check">
				<input type="checkbox" checked={$showWelcomeOnStart} onchange={(e: any) => showWelcomeOnStart.set(e.target.checked)} />
				Show this on start
			</label>
			<span class="welcome-foot-links">
				<button class="welcome-link" onclick={openDemo}>Watch the demo</button>
				<!-- 15-M: the star count doubles as a social cue and a nudge; hidden
				     entirely when GitHub is unreachable (offline / rate limited) -->
				<button class="welcome-link" onclick={openRepo}>
					GitHub{#if $githubStars !== null}<span class="welcome-stars" title="{$githubStars} stars on GitHub"
							>★ {starLabel($githubStars)}</span
						>{/if}
				</button>
				<button
					class="welcome-link"
					onclick={() => {
						closeWelcome();
						openWhatsNew();
					}}>What's new</button
				>
			</span>
		</div>
	</div>
{/if}

<style>
	.welcome-backdrop {
		position: fixed;
		inset: 0;
		background: var(--scrim);
		backdrop-filter: blur(2px);
	}
	.welcome-card {
		position: fixed;
		top: 50%;
		left: 50%;
		/* transform makes this the containing block for fixed children — there are
		   none inside, so centering this way is safe (see the menus gotcha). */
		transform: translate(-50%, -50%);
		width: min(600px, calc(100vw - 24px));
		max-height: 90dvh;
		overflow-y: auto;
		padding: 18px 20px 14px;
		border-radius: 16px;
		border: 1px solid var(--border);
		background: var(--surface-1);
		color: var(--text-2);
		box-shadow: var(--shadow-window);
		outline: none;
	}
	.welcome-head {
		display: flex;
		align-items: center;
		gap: 11px;
		margin-bottom: 12px;
	}
	.welcome-title {
		font-size: 18px;
		font-weight: 650;
		line-height: 1.1;
		color: var(--text);
	}
	.welcome-dim {
		color: var(--text-muted);
		font-weight: 400;
	}
	.welcome-ver {
		font-size: 10.5px;
		color: var(--text-faint);
		font-family: ui-monospace, monospace;
		margin-top: 2px;
	}
	.welcome-x {
		margin-left: auto;
		align-self: flex-start;
		width: 24px;
		height: 24px;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--text-muted);
		font-size: 12px;
		cursor: pointer;
	}
	.welcome-x:hover {
		color: var(--text);
		background: var(--surface-hover);
	}
	.welcome-lead {
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-muted);
	}
	.welcome-lead strong {
		color: var(--text-2);
		font-weight: 600;
	}
	.welcome-q {
		margin-top: 14px;
		font-size: 16px;
		font-weight: 650;
		color: var(--text);
	}
	.welcome-subhead {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.welcome-subhead .welcome-q {
		margin-top: 0;
	}
	.welcome-back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.welcome-back:hover {
		color: var(--text);
		background: var(--surface-hover);
	}
	.welcome-choices {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
		margin-top: 10px;
	}
	.welcome-choice {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
		min-height: 104px;
		padding: 12px 13px;
		border-radius: 12px;
		border: 1px solid var(--border-strong);
		background: var(--surface-2);
		color: var(--text-2);
		text-align: left;
		cursor: pointer;
	}
	.welcome-choice:hover {
		background: var(--surface-hover);
		border-color: var(--accent);
	}
	.welcome-ico {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		margin-bottom: 4px;
		border-radius: 10px;
		background: var(--accent-soft);
		color: var(--accent-soft-text);
	}
	.welcome-choice-title {
		font-size: 14px;
		font-weight: 650;
		color: var(--text);
	}
	.welcome-choice-sub {
		font-size: 12px;
		line-height: 1.4;
		color: var(--text-muted);
	}
	.welcome-quiet {
		margin-top: 12px;
		text-align: center;
	}
	.welcome-sub {
		margin-top: 8px;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--text-muted);
	}
	.welcome-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
		gap: 8px;
		margin-top: 10px;
	}
	.welcome-item {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border-radius: 10px;
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--text-2);
		text-align: left;
		cursor: pointer;
	}
	.welcome-item:hover {
		border-color: var(--accent);
	}
	.welcome-item:disabled {
		opacity: 0.6;
		cursor: progress;
	}
	.welcome-skel {
		height: 112px;
		cursor: default;
	}
	.welcome-thumb {
		width: 100%;
		height: 76px;
		object-fit: cover;
		background: var(--surface-inset);
	}
	.welcome-thumb-ph {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-faint);
	}
	.welcome-item-title {
		padding: 6px 8px 8px;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.welcome-prompt {
		width: 100%;
		margin-top: 10px;
		resize: vertical;
		font-size: 13px;
	}
	.welcome-chips {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 6px;
	}
	.welcome-chip {
		padding: 7px 10px;
		border-radius: 9px;
		border: 1px solid var(--border-strong);
		background: var(--surface-2);
		color: var(--text-2);
		font-size: 12px;
		text-align: left;
		cursor: pointer;
	}
	.welcome-chip:hover {
		background: var(--surface-hover);
	}
	.welcome-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 12px;
	}
	.welcome-btn {
		flex: 0 0 auto;
		padding: 8px 14px;
		border-radius: 9px;
		border: 1px solid var(--border-strong);
		background: var(--surface-hover);
		color: var(--text-2);
		font-size: 12.5px;
		cursor: pointer;
	}
	.welcome-btn:hover {
		background: var(--surface-active);
	}
	.welcome-btn:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.welcome-btn-primary {
		background: var(--accent-fill);
		border-color: var(--accent-fill);
		color: var(--on-accent);
		font-weight: 600;
	}
	.welcome-btn-primary:hover {
		background: var(--accent-fill);
		filter: brightness(0.92);
	}
	/* 15-M: star count chip inside the GitHub link */
	.welcome-stars {
		margin-left: 5px;
		padding: 0 5px;
		border-radius: 999px;
		background: var(--surface-active);
		color: var(--ink-warn);
		font-size: 10.5px;
		font-variant-numeric: tabular-nums;
		text-decoration: none;
		display: inline-block;
	}
	.welcome-foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
		margin-top: 14px;
		padding-top: 11px;
		border-top: 1px solid var(--border);
	}
	.welcome-foot-links {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		margin-left: auto;
	}
	.welcome-check {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 11.5px;
		color: var(--text-muted);
		cursor: pointer;
	}
	.welcome-link {
		background: transparent;
		border: 0;
		padding: 0;
		font-size: 11.5px;
		color: var(--accent-text);
		text-decoration: underline;
		cursor: pointer;
	}
	.welcome-quiet .welcome-link {
		font-size: 12.5px;
	}
	.welcome-link:hover {
		color: var(--accent-soft-text);
	}
	.welcome-sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	@media (max-width: 480px) {
		.welcome-card {
			padding: 14px 14px 12px;
		}
		.welcome-choice {
			min-height: 96px;
			padding: 10px;
		}
		.welcome-choice-sub {
			font-size: 11.5px;
		}
		.welcome-list {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.welcome-foot-links {
			margin-left: 0;
		}
	}
</style>
