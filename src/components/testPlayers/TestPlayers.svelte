<script>
	// 61 G3 — TEST WITH PLAYERS: the setup sheet and, while a test runs, the strip of bots. A lazy
	// component (testPlayers.js mounts it on the first Play menu ▸ Test with players…), so the editor's boot
	// pays nothing. Each bot is a small live view of its own app instance — a same-origin frame — and Drive
	// makes it big enough to play and hands it the keyboard. Everything here is LOCAL to this tab: the bots
	// are ordinary guests of your session, nothing they do is saved, and Stop test removes them.
	import ModalDialog from '../ui/ModalDialog.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import Button from '../ui/Button.svelte';
	import Icon from '../ui/Icon.svelte';
	import { testRun, testSheetOpen, botCap, TEST_ROLE_LABELS, stopTestPlayers } from '$lib/testPlayers/testPlayers.js';
	import { startTest, cannotStart, attachFrame, botUrl, tellBot } from '$lib/testPlayers/host.js';
	import { showToast } from '../../stores/appStore';

	/** @typedef {'player' | 'editor' | 'viewer'} Role */
	const ROLE_HINT = {
		player: 'Joins and enters Play: walks, presses, scores — cannot edit the scene',
		editor: 'Joins as an editor: everything it does changes the scene for everyone',
		viewer: 'Watches only: anything it tries to change is refused'
	};
	const cap = botCap();
	let count = $state(String(Math.min(2, cap)));
	/** @type {Role[]} */
	let roles = $state(['player', 'viewer', 'player']);
	let why = $state('');
	let stopping = $state(false);
	/** @type {number | null} the bot being driven */
	let driving = $state(null);
	let small = $state(false);

	$effect(() => {
		if ($testSheetOpen) why = cannotStart();
	});

	const countOptions = [1, 2, 3].map((n) => ({
		value: String(n),
		label: String(n),
		disabled: n > cap,
		title: n > cap ? 'This device runs up to ' + cap + ' (each player is a whole copy of the app)' : n + (n === 1 ? ' player' : ' players')
	}));
	const roleOptions = /** @type {Role[]} */ (['player', 'editor', 'viewer']).map((r) => ({ value: r, label: TEST_ROLE_LABELS[r], title: ROLE_HINT[r] }));

	async function start() {
		why = cannotStart();
		if (why) return;
		try {
			await startTest(roles.slice(0, Number(count)));
			testSheetOpen.set(false);
		} catch (e) {
			why = String(/** @type {any} */ (e)?.message ?? e);
		}
	}

	async function stop() {
		if (stopping) return;
		stopping = true;
		driving = null;
		try {
			await stopTestPlayers();
			showToast('Test stopped — the players left and nothing they did was saved.');
		} finally {
			stopping = false;
		}
	}

	/** @param {number} n */
	function drive(n) {
		driving = driving === n ? null : n;
		if (driving === n) {
			tellBot(n, 'focus');
			requestAnimationFrame(() => /** @type {HTMLIFrameElement | null} */ (document.getElementById('test-player-frame-' + n))?.focus());
		}
	}

	/** register a bot's frame with the hub BEFORE it loads, so its first message is heard
	 * @param {HTMLIFrameElement} node @param {number} n */
	function botFrame(node, n) {
		attachFrame(n, node);
		node.src = botUrl(n);
		return {};
	}

	const STATUS = /** @type {Record<string, string>} */ ({ loading: 'Loading', joining: 'Joining', joined: 'Joined', playing: 'Playing', left: 'Left' });
</script>

<ModalDialog bind:open={$testSheetOpen} title="Test with players" width="sm" desktopWidth="420px" id="test-players-sheet">
	<div class="tps">
		<p class="tps-lead">Simulated players join your session from this tab, so you can try a multiplayer game alone. Nothing they do is saved, and Stop test removes them.</p>
		<div class="tps-row">
			<span id="test-players-count-label" class="tps-label">Players</span>
			<Segmented id="test-players-count" labelledby="test-players-count-label" options={countOptions} bind:value={count} />
		</div>
		{#each Array.from({ length: Number(count) }, (_, i) => i) as i (i)}
			<div class="tps-row">
				<span id={'test-player-role-label-' + (i + 1)} class="tps-label">Player {i + 1}</span>
				<Segmented id={'test-player-role-' + (i + 1)} labelledby={'test-player-role-label-' + (i + 1)} options={roleOptions} bind:value={roles[i]} />
			</div>
			<p class="tps-hint">{ROLE_HINT[roles[i]]}</p>
		{/each}
		{#if why}<p class="tps-why" role="status">{why}</p>{/if}
	</div>
	{#snippet footer()}
		<div class="tps-foot">
			<Button variant="ghost" onclick={() => testSheetOpen.set(false)}>Cancel</Button>
			<Button variant="primary" id="test-players-start" icon="users" disabled={!!why} onclick={start}>Start test</Button>
		</div>
	{/snippet}
</ModalDialog>

{#if $testRun}
	<section id="test-players-strip" class="tpst" class:small aria-label="Test players">
		<header class="tpst-head">
			<Icon name="users" size={16} aria-hidden="true" />
			<span class="tpst-title">Test players</span>
			{#if $testRun.refused}<span class="tpst-refused" title="Messages refused because of a player's role">{$testRun.refused} refused</span>{/if}
			<button type="button" class="tpst-icon" aria-pressed={small} aria-label={small ? 'Larger views' : 'Smaller views'} title={small ? 'Larger views' : 'Smaller views'} onclick={() => (small = !small)}>
				<Icon name={small ? 'maximize-2' : 'minimize-2'} size={16} aria-hidden="true" />
			</button>
			<Button variant="danger" size="sm" id="test-players-stop" icon="square" disabled={stopping} onclick={stop}>Stop test</Button>
		</header>
		<div class="tpst-bots">
			{#each $testRun.bots as bot (bot.n)}
				<article class="tpst-bot" class:driving={driving === bot.n} data-bot={bot.n} data-role={bot.role} data-status={bot.status}>
					<div class="tpst-view">
						<iframe
							id={'test-player-frame-' + bot.n}
							title={'Test player ' + bot.n + ' (' + TEST_ROLE_LABELS[bot.role] + ')'}
							tabindex={driving === bot.n ? undefined : -1}
							use:botFrame={bot.n}
						></iframe>
					</div>
					<div class="tpst-meta">
						<span class="tpst-name">Player {bot.n}</span>
						<span class="tpst-role">{TEST_ROLE_LABELS[bot.role]}</span>
						<span class="tpst-status" data-status={bot.status}>{STATUS[bot.status] ?? bot.status}</span>
						<button type="button" class="tpst-icon" aria-pressed={driving === bot.n} aria-label={(driving === bot.n ? 'Stop driving' : 'Drive') + ' player ' + bot.n} title={driving === bot.n ? 'Stop driving' : 'Drive: a big view that takes your keyboard'} onclick={() => drive(bot.n)}>
							<Icon name="gamepad-2" size={16} aria-hidden="true" />
						</button>
					</div>
				</article>
			{/each}
		</div>
	</section>
{/if}

<style>
	.tps {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.tps-lead,
	.tps-hint {
		margin: 0;
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.4;
	}
	.tps-hint {
		margin-top: -4px;
	}
	.tps-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.tps-label {
		font-size: 13px;
		color: var(--text);
	}
	.tps-why {
		margin: 0;
		font-size: 12px;
		color: var(--warn-text);
	}
	.tps-foot {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.tpst {
		/* bottom-left, above the toolbar: the views stay up in Play, where the test is */
		--tp-scale: 0.3333;
		position: fixed;
		left: 16px;
		bottom: 96px;
		z-index: calc(var(--z-window) - 2);
		display: flex;
		flex-direction: column;
		gap: 6px;
		max-width: calc(100vw - 32px);
		padding: 6px;
		border-radius: var(--radius-window);
		background: var(--surface-1);
		color: var(--text);
		border: 1px solid var(--border);
		box-shadow: var(--shadow-window);
		font-size: 12px;
	}
	.tpst.small {
		--tp-scale: 0.1667;
	}
	.tpst-head {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.tpst-title {
		font-weight: 600;
		flex: 1;
	}
	.tpst-refused {
		color: var(--text-muted);
	}
	.tpst-bots {
		display: flex;
		gap: 6px;
		overflow-x: auto;
	}
	.tpst-bot {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex: none;
	}
	/* the frame is a 720 x 405 app (wider than the 640 px phone layout), drawn small */
	.tpst-view {
		width: calc(720px * var(--tp-scale));
		height: calc(405px * var(--tp-scale));
		overflow: hidden;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: var(--surface-2);
	}
	.tpst-bot.driving .tpst-view {
		--tp-scale: 0.6667;
		outline: var(--focus-ring-width) solid var(--focus-ring);
	}
	.tpst-view iframe {
		width: 720px;
		height: 405px;
		border: 0;
		transform: scale(var(--tp-scale));
		transform-origin: 0 0;
		pointer-events: none;
	}
	.tpst-bot.driving .tpst-view iframe {
		pointer-events: auto;
	}
	.tpst-meta {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.tpst-name {
		font-weight: 600;
	}
	.tpst-role,
	.tpst-status {
		color: var(--text-muted);
	}
	.tpst-status[data-status='playing'],
	.tpst-status[data-status='joined'] {
		color: var(--text);
	}
	.tpst-meta .tpst-icon {
		margin-left: auto;
	}
	.tpst-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 28px;
		min-height: 28px;
		border-radius: 6px;
		color: inherit;
	}
	.tpst-icon:hover {
		background: var(--surface-hover);
	}
	.tpst-icon[aria-pressed='true'] {
		background: var(--accent);
		color: var(--on-accent);
	}
	.tpst-icon:focus-visible {
		outline: var(--focus-ring-width) solid var(--focus-ring);
		outline-offset: 1px;
	}
	@media (max-width: 640px) {
		.tpst {
			left: 8px;
			bottom: calc(var(--ps-bar-h, 56px) + 8px);
		}
	}
</style>
