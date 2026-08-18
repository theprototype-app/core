<script>
	// 21-D7 — the Actions section: a VIEW on the flow graph, in the element properties pane.
	//
	// Modelled on the Inspector's shader-driven notice (`Inspector.svelte`): a sentence that
	// changes with the count, an action row, and an EXPLANATION where a button cannot work
	// rather than a dead control.
	//
	// The two roles read differently on purpose, because "assign an action" means different
	// things for a button and for a readout:
	//   * a button  — "On press → Set game state → playing"
	//   * a readout — "Driven by → Variable “score”"
	import { Plus, Trash2, ExternalLink } from '@lucide/svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import { flowGraphs } from '../../stores/flowStore';
	import { focusFlowNode, showToast } from '../../stores/appStore.js';
	import { bindingsFor, addBinding, removeBinding, actionGroupsForKind } from '$lib/hudActions';
	import { isInteractiveKind } from '$lib/hudKinds';

	/** @type {{ element: any }} */
	let { element } = $props();

	// $flowGraphs is the DEPENDENCY: bindingsFor reads the store through get(), so without
	// this the list would never refresh after an add (the plain-read family).
	const readBindings = (/** @type {string} */ id, /** @type {any} */ _graphs) => bindingsFor(id);
	const bindings = $derived(element?.id ? readBindings(element.id, $flowGraphs) : []);
	const interactive = $derived(isInteractiveKind(element?.kind ?? ''));
	const groups = $derived(actionGroupsForKind(element?.kind ?? ''));

	let menu = $state(/** @type {{x: number, y: number, items: any[]}|null} */ (null));

	/** @param {MouseEvent} e */
	function openAdd(e) {
		const r = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
		if (!groups.length) {
			showToast('This element kind has no actions of its own — wire it in the node editor.');
			return;
		}
		menu = {
			x: Math.round(r.left),
			y: Math.round(r.bottom + 4),
			items: [
				{ header: { title: (element?.label || element?.id) ?? 'element' } },
				{ label: 'Search actions…', revealFilter: true },
				...groups.map((group) => ({
					label: group.group,
					children: group.items.map((action) => ({
						label: action.label,
						tooltip: action.hint,
						action: () => apply(action.key)
					}))
				}))
			]
		};
	}

	/** @param {string} key */
	function apply(key) {
		const result = addBinding(element.id, key);
		if (!result.ok) showToast(result.reason === 'already bound' ? 'That is already wired up.' : 'Could not add that action.');
	}

	/** @param {any} binding */
	function drop(binding) {
		if (!removeBinding(binding)) showToast('Nothing to remove.');
	}
</script>

<p class="hud-sec-head">Actions</p>
{#if bindings.length}
	<div class="ha-list">
		{#each bindings as binding, i (binding.hudNodeId + ':' + (binding.actionNodeId ?? i))}
			<div class="ha-row">
				<span class="ha-role">{binding.role === 'press' ? 'On press' : 'Driven by'}</span>
				<span class="ha-label" title={binding.label}>
					{binding.role === 'drives' && binding.source ? binding.source : binding.label}
				</span>
				<button
					class="ha-btn"
					title="Show this node in the node editor"
					aria-label="Show in the node editor"
					onclick={() => focusFlowNode(binding.actionNodeId ?? binding.hudNodeId)}
				>
					<ExternalLink size={11} aria-hidden="true" />
				</button>
				<button class="ha-btn ha-danger" title="Unbind" aria-label="Unbind" onclick={() => drop(binding)}>
					<Trash2 size={11} aria-hidden="true" />
				</button>
			</div>
		{/each}
	</div>
{:else}
	<p class="hud-note">
		{#if interactive}
			Nothing happens when this is pressed yet.
		{:else}
			Nothing drives this element yet — it shows its own text.
		{/if}
	</p>
{/if}

{#if groups.length}
	<button id="hud-add-action" class="ha-add" onclick={openAdd}>
		<Plus size={12} aria-hidden="true" /> Add action
	</button>
{:else}
	<!-- an explanation, not a dead button: this kind has nothing to offer, and saying which
	     way out exists beats a control that cannot work (the shader-notice rule) -->
	<p class="hud-note">This kind has no actions of its own. Wire it in the node editor.</p>
{/if}

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} sizeKey="hud-actions" onclose={() => (menu = null)} />
{/if}

<style>
	.ha-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.ha-row {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		border-radius: 0.2rem;
		background: rgb(17 24 39 / 0.5);
		padding: 0.15rem 0.3rem;
	}
	.ha-role {
		flex-shrink: 0;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		opacity: 0.55;
	}
	.ha-label {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
	}
	.ha-btn {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		opacity: 0.6;
	}
	.ha-btn:hover {
		opacity: 1;
	}
	.ha-danger {
		color: #f87171;
	}
	.ha-add {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		border-radius: 0.25rem;
		border: 1px dashed rgb(107 114 128 / 0.7);
		padding: 0.2rem;
		font-size: 11px;
		opacity: 0.85;
	}
	.ha-add:hover {
		border-color: var(--accent, #ef562f);
		opacity: 1;
	}
</style>
