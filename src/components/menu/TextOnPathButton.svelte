<script>
	// 64 D2: "Put text on this path" — a new text object linked to this spline / flow path /
	// shape (textPathEdit.putTextOnPath: one undo step, replicated as a create + its record).
	import UiButton from '../ui/Button.svelte';
	import { putTextOnPath } from '$lib/textPathEdit.js';

	/** @type {{object: any}} */
	let { object } = $props();
</script>

<UiButton
	id="text-on-path"
	size="sm"
	variant="outline"
	title="Add a text object that follows this path (and moves with it)"
	onclick={() => putTextOnPath(object.uuid)}
>
	Put text on this path
</UiButton>
