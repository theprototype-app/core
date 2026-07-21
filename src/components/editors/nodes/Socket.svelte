<script lang="ts">
	// B4.2: a typed socket — wraps @xyflow/svelte's Handle and paints it with the
	// SOCKET TYPE's color (flowSockets.typeColor) instead of the node's group
	// accent, so you can see what connects where. Unmigrated handles keep the
	// --node-accent fallback (flow.css). Legacy-mode like every sibling node file.
	import { Handle, Position } from '@xyflow/svelte';
	import { outputType, inputType, typeColor } from '$lib/flowSockets';

	export let kind: 'source' | 'target' = 'source';
	export let nodeType: string; // the NODE type (slider, math, ...)
	export let id: string | undefined = undefined; // handle id (target inputs)
	export let position: any = undefined; // defaults by kind
	export let top: number | undefined = undefined; // px offset for stacked targets
	export let style: string = '';
	// H5: interface sockets carry a DATA-declared type (flowinput.vtype), not a
	// table lookup — an explicit type wins when provided
	export let forceType: string | undefined = undefined;

	const RIGHT = Position.Right;
	const LEFT = Position.Left;
	$: socketType = forceType ?? (kind === 'source' ? outputType(nodeType) : inputType(nodeType, id ?? 'a'));
	$: pos = position ?? (kind === 'source' ? RIGHT : LEFT);
	$: css = `--socket-color: ${typeColor(socketType)};${top !== undefined ? ` top: ${top}px;` : ''}${style}`;
</script>

<Handle type={kind} position={pos} {id} class="socket-typed" style={css} />
