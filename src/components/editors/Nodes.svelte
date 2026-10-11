<script lang="ts">
	import { untrack, tick, onMount } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import {
		SvelteFlow,
		Background,
		BackgroundVariant,
		Controls,
		ControlButton,
		MiniMap,
		MarkerType,
		SelectionMode,
		useSvelteFlow,
		type Node,
		type Edge,
		type Connection
	} from '@xyflow/svelte';
	// 👇 this is important! You need to import the styles for Svelte Flow to work
	import '@xyflow/svelte/dist/style.css';
	import '../../styles/flow.css';
	import { get } from 'svelte/store';
	import Sidebar from './Sidebar.svelte';
	import GraphTree from './GraphTree.svelte';
	import NodeProperties from './NodeProperties.svelte'; // 36 (flow-revamp 200)
	// 36 (G1): Main graph label + code <-> node (double-click / Open code)
	import { MAIN_GRAPH_LABEL, nodeHasCode, openCodeRequestFor } from '$lib/graphContract.js';
	import { openCode as openCodeRequest } from '$lib/codeOpen';
	import PeerCursors from './PeerCursors.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import ColorPickerNode from './nodes/ColorPickerNode.svelte';
	import SliderNode from './nodes/SliderNode.svelte';
	import SwitcherNode from './nodes/SwitcherNode.svelte';
	import ObjectSelectorNode from './nodes/ObjectSelectorNode.svelte';
	import AnimationNode from './nodes/AnimationNode.svelte';
	import HudNode from './nodes/HudNode.svelte';
	import GameCameraNode from './nodes/GameCameraNode.svelte';
	import TravelNode from './nodes/TravelNode.svelte';
	import SequenceNode from './nodes/SequenceNode.svelte';
	import MoveInputNode from './nodes/MoveInputNode.svelte';
	import ScriptNode from './nodes/ScriptNode.svelte';
	import BehaviourNode from './nodes/BehaviourNode.svelte';
	import CodeRefNode from './nodes/CodeRefNode.svelte'; // 36 (G1)
	import MapRangeNode from './nodes/MapRangeNode.svelte';
	import SelectNode from './nodes/SelectNode.svelte';
	import CustomNode from './nodes/CustomNode.svelte';
	import PathPatrolNode from './nodes/PathPatrolNode.svelte';
	import SoundNode from './nodes/SoundNode.svelte';
	import ParticleNode from './nodes/ParticleNode.svelte';
	import NumberNode from './nodes/NumberNode.svelte';
	import Vector3Node from './nodes/Vector3Node.svelte';
	import ToggleNode from './nodes/ToggleNode.svelte';
	import RandomNode from './nodes/RandomNode.svelte';
	import TimeNode from './nodes/TimeNode.svelte';
	import BinaryNode from './nodes/BinaryNode.svelte';
	import LoopNode from './nodes/LoopNode.svelte';
	import TimerNode from './nodes/TimerNode.svelte';
	import ObjectPairNode from './nodes/ObjectPairNode.svelte';
	import EffectNode from './nodes/EffectNode.svelte';
	import OnClickNode from './nodes/OnClickNode.svelte';
	import ColliderNode from './nodes/ColliderNode.svelte';
	import VelocityNode from './nodes/VelocityNode.svelte';
	import CounterNode from './nodes/CounterNode.svelte';
	import FlowIONode from './nodes/FlowIONode.svelte';
	import ObjectFlowNode from './nodes/ObjectFlowNode.svelte';
	import KeyPressNode from './nodes/KeyPressNode.svelte';
	import GamepadNode from './nodes/GamepadNode.svelte';
	import PlayAnimNode from './nodes/PlayAnimNode.svelte';
	import AnimStateNode from './nodes/AnimStateNode.svelte';
	import OnHitNode from './nodes/OnHitNode.svelte';
	import OnClapNode from './nodes/OnClapNode.svelte'; // 31 (Stars Room S3)
	import ContactNode from './nodes/ContactNode.svelte'; // 36 X6
	import UnknownNode from './nodes/UnknownNode.svelte';
	// 36 U11 / N1: the editor-only kinds (a group, a note) and the boundary cards inside a group
	import GroupNode from './nodes/GroupNode.svelte';
	import NoteNode from './nodes/NoteNode.svelte';
	import GroupIONode from './nodes/GroupIONode.svelte';
	import NodeUxProps from './NodeUxProps.svelte';
	import { kitNodeTypes } from '$lib/kit/catalog.js';
	import { flowNodes as flowNodesStore, flowEdges as flowEdgesStore, customNodeDefs, nodeDesignerOpen, flowGraphs, activeGraphId, SCENE_GRAPH, setActiveGraph, updateGraph } from '../../stores/flowStore';
	import { createObjectGraph, requestDeleteObjectGraph, recordFlowNodesEntry } from '$lib/flowGraphs';
	import { deselectObject, applySelectionSet } from '$lib/objectActions';
	import { flowMouseBindings } from '$lib/flowPrefs';
	import Breadcrumbs from '../ui/Breadcrumbs.svelte'; // 41 G15
	import { readPanelOpen, writePanelOpen } from '$lib/ui/handheldPanels.js'; // 41 G18
	import { objectsGroup, selectedObject, selectedObjects } from '../../stores/sceneStore';
	import { serializeNode, serializeEdge, deleteFlowNodes, deleteFlowEdges, setNodeData } from '$lib/nodesHandler';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import { defDefaults } from '$lib/customNodes';
	import { findNodeSpec, nodeCatalog } from '$lib/nodeCatalog';
	import { nodeDoc } from '$lib/nodeDocs';
	import { isValidFlowConnection, typeColor, replaceableInputEdges, groupSocketType } from '$lib/flowSockets';
	import { variadicSocketExists, switcherItems, MAX_SWITCHER_ITEMS, SWITCHER_TYPES, switcherVType } from '$lib/variadicNodes.js'; // 37 (R6)
	import { removeVariadicSocket, setSwitcherType, addSwitcherItem } from '$lib/variadicEdit.js'; // 37 (R6)
	import KitButton from '../ui/Button.svelte'; // 37: the Switcher ⓘ rows on the redesign kit
	import { moduleNodeGroups, moduleNodeComponents } from '$lib/moduleSDK';
	import { peers, username, modulesOpen, flowFocus, showToast } from '../../stores/appStore';
	import { safeStorage } from '$lib/safeStorage';
	// 36 U11: groups/notes as graph data, the scoped keymap's node actions, undo for editor edits
	import {
		GROUP_TYPE,
		NOTE_TYPE,
		GROUP_IN,
		GROUP_OUT,
		isGroup,
		isNote,
		isPseudo,
		parentMap,
		pathTo,
		graphView,
		computeGroupIO,
		sameIO,
		makeGroup,
		copyPayload,
		instantiatePayload,
		arrange,
		frameRect,
		boundsOf,
		parseIoHandle,
		ioKey,
		withDescendants,
		descendantsOf
	} from '$lib/nodeGroups';
	import { installNodeActions } from '$lib/nodeEditorActions';
	import { onScopeChange, lastScope, setLastScope } from '$lib/keyScope';
	import { bindingOf } from '$lib/shortcuts';
	import { beginHistoryBatch, endHistoryBatch } from '$lib/history';
	import { nodeHasCode as nodeUxHasCode, openNodeCode } from '$lib/nodeCode';
	// 36 B7: the node manager (types switched off on this device) + the .tpnode group file
	import { disabledNodeTypes, enabledCatalog } from '$lib/nodeTypePrefs';
	import { buildTpnode, parseTpnode, tpnodeFileName } from '$lib/tpnode';
	import { APP_VERSION } from '$lib/version';
	import { nodeEditorOpens, openingView, rememberView, flowViewEpoch, viewportOf, viewOf } from '$lib/flowView';
	import { layeredLayout, repairLayout, lintGraph, lintSummary } from '$lib/graphLayout';

	// 21-D7: DEEP LINK — 'show me the node that drives this HUD element'. A write-once
	// request that we act on and CLEAR, the inspectorScrollTo shape, so it cannot re-fire
	// on an unrelated render. fitView over one node centres it without changing the zoom
	// the user chose.
	// runes mode: $effect, never $: . untrack, because focusRequested writes flowFocus and
	// reads flowNodes - an effect that tracked its own write would loop.
	$effect(() => {
		const id = $flowFocus;
		if (id) untrack(() => focusRequested(id));
	});
	function focusRequested(id: string) {
		// CLEAR FIRST: a write-once request, so it cannot re-fire on the next unrelated
		// render (inspectorScrollTo's rule).
		flowFocus.set(null);
		if (!($flowNodesStore as any[]).some((n) => n.id === id)) return;
		// 36-fb-code (F7): the code workspace's "Bound nodes" means "show me THIS node" — so a
		// node inside a collapsed group is shown by entering its group first (members are hidden
		// outside it), and it is SELECTED through selectOnly (leaveGroup's own path), not centred
		// alone. Then fitView, as before.
		const parent = parentMap(storeNodesNow()).get(id) ?? null;
		if (parent !== level) level = parent;
		tick().then(() => {
			selectOnly([id]);
			setTimeout(() => {
				try {
					fitView({ nodes: [{ id }], duration: 200, maxZoom: 1.2 });
				} catch {
					/* the pane is not up yet */
				}
			}, 60);
		});
	}

	// A6.4: ONE rewrite fixes three bugs that lived in this map.
	//
	// (1) It was `get(moduleNodeGroups)` — a NON-REACTIVE init-time read, so a module
	//     installed after the Flow dock mounted rendered as xyflow's bare default
	//     card. That broke the GOOD case, and it is exactly what a game template
	//     does: install the module, then load the scene.
	// (2) Module types were spread LAST, so a module could silently SHADOW a core
	//     node type. Core wins now, and a collision warns instead of vanishing.
	// (3) A type nothing defines got xyflow's default card with no explanation.
	//     UnknownNode says what is missing and offers to install it.
	const CORE_NODE_TYPES: any = {
		colorpicker: ColorPickerNode,
		slider: SliderNode,
		switcher: SwitcherNode,
		objectselector: ObjectSelectorNode,
		shake: AnimationNode,
		spin: AnimationNode,
		rotor: AnimationNode, // 36-fb F25
		flowfloat: AnimationNode, // 36-fb F24
		followpath: AnimationNode, // 40 F15
		wander: AnimationNode,
		orientvelocity: AnimationNode,
		bodywave: AnimationNode,
		bounce: AnimationNode,
		orbit: AnimationNode,
		pulse: AnimationNode,
		blink: AnimationNode,
		script: ScriptNode,
		behaviour: BehaviourNode, // 34 R3
		coderef: CodeRefNode, // 36 (G1): a Main-graph link to module/kit code
		maprange: MapRangeNode,
		select: SelectNode,
		customnode: CustomNode,
		pathpatrol: PathPatrolNode,
		sound: SoundNode,
		particle: ParticleNode,
		jiggle: AnimationNode, // 36-sim U2b
		mass: AnimationNode,
		bounciness: AnimationNode,
		friction: AnimationNode,
		angularvelocity: AnimationNode,
		motor: AnimationNode,
		// 23-B3 music: the spec-driven card, like the physics family above. A type in
		// nodeCatalog but NOT here falls through to UnknownNode — "this node comes from a
		// module that isn't installed" — which is what these four did from the palette.
		deviceparam: AnimationNode,
		devicelevel: AnimationNode,
		transportbeat: AnimationNode,
		notetrigger: AnimationNode,
		number: NumberNode,
		vector3: Vector3Node,
		toggle: ToggleNode,
		random: RandomNode,
		time: TimeNode,
		math: BinaryNode,
		compare: BinaryNode,
		gate: BinaryNode,
		loop: LoopNode,
		timer: TimerNode,
		distance: ObjectPairNode,
		proximity: ObjectPairNode,
		lookat: EffectNode,
		setcolor: EffectNode,
		visibility: EffectNode,
		setuniform: EffectNode,
		onclick: OnClickNode,
		ongrab: OnClickNode, // 30b (core-games): the same pulse card
		onimpact: ContactNode, // 36 X6: filter input + other output
		// 24-A A2: its own card — the pulse dot PLUS speed/byMe value rows (the MoveInput
		// shape: several source handles need labelled rows, not one right-edge dot)
		onhit: OnHitNode,
		onenter: ContactNode, // CL-C sensor edges; 36 X6: the contact card
		onexit: ContactNode,
		collider: ColliderNode, // CL-C
		velocity: VelocityNode, // CL-C
		measure: AnimationNode, // B6
		onrest: AnimationNode, // B6 (the onimpact precedent: a trigger with params)
		impulse: AnimationNode, // B6
		setvelocity: AnimationNode, // B6
		joint: AnimationNode, // B6
		// B7: spec-driven (named input rows, four ranges, and the catalog `note`). A new
		// node type has TWO registries and only one of them complains — a `spawn` in the
		// catalog and not here renders as UnknownNode ("install the module that ships it").
		spawn: AnimationNode,
		counter: CounterNode,
		flowinput: FlowIONode,
		flowoutput: FlowIONode,
		objectflow: ObjectFlowNode,
		keypress: KeyPressNode,
		// 21-E5: ONE card for the pad group (the HudNode precedent)
		gamepadbutton: GamepadNode,
		gamepadaxis: GamepadNode,
		playanim: PlayAnimNode, // 17-E A5
		animfinished: OnClickNode, // 17-E: a pulse when a clip ends
		animmarker: OnClickNode, // 17-E F5: a pulse at a named point in a clip
		animstate: AnimStateNode, // 17-E F3: the readable half of it
		// A3: ONE generic card for the whole HUD group (the ShaderNode precedent)
		hudscreen: HudNode,
		hudtext: HudNode,
		hudbar: HudNode,
		hudbutton: HudNode,
		hudtimer: HudNode,
		hudlist: HudNode,
		hudinput: HudNode,
		// 21-G1 fix, PRE-EXISTING since 21-E7 (ea46a7d): `hudrows` reached `nodeCatalog`
		// and never this map, so a node dragged out of the CORE HUD palette rendered as
		// UnknownNode — "this node comes from a module that isn't installed". Exactly the
		// two-registry gotcha, and `flow-unknown-node` was red on release/next for it.
		hudrows: HudNode,
		hudset: HudNode,
		// 21-G4: the derived scoreboard names an element like every other HUD node
		leaderboard: HudNode,
		// 21-D6: the game shell. AnimationNode renders them from their catalog params;
		// setcamera/gamestart/setlook get their own card for the camera picker.
		setgamestate: AnimationNode,
		ongamestate: AnimationNode,
		setvariable: AnimationNode,
		getvariable: AnimationNode,
		// 30 P4: the device-local pair (the second registry — the catalog is the first)
		storevalue: AnimationNode,
		storedvalue: AnimationNode,
		// 30b (core-games): Game Feel — spec-driven like the rest of the game shell
		announce: AnimationNode,
		gamesound: AnimationNode,
		effectburst: AnimationNode,
		hapticpulse: AnimationNode,
		gamemusic: AnimationNode,
		// 31 (Stars Room): a player's setting row, the pointing switch (both spec-driven) and
		// the clap, whose `point`/`byMe` outputs need labelled rows (the On Hit card's shape)
		gamesetting: AnimationNode,
		pointgrab: AnimationNode,
		onclap: OnClapNode,
		gametime: AnimationNode,
		// 21-F3's `collectcount` card MOVED to the collectible module (R3a) — an old
		// scene's node renders as UnknownNode until the module is installed, honestly
		// 21-G4: the per-player read, same shape
		peervariable: AnimationNode,
		setcamera: GameCameraNode,
		gamestart: GameCameraNode,
		setlook: GameCameraNode,
		// 21-F4: travel gets its own card for the level picker; allplayers is spec-driven
		travel: TravelNode,
		allplayers: AnimationNode,
		// 21-E4: the logic a game loop is made of. All spec-driven except Sequence,
		// which is the only one with several OUTPUTS and so needs its own four rows.
		latch: AnimationNode,
		delay: AnimationNode,
		once: AnimationNode,
		sequence: SequenceNode,
		// 21-E6: the character controller. All spec-driven except Move Input, which is
		// the only one with several OUTPUTS and so needs its own labelled rows.
		charcontroller: AnimationNode,
		possessnode: AnimationNode,
		camerafollow: AnimationNode,
		camerarig: AnimationNode, // 37 (R8)
		movespeed: AnimationNode,
		moveinput: MoveInputNode,
		// 34 R2 (T3): every generated kit node renders from its spec params (the card a node
		// in nodeCatalog but NOT here would get is UnknownNode)
		...Object.fromEntries(kitNodeTypes().map((type) => [type, AnimationNode])),
		// 36 U11 / N1: editor-only kinds (never evaluated) + the boundary cards inside a group
		[GROUP_TYPE]: GroupNode,
		[NOTE_TYPE]: NoteNode,
		groupio: GroupIONode
	};

	// module node types default to the spec-driven AnimationNode unless the
	// module registered its own component
	const moduleTypes = $derived(
		Object.fromEntries(
			$moduleNodeGroups
				.flatMap((group) => group.items)
				.map((item) => [item.type, moduleNodeComponents[item.type] ?? AnimationNode])
		)
	);
	// a module type that collides with a core one loses — and says so, because the
	// old silent shadowing left the core node unreachable with no clue why
	$effect(() => {
		const clash = Object.keys(moduleTypes).filter((type) => type in CORE_NODE_TYPES);
		if (clash.length)
			console.log('module node type(s) shadow core types and were ignored:', clash.join(', '));
	});

	// every type present in ANY graph document that nothing can render
	const unknownTypes = $derived(
		[...new Set($flowGraphs ? Object.values($flowGraphs).flatMap((g: any) => (g.nodes ?? []).map((n: any) => n.type)) : [])]
			.filter((type): type is string => !!type && !(type in CORE_NODE_TYPES) && !(type in moduleTypes))
	);
	const nodeTypes: any = $derived({
		...moduleTypes,
		...CORE_NODE_TYPES,
		...Object.fromEntries(unknownTypes.map((type) => [type, UnknownNode]))
	});
	// how many nodes of the VISIBLE graph are unrenderable (the topbar badge)
	const unknownHere = $derived(
		($flowNodesStore as any[]).filter((node) => unknownTypes.includes(node.type)).length
	);
	// what the map resolved to at MOUNT — kept only so a suite can compute the
	// counterfactual of the reactivity fix (see the debug hook below). Capturing the
	// initial value is the WHOLE POINT here, so the warning is silenced deliberately.
	// svelte-ignore state_referenced_locally
	const mountedTypes: string[] = Object.keys(nodeTypes);

	const { screenToFlowPosition, fitView, setViewport, getInternalNode } = useSvelteFlow();

	// e2e hook (debugStores opt-in), the Outline/CameraPreview pattern: the pane's
	// viewport belongs to xyflow, not to any store, and `fitView` runs at MOUNT — so a
	// suite that seeds nodes afterwards has no way to know, or choose, where they
	// landed on screen. Measured while building node-drag-fields: the mount fit left a
	// card at x = -29.5 (off the pane) at zoom 0.5, and a real pane drag panned by
	// 3775px for a 200px gesture. A test that needs to press a field needs this.
	$effect(() => {
		if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
		if (safeStorage.getItem('debugStores') !== 'true') return;
		// TS syntax, not a JSDoc cast: this file is lang="ts", where JSDoc @type is IGNORED
		(window as any).__flowViewport = { setViewport, fitView };
		// 36 F11/S4: the measured geometry the lint and the Tidy command work on
		(window as any).__flowTidy = { model: () => graphModel(), lint: () => lintHere(), tidy: (mode?: 'layout' | 'repair') => tidyGraph(mode) };
		// A6.4: which types this MOUNTED pane can actually render, plus the snapshot it
		// resolved at mount. A suite proves the reactivity fix by comparing the two:
		// with the old non-reactive `get(moduleNodeGroups)` read they were identical,
		// so a module installed after the dock opened rendered as xyflow's bare card.
		(window as any).__flowNodeTypes = {
			live: () => Object.keys(nodeTypes),
			atMount: mountedTypes,
			unknown: () => [...unknownTypes],
			unknownHere: () => unknownHere
		};
		return () => {
			delete (window as any).__flowViewport;
			delete (window as any).__flowTidy;
			delete (window as any).__flowNodeTypes;
		};
	});

	// palette collapse + side (82), persisted. Exported so the docked host (Flow) can
	// inset its content above the Controls HUD only when the palette is actually shown.
	// 41 G18: on a phone it starts HIDDEN until the user opens it (handheldPanels).
	let {
		paletteOpen = $bindable(readPanelOpen('flowPaletteOpen', true))
	}: { paletteOpen?: boolean } = $props();
	let paletteSide = $state(typeof localStorage !== 'undefined' ? safeStorage.getItem('flowPaletteSide') ?? 'left' : 'left');
	// #20 P7: the left column's own height, measured — the graph tree's resize ceiling
	let paletteColH = $state(0);

	// --- xyflow v1 bridge -------------------------------------------------------
	// SvelteFlow 1.x binds PLAIN $state.raw arrays (immutable-style updates), not
	// writable stores. The flowNodes/flowEdges stores REMAIN the contract for all
	// lib code (nodesHandler appliers, history, flowRuntime, FlowCode...); these
	// locals mirror the ACTIVE graph's view store both ways.
	//
	// 36 U11: the locals are a VIEW of the store now, not a copy. At the level being
	// looked at (the graph's top, or the inside of an open group) a node nested deeper is
	// drawn as a HIDDEN copy (xyflow hides its wires by itself), a wire crossing a
	// collapsed group's boundary gets a PROXY wire to the group's socket, and inside a
	// group two boundary cards stand for the outside. None of that reaches the store:
	// the write-back below maps every hidden copy back to the object it was made from and
	// drops the proxies and the boundary cards. A graph with no groups is drawn as-is
	// (the locals ARE the store arrays then — byte-identical to before).
	let nodes = $state.raw<Node[]>([]);
	let edges = $state.raw<Edge[]>([]);
	let pushingToStore = false;
	/** the open group (null = the graph's top level) */
	let level: string | null = $state(null);
	/** hidden copy -> the store object it stands for (rebuilt with every view) */
	let hiddenCopies = new Map<any, any>();
	/** the boundary cards keep a LOCAL position per open group (never stored) */
	const pseudoPos = new Map<string, { x: number; y: number }>();
	const storeNodesNow = () => get(flowNodesStore) as any[];
	const storeEdgesNow = () => get(flowEdgesStore) as any[];

	/** Same objects in the same order? (a write-back that changes nothing writes nothing) */
	function sameRefs(a: any[], b: any[]) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
		return true;
	}
	/** Same ids in the same order? (a structural change re-derives the view) */
	function sameIds(a: any[], b: any[]) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (a[i]?.id !== b[i]?.id) return false;
		return true;
	}

	/** Do all notes come before every other node? */
	function notesFirst(list: any[]) {
		let seenOther = false;
		for (const n of list) {
			if (isNote(n)) {
				if (seenOther) return false;
			} else seenOther = true;
		}
		return true;
	}

	function rebuildView() {
		const sn = storeNodesNow();
		const se = storeEdgesNow();
		if (level && !sn.some((n) => n.id === level && isGroup(n))) level = null;
		if (!level && !sn.some(isGroup) && notesFirst(sn)) {
			hiddenCopies = new Map();
			if (nodes !== sn) nodes = sn as Node[];
			if (edges !== se) edges = se as Edge[];
			return;
		}
		const view = graphView(sn, se, level);
		const copies = new Map<any, any>();
		// notes first: xyflow paints in array order, and a note is a backdrop
		const ordered = notesFirst(sn) ? sn : [...sn.filter(isNote), ...sn.filter((n) => !isNote(n))];
		const out: any[] = ordered.map((n) => {
			if (view.visible.has(n.id)) return n;
			const copy = { ...n, hidden: true };
			copies.set(copy, n);
			return copy;
		});
		if (level) {
			const group = sn.find((n) => n.id === level);
			const box = boundsOf(sn.filter((n) => view.visible.has(n.id))) ?? { x: 0, y: 0, w: 0, h: 0 };
			const cy = Math.round(box.y + box.h / 2 - 30);
			out.push({
				id: GROUP_IN,
				type: 'groupio',
				position: pseudoPos.get(level + ':in') ?? { x: Math.round(box.x - 260), y: cy },
				data: { kind: 'in', entries: group?.data?.inputs ?? [] },
				deletable: false,
				class: 'w-[150px]'
			});
			out.push({
				id: GROUP_OUT,
				type: 'groupio',
				position: pseudoPos.get(level + ':out') ?? { x: Math.round(box.x + box.w + 100), y: cy },
				data: { kind: 'out', entries: group?.data?.outputs ?? [] },
				deletable: false,
				class: 'w-[150px]'
			});
		}
		hiddenCopies = copies;
		const proxies = view.proxies.map((p) => ({
			...p,
			type: edgeStyle,
			class: 'tp-proxy-edge',
			markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }
		}));
		nodes = out as Node[];
		edges = (proxies.length ? [...se, ...proxies] : se) as Edge[];
	}

	// store -> view (remote edits, undo, graph switches). The subscribe callback fires
	// synchronously and reads the locals, so it runs inside untrack() or the effect would
	// re-run (and resubscribe) on every local change.
	$effect(() =>
		untrack(() =>
			flowNodesStore.subscribe(() => {
				if (pushingToStore) return;
				rebuildView();
				scheduleReconcile();
			})
		)
	);
	$effect(() =>
		untrack(() =>
			flowEdgesStore.subscribe(() => {
				if (pushingToStore) return;
				rebuildView();
				scheduleReconcile();
			})
		)
	);
	// entering / leaving a group re-derives the view
	$effect(() => {
		void level;
		untrack(() => rebuildView());
	});
	// view -> store (drag positions, selection, connects made by SvelteFlow)
	$effect(() => {
		const local = nodes; // track
		untrack(() => {
			const real: any[] = [];
			for (const n of local as any[]) {
				if (isPseudo(n)) {
					if (level) pseudoPos.set(level + (n.id === GROUP_IN ? ':in' : ':out'), n.position);
					continue;
				}
				const orig = hiddenCopies.get(n);
				if (orig) real.push(orig);
				else if (n.hidden) {
					const { hidden: _hidden, ...rest } = n;
					real.push(rest);
				} else real.push(n);
			}
			const current = storeNodesNow();
			if (sameRefs(real, current)) return;
			const structural = !sameIds(real, current);
			pushingToStore = true;
			flowNodesStore.set(real);
			pushingToStore = false;
			if (structural) {
				rebuildView();
				scheduleReconcile();
			}
		});
	});
	$effect(() => {
		const local = edges; // track
		untrack(() => {
			const real = (local as any[]).filter((e) => !e.data?.proxy);
			const current = storeEdgesNow();
			if (sameRefs(real, current)) return;
			const structural = !sameIds(real, current);
			pushingToStore = true;
			flowEdgesStore.set(real);
			pushingToStore = false;
			if (structural) {
				rebuildView();
				scheduleReconcile();
			}
		});
	});

	// --- group sockets follow the wires --------------------------------------------
	// A group's IO list is DERIVED from the wires crossing its boundary; whenever the graph
	// changes, any group whose stored list no longer matches is rewritten (replicated,
	// never recorded — it is a consequence, the edit that caused it is what undo replays).
	// Deterministic, so two peers reconciling at once write the same thing.
	let reconcileQueued = false;
	function scheduleReconcile() {
		if (reconcileQueued) return;
		reconcileQueued = true;
		queueMicrotask(() => {
			reconcileQueued = false;
			reconcileGroups();
		});
	}
	// 36 (U10): one rule with the template author (declared script/behaviour outputs included)
	const socketTypeOf = groupSocketType;
	function reconcileGroups() {
		const sn = storeNodesNow();
		if (!sn.some(isGroup)) return;
		const se = storeEdgesNow();
		const parents = parentMap(sn);
		const ids = new Set(sn.map((n) => n.id));
		for (const g of sn.filter(isGroup)) {
			const io = computeGroupIO(sn, se, g, { parents, typeOf: socketTypeOf, socketExists: variadicSocketExists });
			const children = (g.data?.children ?? []).filter((c: string) => ids.has(c));
			const patch: any = {};
			if (!sameIO(io.inputs, g.data?.inputs ?? [])) patch.inputs = io.inputs;
			if (!sameIO(io.outputs, g.data?.outputs ?? [])) patch.outputs = io.outputs;
			if (children.length !== (g.data?.children ?? []).length) patch.children = children;
			if (Object.keys(patch).length) setNodeData(g.id, patch, activeId);
		}
	}

	// 166: flow PROPERTIES panel — curated graph prefs (LOCAL, persisted) + the
	// selected node's props. Right-side, collapses like the palette.
	const LS = typeof localStorage !== 'undefined' ? localStorage : null;
	let propsOpen = $state(readPanelOpen('flowPropsOpen', false));
	// 4.3: right-panel tab — 'info' (selected node's params) | 'settings' (graph + name/note)
	let propsTab = $state(LS?.getItem('flowPropsTab') || 'settings');
	// 179: the properties panel auto-reflows to the side OPPOSITE the palette so
	// their divider tabs never overlap (the palette-side toggle used to hide it)
	const propsSide = $derived(paletteSide === 'right' ? 'left' : 'right');
	let edgeStyle = $state(LS?.getItem('flowEdgeStyle') ?? 'bezier');
	// 41 G15: on a phone the minimap was a black slab over the canvas (node-graph-text.jpg):
	// it starts OFF there (the ⚙ Settings tab still turns it on, remembered per device)
	let showMinimap = $state(readPanelOpen('flowMinimap', true));
	let bgPattern = $state(LS?.getItem('flowBg') ?? 'dots');
	let gridSnapOn = $state(LS?.getItem('flowGridSnap') !== 'false');
	let gridSize = $state(+(LS?.getItem('flowGridSize') ?? '25'));
	const BG_LINES = BackgroundVariant.Lines;
	const BG_DOTS = BackgroundVariant.Dots;
	const snapGrid = $derived([gridSnapOn ? gridSize : 1, gridSnapOn ? gridSize : 1] as [number, number]);
	const bgVariant = $derived(bgPattern === 'lines' ? BG_LINES : BG_DOTS);
	const selectedNode = $derived((nodes as any[]).find((n) => n.selected && !n.hidden && !isPseudo(n)) ?? null);

	// 114 (v1.13): MOUSE BINDINGS. Classic (the default, byte-identical to every
	// version before it): left-drag pans. Select-first: left-drag draws a selection
	// rectangle, dragging any selected node moves the set, Shift+click toggles
	// membership, and the middle/right button pans. xyflow 1.6: `panOnDrag` takes the
	// button list, `selectionOnDrag` the rectangle, `multiSelectionKey` the modifier.
	const selectFirst = $derived($flowMouseBindings === 'select');
	// Select-first re-emits a STATIONARY right click as the pane menu: once the right
	// button pans, xyflow's Pane preventDefaults EVERY contextmenu and forwards none
	// (its system layer would re-emit a press that did not travel, but the svelte
	// wrapper never passes that callback through), so the wrapper below tracks the
	// gesture itself. A right DRAG is a pan and opens nothing.
	//
	// The decision is made on POINTERUP, not on the contextmenu event: Chromium fires
	// `contextmenu` on the PRESS, so at that moment the gesture has travelled zero
	// pixels whether it turns out to be a click or a 200px pan — measured, and the
	// first version opened the menu on every right drag because of it. The native menu
	// is suppressed either way, by xyflow's own preventDefault.
	let rightDown: { x: number; y: number } | null = null;
	const onWrapPointerDown = (event: PointerEvent) => {
		const target = event.target as HTMLElement | null;
		const onBarePane =
			!!target?.closest('.svelte-flow__pane') && !target.closest('.svelte-flow__node, .svelte-flow__edge');
		rightDown = event.button === 2 && onBarePane ? { x: event.clientX, y: event.clientY } : null;
	};
	const onWrapPointerUp = (event: PointerEvent) => {
		if (!selectFirst || event.button !== 2 || !rightDown) return; // Classic: xyflow's Pane opens it
		const travelled = Math.hypot(event.clientX - rightDown.x, event.clientY - rightDown.y);
		rightDown = null;
		if (travelled > 4) return; // that gesture was a pan
		onPaneContextMenu({ event });
	};

	// H1 (flow v2): the editor scope follows the viewport selection — a selected
	// object shows ITS graph (or the create-flow empty state), deselecting returns
	// to the scene graph. "Has a selection" MUST be read from the selectedObjects
	// SET: selectedObject keeps the last object after a deselect on purpose (the
	// inspector/outline bind to it), so an empty-space click clears only the set.
	$effect(() => {
		const set = $selectedObjects as string[];
		const primary = ($selectedObject as any)?.uuid;
		const scopeUuid = set.length ? (primary && set.includes(primary) ? primary : set[set.length - 1]) : null;
		untrack(() => setActiveGraph(scopeUuid ?? SCENE_GRAPH));
	});
	const activeId = $derived($activeGraphId);
	const hasActiveGraph = $derived(activeId === SCENE_GRAPH || !!$flowGraphs[activeId]);
	const activeOwnerName = $derived(
		activeId === SCENE_GRAPH
			? 'Scene'
			: ($objectsGroup as any)?.getObjectByProperty?.('uuid', activeId)?.name ||
				($objectsGroup as any)?.getObjectByProperty?.('uuid', activeId)?.type ||
				activeId.slice(0, 8)
	);

	function setEdgeStyle(style: string) {
		edgeStyle = style;
		LS?.setItem('flowEdgeStyle', style);
		// restyle existing edges locally (cosmetic — not in the graph hash, 166)
		edges = (edges as any[]).map((e) => ({ ...e, type: style })) as Edge[];
	}

	// shared with <SvelteFlow> (bind:viewport) so peer cursors can be projected
	// to screen space — v1 binds a plain object, not a store
	let viewport = $state.raw({ x: 0, y: 0, zoom: 1 });

	// Stores are initialized with null, so their inferred type is unusable here
	const peer: any = $derived($peers);

	// broadcast the local cursor position in flow coordinates (throttled)
	let lastCursorSent = 0;
	// 36 U11: where the pointer is over the pane ("add at cursor", paste, notes)
	let lastPointer: { x: number; y: number } | null = null;
	const onPointerMoveCursor = (event: PointerEvent) => {
		lastPointer = { x: event.clientX, y: event.clientY };
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
			y: position.y,
			graphId: activeId
		});
	};
	const onPointerLeaveCursor = () => {
		lastPointer = null;
		if (peer) peer.send({ type: 'flowcursor', id: peer.peer.id, leave: true });
	};

	// active context menu: { x, y, items, search? }
	let menu: any = $state(null);

	// =================================================================================
	// 36 U11 — EDITS: every editor edit goes through these, so it is replicated (the
	// existing node/edge messages) and UNDOABLE (one `flownodes` entry, or one batch).
	// =================================================================================

	/** the pane's centre in screen px (the fallback "cursor") */
	function paneCentre() {
		const r = (document.querySelector('.svelteFlow .svelte-flow') as HTMLElement | null)?.getBoundingClientRect();
		return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
	}
	/** where "at the cursor" means right now, in flow coordinates */
	function cursorFlowPos() {
		return screenToFlowPosition(lastPointer ?? paneCentre());
	}
	/** the view's drawable nodes (not hidden, not the boundary cards) */
	const visibleNodes = () => (nodes as any[]).filter((n) => !n.hidden && !isPseudo(n));
	const selectedVisible = () => visibleNodes().filter((n) => n.selected);
	const selectedRealEdges = () => (edges as any[]).filter((e) => e.selected && !e.data?.proxy);

	/** ONE undo step for everything inside `fn`, however deeply the helpers nest (the
	 * history batch is not re-entrant: a nested begin would flush the outer one). */
	let batchDepth = 0;
	function inBatch(label: string, fn: () => void) {
		if (batchDepth++ === 0) beginHistoryBatch();
		try {
			fn();
		} finally {
			if (--batchDepth === 0) endHistoryBatch(label);
		}
	}

	/** Put new nodes into the open group (a node made inside a group belongs to it).
	 * Returns the history item, or null at the top level. */
	function joinLevel(ids: string[]) {
		if (!level || !ids.length) return null;
		const group = storeNodesNow().find((n) => n.id === level);
		if (!group) return null;
		const before = { children: [...(group.data?.children ?? [])] };
		const after = { children: [...before.children, ...ids.filter((id) => !before.children.includes(id))] };
		setNodeData(level, after, activeId);
		return { id: level, before, after };
	}

	/** Add nodes + edges as ONE undoable, replicated step; the new nodes become the
	 * selection. @param extraData data items recorded in the same step */
	function commitCreate(newNodes: any[], newEdges: any[] = [], extraData: any[] = [], opts: { join?: boolean } = {}) {
		if (!newNodes.length && !newEdges.length) return;
		if (activeId !== SCENE_GRAPH && !hasActiveGraph) createObjectGraph(activeId);
		const fresh = new Set(newNodes.map((n) => n.id));
		updateGraph(activeId, (g) => ({
			nodes: [...g.nodes.map((n: any) => (n.selected ? { ...n, selected: false } : n)), ...newNodes.map((n) => ({ ...n, selected: true }))],
			edges: [...g.edges, ...newEdges]
		}));
		for (const n of newNodes) peer?.send({ type: 'nodecreate', node: serializeNode(n), graphId: activeId });
		for (const e of newEdges) peer?.send({ type: 'edgecreate', edge: serializeEdge(e), graphId: activeId });
		const joined = opts.join === false ? null : joinLevel([...fresh].filter((id) => !nestedIn(newNodes, id)));
		const items = [...extraData, ...(joined ? [joined] : [])];
		inBatch('Add nodes', () => {
			recordFlowNodesEntry({ op: 'create', graphId: activeId, nodes: newNodes.map(serializeNode), edges: newEdges.map(serializeEdge) });
			if (items.length) recordFlowNodesEntry({ op: 'data', graphId: activeId, items });
		});
	}
	/** is `id` nested inside one of the payload's own groups? */
	function nestedIn(list: any[], id: string) {
		return list.some((n) => isGroup(n) && (n.data?.children ?? []).includes(id));
	}

	/** Delete nodes (groups take their contents) and wires, ONE undoable step. */
	function commitDelete(nodeIds: string[], edgeIds: string[] = [], opts: { contents?: boolean } = {}) {
		const sn = storeNodesNow();
		const se = storeEdgesNow();
		const picked = nodeIds.filter((id) => !isPseudo({ id }));
		// a deleted group takes its contents, unless it is being UNGROUPED
		const ids = opts.contents === false ? new Set(picked) : withDescendants(sn, picked);
		// a FRAME note's members are NOT deleted with it (a frame is an annotation)
		for (const id of nodeIds) {
			const node = sn.find((n) => n.id === id);
			if (isNote(node)) for (const m of node.data?.frame ?? []) if (!nodeIds.includes(m)) ids.delete(m);
		}
		const goneNodes = sn.filter((n) => ids.has(n.id));
		const edgeSet = new Set(edgeIds);
		const goneEdges = se.filter((e) => ids.has(e.source) || ids.has(e.target) || edgeSet.has(e.id));
		if (!goneNodes.length && !goneEdges.length) return;
		const nodeIdList = goneNodes.map((n) => n.id);
		const edgeIdList = goneEdges.map((e) => e.id);
		if (edgeIdList.length) deleteFlowEdges(edgeIdList, activeId);
		if (nodeIdList.length) deleteFlowNodes(nodeIdList, activeId);
		if (edgeIdList.length) peer?.send({ type: 'edgedelete', ids: edgeIdList, graphId: activeId });
		if (nodeIdList.length) peer?.send({ type: 'nodedelete', ids: nodeIdList, graphId: activeId });
		recordFlowNodesEntry({ op: 'delete', graphId: activeId, nodes: goneNodes.map(serializeNode), edges: goneEdges.map(serializeEdge) });
	}

	/** Move nodes (absolute), replicated as `nodemove`, ONE undoable step.
	 * @param moves [{id, x, y}] @param before positions to record as the undo state */
	function commitMoves(moves: { id: string; x: number; y: number }[], before?: Map<string, { x: number; y: number }>) {
		const sn = storeNodesNow();
		const items: any[] = [];
		const map = new Map(moves.map((m) => [m.id, m]));
		for (const m of moves) {
			const node = sn.find((n) => n.id === m.id);
			if (!node) continue;
			const from = before?.get(m.id) ?? node.position;
			if (from.x === m.x && from.y === m.y) continue;
			items.push({ id: m.id, before: { x: from.x, y: from.y }, after: { x: m.x, y: m.y } });
		}
		if (!items.length) return [];
		updateGraph(activeId, (g) => ({
			nodes: g.nodes.map((n: any) => (map.has(n.id) ? { ...n, position: { x: map.get(n.id)!.x, y: map.get(n.id)!.y } } : n)),
			edges: g.edges
		}));
		for (const it of items) peer?.send({ type: 'nodemove', id: it.id, position: it.after, graphId: activeId });
		recordFlowNodesEntry({ op: 'move', graphId: activeId, items });
		return items;
	}

	/** Patch node data, replicated, ONE undoable step. @param patches [{id, patch}] */
	function commitData(patches: { id: string; patch: any }[], label = 'Edit nodes') {
		const sn = storeNodesNow();
		const items: any[] = [];
		for (const { id, patch } of patches) {
			const node = sn.find((n) => n.id === id);
			if (!node) continue;
			const before: any = {};
			for (const key of Object.keys(patch)) before[key] = node.data?.[key] === undefined ? undefined : structuredClone(node.data[key]);
			setNodeData(id, patch, activeId);
			items.push({ id, before, after: patch });
		}
		if (items.length) recordFlowNodesEntry({ op: 'data', graphId: activeId, items });
		void label;
	}

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
		// H1: adding a node to a selected object that has no flow yet CREATES the flow
		// implicitly (replicated + undoable) — commitCreate does it; 36 U11: undoable too
		commitCreate([newNode]);
	}

	// Touch has no HTML5 drag-and-drop, so a palette TAP adds the node at the flow
	// pane's centre (the node can then be dragged on the canvas, which touch supports).
	function addNodeAtCenter(type: string) {
		const position = screenToFlowPosition(paneCentre());
		if (type.startsWith('customnode:')) {
			const def = $customNodeDefs.find((d) => d.id === type.slice('customnode:'.length));
			if (def) addNode('customnode', def.name, position, defDefaults(def));
			return;
		}
		addNode(type, findNodeSpec(type)?.label ?? `${type} node`, position);
	}

	// Touch drag-to-place: the palette (Sidebar) drags a ghost and drops it here at a
	// screen point; place the node there (mirrors onDrop, which touch can't trigger).
	function addNodeAtScreen(type: string, clientX: number, clientY: number) {
		const position = screenToFlowPosition({ x: clientX, y: clientY });
		if (type.startsWith('customnode:')) {
			const def = $customNodeDefs.find((d) => d.id === type.slice('customnode:'.length));
			if (def) addNode('customnode', def.name, position, defDefaults(def));
			return;
		}
		addNode(type, findNodeSpec(type)?.label ?? `${type} node`, position);
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

		// 36 B7: a .tpnode file dropped on the canvas lands where it was dropped
		const file = [...(event.dataTransfer.files ?? [])].find((f) => f.name.toLowerCase().endsWith('.tpnode'));
		if (file) {
			const at = screenToFlowPosition({ x: event.clientX, y: event.clientY });
			file.text().then((text) => importTpnodeText(text, at));
			return;
		}
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

	// --- drags: replicated + undoable, and FRAME notes carry what they frame -----------
	let dragStart: Map<string, { x: number; y: number }> | null = null;
	let frameCarry: { noteId: string; start: { x: number; y: number }; members: Map<string, { x: number; y: number }> }[] = [];
	const onNodeDragStart = ({ nodes: dragged }: { nodes: Node[] }) => {
		dragStart = new Map((nodes as any[]).filter((n) => !n.hidden).map((n) => [n.id, { ...n.position }]));
		const draggedIds = new Set(dragged.map((n) => n.id));
		frameCarry = (dragged as any[])
			.filter((n) => isNote(n) && n.data?.frame?.length)
			.map((n) => ({
				noteId: n.id,
				start: { ...n.position },
				members: new Map(
					(nodes as any[])
						.filter((m) => n.data.frame.includes(m.id) && !draggedIds.has(m.id) && !m.hidden)
						.map((m) => [m.id, { ...m.position }])
				)
			}));
	};
	const onNodeDrag = ({ nodes: dragged }: { nodes: Node[] }) => {
		if (!frameCarry.length) return;
		const byId = new Map((dragged as any[]).map((n) => [n.id, n]));
		const moves = new Map<string, { x: number; y: number }>();
		for (const carry of frameCarry) {
			const note = byId.get(carry.noteId);
			if (!note) continue;
			const dx = note.position.x - carry.start.x;
			const dy = note.position.y - carry.start.y;
			for (const [id, p] of carry.members) moves.set(id, { x: p.x + dx, y: p.y + dy });
		}
		if (moves.size) nodes = (nodes as any[]).map((n) => (moves.has(n.id) ? { ...n, position: moves.get(n.id) } : n)) as Node[];
	};
	// Replicate node positions when a drag ends (v1 payload: plain object) — and record
	// ONE undo step for everything that moved (dragged + carried + refit frames)
	const onNodeDragStop = ({ nodes: dragged }: { targetNode: Node | null; nodes: Node[]; event: MouseEvent | TouchEvent }) => {
		const start = dragStart;
		dragStart = null;
		const carried = frameCarry;
		frameCarry = [];
		if (!start) return;
		const local = new Map((nodes as any[]).map((n) => [n.id, n]));
		const movedIds = new Set<string>(dragged.map((n) => n.id));
		for (const c of carried) for (const id of c.members.keys()) movedIds.add(id);
		const moves = [...movedIds]
			.map((id) => local.get(id))
			.filter((n) => n && !isPseudo(n))
			.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }));
		// frames whose members moved (without the frame) refit around them
		const sn = storeNodesNow();
		const refits: { id: string; x: number; y: number; w: number; h: number }[] = [];
		for (const note of sn.filter((n) => isNote(n) && n.data?.frame?.length && !movedIds.has(n.id))) {
			if (!note.data.frame.some((m: string) => movedIds.has(m))) continue;
			const members = note.data.frame.map((m: string) => local.get(m)).filter(Boolean);
			const rect = frameRect(members);
			if (rect) refits.push({ id: note.id, ...rect });
		}
		inBatch('Move nodes', () => {
			commitMoves(moves, start);
			for (const r of refits) {
				commitMoves([{ id: r.id, x: r.x, y: r.y }]);
				const note = sn.find((n) => n.id === r.id);
				if (note && (note.data?.w !== r.w || note.data?.h !== r.h)) commitData([{ id: r.id, patch: { w: r.w, h: r.h } }]);
			}
		});
	};

	// --- connections: a group's socket stands for the socket inside it ----------------
	/** Translate a connection drawn onto a group's socket into the real inner endpoint. */
	function realConnection(c: any) {
		let { source, sourceHandle, target, targetHandle } = c;
		const sp = parseIoHandle(sourceHandle);
		if (sp && sp.dir === 'o' && source !== GROUP_IN && source !== GROUP_OUT) {
			source = sp.node;
			sourceHandle = sp.socket;
		}
		const tp = parseIoHandle(targetHandle);
		if (tp && tp.dir === 'i' && target !== GROUP_IN && target !== GROUP_OUT) {
			target = tp.node;
			targetHandle = tp.socket;
		}
		return { ...c, source, sourceHandle, target, targetHandle };
	}

	// 165: reject a drag between incompatible socket types (same type or a sane
	// coercion). Saved edges are not re-validated — only live drags.
	const isValidConnection = (connection: any) => {
		if (connection.source === GROUP_OUT || connection.target === GROUP_IN) return false;
		if (connection.source === GROUP_IN) return connection.target !== GROUP_OUT && !isPseudo({ id: connection.target });
		if (connection.target === GROUP_OUT) return !isPseudo({ id: connection.source });
		const all = storeNodesNow();
		return isValidFlowConnection(realConnection(connection), all);
	};

	/** The canonical edge object (4.1: the id MUST include the handles). */
	function makeEdge(c: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) {
		return {
			id: `e-${c.source}${c.sourceHandle ? '.' + c.sourceHandle : ''}-${c.target}${c.targetHandle ? '.' + c.targetHandle : ''}`,
			source: c.source,
			target: c.target,
			sourceHandle: c.sourceHandle,
			targetHandle: c.targetHandle,
			// 69: readable edges — same shape on every peer via serializeEdge
			// 150/166: edge style follows the flow properties panel (local pref)
			type: edgeStyle,
			markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }
		} as any;
	}

	/** Inside a group: a wire onto a boundary card exposes a socket ("＋") or, from an
	 * existing input socket, fans that input out to another inner socket. */
	function connectBoundary(c: any) {
		const group = storeNodesNow().find((n) => n.id === level);
		if (!group) return;
		if (c.source === GROUP_IN) {
			if (c.sourceHandle === 'i|+') {
				const key = ioKey(c.target, c.targetHandle);
				if ((group.data?.inputs ?? []).some((e: any) => e.key === key)) return;
				const node = storeNodesNow().find((n) => n.id === c.target);
				const entry = { key, name: c.targetHandle || node?.data?.label || 'in', type: socketTypeOf(node, c.targetHandle ?? null, 'in'), to: [c.target, c.targetHandle ?? null] };
				commitData([{ id: group.id, patch: { inputs: [...(group.data?.inputs ?? []), entry] } }]);
				return;
			}
			const p = parseIoHandle(c.sourceHandle);
			if (!p) return;
			const inside = descendantsOf(parentMap(storeNodesNow()), group.id);
			const feeds = storeEdgesNow().filter((e) => e.target === p.node && (e.targetHandle ?? null) === p.socket && !inside.has(e.source));
			if (!feeds.length) {
				showToast('Nothing is wired into that group socket outside the group yet');
				return;
			}
			const fresh = feeds
				.map((f) => makeEdge({ source: f.source, sourceHandle: f.sourceHandle, target: c.target, targetHandle: c.targetHandle }))
				.filter((e) => !storeEdgesNow().some((x) => x.id === e.id));
			commitCreate([], fresh);
			return;
		}
		if (c.target === GROUP_OUT) {
			if (c.targetHandle !== 'o|+') {
				showToast('Wire that output outside the group');
				return;
			}
			const key = ioKey(c.source, c.sourceHandle);
			if ((group.data?.outputs ?? []).some((e: any) => e.key === key)) return;
			const node = storeNodesNow().find((n) => n.id === c.source);
			const entry = { key, name: c.sourceHandle || node?.data?.label || 'out', type: socketTypeOf(node, c.sourceHandle ?? null, 'out'), from: [c.source, c.sourceHandle ?? null] };
			commitData([{ id: group.id, patch: { outputs: [...(group.data?.outputs ?? []), entry] } }]);
		}
	}

	// Give new edges a deterministic id and replicate them to all peers.
	// 4.1: the id MUST include the handles — without them, wiring one source into
	// BOTH a and b of a node collided ids, the peer-side dedupe dropped edge #2
	// and the graphs diverged permanently (nodesync could never converge).
	// v1: onbeforeconnect replaces v0's onedgecreate (same return-the-edge contract).
	// 36 U11: a wire drawn onto a group socket is the wire to the socket INSIDE it; the
	// connect (and the wire it replaces) is one undo step.
	const onbeforeconnect = (connection: Connection) => {
		if (connection.source === GROUP_IN || connection.target === GROUP_OUT) {
			connectBoundary(connection);
			return null;
		}
		const real = realConnection(connection);
		// single-connection inputs: a new wire into an occupied VALUE input
		// replaces the old one (effect/event inputs keep multi fan-in; fan-out
		// from an output is always unlimited)
		const stale = replaceableInputEdges(real, storeNodesNow(), storeEdgesNow());
		const edge = makeEdge(real);
		if (storeEdgesNow().some((e) => e.id === edge.id)) return null;
		inBatch('Connect', () => {
			if (stale.length) commitDelete([], stale);
			peer?.send({ type: 'edgecreate', edge: serializeEdge(edge), graphId: activeId });
			recordFlowNodesEntry({ op: 'create', graphId: activeId, nodes: [], edges: [serializeEdge(edge)] });
		});
		return edge;
	};

	// Replicate deletions xyflow made itself (deleteKey is the registry's now — this is the
	// path for any delete xyflow still owns)
	const ondelete = ({ nodes: deletedNodes, edges: deletedEdges }: { nodes: Node[]; edges: Edge[] }) => {
		if (deletedNodes.length)
			peer?.send({ type: 'nodedelete', ids: deletedNodes.map((n) => n.id), graphId: activeId });
		if (deletedEdges.length)
			peer?.send({ type: 'edgedelete', ids: deletedEdges.filter((e) => !(e as any).data?.proxy).map((e) => e.id), graphId: activeId });
	};

	// =================================================================================
	// 36 U11 — THE NODE EDITOR'S COMMANDS (keys: shortcuts.js scope 'nodes'; menus below)
	// =================================================================================
	const FIT_PADDING = $derived(
		showMinimap
			? { top: '56px', right: '28px', bottom: '118px', left: '28px' }
			: { top: '56px', right: '28px', bottom: '28px', left: '28px' }
	);
	function frameNodes(list: any[]) {
		if (!list.length) return;
		try {
			fitView({ nodes: list.map((n) => ({ id: n.id })), duration: 260, padding: FIT_PADDING as any, maxZoom: 1 });
		} catch {
			/* the pane is not up yet */
		}
	}
	const frameSelected = () => {
		const sel = selectedVisible();
		frameNodes(sel.length ? sel : (nodes as any[]).filter((n) => !n.hidden));
	};
	const frameAll = () => frameNodes((nodes as any[]).filter((n) => !n.hidden));

	// =================================================================================
	// 36 F11 / S4 — TIDY GRAPH. The same layout the game templates are authored with
	// ($lib/graphLayout), on the cards as they are DRAWN: sizes from xyflow's measurement,
	// wire ends from its handle bounds, so a 24-socket group card counts as tall as it is.
	// Every move lands as ONE undo step and one nodemove per card (commitMoves), so peers
	// see the tidy and Ctrl+Z takes it back whole (S8).
	// =================================================================================
	function graphModel() {
		const vis = (nodes as any[]).filter((n) => !n.hidden && !isPseudo(n));
		const ids = new Set(vis.map((n) => n.id));
		const boxes = vis.map((n) => {
			const w = n.measured?.width ?? n.width ?? 150;
			const h = n.measured?.height ?? n.height ?? 80;
			const kind: 'node' | 'note' | 'group' | 'frame' = n.type === 'note' ? (n.data?.frame ? 'frame' : 'note') : n.type === 'group' ? 'group' : 'node';
			return { id: n.id, x: n.position.x, y: n.position.y, w, h, kind };
		});
		const wires: any[] = [];
		for (const e of edges as any[]) {
			if (!ids.has(e.source) || !ids.has(e.target) || e.hidden) continue;
			const s = getInternalNode(e.source);
			const t = getInternalNode(e.target);
			const pick = (list: any[] | null | undefined, id: string | null | undefined) => (list ? (!id ? list[0] : list.find((h) => h.id === id)) : null) ?? null;
			const sh = pick(s?.internals.handleBounds?.source, e.sourceHandle);
			const th = pick(t?.internals.handleBounds?.target, e.targetHandle);
			const sb = boxes.find((b) => b.id === e.source)!;
			const tb = boxes.find((b) => b.id === e.target)!;
			const end = (h: any, b: any, fallback: string) => {
				const pos = h?.position ?? fallback;
				const hx = h?.x ?? (fallback === 'right' ? b.w : 0);
				const hy = h?.y ?? b.h / 2;
				const hw = h?.width ?? 0;
				const hh = h?.height ?? 0;
				if (pos === 'right') return { x: hx + hw, y: hy + hh / 2, pos };
				if (pos === 'top') return { x: hx + hw / 2, y: hy, pos };
				if (pos === 'bottom') return { x: hx + hw / 2, y: hy + hh, pos };
				return { x: hx, y: hy + hh / 2, pos };
			};
			const a = end(sh, sb, 'right');
			const b = end(th, tb, 'left');
			wires.push({ id: e.id, source: e.source, target: e.target, sx: a.x, sy: a.y, sp: a.pos, tx: b.x, ty: b.y, tp: b.pos });
		}
		return { boxes, wires };
	}
	function lintHere() {
		const m = graphModel();
		return lintGraph(m.boxes, m.wires);
	}
	function tidyGraph(mode: 'layout' | 'repair' = 'layout') {
		const m = graphModel();
		if (m.boxes.length < 2) {
			showToast('Nothing to tidy here');
			return null;
		}
		const before = lintGraph(m.boxes, m.wires);
		const r = mode === 'repair' ? repairLayout(m.boxes, m.wires) : layeredLayout(m.boxes, m.wires);
		const moved = commitMoves(r.boxes.map((b) => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y) })));
		const n = moved?.length ?? 0;
		showToast(
			n
				? `${mode === 'repair' ? 'Fixed' : 'Tidied'}: ${n} card${n === 1 ? '' : 's'} moved — ${r.lint.ok ? 'nothing overlaps, no wire crosses a card' : lintSummary(r.lint)} (Ctrl+Z undoes it)`
				: before.ok
					? 'Already tidy: nothing overlaps, no wire crosses a card'
					: 'Could not tidy this graph: ' + lintSummary(before)
		);
		if (n && mode === 'layout') tick().then(() => setTimeout(frameAll, 60));
		return { moved: n, before, after: r.lint };
	}

	// =================================================================================
	// 36 F10 — WHERE THE EDITOR OPENS. It used to fit ONCE, at mount (xyflow's `fitView`
	// prop): a scene loaded with the editor already open kept the last scene's pan and zoom
	// (Target Toss opened on Mini Golf's view, cut off at the right). Every OPEN — the pane
	// mounting, the active graph switching, a scene replacing the graphs (flowViewEpoch) —
	// now shows the graph's saved view (where a hand left it: this session, or the file's
	// `flowViews`) or frames every node. A graph that is still empty is framed the moment
	// its first nodes arrive (a joiner's snapshot, a recipe). Setting: Node editor opens.
	// =================================================================================
	let paneEl: HTMLDivElement | null = $state(null);
	/** an open is waiting for nodes to frame */
	let framePending = false;
	/** bumps per open, so a slow retry of an older open gives up */
	let openSeq = 0;
	const visibleCount = () => (nodes as any[]).filter((n) => !n.hidden).length;
	function paneSize() {
		return { w: paneEl?.clientWidth ?? 0, h: paneEl?.clientHeight ?? 0 };
	}
	function frameOnOpen() {
		framePending = false;
		try {
			// no `nodes` list: xyflow frames every VISIBLE node once they are measured (the
			// call is queued until then), so this works while the new graph is still mounting
			fitView({ padding: FIT_PADDING as any, maxZoom: 1, duration: 0 });
		} catch {
			/* the pane is not up yet */
		}
	}
	function openView() {
		const seq = ++openSeq;
		const graphId = activeId;
		const choice = openingView(graphId, get(nodeEditorOpens));
		if (choice.kind === 'saved') {
			framePending = false;
			const place = (tries: number) => {
				if (seq !== openSeq) return;
				const { w, h } = paneSize();
				if (w && h) {
					void setViewport(viewportOf(choice.view, w, h)).then((ok) => {
						if (!ok && tries > 0) requestAnimationFrame(() => place(tries - 1));
					});
				} else if (tries > 0) requestAnimationFrame(() => place(tries - 1));
			};
			place(60);
			return;
		}
		if (visibleCount() === 0) framePending = true;
		else frameOnOpen();
	}
	// the opens: mount + a graph switch + a scene load (each re-runs this effect)
	$effect(() => {
		void activeId;
		void $flowViewEpoch;
		untrack(() => tick().then(openView));
	});
	// an empty graph that was opened is framed when its first nodes arrive
	$effect(() => {
		const count = (nodes as any[]).filter((n) => !n.hidden).length;
		// re-checked when it runs: an open queued in the same flush (a switch back to a graph
		// with a saved view) clears it first, and must not be framed over
		if (count > 0 && framePending) untrack(() => tick().then(() => framePending && frameOnOpen()));
	});
	/** where a hand gesture on the pane started (a click with no travel ends one too) */
	let moveFrom: { x: number; y: number; zoom: number } | null = null;
	function onMoveStart(event: MouseEvent | TouchEvent | null, vp: { x: number; y: number; zoom: number }) {
		moveFrom = event ? { ...vp } : null;
	}
	/** a hand moved the view (a programmatic fit or focus passes no event): remember it */
	function onMoveEnd(event: MouseEvent | TouchEvent | null, vp: { x: number; y: number; zoom: number }) {
		const from = moveFrom;
		moveFrom = null;
		// only a gesture a hand STARTED counts: an animated fit (A, F, focus a node) can end with
		// an event attached while its start had none
		if (!event || !from || level) return;
		// a click that went nowhere is not "where it was left" (xyflow ends a move for it too)
		if (Math.abs(from.x - vp.x) < 0.5 && Math.abs(from.y - vp.y) < 0.5 && Math.abs(from.zoom - vp.zoom) < 1e-4) return;
		framePending = false;
		const { w, h } = paneSize();
		if (w && h) rememberView(activeId, viewOf(vp, w, h));
	}

	function selectAll() {
		nodes = (nodes as any[]).map((n) => (!n.hidden && !n.selected ? { ...n, selected: true } : n)) as Node[];
	}
	function selectOnly(ids: string[]) {
		const set = new Set(ids);
		nodes = (nodes as any[]).map((n) => (set.has(n.id) !== !!n.selected && !n.hidden ? { ...n, selected: set.has(n.id) } : n)) as Node[];
	}

	const CLIP_KEY = 'nodeClipboard';
	let clipboard: any = null;
	function readClipboard() {
		if (clipboard) return clipboard;
		try {
			const raw = safeStorage.getItem(CLIP_KEY);
			const parsed = raw ? JSON.parse(raw) : null;
			return parsed?.tp === 'nodes' ? parsed : null;
		} catch {
			return null;
		}
	}
	function copySelection(cut = false) {
		const sel = selectedVisible();
		if (!sel.length) return;
		clipboard = copyPayload(storeNodesNow(), storeEdgesNow(), sel.map((n) => n.id), serializeNode, serializeEdge);
		try {
			safeStorage.setItem(CLIP_KEY, JSON.stringify(clipboard));
		} catch {
			/* too big for storage: this tab keeps it */
		}
		if (cut) commitDelete(sel.map((n) => n.id));
		else showToast(`Copied ${clipboard.nodes.length} node${clipboard.nodes.length === 1 ? '' : 's'}`);
	}
	function pasteAt(at?: { x: number; y: number }) {
		const payload = readClipboard();
		if (!payload?.nodes?.length) {
			showToast('Nothing to paste — copy some nodes first (Ctrl+C)');
			return;
		}
		const out = instantiatePayload(payload, () => crypto.randomUUID(), { at: at ?? cursorFlowPos() });
		commitCreate(out.nodes, out.edges);
	}
	function duplicateSelection() {
		const sel = selectedVisible();
		if (!sel.length) return;
		const payload = copyPayload(storeNodesNow(), storeEdgesNow(), sel.map((n) => n.id), serializeNode, serializeEdge);
		const out = instantiatePayload(payload, () => crypto.randomUUID(), { offset: { x: 40, y: 40 } });
		commitCreate(out.nodes, out.edges);
	}
	function deleteSelection() {
		const sel = selectedVisible();
		const selE = selectedRealEdges();
		if (!sel.length && !selE.length) return;
		commitDelete(
			sel.map((n) => n.id),
			selE.map((e) => e.id)
		);
	}

	/** members of the selection a data toggle applies to (a group passes it to its contents) */
	function toggleTargets(includeGroupsContents: boolean) {
		const sn = storeNodesNow();
		const parents = parentMap(sn);
		const out = new Set<string>();
		for (const n of selectedVisible()) {
			out.add(n.id);
			if (includeGroupsContents && isGroup(n)) for (const d of descendantsOf(parents, n.id)) out.add(d);
		}
		return sn.filter((n) => out.has(n.id));
	}
	function toggleMute() {
		const targets = toggleTargets(true).filter((n) => !isNote(n));
		if (!targets.length) return;
		const mute = targets.some((n) => !n.data?.muted);
		commitData(targets.map((n) => ({ id: n.id, patch: { muted: mute } })));
		showToast(mute ? `Muted ${targets.length} node${targets.length === 1 ? '' : 's'} (they do nothing until unmuted)` : 'Unmuted');
	}
	function toggleCollapse() {
		const targets = toggleTargets(false);
		if (!targets.length) return;
		const collapse = targets.some((n) => !n.data?.collapsed);
		commitData(targets.map((n) => ({ id: n.id, patch: { collapsed: collapse } })));
	}

	function arrangeSelection(op: 'column' | 'row' | 'distributeV' | 'distributeH') {
		const sel = selectedVisible();
		if (sel.length < 2) {
			showToast('Select two or more nodes to align them');
			return;
		}
		if ((op === 'distributeV' || op === 'distributeH') && sel.length < 3) {
			showToast('Select three or more nodes to distribute them');
			return;
		}
		commitMoves(arrange(sel, op));
	}
	function nudge(delta: [number, number]) {
		const sel = selectedVisible();
		if (!sel.length) return;
		const step = gridSnapOn ? gridSize : 10;
		commitMoves(sel.map((n) => ({ id: n.id, x: Math.round(n.position.x + delta[0] * step), y: Math.round(n.position.y + delta[1] * step) })));
	}

	// --- groups ------------------------------------------------------------------------
	function groupSelection() {
		const sel = selectedVisible().filter((n) => !isPseudo(n));
		if (!sel.length) {
			showToast('Select the nodes to group first');
			return;
		}
		const sn = storeNodesNow();
		const group = makeGroup(sn, storeEdgesNow(), sel.map((n) => n.id), crypto.randomUUID(), { typeOf: socketTypeOf });
		// the group takes the members' place in the group we are inside
		const extra: any[] = [];
		if (level) {
			const parent = sn.find((n) => n.id === level);
			if (parent) {
				const before = { children: [...(parent.data?.children ?? [])] };
				const memberIds = new Set(sel.map((n) => n.id));
				const after = { children: [...before.children.filter((c: string) => !memberIds.has(c)), group.id] };
				setNodeData(level, after, activeId);
				extra.push({ id: level, before, after });
			}
		}
		// the parent's children were rewritten above, so the group must not join it again
		commitCreate([group], [], extra, { join: false });
		showToast(`Grouped ${sel.length} node${sel.length === 1 ? '' : 's'} — double-click or Tab to open it`);
	}
	function ungroup(id?: string) {
		const sn = storeNodesNow();
		const sel = selectedVisible().filter(isGroup);
		const targets = id ? sn.filter((n) => n.id === id && isGroup(n)) : sel.length ? sel : level ? sn.filter((n) => n.id === level) : [];
		if (!targets.length) {
			showToast('Select a group to ungroup');
			return;
		}
		const parents = parentMap(sn);
		inBatch('Ungroup', () => {
			for (const g of targets) {
				const parentId = parents.get(g.id) ?? null;
				const children = [...(g.data?.children ?? [])];
				if (parentId) {
					const parent = storeNodesNow().find((n) => n.id === parentId);
					const before = [...(parent?.data?.children ?? [])];
					commitData([{ id: parentId, patch: { children: [...before.filter((c: string) => c !== g.id), ...children] } }]);
				}
				if (level === g.id) level = parentId;
				// the members stay exactly where they are: only the group node goes
				commitDelete([g.id], [], { contents: false });
			}
		});
	}
	function enterGroup(id?: string) {
		const target = id ?? selectedVisible().find(isGroup)?.id;
		if (!target) return;
		level = target;
		tick().then(() => setTimeout(frameAll, 30));
	}
	function leaveGroup() {
		if (!level) return;
		const left = level;
		level = parentMap(storeNodesNow()).get(left) ?? null;
		tick().then(() => {
			selectOnly([left]);
			setTimeout(() => frameNodes((nodes as any[]).filter((n) => n.id === left)), 30);
		});
	}
	function toggleGroup() {
		const g = selectedVisible().find(isGroup);
		if (g && selectedVisible().length === 1) enterGroup(g.id);
		else if (level) leaveGroup();
	}

	// --- notes -------------------------------------------------------------------------
	function addNote(at?: { x: number; y: number }) {
		const p = at ?? cursorFlowPos();
		commitCreate([
			{
				id: crypto.randomUUID(),
				type: NOTE_TYPE,
				position: { x: Math.round(p.x), y: Math.round(p.y) },
				data: { label: 'Note', type: NOTE_TYPE, title: 'Note', text: '', color: 'yellow', w: 220, h: 140 }
			}
		]);
		propsOpenFor('settings');
	}
	function noteAroundSelection() {
		const sel = selectedVisible().filter((n) => !isNote(n));
		if (!sel.length) {
			showToast('Select the nodes the note should frame');
			return;
		}
		const rect = frameRect(sel);
		if (!rect) return;
		commitCreate([
			{
				id: crypto.randomUUID(),
				type: NOTE_TYPE,
				position: { x: rect.x, y: rect.y },
				data: { label: 'Frame', type: NOTE_TYPE, title: 'Frame', text: '', color: 'blue', w: rect.w, h: rect.h, frame: sel.map((n) => n.id) }
			}
		]);
		propsOpenFor('settings');
	}
	function noteResized(arg: { id: string; x: number; y: number; w: number; h: number }) {
		inBatch('Resize note', () => {
			commitMoves([{ id: arg.id, x: Math.round(arg.x), y: Math.round(arg.y) }]);
			commitData([{ id: arg.id, patch: { w: arg.w, h: arg.h } }]);
		});
		// the resizer leaves xyflow's own width/height on the node, which would pin the
		// wrapper at that size forever (an undo or a collapse could not shrink it): the
		// note's size is its DATA, so drop them
		updateGraph(activeId, (g) => ({
			nodes: g.nodes.map((n: any) => {
				if (n.id !== arg.id || (n.width === undefined && n.height === undefined)) return n;
				const { width: _w, height: _h, ...rest } = n;
				return rest;
			}),
			edges: g.edges
		}));
	}
	function propsOpenFor(tab: 'info' | 'settings') {
		propsOpen = true;
		propsTab = tab;
		writePanelOpen('flowPropsOpen', true);
		LS?.setItem('flowPropsTab', tab);
	}

	function openCode(node?: any) {
		const target = node ?? selectedVisible()[0];
		// 36 (G1): the code workspace first (script / behaviour / kit / module / coderef), then U11's built-ins
		const spec = target ? findNodeSpec(String(target.type)) : null;
		if (target && nodeHasCode(target, spec)) {
			void openCodeRequest(openCodeRequestFor(target, activeId, spec));
			return;
		}
		if (!target || !openNodeCode(target, activeId)) showToast('This node has no code to open');
	}

	// --- 36 B7: a group (or any selection) as a .tpnode file -----------------------------
	function exportTpnode(ids?: string[]) {
		const pick = ids ?? selectedVisible().map((n) => n.id);
		if (!pick.length) return;
		const sn = storeNodesNow();
		const first = sn.find((n) => n.id === pick[0]);
		const name = pick.length === 1 && isGroup(first) ? first.data?.label ?? 'Node group' : 'Node group';
		const file = buildTpnode(copyPayload(sn, storeEdgesNow(), pick, serializeNode, serializeEdge), name, { app: APP_VERSION });
		const blob = new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = tpnodeFileName(name);
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(a.href), 2000);
		showToast('Saved ' + a.download);
	}
	/** Read .tpnode text and place it at `at` (flow coordinates) — one undo step. */
	function importTpnodeText(text: string, at?: { x: number; y: number }) {
		const parsed = parseTpnode(text);
		if (!parsed.ok) {
			showToast(parsed.error);
			return false;
		}
		const out = instantiatePayload(parsed.payload, () => crypto.randomUUID(), { at: at ?? cursorFlowPos() });
		commitCreate(out.nodes, out.edges);
		showToast(`Added "${parsed.name}" (${out.nodes.length} node${out.nodes.length === 1 ? '' : 's'})`);
		return true;
	}
	let tpnodeInput: HTMLInputElement | null = $state(null);
	let tpnodeAt: { x: number; y: number } | null = null;
	function pickTpnode(at?: { x: number; y: number }) {
		tpnodeAt = at ?? cursorFlowPos();
		tpnodeInput?.click();
	}
	async function onTpnodePicked(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (file) importTpnodeText(await file.text(), tpnodeAt ?? undefined);
	}

	/** Shift+A / Space: the pane menu at the cursor, already searching */
	function addSearch() {
		const p = lastPointer ?? paneCentre();
		openPaneMenu(p.x, p.y, true);
	}

	// the registry's node rows reach these by name (nodeEditorActions)
	onMount(() =>
		installNodeActions(
			{
				frame: frameSelected,
				frameAll,
				addSearch,
				delete: deleteSelection,
				duplicate: duplicateSelection,
				selectAll,
				copy: () => copySelection(false),
				cut: () => copySelection(true),
				paste: () => pasteAt(),
				mute: toggleMute,
				collapse: toggleCollapse,
				group: groupSelection,
				ungroup: () => ungroup(),
				toggleGroup,
				enterGroup: (id?: string) => enterGroup(id),
				leaveGroup,
				addNote: () => addNote(),
				noteAround: noteAroundSelection,
				noteResized,
				tidy: () => tidyGraph('layout'),
				tidyKeep: () => tidyGraph('repair'),
				alignColumn: () => arrangeSelection('column'),
				alignRow: () => arrangeSelection('row'),
				distributeV: () => arrangeSelection('distributeV'),
				distributeH: () => arrangeSelection('distributeH'),
				nudge: (d: [number, number]) => nudge(d),
				openCode: () => openCode()
			},
			{ insideGroup: () => !!level }
		)
	);

	// the pane shows when it holds the keyboard (keys fire in the focused panel)
	let hasKeys = $state(lastScope() === 'nodes');
	onMount(() => onScopeChange((scope) => (hasKeys = scope === 'nodes')));

	// the open group's breadcrumb
	const crumbs = $derived(
		level
			? pathTo(parentMap(nodes as any[]), level).map((id) => ({
					id,
					label: (nodes as any[]).find((n) => n.id === id)?.data?.label ?? 'Group'
				}))
			: []
	);

	// 41 G15 — THE BREADCRUMB BAR: Scene › <object> › ⧉ group › ⧉ group, one line above the
	// graph (ui/Breadcrumbs). Every crumb opens its SIBLINGS to jump to. At the graph level a
	// crumb's siblings are the scene's flows (Main + every object that owns one) — the same
	// list from Scene and from the object, because that is the one choice at that level. Picking
	// the current one goes back to the TOP of that flow (out of any open group).
	// $objectsGroup is read on purpose: a rename/delete must reach the rows (THREE is not reactive)
	const flowRows = $derived.by(() => {
		const group = $objectsGroup as any;
		const rows = Object.keys($flowGraphs ?? {})
			.filter((key) => key !== SCENE_GRAPH)
			.map((uuid) => {
				const o = group?.getObjectByProperty?.('uuid', uuid);
				return { uuid, name: o?.name || o?.type || 'Object', missing: !o };
			})
			.filter((r) => !r.missing);
		// the object you are on is a flow destination even before it has a document
		if (activeId !== SCENE_GRAPH && !rows.some((r) => r.uuid === activeId))
			rows.push({ uuid: activeId, name: activeOwnerName, missing: false });
		return rows.sort((a, b) => a.name.localeCompare(b.name));
	});
	function flowSwitchItems() {
		const items: any[] = [
			{
				label: MAIN_GRAPH_LABEL + ' — the Scene graph',
				icon: 'waypoints',
				checked: activeId === SCENE_GRAPH,
				tooltip: 'The scene-wide graph (deselects the object)',
				action: () => (activeId === SCENE_GRAPH ? (level = null) : deselectObject())
			}
		];
		if (flowRows.length) items.push({ section: 'Object flows' });
		for (const r of flowRows)
			items.push({
				label: r.name,
				icon: 'box',
				checked: r.uuid === activeId,
				tooltip: r.uuid === activeId ? 'The top of this flow' : `Edit ${r.name}'s flow (selects it)`,
				action: () => (r.uuid === activeId ? (level = null) : applySelectionSet([r.uuid]))
			});
		return items;
	}
	/** the groups that share `groupId`'s parent — the crumb's siblings */
	function groupSiblingItems(groupId: string) {
		const all = nodes as any[];
		const parents = parentMap(all);
		const parent = parents.get(groupId) ?? null;
		return all
			.filter((n) => isGroup(n) && (parents.get(n.id) ?? null) === parent)
			.map((n) => ({ id: n.id, label: n.data?.label ?? 'Group' }))
			.sort((a, b) => a.label.localeCompare(b.label))
			.map((g) => ({
				label: g.label,
				icon: 'group',
				checked: g.id === groupId,
				tooltip: g.id === groupId && g.id !== level ? 'Back to this group' : 'Open this group',
				action: () => enterGroup(g.id)
			}));
	}
	const breadcrumbs = $derived.by(() => {
		const list: any[] = [
			{
				key: 'scene',
				label: 'Scene',
				icon: 'house',
				title: activeId === SCENE_GRAPH ? `Scene — the ${MAIN_GRAPH_LABEL} graph` : 'Scene — every flow in it',
				siblings: flowSwitchItems
			}
		];
		if (activeId !== SCENE_GRAPH)
			list.push({ key: 'object', label: activeOwnerName, icon: 'box', title: activeOwnerName + ' — object flow', siblings: flowSwitchItems });
		for (const c of crumbs)
			list.push({ key: 'group:' + c.id, label: c.label, icon: 'group', title: c.label + ' — group', siblings: () => groupSiblingItems(c.id) });
		return list;
	});

	// muted / collapsed cards: one generated stylesheet keyed by node id, so no node
	// component has to learn about either (CSS.escape keeps a hostile id inert)
	const flagsCss = $derived.by(() => {
		const rules: string[] = [];
		const esc = (id: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/[^\w-]/g, ''));
		for (const n of nodes as any[]) {
			if (n.hidden) continue;
			const sel = `.svelteFlow .svelte-flow__node[data-id="${esc(n.id)}"]`;
			if (n.data?.muted) rules.push(`${sel} .node-card{opacity:.45;filter:grayscale(.7)}${sel}::after{content:'muted';position:absolute;top:-9px;right:6px;font-size:9px;padding:0 4px;border-radius:4px;background:var(--border-strong);color:var(--text-2)}`);
			if (n.data?.collapsed && !isNote(n))
				rules.push(
					`${sel} .node-card>:last-child{position:absolute;inset:0 0 auto 0;height:0;padding:0;overflow:visible;visibility:hidden}${sel} .node-card>:last-child *{position:static}${sel} .node-card>:last-child .svelte-flow__handle{position:absolute!important;visibility:visible;top:14px!important}${sel} .node-card>:first-child{border-bottom:0}`
				);
			if (n.data?.collapsed && isNote(n)) rules.push(`${sel} .tp-note{height:28px!important}${sel} .tp-note-body{display:none}`);
		}
		return rules.join('\n');
	});

	// --- context menus ---

	function disconnectNode(id: string) {
		const ids = storeEdgesNow().filter((e) => e.source === id || e.target === id).map((e) => e.id);
		if (ids.length) commitDelete([], ids);
	}

	function deleteEdge(edge: any) {
		const ids = edge?.data?.proxy ? edge.data.reals ?? [] : [edge.id];
		if (ids.length) commitDelete([], ids);
	}

	/** a registry binding's current combo, for the menu hint */
	const hint = (id: string) => bindingOf(id) ?? undefined;

	function addNodeItems(flowPos: { x: number; y: number }) {
		return [
			...enabledCatalog([...nodeCatalog, ...$moduleNodeGroups], $disabledNodeTypes).map((group) => ({
				label: group.group,
				children: group.items.map((item: any) => ({
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
		];
	}

	function openPaneMenu(x: number, y: number, search = false) {
		const flowPos = screenToFlowPosition({ x, y });
		const clip = readClipboard();
		menu = {
			x,
			y,
			flowPos,
			search,
			items: [
				// 16-P2: the pane menu no longer carries its own search POPUP — this row
				// reveals the shared context-menu filter, which flattens every group as
				// "Group ▸ Node" with the same ranking as everywhere else. Typing
				// anywhere in the menu does the same thing (the filter input is always
				// focused), so this row is just the discoverable way in.
				{ label: 'Search nodes…', revealFilter: true, hint: hint('nodes.add-search') },
				{ label: 'Add note', icon: 'sticky-note', hint: hint('nodes.add-note'), action: () => addNote(flowPos) },
				...(clip?.nodes?.length
					? [{ label: `Paste ${clip.nodes.length} node${clip.nodes.length === 1 ? '' : 's'}`, icon: 'file-plus', hint: hint('nodes.paste'), action: () => pasteAt(flowPos) }]
					: []),
				{ label: 'Select all', hint: hint('nodes.select-all'), action: selectAll },
				{ label: 'Frame all', icon: 'focus', hint: hint('nodes.frame-all'), action: frameAll },
				{ label: 'Tidy graph', icon: 'network', hint: hint('nodes.tidy'), action: () => tidyGraph('layout') },
				{ label: 'Fix overlaps and crossings', icon: 'wand-sparkles', hint: hint('nodes.tidy-keep'), action: () => tidyGraph('repair') },
				{ label: 'Import node group (.tpnode)…', icon: 'folder-input', action: () => pickTpnode(flowPos) },
				...(level
					? [
							{ label: 'Leave group', icon: 'undo-2', hint: 'Esc', action: leaveGroup },
							{ label: 'Ungroup this group', hint: hint('nodes.ungroup'), action: () => ungroup(level ?? undefined) }
						]
					: []),
				{ section: 'Add' },
				...addNodeItems(flowPos)
			]
		};
	}

	const onPaneContextMenu = ({ event }: { event: MouseEvent }) => {
		event.preventDefault();
		openPaneMenu(event.clientX, event.clientY);
	};

	/** The menu for a SET of nodes (a multi-selection, or one node). */
	function selectionItems(list: any[]) {
		const one = list.length === 1 ? list[0] : null;
		const groups = list.filter(isGroup);
		const muted = list.some((n) => n.data?.muted);
		const collapsed = list.some((n) => n.data?.collapsed);
		const n = list.length;
		const items: any[] = [];
		if (one && (nodeHasCode(one, findNodeSpec(String(one.type))) || nodeUxHasCode(one))) items.push({ label: 'Open code', icon: 'file-text', action: () => openCode(one) });
		if (one && isGroup(one)) items.push({ label: 'Open group', icon: 'folder-input', hint: hint('nodes.enter-group'), action: () => enterGroup(one.id) });
		items.push({ label: n > 1 ? `Group ${n} nodes` : 'Group', icon: 'group', hint: hint('nodes.group'), action: groupSelection });
		if (groups.length) items.push({ label: groups.length > 1 ? `Ungroup ${groups.length}` : 'Ungroup', icon: 'ungroup', hint: hint('nodes.ungroup'), action: () => ungroup() });
		items.push({ label: 'Add note around', icon: 'sticky-note', hint: hint('nodes.note-around'), action: noteAroundSelection });
		items.push({ label: one && isGroup(one) ? 'Export group (.tpnode)…' : 'Export as node group (.tpnode)…', icon: 'download', action: () => exportTpnode(list.map((x) => x.id)) });
		items.push({ section: ' ' });
		items.push({ label: 'Duplicate', icon: 'copy', hint: hint('nodes.duplicate'), action: duplicateSelection });
		items.push({ label: 'Copy', icon: 'copy', hint: hint('nodes.copy'), action: () => copySelection(false) });
		items.push({ label: 'Cut', hint: hint('nodes.cut'), action: () => copySelection(true) });
		const clip = readClipboard();
		if (clip?.nodes?.length) items.push({ label: 'Paste', icon: 'file-plus', hint: hint('nodes.paste'), action: () => pasteAt() });
		items.push({ section: ' ' });
		if (!list.every(isNote)) items.push({ label: muted ? 'Unmute' : 'Mute (bypass)', icon: muted ? 'eye' : 'eye-off', hint: hint('nodes.mute'), action: toggleMute });
		items.push({ label: collapsed ? 'Expand' : 'Collapse', icon: collapsed ? 'chevron-down' : 'chevron-up', hint: hint('nodes.collapse'), action: toggleCollapse });
		items.push({ label: 'Frame', icon: 'focus', hint: hint('nodes.frame-selected'), action: frameSelected });
		if (n > 1)
			items.push({
				label: 'Align',
				icon: 'sliders-horizontal',
				children: [
					{ label: 'Column (left edges)', hint: hint('nodes.align-column'), action: () => arrangeSelection('column') },
					{ label: 'Row (top edges)', hint: hint('nodes.align-row'), action: () => arrangeSelection('row') },
					{ label: 'Distribute vertically', hint: hint('nodes.distribute-v'), disabled: n < 3, action: () => arrangeSelection('distributeV') },
					{ label: 'Distribute horizontally', hint: hint('nodes.distribute-h'), disabled: n < 3, action: () => arrangeSelection('distributeH') }
				]
			});
		if (one && !isNote(one)) items.push({ label: 'Disconnect all', icon: 'x', action: () => disconnectNode(one.id) });
		items.push({ label: n > 1 ? `Delete ${n} nodes` : 'Delete node', danger: true, icon: 'trash-2', hint: hint('nodes.delete'), action: deleteSelection });
		return items;
	}

	const onNodeContextMenu = ({ node, event }: { node: Node; event: MouseEvent }) => {
		event.preventDefault();
		if (isPseudo(node)) {
			menu = { x: event.clientX, y: event.clientY, items: [{ label: 'Leave group', icon: 'undo-2', hint: 'Esc', action: leaveGroup }] };
			return;
		}
		// right-clicking a node outside the selection makes it the selection (DCC rule)
		const sel = selectedVisible();
		const list = sel.some((n) => n.id === node.id) ? sel : [node];
		if (list.length === 1 && !(node as any).selected) selectOnly([node.id]);
		menu = { x: event.clientX, y: event.clientY, items: selectionItems(list) };
	};

	const onSelectionContextMenu = ({ event }: { nodes: Node[]; event: MouseEvent }) => {
		event.preventDefault();
		const sel = selectedVisible();
		if (!sel.length) return;
		menu = { x: event.clientX, y: event.clientY, items: selectionItems(sel) };
	};

	/**
	 * 36 (G1): double-click a node that has code → its code. xyflow has no node double-click
	 * event, so this listens in CAPTURE on the wrapper: a code node's double-click is consumed
	 * here (the pane's zoom-on-double-click never sees it); every other double-click — a text
	 * field inside a card, the bare pane, a node without code — passes through untouched.
	 */
	function onNodeDoubleClick(event: MouseEvent) {
		const target = event.target as HTMLElement | null;
		if (!target || target.closest('input, textarea, select, [contenteditable="true"], .cm-editor')) return;
		const el = target.closest('.svelte-flow__node') as HTMLElement | null;
		const id = el?.dataset?.id;
		const node = id ? (nodes as any[]).find((n) => n.id === id) : null;
		const spec = node ? findNodeSpec(node.type) : null;
		if (!node || !nodeHasCode(node, spec)) return;
		event.stopPropagation();
		event.preventDefault();
		void openCodeRequest(openCodeRequestFor(node, activeId, spec));
	}

	const onEdgeContextMenu = ({ edge, event }: { edge: Edge; event: MouseEvent }) => {
		event.preventDefault();
		menu = {
			x: event.clientX,
			y: event.clientY,
			items: [{ label: (edge as any).data?.proxy ? 'Disconnect (the wire inside the group)' : 'Disconnect', action: () => deleteEdge(edge) }]
		};
	};

</script>

<!-- 36 U11: the node editor is a KEY SCOPE — its keymap rows fire while a press landed here last -->
<div class="flex h-full w-full" data-key-scope="nodes">
	<!-- muted / collapsed cards (generated, keyed by node id) -->
	{@html '<style>' + flagsCss + '</style>'}
	<input id="flow-tpnode-input" type="file" accept=".tpnode,application/json" class="hidden" bind:this={tpnodeInput} onchange={onTpnodePicked} />
	{#if paletteOpen}
		<div
			class="flex h-full w-40 shrink-0 flex-col overflow-hidden"
			style="order: {paletteSide === 'right' ? 3 : 1}"
			bind:clientHeight={paletteColH}
		>
			<!-- #20 P7: the graph navigator sits ABOVE the palette in the same pane -->
			<GraphTree
				kind="flow"
				documents={$flowGraphs}
				sceneKey={SCENE_GRAPH}
				label="Flows"
				paneHeight={paletteColH}
			/>
			<div class="min-h-0 flex-1 overflow-y-auto" use:minimalScroll>
				<Sidebar onPick={addNodeAtCenter} onPlaceAt={addNodeAtScreen} />
			</div>
		</div>
	{/if}
	<!-- palette collapse/side controls: notebook-tab buttons on the divider (82) -->
	<div class="relative z-10 w-0" style="order: 2">
		<button
			id="palette-toggle"
			class="palette-tab {paletteSide === 'right' ? 'palette-tab-mirrored' : ''} absolute top-8 flex h-14 w-4 items-center justify-center bg-surface-2 text-[10px] text-text-2 hover:bg-surface-active"
			style="{paletteSide === 'right' ? 'right' : 'left'}: -1px"
			title={paletteOpen ? 'Hide the node palette' : 'Show the node palette'}
			onclick={() => {
				paletteOpen = !paletteOpen;
				writePanelOpen('flowPaletteOpen', paletteOpen);
			}}
		>
			{paletteOpen ? (paletteSide === 'right' ? '▸' : '◂') : paletteSide === 'right' ? '◂' : '▸'}
		</button>
		<button
			id="palette-side"
			class="palette-tab {paletteSide === 'right' ? 'palette-tab-mirrored' : ''} absolute top-24 flex h-9 w-4 items-center justify-center bg-surface-2 text-[9px] text-text-2 hover:bg-surface-active"
			style="{paletteSide === 'right' ? 'right' : 'left'}: -1px"
			title="Move the palette to the other side"
			onclick={() => {
				paletteSide = paletteSide === 'right' ? 'left' : 'right';
				safeStorage.setItem('flowPaletteSide', paletteSide);
			}}
		>
			⇄
		</button>
	</div>
	<!-- 41 G15: the graph column = the breadcrumb bar (in the layout flow, so it can never cover
	     the graph — the old floating chips wrapped into a tower over the nodes on a phone) + the pane -->
	<div class="flex h-full min-w-0 grow flex-col" style="order: {paletteSide === 'right' ? 1 : 3}">
		<Breadcrumbs id="flow-scope-chip" label="Flow location" menuKey="flowCrumbs" crumbs={breadcrumbs}>
			{#snippet actions()}
				<!-- A6.4: how many nodes in THIS graph cannot be rendered. Counted per graph, because that
				     is the graph the user is looking at; the Notification Center entry on scene load covers
				     the case where the editor is closed entirely. -->
				{#if unknownHere}
					<KitButton
						id="flow-unknown-badge"
						variant="warn-text"
						size="sm"
						icon="circle-alert"
						title="These nodes come from a module that isn't installed — click to open Modules"
						onclick={() => modulesOpen.set(true)}
					>{unknownHere} node{unknownHere === 1 ? ' needs' : 's need'} modules</KitButton>
				{/if}
				{#if level}
					<!-- 36 U11: one level out of a group (Esc / Tab do the same) -->
					<KitButton id="flow-group-leave" variant="icon" size="sm" icon="corner-left-up" label="Leave the group (Esc)" title="Leave the group (Esc)" onclick={leaveGroup} />
				{/if}
				{#if activeId !== SCENE_GRAPH && hasActiveGraph}
					<KitButton
						id="flow-scope-delete"
						variant="icon"
						size="sm"
						icon="trash-2"
						label="Delete this object's flow"
						title="Delete this object's flow"
						onclick={() => requestDeleteObjectGraph(activeId, activeOwnerName)}
					/>
				{/if}
			{/snippet}
		</Breadcrumbs>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="svelteFlow relative min-h-0 w-full flex-1"
		bind:this={paneEl}
		class:tp-has-keys={hasKeys}
		ondblclickcapture={onNodeDoubleClick}
		onpointerdown={onWrapPointerDown}
		onpointerup={onWrapPointerUp}
		onpointermove={onPointerMoveCursor}
		onpointerleave={onPointerLeaveCursor}
	>

		<!-- H1: empty state — the selected object has no flow document yet.
		     21-G1: it covers the pane, so a RIGHT-CLICK has to be forwarded or the pane
		     menu is unreachable in exactly the state where an object is selected — which
		     is the state the collectible recipe is FOR. (`addNode` already creates the
		     object's flow implicitly from here, for the palette; this gives the menu the
		     same courtesy.) An explanation must not behave like a modal. -->
		{#if activeId !== SCENE_GRAPH && !hasActiveGraph}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				id="flow-empty-state"
				class="absolute inset-0 z-5 flex flex-col items-center justify-center gap-3 bg-app/60 backdrop-blur-[2px]"
				oncontextmenu={(event) => onPaneContextMenu({ event })}
			>
				<p class="text-sm text-text-2">
					<span class="font-semibold text-text">{activeOwnerName}</span> has no flow yet
				</p>
				<button
					id="flow-create-btn"
					class="rounded-lg bg-accent-fill px-4 py-2 text-sm font-medium text-on-accent hover:brightness-110"
					onclick={() => createObjectGraph(activeId)}
				>
					Create flow
				</button>
				<p class="text-[11px] text-text-faint">Nodes here will drive this object (no Object Selector needed)</p>
			</div>
		{/if}
		<SvelteFlow
			bind:nodes
			{nodeTypes}
			bind:edges
			{snapGrid}
			bind:viewport
			{onbeforeconnect}
			{ondelete}
			{isValidConnection}
			panOnDrag={selectFirst ? [1, 2] : true}
			selectionOnDrag={selectFirst}
			selectionMode={SelectionMode.Partial}
			multiSelectionKey={selectFirst ? 'Shift' : undefined}
			defaultEdgeOptions={{ type: edgeStyle, markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 } }}
			deleteKey={null}
			panActivationKey={null}
			disableKeyboardA11y={true}
			onmovestart={onMoveStart}
			onmoveend={onMoveEnd}
			maxZoom={1}
			minZoom={0.2}
			ondragover={onDragOver}
			ondrop={onDrop}
			onnodedragstart={onNodeDragStart}
			onnodedrag={onNodeDrag}
			onnodedragstop={onNodeDragStop}
			onpanecontextmenu={onPaneContextMenu}
			onnodecontextmenu={onNodeContextMenu}
			onselectioncontextmenu={onSelectionContextMenu}
			onedgecontextmenu={onEdgeContextMenu}
			onpaneclick={() => (menu = null)}
		>
			{#if bgPattern !== 'none'}
				<!-- 180: {#key} forces a remount so a dots<->lines switch applies at
				     once (xyflow ignores a live variant change); softer low-alpha
				     colour so the grid stops reading like a high-contrast notebook -->
				{#key bgPattern}
					<Background bgColor="transparent" variant={bgVariant} lineWidth={0.6} patternColor="color-mix(in srgb, var(--text-faint) 18%, transparent)" />
				{/key}
			{/if}
			<Controls showLock={false}>
				<!-- 36 S4: Tidy graph (L) — the same layout the game templates are authored with -->
				<ControlButton id="flow-tidy" title={'Tidy graph (' + (hint('nodes.tidy') || 'L') + ')'} aria-label="Tidy graph" onclick={() => tidyGraph('layout')}>
					<Icon name="network" size={16} aria-hidden="true" />
				</ControlButton>
			</Controls>
			{#if showMinimap}
				<MiniMap
					pannable
					zoomable
					width={140}
					height={90}
					nodeColor={() => 'var(--border-strong)'}
					maskColor="color-mix(in srgb, var(--bg-app) 65%, transparent)"
				/>
			{/if}
		</SvelteFlow>
		<PeerCursors {viewport} />
	</div>
	</div>
	<!-- 166/179: flow PROPERTIES panel, auto-reflowed opposite the palette -->
	<div class="relative z-10 w-0" style="order: {propsSide === 'left' ? 0 : 4}">
		<button
			id="flow-props-toggle"
			class="palette-tab {propsSide === 'left' ? '' : 'palette-tab-mirrored'} absolute top-8 flex h-14 w-4 items-center justify-center bg-surface-2 text-xs text-text-2 hover:bg-surface-active"
			style="{propsSide === 'left' ? 'left' : 'right'}: -1px"
			title={propsOpen ? 'Hide properties' : 'Show properties'}
			onclick={() => { propsOpen = !propsOpen; writePanelOpen('flowPropsOpen', propsOpen); }}
		>
			⚙
		</button>
	</div>
	{#if propsOpen}
		<div id="flow-props" class="relative flex h-full w-52 shrink-0 flex-col gap-2 overflow-y-auto bg-surface-1 p-2 text-xs text-text-2" use:minimalScroll style="order: {propsSide === 'left' ? -1 : 5}">
			<!-- 4.3: Explorer-style tabs — ⓘ = the selected node's PARAMETERS,
			     ⚙ = graph settings + node name/note (as before) -->
			<div class="flex gap-1">
				<button id="flow-tab-info" class="flex-1 rounded-sm px-2 py-1 {propsTab === 'info' ? 'bg-accent-fill text-on-accent' : 'bg-surface-2 hover:bg-surface-active'}"
					onclick={() => { propsTab = 'info'; LS?.setItem('flowPropsTab', 'info'); }}>ⓘ Params</button>
				<button id="flow-tab-settings" class="flex-1 rounded-sm px-2 py-1 {propsTab === 'settings' ? 'bg-accent-fill text-on-accent' : 'bg-surface-2 hover:bg-surface-active'}"
					onclick={() => { propsTab = 'settings'; LS?.setItem('flowPropsTab', 'settings'); }}>⚙ Settings</button>
			</div>
			{#if propsTab === 'info'}
				{#if selectedNode}
					<p class="ui-section-label">{selectedNode.data?.label ?? selectedNode.type}</p>
					{#if nodeDoc(selectedNode.type)}
						<p id="flow-node-doc" class="text-[11px] leading-snug text-text-muted">{nodeDoc(selectedNode.type)}</p>
					{/if}
					{#if selectedNode.type === 'slider'}
						<label class="flex items-center justify-between gap-2">Min
							<input id="param-slider-min" class="ui-input w-16" type="number" value={selectedNode.data?.min ?? 0}
								onchange={(e) => setNodeData(selectedNode.id, { min: +e.currentTarget.value || 0 })} /></label>
						<label class="flex items-center justify-between gap-2">Max
							<input id="param-slider-max" class="ui-input w-16" type="number" value={selectedNode.data?.max ?? 40}
								onchange={(e) => setNodeData(selectedNode.id, { max: +e.currentTarget.value || 0 })} /></label>
					{:else if selectedNode.type === 'switcher'}
						{#each selectedNode.data?.items ?? ['cube', 'pyramid'] as item, i}
							<div class="flex items-center gap-1">
								<input class="ui-input flex-1" value={item}
									onchange={(e) => {
										const items = [...(selectedNode.data?.items ?? ['cube', 'pyramid'])];
										items[i] = e.currentTarget.value;
										setNodeData(selectedNode.id, { items });
									}} />
								<!-- 37 (R6): removing an item removes its input socket; wires into later items move
								     down with them, the radio keeps its item, groups follow — ONE undo step -->
								<KitButton variant="icon" size="sm" icon="x" label="Remove item" title="Remove item"
									onclick={() => removeVariadicSocket(selectedNode.id, i, activeId)} />
							</div>
						{/each}
						{#if switcherItems(selectedNode.data).length < MAX_SWITCHER_ITEMS}
							<KitButton id="param-switcher-add" variant="secondary" size="sm" icon="plus" text="Add item"
								onclick={() => addSwitcherItem(selectedNode.id, undefined, activeId)} />
						{/if}
						<!-- 37 (R6): what the item sockets and the `value` output carry -->
						<label class="flex items-center justify-between gap-2">Inputs carry
							<ThemedSelect
								id="param-switcher-vtype"
								items={SWITCHER_TYPES.map((t) => ({ value: t, name: t }))}
								value={switcherVType(selectedNode.data)}
								onchange={(v) => {
									const removed = setSwitcherType(selectedNode.id, v, activeId);
									if (removed > 0) showToast(removed + (removed === 1 ? ' wire' : ' wires') + ' removed — they cannot carry ' + v + '.');
								}} /></label>
					{:else if selectedNode.type === 'number'}
						<label class="flex items-center justify-between gap-2">Step
							<input id="param-number-step" class="ui-input w-16" type="number" min="0" value={selectedNode.data?.step ?? 1}
								onchange={(e) => setNodeData(selectedNode.id, { step: +e.currentTarget.value || 1 })} /></label>
					{:else}
						<NodeProperties node={selectedNode} /><!-- 36: every node's property schema -->
					{/if}
				{:else}
					<p class="text-text-muted">Select a node to edit its parameters.</p>
				{/if}
			{:else}
			{#if selectedNode && (isGroup(selectedNode) || isNote(selectedNode))}
				<!-- 36 U11: a group (name + socket names) / a note (title, markdown, colour) -->
				<NodeUxProps node={selectedNode} graphId={activeId} onOpen={(id) => enterGroup(id)} onUngroup={(id) => ungroup(id)} />
			{:else if selectedNode}
				<p class="ui-section-label">Node</p>
				<label class="flex flex-col gap-1">Name
					<input id="flow-node-name" class="ui-input" value={selectedNode.data?.label ?? ''}
						onchange={(e) => setNodeData(selectedNode.id, { label: e.currentTarget.value })} /></label>
				<label class="flex flex-col gap-1">Note
					<textarea class="ui-input" rows="2" value={selectedNode.data?.note ?? ''}
						onchange={(e) => setNodeData(selectedNode.id, { note: e.currentTarget.value })}></textarea></label>
			{:else}
				<p class="ui-section-label">Graph</p>
				<label class="flex flex-col gap-1">Edge style
					<ThemedSelect
						id="flow-edge-style"
						items={[{ value: 'bezier', name: 'Bezier' }, { value: 'smoothstep', name: 'Step' }, { value: 'straight', name: 'Straight' }]}
						value={edgeStyle}
						onchange={(v) => setEdgeStyle(v)} /></label>
				<label class="flex flex-col gap-1">Background
					<ThemedSelect
						id="flow-bg-pattern"
						items={[{ value: 'dots', name: 'Dots' }, { value: 'lines', name: 'Lines' }, { value: 'none', name: 'None' }]}
						value={bgPattern}
						onchange={(v) => { bgPattern = v; LS?.setItem('flowBg', v); }} /></label>
				<label class="flex items-center gap-2">
					<input id="flow-minimap-toggle" type="checkbox" checked={showMinimap}
						onchange={(e) => { showMinimap = e.currentTarget.checked; writePanelOpen('flowMinimap', showMinimap); }} /> Minimap</label>
				<label class="flex items-center gap-2">
					<input type="checkbox" checked={gridSnapOn}
						onchange={(e) => { gridSnapOn = e.currentTarget.checked; LS?.setItem('flowGridSnap', String(gridSnapOn)); }} /> Snap to grid</label>
				<label class="flex items-center gap-2">Grid size
					<input class="ui-input w-16" type="number" min="1" value={gridSize}
						onchange={(e) => { gridSize = +e.currentTarget.value || 25; LS?.setItem('flowGridSize', String(gridSize)); }} /></label>
				<div class="mt-1 flex gap-1">
					<button id="flow-fit" class="rounded-sm bg-surface-active px-2 py-1 hover:bg-border-strong" onclick={() => fitView()}>Fit</button>
					<button id="flow-reset-view" class="rounded-sm bg-surface-active px-2 py-1 hover:bg-border-strong" onclick={() => setViewport({ x: 0, y: 0, zoom: 1 })}>Reset view</button>
				</div>
				<!-- B4.2: socket type -> color legend (sockets are painted by TYPE now) -->
				<p class="ui-section-label mt-1">Socket types</p>
				<div id="socket-legend" class="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-text-2">
					{#each ['number', 'vector3', 'boolean', 'color', 'object', 'event', 'effect'] as t}
						<span class="flex items-center gap-1">
							<span class="inline-block h-2 w-2 rounded-full" style="background: {typeColor(t)}"></span>{t}
						</span>
					{/each}
				</div>
			{/if}
			{/if}
		</div>
	{/if}
</div>

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} sizeKey="nodes" startSearch={!!menu.search} on:close={() => (menu = null)} />
{/if}

<style>
	:global(.svelte-flow) {
		background-color: transparent !important;
	}
	:global(.svelte-flow__attribution) {
		display: none;
	}
	/* 36 U11: the pane that holds the keyboard says so (a hairline, the accent) */
	.svelteFlow.tp-has-keys {
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
	}
	/* xyflow ships chrome for its own built-in 'group' type (padding, border, a pale fill,
	   a hover shadow); our group draws its own card, so the wrapper must be bare */
	:global(.svelte-flow .svelte-flow__node-group) {
		padding: 0;
		border: none;
		background: transparent;
		width: auto;
		text-align: left;
		box-shadow: none !important;
	}
	/* notes sit BEHIND the cards (drawn first, and never elevated when selected) */
	:global(.svelte-flow__node-note) {
		z-index: 0 !important;
	}
	:global(.svelte-flow__edge.tp-proxy-edge .svelte-flow__edge-path) {
		stroke-dasharray: 6 3;
	}
</style>
