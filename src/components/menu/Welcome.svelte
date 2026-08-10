<script lang="ts">
	// RW/B1: first-visit welcome overlay. The app IS the landing page, so this is the
	// only thing between the click and the canvas — three sentences, three buttons,
	// then out of the way. Shown once ever (hasSeenWelcome) unless the user ticks
	// "Show this on start", which also has a Settings toggle.
	import { welcomeOpen, closeWelcome, showWelcomeOnStart, openWhatsNew } from '$lib/whatsNew';
	import { templatesModalOpen } from '../../stores/appStore.js';
	import { versionString } from '$lib/version';
	import { githubStars, loadGithubStars } from '$lib/githubStars';

	loadGithubStars(); // cached 12h, no-ops after the first call
	/** compact star count (1234 -> 1.2k) */
	const starLabel = (n: number) =>
		n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);

	// The 60s demo/tour video. Points at the channel playlist until a dedicated
	// release clip exists.
	const DEMO_URL = 'https://www.youtube.com/watch?v=yR21_x4jV7g&list=PLBSyotD7wAZvjCW3ZSKQbNpb-9_f7Q3YM';
	const REPO_URL = 'https://github.com/theprototype-app/core';

	function start() {
		closeWelcome();
	}
	function openTemplates() {
		closeWelcome();
		templatesModalOpen.set(true);
	}
	function openDemo() {
		window.open(DEMO_URL, '_blank', 'noopener');
	}
	function openRepo() {
		window.open(REPO_URL, '_blank', 'noopener');
	}
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			closeWelcome();
		}
	}
</script>

{#if $welcomeOpen}
	<!-- Own backdrop + card rather than a flowbite Modal: this must sit above every
	     panel at the modal tier and needs no accordion/scroll chrome. -->
	<div class="welcome-backdrop" style="z-index: calc(var(--z-modal) - 1)"></div>
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		id="welcome-overlay"
		class="welcome-card"
		style="z-index: var(--z-modal)"
		role="dialog"
		aria-modal="true"
		aria-label="Welcome to theprototype.app"
		tabindex="-1"
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

		<p class="welcome-lead">
			Build 3D prototypes in your browser — alone or together. Sessions are
			<strong>peer&#8209;to&#8209;peer</strong>: share your ID and everything you do shows up for
			everyone, with no account and no server holding your scene.
		</p>
		<p class="welcome-sub">
			Right&#8209;click the viewport to add something, or open the logo menu for files, modules and
			settings. Not sure where to start? The logo menu's <strong>Templates</strong> has starting
			scenes, examples and community creations.
		</p>

		<div class="welcome-actions">
			<button id="welcome-start" class="welcome-btn welcome-btn-primary" onclick={start}>Start building</button>
			<button id="welcome-templates" class="welcome-btn" onclick={openTemplates}>Start from a template</button>
			<button class="welcome-btn" onclick={openDemo}>▶ Watch the demo</button>
			<!-- 15-M: the star count doubles as a social cue and a nudge; hidden
			     entirely when GitHub is unreachable (offline / rate limited) -->
			<button class="welcome-btn" onclick={openRepo}>
				GitHub{#if $githubStars !== null}<span class="welcome-stars" title="{$githubStars} stars on GitHub"
						>★ {starLabel($githubStars)}</span
					>{/if}
			</button>
		</div>

		<div class="welcome-foot">
			<label class="welcome-check">
				<input type="checkbox" checked={$showWelcomeOnStart} onchange={(e: any) => showWelcomeOnStart.set(e.target.checked)} />
				Show this on start
			</label>
			<button
				class="welcome-link"
				onclick={() => {
					closeWelcome();
					openWhatsNew();
				}}>What's new</button
			>
		</div>
	</div>
{/if}

<style>
	.welcome-backdrop {
		position: fixed;
		inset: 0;
		background: rgb(0 0 0 / 0.55);
		backdrop-filter: blur(2px);
	}
	.welcome-card {
		position: fixed;
		top: 50%;
		left: 50%;
		/* transform makes this the containing block for fixed children — there are
		   none inside, so centering this way is safe (see the menus gotcha). */
		transform: translate(-50%, -50%);
		width: min(560px, 92vw);
		max-height: 88vh;
		overflow-y: auto;
		padding: 18px 20px 14px;
		border-radius: 16px;
		border: 1px solid rgb(255 255 255 / 0.1);
		background: var(--color-form, rgb(31 41 55 / 0.99));
		color: #e5e7eb;
		box-shadow: 0 24px 60px rgb(0 0 0 / 0.55);
		outline: none;
	}
	.welcome-head {
		display: flex;
		align-items: center;
		gap: 11px;
		margin-bottom: 14px;
	}
	.welcome-title {
		font-size: 18px;
		font-weight: 650;
		line-height: 1.1;
		color: #f3f4f6;
	}
	.welcome-dim {
		color: #9ca3af;
		font-weight: 400;
	}
	.welcome-ver {
		font-size: 10.5px;
		color: #6b7280;
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
		color: #9ca3af;
		font-size: 12px;
		cursor: pointer;
	}
	.welcome-x:hover {
		color: #fff;
		background: rgb(255 255 255 / 0.08);
	}
	.welcome-lead {
		font-size: 13.5px;
		line-height: 1.55;
		color: #d1d5db;
	}
	.welcome-lead strong {
		color: #f3f4f6;
		font-weight: 600;
	}
	.welcome-sub {
		margin-top: 8px;
		font-size: 12.5px;
		line-height: 1.5;
		color: #9ca3af;
	}
	.welcome-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 16px;
	}
	.welcome-btn {
		flex: 0 0 auto;
		padding: 8px 14px;
		border-radius: 9px;
		border: 1px solid rgb(255 255 255 / 0.12);
		background: rgb(255 255 255 / 0.05);
		color: #e5e7eb;
		font-size: 12.5px;
		cursor: pointer;
	}
	.welcome-btn:hover {
		background: rgb(255 255 255 / 0.1);
	}
	/* 15-M: star count chip inside the GitHub button */
	.welcome-stars {
		margin-left: 7px;
		padding: 1px 6px;
		border-radius: 999px;
		background: rgb(255 255 255 / 0.09);
		color: #fcd34d;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
	.welcome-btn-primary {
		background: #2563eb;
		border-color: #2563eb;
		color: #fff;
		font-weight: 600;
	}
	.welcome-btn-primary:hover {
		background: #1d4ed8;
	}
	.welcome-foot {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 16px;
		padding-top: 11px;
		border-top: 1px solid rgb(255 255 255 / 0.08);
	}
	.welcome-check {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 11.5px;
		color: #9ca3af;
		cursor: pointer;
	}
	.welcome-link {
		margin-left: auto;
		background: transparent;
		border: 0;
		padding: 0;
		font-size: 11.5px;
		color: #93c5fd;
		text-decoration: underline;
		cursor: pointer;
	}
	.welcome-link:hover {
		color: #bfdbfe;
	}
	@media (max-width: 480px) {
		.welcome-actions .welcome-btn {
			flex: 1 1 100%;
			text-align: center;
		}
	}
</style>
