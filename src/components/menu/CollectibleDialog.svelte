<script>
	// 21-F2: "Make collectible into…" — the variable a pickup counts into, and whether it
	// comes back. ConfirmModal's sibling and its legacy-mode file on purpose: flowbite's
	// Modal binds `open` and has no onopen/onclose, so an outside click / Esc flips the
	// binding and must resolve as CANCEL. Truly modal like ConfirmModal (a blocking
	// question with a focused text field), not one of the non-modal app panels.
	import { Modal, Button } from 'flowbite-svelte';
	import { recipeDialog, resolveRecipeDialog } from '$lib/recipeDialog';

	let open = false;
	/** @type {string} */ let variable = '';
	/** @type {boolean} */ let respawns = false;
	/** @type {number} */ let seconds = 5;
	/** 21-G4: shared (off) or per player (on) */
	/** @type {boolean} */ let perPlayer = false;
	/** the dialog instance these fields were seeded from — reseeding on every store tick
	 * would fight the user's own typing */
	/** @type {any} */ let seeded = null;

	// eslint-disable-next-line no-unused-vars
	$: open = !!$recipeDialog;
	$: if ($recipeDialog && $recipeDialog !== seeded) {
		seeded = $recipeDialog;
		variable = $recipeDialog.variable ?? '';
		respawns = ($recipeDialog.respawn ?? 0) > 0;
		seconds = ($recipeDialog.respawn ?? 0) > 0 ? $recipeDialog.respawn : 5;
		perPlayer = !!$recipeDialog.perPlayer;
	}
	// outside-close (backdrop / Esc) with a dialog still pending = cancel
	$: if (!open && $recipeDialog) resolveRecipeDialog(null);

	function create() {
		const name = String(variable ?? '').trim();
		if (!name) return; // validate on CLICK and say why inline, never a stale disabled
		resolveRecipeDialog({
			variable: name,
			respawn: respawns ? Math.max(0.1, Number(seconds) || 0) : 0,
			perPlayer
		});
	}
</script>

{#if $recipeDialog}
	<Modal bind:open size="xs" autoclose={false} class="w-full">
		<div class="flex flex-col gap-4">
			<div>
				<h3 class="text-lg font-semibold text-gray-900 dark:text-white">Make collectible</h3>
				<p class="mt-1 text-sm text-gray-600 dark:text-gray-300">
					{$recipeDialog.count > 1 ? $recipeDialog.count + ' objects' : 'This object'}
					{perPlayer
						? ' will hide for whoever clicks it, and add 1 to that player’s own count.'
						: ' will hide for everyone when clicked and add 1 to a shared variable.'}
				</p>
			</div>

			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium text-gray-900 dark:text-gray-200">Count into</span>
				<input
					id="collectible-variable"
					class="w-full rounded-lg border border-gray-300 bg-gray-50 p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
					type="text"
					maxlength="40"
					placeholder="gems"
					bind:value={variable}
				/>
			</label>
			{#if $recipeDialog.variables?.length}
				<!-- the names already in play, as CHIPS rather than a datalist: a datalist
				     reads as a filter (the 21-D3 finding) and hides what is on offer until
				     you type the thing you were trying to discover -->
				<div class="-mt-2 flex flex-wrap gap-1.5">
					{#each $recipeDialog.variables as name (name)}
						<button
							type="button"
							data-var-suggestion={name}
							class="rounded-full border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-primary-500 dark:border-gray-600 dark:text-gray-300"
							class:!border-primary-500={variable === name}
							on:click={() => (variable = name)}>{name}</button
						>
					{/each}
				</div>
			{/if}
			{#if !String(variable ?? '').trim()}
				<p class="-mt-2 text-xs text-red-500">A collectible has to count into something — name a variable.</p>
			{/if}

			<!-- 21-G4: WHOSE pickup is it. One sentence, because the difference is not
			     obvious from the words "per player" alone and it changes what every peer
			     sees in the scene. -->
			<div class="flex flex-col gap-1">
				<label class="flex items-center gap-2 text-sm text-gray-900 dark:text-gray-200">
					<input id="collectible-per-player" type="checkbox" bind:checked={perPlayer} />
					<span>Per player</span>
				</label>
				<p class="text-xs text-gray-500 dark:text-gray-400">
					Off: one pickup, the first person to click it takes it for everyone. On: everyone has their
					own — it hides only for whoever collected it, and each player’s count is theirs alone
					(show them all with a HUD List ▸ Show a leaderboard).
				</p>
			</div>

			<div class="flex flex-col gap-1">
				<label class="flex items-center gap-2 text-sm text-gray-900 dark:text-gray-200">
					<input id="collectible-respawn-on" type="checkbox" bind:checked={respawns} />
					<span>Comes back after</span>
					<input
						id="collectible-respawn"
						class="w-16 rounded-lg border border-gray-300 bg-gray-50 p-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
						type="number"
						min="0.1"
						step="0.5"
						disabled={!respawns}
						bind:value={seconds}
					/>
					<span>s</span>
				</label>
				<p class="text-xs text-gray-500 dark:text-gray-400">
					Built as a Delay wired back to the Latch and the Once, so it is visible and editable in the
					node editor like the rest of the recipe.
				</p>
			</div>

			<div class="flex justify-end gap-3">
				<Button id="collectible-cancel" color="alternative" onclick={() => resolveRecipeDialog(null)}>Cancel</Button>
				<Button id="collectible-create" color="primary" onclick={create}>Create</Button>
			</div>
		</div>
	</Modal>
{/if}
