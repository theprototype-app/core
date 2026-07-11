<script lang="ts">
	import {
		SvelteFlow,
		Background,
		BackgroundVariant,
		Controls,
		MiniMap,
		MarkerType,
		useSvelteFlow,
		type Node,
		type Edge,
		type Connection
	} from '@xyflow/svelte';
	// 👇 this is important! You need to import the styles for Svelte Flow to work
	import '@xyflow/svelte/dist/style.css';
	import '../../styles/flow.css';
	import { writable, get } from 'svelte/store';
	import Sidebar from './Sidebar.svelte';
	import PeerCursors from './PeerCursors.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import ColorPickerNode from './nodes/ColorPickerNode.svelte';
	import SliderNode from './nodes/SliderNode.svelte';
	import SwitcherNode from './nodes/SwitcherNode.svelte';
	import ObjectSelectorNode from './nodes/ObjectSelectorNode.svelte';
	import AnimationNode from './nodes/AnimationNode.svelte';
	import ScriptNode from './nodes/ScriptNode.svelte';
	import CustomNode from './nodes/CustomNode.svelte';
	import PathPatrolNode from './nodes/PathPatrolNode.svelte';
	import SoundNode from './nodes/SoundNode.svelte';
	import { flowNodes as nodes, flowEdges as edges, customNodeDefs, nodeDesignerOpen } from '../../stores/flowStore';
	import { serializeNode, serializeEdge, deleteFlowNodes, deleteFlowEdges } from '$lib/nodesHandler';
	import { defDefaults } from '$lib/customNodes';
	import { findNodeSpec, nodeCatalog } from '$lib/nodeCatalog';
	import { moduleNodeGroups, moduleNodeComponents } from '$lib/moduleSDK';
	import { rightDragMove, inputContextMenu } from '$lib/searchMenuUx';
	import { peers, username } from '../../stores/appStore';

	// module node types default to the spec-driven AnimationNode unless the
	// module registered its own component
	const moduleTypes = Object.fromEntries(
		get(moduleNodeGroups)
			.flatMap((group) => group.items)
			.map((item) => [item.type, moduleNodeComponents[item.type] ?? AnimationNode])
	);
	const nodeTypes = {
		colorpicker: ColorPickerNode,
		slider: SliderNode,
		switcher: SwitcherNode,
		objectselector: ObjectSelectorNode,
		shake: AnimationNode,
		spin: AnimationNode,
		bounce: AnimationNode,
		orbit: AnimationNode,
		pulse: AnimationNode,
		blink: AnimationNode,
		script: ScriptNode,
		customnode: CustomNode,
		pathpatrol: PathPatrolNode,
		sound: SoundNode,
		mass: AnimationNode,
		bounciness: AnimationNode,
		friction: AnimationNode,
		...moduleTypes
	};

	const snapGrid: [number, number] = [25, 25];
	const { screenToFlowPosition } = useSvelteFlow();

	// palette collapse + side (82), persisted
	let paletteOpen = typeof localStorage === 'undefined' || localStorage.getItem('flowPaletteOpen') !== 'false';
	let paletteSide = typeof localStorage !== 'undefined' ? localStorage.getItem('flowPaletteSide') ?? 'left' : 'left';

	// shared with <SvelteFlow> so peer cursors can be projected to screen space
	const viewport = writable({ x: 0, y: 0, zoom: 1 });

	// Stores are initialized with null, so their inferred type is unusable here
	let peer: any;
	$: peer = $peers;

	// broadcast the local cursor position in flow coordinates (throttled)
	let lastCursorSent = 0;
	const onPointerMoveCursor = (event: PointerEvent) => {
		if (!peer) return;
		const now = Date.now();
		if (now - lastCursorSent < 50) return;
		lastCursorSent = now;
		const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
		peer.send({
			type: 'flowcursor',
			id: peer.peer.id,
			name: $username || peer.peer.id,
			x: position.x,
			y: position.y
		});
	};
	const onPointerLeaveCursor = () => {
		if (peer) peer.send({ type: 'flowcursor', id: peer.peer.id, leave: true });
	};

	// active context menu: { x, y, items }
	let menu: any = null;

	function addNode(type: string, label: string, position: { x: number; y: number }, extraDefaults: any = null) {
		const spec = findNodeSpec(type);
		const newNode = {
			id: crypto.randomUUID(),
			type,
			position,
			data: {
				label: label,
				type: type,
				...(spec?.defaults ?? {}),
				...(extraDefaults ?? {})
			},
			class: 'w-[150px]'
		} satisfies Node;

		nodes.update((nodes) => [...nodes, newNode]);
		// Replicate the new node to all peers
		peer?.send({ type: 'nodecreate', node: serializeNode(newNode) });
	}

	const onDragOver = (event: DragEvent) => {
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
	};

	const onDrop = (event: DragEvent) => {
		event.preventDefault();
		if (!event.dataTransfer) return;

		const type = event.dataTransfer.getData('application/svelteflow');
		if (!type) return;

		const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
		// custom node defs are dragged as 'customnode:<defId>'
		if (type.startsWith('customnode:')) {
			const def = $customNodeDefs.find((d) => d.id === type.slice('customnode:'.length));
			if (def) addNode('customnode', def.name, position, defDefaults(def));
			return;
		}
		addNode(type, findNodeSpec(type)?.label ?? `${type} node`, position);
	};

	// Replicate node positions when a drag ends
	const onNodeDragStop = (event: CustomEvent<{ nodes: Node[] }>) => {
		event.detail.nodes.forEach((node) => {
			peer?.send({ type: 'nodemove', id: node.id, position: { x: node.position.x, y: node.position.y } });
		});
	};

	// Give new edges a deterministic id and replicate them to all peers
	const onedgecreate = (connection: Connection) => {
		const edge = {
			id: `e-${connection.source}-${connection.target}`,
			source: connection.source,
			target: connection.target,
			sourceHandle: connection.sourceHandle,
			targetHandle: connection.targetHandle,
			// 69: readable edges — same shape on every peer via serializeEdge
			type: 'smoothstep',
			markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }
		} satisfies Edge;
		peer?.send({ type: 'edgecreate', edge: serializeEdge(edge) });
		return edge;
	};

	// Replicate deletions (Backspace / Delete key)
	const ondelete = ({ nodes: deletedNodes, edges: deletedEdges }: { nodes: Node[]; edges: Edge[] }) => {
		if (deletedNodes.length)
			peer?.send({ type: 'nodedelete', ids: deletedNodes.map((n) => n.id) });
		if (deletedEdges.length)
			peer?.send({ type: 'edgedelete', ids: deletedEdges.map((e) => e.id) });
	};

	// --- context menus ---

	function deleteNode(id: string) {
		deleteFlowNodes([id]);
		peer?.send({ type: 'nodedelete', ids: [id] });
	}

	function disconnectNode(id: string) {
		const ids = $edges.filter((e) => e.source === id || e.target === id).map((e) => e.id);
		if (ids.length) {
			deleteFlowEdges(ids);
			peer?.send({ type: 'edgedelete', ids: ids });
		}
	}

	function deleteEdge(id: string) {
		deleteFlowEdges([id]);
		peer?.send({ type: 'edgedelete', ids: [id] });
	}

	const onPaneContextMenu = (event: CustomEvent<{ event: MouseEvent }>) => {
		const e = event.detail.event;
		e.preventDefault();
		const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
		menu = {
			x: e.clientX,
			y: e.clientY,
			flowPos,
			items: [
				{ label: '🔍 Search nodes…', action: () => openSearch('') },
				...[...nodeCatalog, ...$moduleNodeGroups].map((group) => ({
					label: group.group,
					children: group.items.map((item) => ({
						label: item.label,
						action: () => addNode(item.type, item.label, flowPos)
					}))
				})),
				{
					label: 'Custom',
					children: [
						...$customNodeDefs.map((def) => ({
							label: def.name,
							action: () => addNode('customnode', def.name, flowPos, defDefaults(def))
						})),
						{ label: 'New custom node…', action: () => nodeDesignerOpen.set('new') }
					]
				}
			]
		};
	};

	const onNodeContextMenu = (event: CustomEvent<{ event: MouseEvent; node: Node }>) => {
		event.detail.event.preventDefault();
		const id = event.detail.node.id;
		menu = {
			x: event.detail.event.clientX,
			y: event.detail.event.clientY,
			items: [
				{ label: 'Disconnect all', action: () => disconnectNode(id) },
				{ label: 'Delete node', danger: true, action: () => deleteNode(id) }
			]
		};
	};

	const onEdgeContextMenu = (event: CustomEvent<{ event: MouseEvent; edge: Edge }>) => {
		event.detail.event.preventDefault();
		const id = event.detail.edge.id;
		menu = {
			x: event.detail.event.clientX,
			y: event.detail.event.clientY,
			items: [{ label: 'Disconnect', action: () => deleteEdge(id) }]
		};
	};

	// --- node search: a box that REPLACES the pane menu at the same spot/size ---
	let search: any = null; // {x, y, width, flowPos, query, highlight}
	let savedMenu: any = null;

	function openSearch(initial: string) {
		if (!menu?.flowPos) return;
		const menuEl = document.querySelector('[role="menu"]');
		const width = Math.max(menuEl?.getBoundingClientRect().width ?? 0, 240);
		savedMenu = menu;
		// clamp so the box (input + scrollable results, ~330px) stays on screen (91)
		const y = Math.max(8, Math.min(menu.y, window.innerHeight - 330));
		search = { x: menu.x, y, width, flowPos: menu.flowPos, query: initial, highlight: 0 };
		menu = null;
	}

	/** every addable node as a flat searchable entry */
	function searchEntries() {
		const entries: any[] = [];
		for (const group of [...nodeCatalog, ...$moduleNodeGroups])
			for (const item of group.items)
				entries.push({
					group: group.group,
					label: item.label,
					add: (pos: any) => addNode(item.type, item.label, pos)
				});
		for (const def of $customNodeDefs)
			entries.push({
				group: 'Custom',
				label: def.name,
				add: (pos: any) => addNode('customnode', def.name, pos, defDefaults(def))
			});
		return entries;
	}

	function subsequence(text: string, query: string) {
		let i = 0;
		for (const ch of text) if (ch === query[i]) i++;
		return i >= query.length;
	}

	function searchResults(query: string) {
		const entries = searchEntries();
		const q = query.trim().toLowerCase();
		// empty query = browse everything, scrolling (viewport Add search parity, 103)
		if (!q) return entries;
		return entries
			.map((entry) => {
				const text = (entry.label + ' ' + entry.group).toLowerCase();
				const rank = text.startsWith(q) ? 0 : text.includes(q) ? 1 : subsequence(text, q) ? 2 : 3;
				return [rank, entry] as [number, any];
			})
			.filter(([rank]) => rank < 3)
			.sort((a, b) => a[0] - b[0] || a[1].label.localeCompare(b[1].label))
			.map(([, entry]) => entry)
			.slice(0, 30); // the list scrolls now (84)
	}

	$: results = search ? searchResults(search.query) : [];

	function pickResult(entry: any) {
		entry.add(search.flowPos);
		search = null;
		savedMenu = null;
	}

	function scrollHighlightIntoView() {
		requestAnimationFrame(() =>
			document
				.querySelector('#node-search-box [data-selected="true"]')
				?.scrollIntoView({ block: 'nearest' })
		);
	}

	function onSearchKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			search = { ...search, highlight: Math.min(search.highlight + 1, results.length - 1) };
			scrollHighlightIntoView();
			event.preventDefault();
		} else if (event.key === 'ArrowUp') {
			search = { ...search, highlight: Math.max(search.highlight - 1, 0) };
			scrollHighlightIntoView();
			event.preventDefault();
		} else if (event.key === 'Enter') {
			if (results[search.highlight]) pickResult(results[search.highlight]);
			event.preventDefault();
		} else if (event.key === 'Escape') {
			menu = savedMenu; // back to the classic grouped menu
			search = null;
			event.preventDefault();
			event.stopPropagation();
		}
	}

	// typing while the pane menu is open jumps straight into search
	function onWindowKeydown(event: KeyboardEvent) {
		if (!menu?.flowPos || search) return;
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.key.length !== 1) return;
		openSearch(event.key);
		event.preventDefault();
	}

	function focusInput(node: HTMLInputElement) {
		node.focus();
		node.setSelectionRange(node.value.length, node.value.length);
	}
</script>

<svelte:window on:keydown={onWindowKeydown} />

<div class="flex h-full w-full">
	{#if paletteOpen}
		<div class="h-full w-40 shrink-0 overflow-y-auto" style="order: {paletteSide === 'right' ? 3 : 1}">
			<Sidebar />
		</div>
	{/if}
	<!-- palette collapse/side controls: notebook-tab buttons on the divider (82) -->
	<div class="relative z-10 w-0" style="order: 2">
		<button
			id="palette-toggle"
			class="palette-tab absolute top-8 flex h-14 w-4 items-center justify-center bg-gray-700 text-[10px] text-gray-200 hover:bg-gray-600"
			style="{paletteSide === 'right' ? 'right' : 'left'}: -1px"
			title={paletteOpen ? 'Hide the node palette' : 'Show the node palette'}
			on:click={() => {
				paletteOpen = !paletteOpen;
				localStorage.setItem('flowPaletteOpen', String(paletteOpen));
			}}
		>
			{paletteOpen ? (paletteSide === 'right' ? '▸' : '◂') : paletteSide === 'right' ? '◂' : '▸'}
		</button>
		<button
			id="palette-side"
			class="palette-tab absolute top-24 flex h-9 w-4 items-center justify-center bg-gray-700 text-[9px] text-gray-300 hover:bg-gray-600"
			style="{paletteSide === 'right' ? 'right' : 'left'}: -1px"
			title="Move the palette to the other side"
			on:click={() => {
				paletteSide = paletteSide === 'right' ? 'left' : 'right';
				localStorage.setItem('flowPaletteSide', paletteSide);
			}}
		>
			⇄
		</button>
	</div>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="svelteFlow relative h-full grow"
		style="order: {paletteSide === 'right' ? 1 : 3}"
		on:pointermove={onPointerMoveCursor}
		on:pointerleave={onPointerLeaveCursor}
	>
		<SvelteFlow
			{nodes}
			{nodeTypes}
			{edges}
			{snapGrid}
			{viewport}
			{onedgecreate}
			{ondelete}
			deleteKey={['Backspace', 'Delete']}
			fitView
			maxZoom={1}
			minZoom={0.5}
			on:dragover={onDragOver}
			on:drop={onDrop}
			on:nodedragstop={onNodeDragStop}
			on:panecontextmenu={onPaneContextMenu}
			on:nodecontextmenu={onNodeContextMenu}
			on:edgecontextmenu={onEdgeContextMenu}
			on:paneclick={() => (menu = null)}
		>
			<Background bgColor="transparent" variant={BackgroundVariant.Dots} />
			<Controls showLock={false} />
			<MiniMap
				pannable
				zoomable
				width={140}
				height={90}
				nodeColor={() => '#475569'}
				maskColor="rgb(17 24 39 / 0.65)"
			/>
		</SvelteFlow>
		<PeerCursors {viewport} />
	</div>
</div>

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} on:close={() => (menu = null)} />
{/if}

{#if search}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0"
		style="z-index: 999;"
		role="presentation"
		on:click={() => {
			search = null;
			savedMenu = null;
		}}
	></div>
	<div
		id="node-search-box"
		class="fixed rounded-lg border border-gray-200 bg-white py-1 text-xs shadow-lg dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
		style="left: {search.x}px; top: {search.y}px; width: {search.width}px; z-index: 1000;"
		use:rightDragMove={{ onMove: (dx, dy) => (search = { ...search, x: Math.max(0, search.x + dx), y: Math.max(0, search.y + dy) }) }}
	>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			id="node-search-input"
			use:focusInput
			use:inputContextMenu
			class="mx-2 mb-1 w-[calc(100%-16px)] rounded border border-gray-300 bg-transparent px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-500"
			placeholder="Search nodes… (Esc = menu)"
			value={search.query}
			on:input={(e) => (search = { ...search, query: e.currentTarget.value, highlight: 0 })}
			on:keydown={onSearchKeydown}
		/>
		<div class="max-h-64 overflow-y-auto">
			{#each results as entry, index}
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div
					class="cursor-pointer px-3 py-1.5 {index === search.highlight
						? 'bg-primary-600 text-white'
						: 'hover:bg-gray-100 dark:hover:bg-gray-600'}"
					data-selected={index === search.highlight}
					on:mouseenter={() => (search = { ...search, highlight: index })}
					on:click={() => pickResult(entry)}
				>
					<span class={index === search.highlight ? 'text-white/70' : 'text-gray-400'}>{entry.group} · </span>{entry.label}
				</div>
			{/each}
			{#if results.length === 0}
				<div class="px-3 py-1.5 text-gray-400">No matches</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	:global(.svelte-flow) {
		background-color: transparent !important;
	}
	:global(.svelte-flow__attribution) {
		display: none;
	}
</style>
