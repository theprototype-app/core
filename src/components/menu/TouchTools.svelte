<script>
	// #20 P4: the touch-tools cluster — round Undo / Redo / Multi-select buttons beside
	// the logo, matching its 48px chrome and dropping below the Connect bar with it.
	//
	// Why these three and not more: touch has no keyboard and no right-click, so Ctrl+Z
	// and Shift-click are the two reflexes a phone user simply cannot perform. Everything
	// else already has a touch path (the long-press viewport menu, the + button).
	//
	// MULTI-SELECT is one toggle covering both gestures a modifier would have covered —
	// a tap ADDS instead of replacing, and a drag on empty space draws the marquee — so
	// there is one thing to learn and one mode to see. Scene.svelte reads
	// `multiSelectMode` in the same two places it reads `event.shiftKey`, which is what
	// keeps this from being a second selection implementation.
	import { Undo2, Redo2, BoxSelect } from '@lucide/svelte';
	import { touchTools, multiSelectMode, connectDocked, connectBarHeight } from '../../stores/appStore';
	import { undo, redo, canUndo, canRedo } from '$lib/history';

	// ---- row or column: MEASURED, not a breakpoint -----------------------------
	// A width breakpoint got this wrong on a real device — an unfolded Oppo N8 has plenty
	// of room beside the logo and still stacked. So the question is asked directly: does a
	// row of three buttons fit between the logo and whatever is next along that row?
	// Connect's own `measureDock()` decides its docking the same way, for the same reason.
	const BTN = 48;
	const GAP = 6;
	/** where the row starts — the same 78px the CSS uses. Measuring from the LOGO's right
	 *  edge instead was optimistic by 22px and let the row claim space it never occupies. */
	const ROW_LEFT = 78;
	/** breathing room, not just collision avoidance. At 420px the row cleared the notes
	 *  button by 14px — technically fitting, visually touching it, which is what the user
	 *  reported. 24px is the gap at which the two read as separate clusters. */
	const GUTTER = 24;
	/** the row's own width, from CONSTANTS — never from the element's own rect, or the
	 *  measurement would feed the layout that produced it (the frozen-span rule) */
	const ROW_RIGHT = ROW_LEFT + BTN * 3 + GAP * 2 + GUTTER;

	let stacked = $state(false);

	/** Everything that can sit on the logo's row and must not be run into: the centred
	 *  Connect pill, and the notes / peers / profile cluster the user pointed out is just
	 *  as much of a wall as the pill.
	 *
	 *  The concrete BUTTONS, not their `.top-right-chrome` wrapper — measured, that wrapper
	 *  has HEIGHT 0 (its children are positioned inside it), so a vertical-overlap test
	 *  skipped it every time and the cluster was invisible to this measurement. */
	const NEIGHBOURS = ['.connect-pill', '#notes-toggle', '#peers-trigger', '#avatar-trigger'];

	function measure() {
		if (typeof document === 'undefined') return;
		const logo = document.querySelector('#logo-menu')?.getBoundingClientRect();
		if (!logo) {
			stacked = false;
			return;
		}
		// the row would occupy logo.right .. logo.right + ROW_W at the logo's own top
		const top = logo.top;
		const bottom = logo.bottom;
		let limit = window.innerWidth;
		for (const selector of NEIGHBOURS) {
			const rect = document.querySelector(selector)?.getBoundingClientRect();
			if (!rect || !rect.width || !rect.height) continue;
			// only things that VERTICALLY overlap the row can block it — a docked Connect
			// bar sits entirely above the logo and leaves the width below it free
			if (rect.bottom <= top || rect.top >= bottom) continue;
			if (rect.left > logo.right) limit = Math.min(limit, rect.left);
		}
		stacked = ROW_RIGHT > limit;
	}

	// re-measure on the things that can change the answer: the window, and Connect
	// docking or changing height (both move the logo and the pill)
	$effect(() => {
		void $connectDocked;
		void $connectBarHeight;
		void $touchTools;
		measure();
		// one more after layout settles — the pill is centred with a transform and its
		// rect is not final on the same frame the bar's height changes
		const t = setTimeout(measure, 120);
		return () => clearTimeout(t);
	});
</script>

<svelte:window onresize={measure} />

{#if $touchTools}
	<!-- The logo's own top is published as a CUSTOM PROPERTY rather than written straight
	     to `top`, because the stacked layout needs to place itself BELOW that anchor. The
	     first version set `top` directly, which overrode the stacked position and put the
	     cluster back on top of the logo whenever Connect docked — both landed at the same
	     top and the same inset. -->
	<div
		id="touch-tools"
		class="touch-tools"
		class:tt-stacked={stacked}
		style="--tt-anchor: {$connectDocked ? $connectBarHeight + 8 : 20}px"
		aria-label="Touch tools"
	>
		<button
			id="touch-undo"
			class="tt-btn"
			disabled={!$canUndo}
			title="Undo"
			aria-label="Undo"
			onclick={() => undo()}
		>
			<Undo2 size={20} aria-hidden="true" />
		</button>
		<button
			id="touch-redo"
			class="tt-btn"
			disabled={!$canRedo}
			title="Redo"
			aria-label="Redo"
			onclick={() => redo()}
		>
			<Redo2 size={20} aria-hidden="true" />
		</button>
		<button
			id="touch-multiselect"
			class="tt-btn"
			class:tt-on={$multiSelectMode}
			aria-pressed={$multiSelectMode}
			title={$multiSelectMode
				? 'Multi-select on — a tap adds to the selection, a drag on empty space boxes'
				: 'Multi-select — tap to add objects, drag empty space to box-select'}
			aria-label="Multi-select"
			onclick={() => multiSelectMode.update((v) => !v)}
		>
			<BoxSelect size={20} aria-hidden="true" />
		</button>
	</div>
{/if}

<style>
	/* Beside the logo when there is room: same top, one 48px button's width clear of it.
	   Fixed, never absolute — an absolute element off an edge grows the document and drags
	   the centred Connect pill sideways. */
	.touch-tools {
		position: fixed;
		top: var(--tt-anchor, 20px);
		left: 78px;
		z-index: var(--z-hud);
		display: flex;
		flex-direction: row;
		gap: 6px;
	}
	/* No room for a row beside the logo: stack VERTICALLY BELOW it instead of over it.
	   Driven by the MEASUREMENT above, not a breakpoint — a width guess stacked on an
	   unfolded phone that had plenty of room. 56px = the logo's 48px plus its 8px gutter.

	   The left inset aligns these buttons' CENTRES with the bottom-left HUD cluster, which
	   is 44px wide at a 16px inset while these are 48px: 16 + (44 - 48) / 2 = 14px. Using
	   the same 20px the logo uses left them looking 6px out. */
	.touch-tools.tt-stacked {
		top: calc(var(--tt-anchor, 20px) + 56px);
		left: calc(16px + (44px - 48px) / 2);
		flex-direction: column;
	}
	.tt-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 48px;
		width: 48px;
		border-radius: 9999px;
		border: 1px solid rgb(55 65 81 / 0.6);
		background: var(--surface, rgb(31 41 55 / 0.9));
		color: rgb(229 231 235);
		box-shadow:
			0 10px 15px -3px rgb(0 0 0 / 0.1),
			0 4px 6px -4px rgb(0 0 0 / 0.1);
		backdrop-filter: blur(4px);
		transition: transform 0.12s ease;
	}
	.tt-btn:hover:not(:disabled) {
		transform: scale(1.05);
	}
	.tt-btn:disabled {
		opacity: 0.4;
	}
	/* the armed toggle owns its fill from the shell, never from a Tailwind utility —
	   a scoped style beats every utility, which is how the mesh toolbox lost its
	   armed colour in the dark theme */
	.tt-on {
		background: var(--accent, #2563eb);
		border-color: var(--accent, #2563eb);
		color: #fff;
	}

	/* No width media query on purpose: the stack is decided by MEASUREMENT (see the script).
	   A 560px breakpoint stacked on an unfolded Oppo N8 that had room to spare, which is
	   the whole reason the decision moved out of CSS. */
</style>
