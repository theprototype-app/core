<script>
	import { untrack } from 'svelte';
	// 36-community (C6) — THE HEART. One toggle with its count, shared by the Templates modal's
	// Community cards, the play-link start card and a published game's pause menu. Presentation
	// and the optimistic flip only: `ontoggle` (the cloud plugin's) does the write and resolves
	// `{liked, count}` (the server's answer, which wins) or null (refused — signed out, a failed
	// write), and the flip rolls back. A second press while one is in flight is ignored, so a
	// double tap cannot send like + unlike out of order.
	//
	// Theme tokens only: the filled heart is `--ink-bad` (each theme states a readable red), the
	// empty one inherits the text colour.

	/** @type {{ count?: number, liked?: boolean, ontoggle: () => Promise<{liked: boolean, count: number} | null>,
	 *   size?: 'sm' | 'md', id?: string, label?: string, overlay?: boolean }} */
	let { count = 0, liked = false, ontoggle, size = 'sm', id = undefined, label = 'Like', overlay = false } = $props();

	// the shown state: the props until a press, then the optimistic value until the answer lands
	let pending = $state(/** @type {{liked: boolean, count: number} | null} */ (null));
	let busy = $state(false);
	const shownLiked = $derived(pending ? pending.liked : !!liked);
	const shownCount = $derived(Math.max(0, pending ? pending.count : Number(count) || 0));

	/** @param {MouseEvent} e */
	async function press(e) {
		// a card's heart sits beside the card's own load button: never let the press reach it
		e.stopPropagation();
		e.preventDefault();
		if (busy) return;
		const was = { liked: !!liked, count: Math.max(0, Number(count) || 0) };
		const flip = { liked: !was.liked, count: Math.max(0, was.count + (was.liked ? -1 : 1)) };
		pending = flip;
		busy = true;
		/** @type {{liked: boolean, count: number} | null} */
		let answer = null;
		try {
			answer = await ontoggle();
		} catch {
			answer = null;
		}
		// the answer (or the rollback) holds until the parent's props catch up with it
		pending = answer && typeof answer === 'object' ? { liked: !!answer.liked, count: Math.max(0, Number(answer.count) || 0) } : was;
		busy = false;
	}

	// the parent re-rendered with the server's truth: drop the local override
	// (only the PROPS are dependencies: `busy` flipping false must not discard the answer)
	$effect(() => {
		void liked;
		void count;
		untrack(() => {
			if (!busy) pending = null;
		});
	});
</script>

<button
	{id}
	type="button"
	class="tp-heart"
	class:tp-heart-md={size === 'md'}
	class:tp-heart-overlay={overlay}
	class:tp-heart-on={shownLiked}
	aria-pressed={shownLiked}
	aria-label={(shownLiked ? 'Unlike' : label) + ' (' + shownCount + ')'}
	title={shownLiked ? 'Unlike' : label}
	data-liked={shownLiked ? '1' : '0'}
	data-count={shownCount}
	disabled={busy}
	onclick={press}
>
	<svg viewBox="0 0 24 24" width={size === 'md' ? 18 : 14} height={size === 'md' ? 18 : 14} aria-hidden="true">
		<path
			d="M12 21s-7.5-4.6-9.6-9.1C1 8.6 3 5 6.6 5c2.1 0 3.5 1.2 4.4 2.5h2C13.9 6.2 15.3 5 17.4 5 21 5 23 8.6 21.6 11.9 19.5 16.4 12 21 12 21z"
			fill={shownLiked ? 'currentColor' : 'none'}
			stroke="currentColor"
			stroke-width="2"
			stroke-linejoin="round"
		/>
	</svg>
	<span class="tp-heart-count">{shownCount}</span>
</button>

<style>
	.tp-heart {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 1.6rem;
		padding: 0 0.45rem;
		font: 600 0.7rem/1 system-ui, sans-serif;
		color: var(--text, #e5e7eb);
		background: rgb(var(--surface-rgb, 17 24 39) / 0.75);
		border: 1px solid var(--border, rgb(75 85 99 / 0.7));
		border-radius: 999px;
		cursor: pointer;
		touch-action: manipulation;
	}
	.tp-heart:hover {
		border-color: var(--ink-bad, #f87171);
	}
	.tp-heart-on {
		color: var(--ink-bad, #f87171);
	}
	.tp-heart:disabled {
		cursor: wait;
	}
	.tp-heart-md {
		height: 2.1rem;
		padding: 0 0.7rem;
		font-size: 0.85rem;
		gap: 0.35rem;
	}
	.tp-heart-overlay {
		position: absolute;
		top: 0.35rem;
		left: 0.35rem;
	}
	.tp-heart-count {
		font-variant-numeric: tabular-nums;
		color: var(--text, #e5e7eb);
	}
</style>
