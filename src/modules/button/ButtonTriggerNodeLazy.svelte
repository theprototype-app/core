<script>
	// 94 SP1: the node-editor card loads with the node editor, never with a play boot — the card
	// imports @xyflow/svelte, which a player never needs. Same props, passed through.
	let props = $props();
	const card = import('./ButtonTriggerNode.svelte');
</script>

{#await card then m}<m.default {...props} />{/await}
