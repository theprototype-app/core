<script>
	import { onLayoutRestore, storedPanelLayout } from '$lib/uiLayoutsCore';
	// The Shader editor dock tab (plan SH3).
	//
	// SCOPE FOLLOWS THE SELECTION, exactly like the node editor's flow graphs: nothing
	// selected edits the SCENE default material, one object selected edits that object's
	// own. There is no scope switch to get wrong — deselect to go back to the scene — and
	// a scope with no graph gets one centred Create button (the `#flow-empty-state`
	// shape). Selection is read from the SET, never the sticky `selectedObject`, which
	// keeps the last object after a deselect and so can never signal "nothing selected".
	//
	// Separate xyflow instance from the node editor on purpose: flowGraphs,
	// allNodes()/allEdges(), nodesync and the flow hash stay byte-untouched. The bridge to
	// `shaderGraphs` is the Nodes.svelte shape — SvelteFlow 1.x binds PLAIN $state.raw
	// arrays, not stores, so the two are mirrored both ways behind a re-entrancy guard.
	import { untrack } from 'svelte';
	import { get } from 'svelte/store';
	import Icon from '../ui/Icon.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import {
		SvelteFlow,
		Background,
		BackgroundVariant,
		Controls,
		MiniMap,
		MarkerType,
		useSvelteFlow
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import '../../styles/flow.css';
	import { selectedObjects, objectsGroup } from '../../stores/sceneStore';
	import { shaderEditorClose, showToast, mobileUndockAllowed } from '../../stores/appStore.js';
	import {
		shaderGraphs,
		shaderErrors,
		SCENE_GRAPH_KEY,
		setShaderGraphFor,
		detachFrom,
		shaderTargetSupported,
		shaderRefusalReason
	} from '$lib/shaderGraph';
	import { beginShaderGesture, endShaderGesture } from '$lib/shaderSync';
	import { shaderNodeDefs, shaderNodeDef, SURFACE_NODE, POST_OUTPUT_NODE } from '$lib/shaderCatalog';
	// P4: the POST domain. The editor is one surface for two domains — same cards, same
	// palette, same pane menu — because a post graph IS a shader graph; what differs is
	// which nodes mean anything, which terminal node the graph ends at, and (since a post
	// graph belongs to no object) that the post half needs a scope control while the
	// surface half's scope is still the selection.
	import {
		shaderDomain,
		activePostGraph,
		postGraphKeys,
		postGraphName,
		createPostGraph,
		deletePostGraph,
		postPresets
	} from '$lib/postGraphs';
	import {
		setDockOccupant,
		dockHeight,
		visibleDockKey,
		dockMinimized,
		activateDock,
		dockModeArm,
		forgetDockTab
	} from '$lib/bottomDock';
	import { bottomDockable } from '$lib/bottomDockDrop';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable, resizeGroup, tabGroups } from '$lib/windowTabs';
	import { clampWinSize, clampResize, anchorOf } from '$lib/windowSize';
	import DockTabs from '../DockTabs.svelte';
	import WindowChrome from '../ui/WindowChrome.svelte';
	import Sheet from '../ui/Sheet.svelte';
	import Button from '../ui/Button.svelte';
	import ScrollStrip from '../ui/ScrollStrip.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import ShaderNode from './nodes/ShaderNode.svelte';
	import ShaderSidebar from './ShaderSidebar.svelte';
	import GraphTree from './GraphTree.svelte';
	import ShaderTexturePicker from './nodes/ShaderTexturePicker.svelte';
	import ShaderVectorInput from './nodes/ShaderVectorInput.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import { safeStorage } from '$lib/safeStorage';

	const nodeTypes = Object.fromEntries(shaderNodeDefs().map((def) => [def.key, ShaderNode]));
	const allDefs = shaderNodeDefs();
	/**
	 * The palette for ONE domain.
	 *
	 * `stages` absent means every stage, so the arithmetic and channel nodes are in both
	 * lists; a node declaring its stages is offered only where it means something. Showing
	 * the others anyway would be the worst outcome: the compiler refuses them BY NAME, so
	 * the user would place a card, wire it, and be told it belongs somewhere else — the
	 * palette is the right place to say so, before the wire.
	 * @param {string} which
	 */
	const catalogFor = (which) =>
		allDefs.filter(
			(def) =>
				def.key !== SURFACE_NODE &&
				def.key !== POST_OUTPUT_NODE &&
				(!def.stages || def.stages.includes(which === 'post' ? 'post' : 'fragment'))
		);
	const catalog = $derived(catalogFor($shaderDomain));
	const groups = $derived([...new Set(catalog.map((def) => def.group))]);
	const { screenToFlowPosition } = useSvelteFlow();

	const LS = typeof localStorage !== 'undefined' ? localStorage : null;

	// ---- scope: selection-driven in SURFACE, picked in POST ---------------------
	const selectedUuid = $derived($selectedObjects?.length === 1 ? $selectedObjects[0] : null);
	const isPost = $derived($shaderDomain === 'post');
	/** every post graph, re-derived off the store so a new one appears at once */
	/** @param {any} _poke */
	const graphsOf = (_poke) => postGraphKeys();
	const postGraphs = $derived(graphsOf($shaderGraphs));
	/** the post scope: the one asked for, else the first that exists, else none */
	const postScope = $derived(
		$activePostGraph && $shaderGraphs[$activePostGraph]
			? $activePostGraph
			: (postGraphs[0]?.key ?? '')
	);
	const scope = $derived(isPost ? postScope : (selectedUuid ?? SCENE_GRAPH_KEY));
	/** the navigator's list, split by domain (see its markup below) */
	const treeDocuments = $derived(
		Object.fromEntries(
			Object.entries($shaderGraphs).filter(([key]) => key.startsWith('post:') === isPost)
		)
	);
	const doc = $derived(scope ? ($shaderGraphs[scope] ?? null) : null);
	const errors = $derived(scope ? ($shaderErrors[scope] ?? []) : []);
	const ownerName = $derived(
		isPost
			? scope
				? postGraphName(scope)
				: 'No post effect'
			: scope === SCENE_GRAPH_KEY
				? 'The scene'
				: $objectsGroup?.getObjectByProperty('uuid', scope)?.name || 'This object'
	);
	const scopeLabel = $derived(
		isPost
			? ownerName + ' — post effect'
			: scope === SCENE_GRAPH_KEY
				? 'Scene default material'
				: ownerName + ' — own material'
	);

	// ---- graph settings (LOCAL prefs, the node editor's set) -------------------
	let propsOpen = $state(LS?.getItem('shaderPropsOpen') !== 'false');
	let paletteOpen = $state(LS?.getItem('shaderPaletteOpen') !== 'false');
	let propsTab = $state(LS?.getItem('shaderPropsTab') || 'settings');
	// #20 P7: the left column's own height, measured — the graph tree's resize ceiling
	let paletteColH = $state(0);
	// 38 NOTES-38 #36: below 640px of its OWN width (a docked phone panel, a narrowed window)
	// the two side columns squeezed the graph to a sliver. COMPACT gives the canvas the whole
	// width and opens the palette and the properties as kit Sheets from two buttons over it.
	// LOCAL, unsaved: the desktop column prefs (shaderPaletteOpen / shaderPropsOpen) are not
	// touched. 0 = hidden behind another dock tab, which is not narrow.
	let bodyW = $state(0);
	const compact = $derived(bodyW > 0 && bodyW < 640);
	let paletteSheet = $state(false);
	let propsSheet = $state(false);
	$effect(() => {
		if (!compact) {
			paletteSheet = false;
			propsSheet = false;
		}
	});
	/** a pick from the palette SHEET lands on the canvas and gets out of the way @param {string} key */
	function pickFromSheet(key) {
		addNodeAtCentre(key);
		paletteSheet = false;
	}
	let edgeStyle = $state(LS?.getItem('shaderEdgeStyle') ?? 'bezier');
	let bgPattern = $state(LS?.getItem('shaderBg') ?? 'dots');
	let showMinimap = $state(LS?.getItem('shaderMinimap') === 'true');
	let snapToGrid = $state(LS?.getItem('shaderSnap') === 'true');
	$effect(() => {
		LS?.setItem('shaderPropsOpen', String(propsOpen));
		LS?.setItem('shaderPaletteOpen', String(paletteOpen));
		LS?.setItem('shaderPropsTab', propsTab);
		LS?.setItem('shaderEdgeStyle', edgeStyle);
		LS?.setItem('shaderBg', bgPattern);
		LS?.setItem('shaderMinimap', String(showMinimap));
		LS?.setItem('shaderSnap', String(snapToGrid));
	});
	const bgVariant = $derived(
		bgPattern === 'lines'
			? BackgroundVariant.Lines
			: bgPattern === 'cross'
				? BackgroundVariant.Cross
				: BackgroundVariant.Dots
	);

	// ---- the xyflow bridge ------------------------------------------------------
	/** @type {any[]} */
	let nodes = $state.raw([]);
	/** @type {any[]} */
	let edges = $state.raw([]);
	let pushing = false;

	$effect(() => {
		const next = doc;
		const key = scope;
		untrack(() => {
			pushing = true;
			nodes = (next?.nodes ?? []).map((/** @type {any} */ n) => ({
				...n,
				// the card needs to know which document to write its params into
				data: { ...(n.data ?? {}), __graphKey: key }
			}));
			edges = next?.edges ?? [];
			pushing = false;
		});
	});

	$effect(() => {
		const localNodes = nodes;
		const localEdges = edges;
		untrack(() => {
			if (pushing || !doc) return;
			const stripped = localNodes.map((/** @type {any} */ n) => {
				const { __graphKey, ...rest } = n.data ?? {};
				return { ...n, data: rest };
			});
			if (
				JSON.stringify(stripped) !== JSON.stringify(doc.nodes) ||
				JSON.stringify(localEdges) !== JSON.stringify(doc.edges)
			)
				setShaderGraphFor(scope, { nodes: stripped, edges: localEdges });
		});
	});

	// ---- the selected node, for the properties pane ----------------------------
	const selectedNode = $derived(nodes.find((/** @type {any} */ n) => n.selected) ?? null);
	const selectedDef = $derived(selectedNode ? shaderNodeDef(selectedNode.type) : null);
	// SH7: the uniform NAMES this node's params compile to. Mirrors the compiler's naming
	// rule (`u_<nodeId>_<param>`) — the one place a user can read it, since a Set Shader
	// Uniform flow node has to name a uniform to write it.
	const uniformNames = $derived(
		(selectedDef?.params ?? [])
			.filter((/** @type {any} */ p) => p.uniform && p.type !== 'texture')
			.map((/** @type {any} */ p) => 'u_' + String(selectedNode?.id ?? '').replace(/[^A-Za-z0-9_]/g, '_') + '_' + p.name)
	);

	// ---- actions ---------------------------------------------------------------
	function createGraph() {
		if (isPost) {
			// in the post half "create" MINTS a document (there is no object to attach one
			// to), and the new one becomes the scope so you are looking at what you made
			activePostGraph.set(createPostGraph({}));
			return;
		}
		if (scope !== SCENE_GRAPH_KEY) {
			const object = $objectsGroup?.getObjectByProperty('uuid', scope);
			if (object && !shaderTargetSupported(object)) {
				showToast(shaderRefusalReason(object));
				return;
			}
		}
		setShaderGraphFor(scope, {
			nodes: [
				{ id: 'surface', type: SURFACE_NODE, position: { x: 380, y: 120 }, data: {} },
				{ id: 'colour', type: 'color', position: { x: 90, y: 130 }, data: { value: '#cccccc' } } // tokens-ok: the new graph's starting albedo (user-editable shader data)
			],
			edges: [
				{
					id: 'e-colour',
					source: 'colour',
					sourceHandle: 'out',
					target: 'surface',
					targetHandle: 'albedo'
				}
			]
		});
	}

	function removeGraph() {
		if (isPost) {
			if (scope) deletePostGraph(scope);
			activePostGraph.set(null);
			return;
		}
		if (scope !== SCENE_GRAPH_KEY) {
			const object = $objectsGroup?.getObjectByProperty('uuid', scope);
			if (object) detachFrom(object);
		}
		setShaderGraphFor(scope, null);
	}

	/** @param {string} key @param {{x:number,y:number}} [at] */
	function addNode(key, at) {
		if (!doc || !scope) return;
		const id = key + '_' + Math.random().toString(36).slice(2, 7);
		setShaderGraphFor(scope, {
			nodes: [...doc.nodes, { id, type: key, position: at ?? { x: 140, y: 120 }, data: {} }]
		});
	}

	/** @param {string} key */
	function addNodeAtCentre(key) {
		const box = paneEl?.getBoundingClientRect();
		const at = box
			? screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 })
			: undefined;
		addNode(key, at);
	}

	/** @param {string[]} ids */
	function deleteEdges(ids) {
		if (!doc || !ids.length) return;
		setShaderGraphFor(scope, {
			edges: doc.edges.filter((/** @type {any} */ e) => !ids.includes(e.id))
		});
	}

	/** @param {string} id */
	function deleteNode(id) {
		if (!doc) return;
		setShaderGraphFor(scope, {
			nodes: doc.nodes.filter((/** @type {any} */ n) => n.id !== id),
			// an orphaned edge would make the compiler walk a dangling reference
			edges: doc.edges.filter((/** @type {any} */ e) => e.source !== id && e.target !== id)
		});
	}

	/** @param {string} id */
	function disconnectNode(id) {
		if (!doc) return;
		setShaderGraphFor(scope, {
			edges: doc.edges.filter((/** @type {any} */ e) => e.source !== id && e.target !== id)
		});
	}

	/** @param {string} id */
	function duplicateNode(id) {
		if (!doc) return;
		const src = doc.nodes.find((/** @type {any} */ n) => n.id === id);
		if (!src) return;
		setShaderGraphFor(scope, {
			nodes: [
				...doc.nodes,
				{
					...src,
					id: src.type + '_' + Math.random().toString(36).slice(2, 7),
					position: { x: src.position.x + 32, y: src.position.y + 32 },
					data: { ...(src.data ?? {}) }
				}
			]
		});
	}

	// ---- context menus (the node editor's shape) -------------------------------
	/** @type {any} */
	let menu = $state(null);
	/** @type {HTMLDivElement|null} */
	let paneEl = $state(null);

	const onPaneContextMenu = (/** @type {any} */ arg) => {
		const event = arg?.event ?? arg;
		event.preventDefault?.();
		if (!doc) return;
		const at = screenToFlowPosition({ x: event.clientX, y: event.clientY });
		menu = {
			x: event.clientX,
			y: event.clientY,
			items: [
				// the shared context-menu FILTER: flattens every group as "Group ▸ Node"
				// with the same ranking as everywhere else, so typing searches the catalog
				{ label: 'Search nodes…', revealFilter: true },
				...groups.map((group) => ({
					label: group,
					children: catalog
						.filter((def) => def.group === group)
						.map((def) => ({ label: def.label, action: () => addNode(def.key, at) }))
				}))
			]
		};
	};

	const onNodeContextMenu = (/** @type {any} */ arg) => {
		const { node, event } = arg;
		event.preventDefault?.();
		const id = node.id;
		menu = {
			x: event.clientX,
			y: event.clientY,
			items: [
				{ label: 'Duplicate', action: () => duplicateNode(id) },
				{ label: 'Disconnect all', action: () => disconnectNode(id) },
				// the Surface output is the graph's terminal — there is exactly one, and a
				// graph without it cannot compile at all
				...(node.type === SURFACE_NODE
					? []
					: [{ label: 'Delete node', danger: true, action: () => deleteNode(id) }])
			]
		};
	};

	const onEdgeContextMenu = (/** @type {any} */ arg) => {
		const { edge, event } = arg;
		event.preventDefault?.();
		const id = edge.id;
		menu = {
			x: event.clientX,
			y: event.clientY,
			items: [{ label: 'Disconnect', danger: true, action: () => deleteEdges([id]) }]
		};
	};

	// Delete/Backspace: xyflow removes them from the bound arrays and the mirror writes
	// through, but a removed NODE must take its edges with it.
	const ondelete = (/** @type {any} */ arg) => {
		const deletedNodes = arg?.nodes ?? [];
		if (!deletedNodes.length || !doc) return;
		const ids = deletedNodes.map((/** @type {any} */ n) => n.id);
		setShaderGraphFor(scope, {
			edges: doc.edges.filter(
				(/** @type {any} */ e) => !ids.includes(e.source) && !ids.includes(e.target)
			)
		});
	};

	// refuse a connection GLSL cannot make sense of: a texture sampler is an OBJECT, not a
	// number, so it may only feed a socket that expects one. Everything else coerces.
	const isValidConnection = (/** @type {any} */ connection) => {
		const from = nodes.find((/** @type {any} */ n) => n.id === connection.source);
		const to = nodes.find((/** @type {any} */ n) => n.id === connection.target);
		if (!from || !to) return false;
		const out = (shaderNodeDef(from.type)?.outputs ?? []).find(
			(/** @type {any} */ o) => o.name === connection.sourceHandle
		);
		const inp = (shaderNodeDef(to.type)?.inputs ?? []).find(
			(/** @type {any} */ i) => i.name === connection.targetHandle
		);
		if (!out || !inp) return true;
		return (out.type === 'sampler2D') === (inp.type === 'sampler2D');
	};

	/** @param {DragEvent} event */
	function onDrop(event) {
		event.preventDefault();
		const key = event.dataTransfer?.getData('application/shadernode');
		if (!key) return;
		addNode(key, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
	}

	/** @param {string} name @param {any} value */
	function writeSelectedParam(name, value) {
		if (!selectedNode || !doc) return;
		setShaderGraphFor(scope, {
			nodes: doc.nodes.map((/** @type {any} */ n) =>
				n.id === selectedNode.id ? { ...n, data: { ...(n.data ?? {}), [name]: value } } : n
			)
		});
	}

	// ---- docked vs floating -----------------------------------------------------
	// UvEditor's split verbatim. This editor was the ONE dock view with no floating
	// mode at all — no `docked` flag, no window chrome, and an occupancy report that
	// never asked the question — which two other modules then had to code around
	// (`panelToggles`' `dockOnly` and `dockMenu` withholding Undock). Both of those
	// exceptions are gone with this block; the seventh view now behaves like its six
	// siblings and nothing has to know it is special.
	let docked = $state(true);
	const WIN_MIN = { minW: 380, minH: 280 };
	const WIN_DEFAULT = { w: 720, h: 480 };
	let winW = $state(720);
	let winH = $state(480);
	if (typeof localStorage !== 'undefined') {
		docked = safeStorage.getItem('shaderDocked') !== 'false';
		// 18-B: a size saved on a bigger screen must not come back oversized. Fitted
		// BEFORE the assignment so nothing reads $state during init.
		const savedWin = clampWinSize(
			parseInt(safeStorage.getItem('shaderWinW') ?? '720') || 720,
			parseInt(safeStorage.getItem('shaderWinH') ?? '480') || 480,
			WIN_MIN
		);
		winW = savedWin.w;
		winH = savedWin.h;
	}
	// touch / limited-width: keep the editor docked (no room to float; undock hidden),
	// unless the user opted into undocking on touch (Settings > Allow undocking)
	if (
		typeof window !== 'undefined' &&
		window.matchMedia?.('(pointer: coarse)').matches &&
		!get(mobileUndockAllowed)
	)
		docked = true;

	// 37 R14: a named workspace layout was applied — re-read the mode + floating size
	// this panel read ONCE above (it stays mounted while closed, so nothing else would)
	$effect(() =>
		onLayoutRestore(() => {
			const stored = storedPanelLayout(safeStorage.getItem, 'shader', 720, 480);
			docked = !!(stored.docked || (window.matchMedia?.('(pointer: coarse)').matches && !get(mobileUndockAllowed)));
			const fit = clampWinSize(stored.w, stored.h, WIN_MIN);
			winW = fit.w;
			winH = fit.h;
		})
	);

	function setDocked(/** @type {boolean} */ v) {
		docked = v;
		safeStorage.setItem('shaderDocked', String(v));
		if (v) activateDock('shader'); // re-docking makes it the visible tab
		else forgetDockTab('shader'); // an undock gives up its slot, so re-docking is a fresh add at the end of the strip
	}

	// W5: consume the shared dock-mode arm — the tab strip's right-click menu and its
	// drag-a-tab-out both ask through it, and `docked` above is read from localStorage
	// exactly ONCE at mount, so writing that flag from outside is inert; `setDocked`
	// owns the mode and is what has to run. Cleared as it is acted on. THIS is the seam
	// that makes "Undock" reach this view at all — the row was withheld until now
	// precisely because there was nothing here to consume the ask.
	$effect(() => {
		const arm = $dockModeArm;
		if (!arm || arm.key !== 'shader') return;
		dockModeArm.set(null);
		untrack(() => {
			if (arm.docked !== docked) setDocked(arm.docked);
			shaderEditorClose.set(false);
		});
	});

	const myGroup = $derived($tabGroups.find((g) => g.members.includes('shader')) ?? null);
	const effW = $derived(myGroup ? myGroup.rect.width : winW);
	const effH = $derived(myGroup ? myGroup.rect.height : winH);

	// dock presence — `docked` is part of the question now: a floating Shader editor is
	// open and is NOT a dock tab, and reporting it as one leaves a phantom in the strip.
	$effect(() => {
		setDockOccupant('shader', !$shaderEditorClose && docked, $dockHeight);
		return () => setDockOccupant('shader', false);
	});
	// W2: a MINIMIZED dock renders nothing while every tab stays open (the occupant
	// report above is untouched, so the strip comes back with its tabs intact)
	const dockVisible = $derived($visibleDockKey === 'shader' && !$dockMinimized);

	// W6: the top-edge dock resize, which this panel ALONE never had — its six siblings
	// have carried it since the dock existed, so the shared height silently froze
	// whenever the Shader editor was the tab on screen. Same handlers, same shared
	// `dockHeight`, same clamp (FlowCode is the reference), so the seven behave
	// identically. It now pairs with a corner grip in the floating mode, exactly as the
	// siblings do — the top edge sizes the shared dock, the corner sizes this window.
	const clampH = (/** @type {number} */ h) =>
		Math.min(Math.max(h || 320, 200), Math.round(window.innerHeight * 0.8));
	let resizing = $state(false);
	let winResizing = $state(false);
	function startResize(/** @type {any} */ e) {
		resizing = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function doResize(/** @type {any} */ e) {
		if (resizing) dockHeight.update((h) => clampH(h - e.movementY));
	}
	function endResize(/** @type {any} */ e) {
		if (resizing) {
			resizing = false;
			e.currentTarget.releasePointerCapture?.(e.pointerId);
		}
	}
	function startWinResize(/** @type {any} */ e) {
		winResizing = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
		e.stopPropagation();
	}
	function doWinResize(/** @type {any} */ e) {
		if (!winResizing) return;
		const baseW = myGroup ? myGroup.rect.width : winW;
		const baseH = myGroup ? myGroup.rect.height : winH;
		const at = anchorOf(e.currentTarget.parentElement);
		const fit = clampResize(baseW + e.movementX, baseH + e.movementY, at.left, at.top, WIN_MIN);
		winW = fit.w;
		winH = fit.h;
		resizeGroup('shader', winW, winH);
	}
	function endWinResize(/** @type {any} */ e) {
		if (!winResizing) return;
		winResizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		saveWinSize();
	}
	function saveWinSize() {
		safeStorage.setItem('shaderWinW', String(winW));
		safeStorage.setItem('shaderWinH', String(winH));
	}
	function resetWinSize() {
		const fit = clampWinSize(WIN_DEFAULT.w, WIN_DEFAULT.h, WIN_MIN);
		winW = fit.w;
		winH = fit.h;
		resizeGroup('shader', winW, winH);
		saveWinSize();
	}
	// 18-B: a window bigger than the screen can never be shrunk again, so re-fit on
	// every viewport change rather than only at load
	function fitToViewport() {
		const fit = clampWinSize(winW, winH, WIN_MIN);
		if (fit.w === winW && fit.h === winH) return;
		winW = fit.w;
		winH = fit.h;
		resizeGroup('shader', winW, winH);
	}
</script>

<svelte:window onresize={fitToViewport} />

<!-- The two chrome buttons every mode shows, as ONE snippet: the docked strip and the
     floating header differ ONLY in the mode button between them, and writing the pair
     out twice is how the two headers drift on the next button either gains. -->
<!-- P4: ONE control for the two domains, plus the post half's scope picker. A snippet
     because the editor has TWO headers (docked and floating) and a second copy would
     drift the moment either gains anything. -->
{#snippet domainSwitch()}
	<div class="tp-seg shader-domain" id="shader-domain" role="group" aria-label="Shader domain">
		<button
			class="tp-seg-btn"
			id="shader-domain-surface"
			aria-pressed={!isPost}
			title="Materials: this object's, or the scene's default"
			onclick={() => shaderDomain.set('surface')}>Surface</button
		>
		<button
			class="tp-seg-btn"
			id="shader-domain-post"
			aria-pressed={isPost}
			title="Post effects: a fragment over the finished frame, added to the scene look"
			onclick={() => shaderDomain.set('post')}>Post</button
		>
	</div>
	{#if isPost && postGraphs.length}
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<select
			id="shader-post-pick"
			class="shader-post-pick"
			title="Which post effect to edit"
			value={scope}
			onchange={(e) => activePostGraph.set(e.currentTarget.value)}
		>
			{#each postGraphs as entry (entry.key)}
				<option value={entry.key}>{entry.name}</option>
			{/each}
		</select>
	{/if}
{/snippet}

{#snippet editorActions()}
	{#if doc}
		<button
			class="ui-button-quiet"
			id="shader-remove"
			title="Remove this shader graph and restore the material"
			aria-label="Remove this shader graph"
			onclick={removeGraph}
		>
			<Icon name="trash-2" size={16} aria-hidden="true" />
		</button>
	{/if}
	<button class="tp-dock-btn"
		id="shader-close"
		title="Close"
		aria-label="Close the shader editor"
		onclick={() => shaderEditorClose.set(true)}><Icon name="x" size={16} /></button
	>
{/snippet}

{#snippet paletteContent(/** @type {number} */ paneH, /** @type {(key: string) => void} */ pick)}
					<!-- #20 P7: the graph navigator sits ABOVE the palette in the same pane -->
					<!-- the navigator shows the documents of the domain you are IN: it resolves a
					     key to the object that owns it, and a post graph owns no object, so
					     listing both halves together would offer rows that can go nowhere -->
					<GraphTree
						kind="shader"
						documents={treeDocuments}
						sceneKey={SCENE_GRAPH_KEY}
						label={isPost ? 'Post effects' : 'Shaders'}
						paneHeight={paneH}
					/>
					<div class="shader-side-scroll" use:minimalScroll>
						<ShaderSidebar onPick={pick} entries={catalog} />
					</div>
{/snippet}

{#snippet body()}
	{#if errors.length}
			<div class="shader-errors" id="shader-errors" use:minimalScroll>
				{#each errors as message, i (i)}<div>{message}</div>{/each}
			</div>
		{/if}

		<div class="shader-body" bind:clientWidth={bodyW}>
			{#if paletteOpen && !compact}
				<div class="shader-side shader-side-left" bind:clientHeight={paletteColH}>
					{@render paletteContent(paletteColH, addNodeAtCentre)}
				</div>
			{/if}
			{#if !compact}
			<button
				id="shader-palette-toggle"
				class="shader-divider"
				title={paletteOpen ? 'Hide the node palette' : 'Show the node palette'}
				aria-label="Toggle the node palette"
				onclick={() => (paletteOpen = !paletteOpen)}>{paletteOpen ? '‹' : '›'}</button
			>
			{/if}

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="shader-canvas"
				class:shader-canvas-compact={compact}
				data-key-scope="shader"
				bind:this={paneEl}
				ondrop={onDrop}
				ondragover={(e) => e.preventDefault()}
			>
				{#if doc}
					<SvelteFlow
						bind:nodes
						bind:edges
						{nodeTypes}
						{ondelete}
						{isValidConnection}
						onpanecontextmenu={onPaneContextMenu}
						onnodecontextmenu={onNodeContextMenu}
						onedgecontextmenu={onEdgeContextMenu}
						snapGrid={snapToGrid ? [16, 16] : undefined}
						defaultEdgeOptions={{
							type: edgeStyle,
							markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }
						}}
						deleteKey={['Backspace', 'Delete']}
						fitView
						minZoom={0.4}
						maxZoom={1.4}
					>
						<Background variant={bgVariant} />
						<Controls />
						{#if showMinimap}<MiniMap />{/if}
					</SvelteFlow>
				{:else}
					<!-- the `#flow-empty-state` shape: ONE centred call to action -->
					<div id="shader-empty-state" class="shader-empty">
						<p class="text-sm text-text-2">
							{#if isPost}
								No post effect to edit yet
							{:else}
								<span class="font-semibold text-text">{ownerName}</span> has no shader yet
							{/if}
						</p>
						<button id="shader-create-btn" class="shader-create" onclick={createGraph}>
							{isPost ? 'Create post effect' : 'Create shader'}
						</button>
						{#if isPost}
							<!-- the presets are the fastest way to see what the domain can do, and each
							     one is an ordinary graph you can then take apart -->
							<div class="shader-preset-row">
								{#each postPresets() as preset (preset.key)}
									<button
										class="shader-preset"
										title={preset.hint}
										onclick={() => activePostGraph.set(createPostGraph({ preset: preset.key }))}
										>{preset.label}</button
									>
								{/each}
							</div>
							<p class="text-[11px] text-text-faint">
								A post effect runs over the finished frame — add it to a look in Configure
								Scene ▸ Post-processing
							</p>
						{:else}
							<p class="text-[11px] text-text-faint">
								{scope === SCENE_GRAPH_KEY
									? 'A scene shader drives every object that has no shader of its own'
									: 'Deselect to edit the scene-wide shader instead'}
							</p>
						{/if}
					</div>
				{/if}
				{#if compact}
					<!-- the two side panels, one tap away (NOTES-38 #36) -->
					<div class="shader-fabs">
						<Button
							variant="secondary"
							size="sm"
							icon="plus"
							id="shader-palette-sheet-btn"
							aria-haspopup="dialog"
							aria-expanded={paletteSheet}
							onclick={() => { propsSheet = false; paletteSheet = !paletteSheet; }}>Nodes</Button
						>
						<Button
							variant="secondary"
							size="sm"
							icon="sliders-horizontal"
							id="shader-props-sheet-btn"
							aria-haspopup="dialog"
							aria-expanded={propsSheet}
							onclick={() => { paletteSheet = false; propsSheet = !propsSheet; }}>Properties</Button
						>
					</div>
				{/if}
			</div>

			{#if !compact}
			<button
				id="shader-props-toggle"
				class="shader-divider"
				title={propsOpen ? 'Hide properties' : 'Show properties'}
				aria-label="Toggle the properties panel"
				onclick={() => (propsOpen = !propsOpen)}>{propsOpen ? '›' : '‹'}</button
			>
			{/if}
			{#if propsOpen && !compact}
				<div class="shader-side shader-side-right" id="shader-props" use:minimalScroll>
					{@render propsContent()}
				</div>
			{/if}
		</div>
		{#if compact}
			<Sheet bind:open={paletteSheet} title="Nodes" detents={['half', 'full']} id="shader-palette-sheet">
				<div class="shader-sheet-body">{@render paletteContent(320, pickFromSheet)}</div>
			</Sheet>
			<Sheet bind:open={propsSheet} title="Properties" detents={['half', 'full']} id="shader-props-sheet">
				<div class="shader-sheet-body" id="shader-props">{@render propsContent()}</div>
			</Sheet>
		{/if}
{/snippet}

{#snippet propsContent()}
					<div class="shader-props-tabs">
						<button
							class:active={propsTab === 'info'}
							title="Selected node"
							aria-label="Selected node properties"
							onclick={() => (propsTab = 'info')}><Icon name="info" size={16} aria-hidden="true" /></button
						>
						<button
							class:active={propsTab === 'settings'}
							title="Graph settings"
							aria-label="Graph settings"
							onclick={() => (propsTab = 'settings')}
							><Icon name="settings" size={16} aria-hidden="true" /></button
						>
					</div>

					{#if propsTab === 'info' && selectedNode && selectedDef}
						<div class="shader-props-body" id="shader-props-node">
							<div class="shader-props-title">{selectedDef.label}</div>
							<!-- the MANUAL line for this node, straight from the catalog — the same text
							     the docs-site reference table is built from, so the two cannot drift -->
							{#if selectedDef.doc}
								<p class="shader-doc" id="shader-node-doc">{selectedDef.doc}</p>
							{/if}
							<label class="shader-field">
								<span>name</span>
								<input
									type="text"
									value={selectedNode.data?.label ?? ''}
									placeholder={selectedDef.label}
									onchange={(e) => writeSelectedParam('label', e.currentTarget.value)}
								/>
							</label>
							{#each selectedDef.params ?? [] as param (param.name)}
								{#if param.type === 'texture'}
									<!-- a div, not a label: the picker has its own around the file input -->
									<div class="shader-field">
										<span>{param.name}</span>
										<ShaderTexturePicker
											hash={selectedNode.data?.[param.name] ?? ''}
											onpick={(/** @type {string} */ next) => writeSelectedParam(param.name, next)}
										/>
									</div>
								{:else}
								<label class="shader-field">
									<span>{param.name}</span>
									{#if param.type === 'vec3' && typeof (selectedNode.data?.[param.name] ?? param.default) === 'string'}
										<input
											type="color"
											value={selectedNode.data?.[param.name] ?? param.default}
											oninput={(e) => writeSelectedParam(param.name, e.currentTarget.value)}
										/>
									{:else if param.type === 'vec2' || param.type === 'vec3' || param.type === 'vec4'}
										<ShaderVectorInput
											value={selectedNode.data?.[param.name] ?? param.default}
											size={param.type === 'vec2' ? 2 : param.type === 'vec4' ? 4 : 3}
											onchange={(/** @type {number[]} */ next) => writeSelectedParam(param.name, next)}
											onstart={() => beginShaderGesture(scope)}
											onend={() => endShaderGesture(scope)}
										/>
									{:else if param.type === 'float'}
										<DragRow
											step={0.005}
											decimals={3}
											value={selectedNode.data?.[param.name] ?? param.default}
											onscrubstart={() => beginShaderGesture(scope)}
											onscrubend={() => endShaderGesture(scope)}
											onchange={(/** @type {number} */ v) => writeSelectedParam(param.name, v)}
										/>
									{:else if param.type === 'enum'}
										<select
											value={selectedNode.data?.[param.name] ?? param.default}
											onchange={(e) => writeSelectedParam(param.name, e.currentTarget.value)}
										>
											{#each param.options ?? [] as option (option)}
												<option value={option}>{option}</option>
											{/each}
										</select>
									{:else}
										<input
											type="text"
											value={selectedNode.data?.[param.name] ?? param.default}
											onchange={(e) => writeSelectedParam(param.name, e.currentTarget.value)}
										/>
									{/if}
								</label>
								{/if}
							{/each}
							<p class="shader-hint">
								{(selectedDef.inputs ?? []).length} in · {(selectedDef.outputs ?? []).length} out
							</p>
							<!-- SH7: the generated UNIFORM NAMES, so a Set Shader Uniform flow node has
							     something to address. Without this the name is only discoverable by
							     reading the compiler's naming rule. -->
							{#if uniformNames.length}
								<p class="shader-hint">uniforms — paste into a Set Shader Uniform node:</p>
								{#each uniformNames as name (name)}
									<code class="shader-uniform-name">{name}</code>
								{/each}
							{/if}
						</div>
					{:else}
						<!-- no node selected: the GRAPH's own settings -->
						<div class="shader-props-body" id="shader-props-graph">
							<div class="shader-props-title">Graph</div>
							<label class="shader-field">
								<span>edges</span>
								<select bind:value={edgeStyle}>
									<option value="bezier">bezier</option>
									<option value="smoothstep">smoothstep</option>
									<option value="step">step</option>
									<option value="straight">straight</option>
								</select>
							</label>
							<label class="shader-field">
								<span>background</span>
								<select bind:value={bgPattern}>
									<option value="dots">dots</option>
									<option value="lines">lines</option>
									<option value="cross">cross</option>
								</select>
							</label>
							<label class="shader-field">
								<span>snap to grid</span>
								<input type="checkbox" bind:checked={snapToGrid} />
							</label>
							<label class="shader-field">
								<span>minimap</span>
								<input type="checkbox" bind:checked={showMinimap} />
							</label>
							{#if doc}
								<p class="shader-hint">
									{doc.nodes.length} nodes · {doc.edges.length} wires · {doc.backend}
								</p>
								<p class="shader-hint">Replicates to peers · saved with the scene</p>
							{:else if isPost}
								<p class="shader-hint">
									Create a post effect, then add it to a look in Configure Scene ▸
									Post-processing.
								</p>
							{:else}
								<p class="shader-hint">
									Select nothing for the scene shader, or one object for its own.
								</p>
							{/if}
						</div>
					{/if}
{/snippet}

<!-- The seventh dock view finally has both modes. The DOCKED branch keeps the render
     condition it always had (present only while it is the visible tab) and simply adds
     `docked`; the FLOATING branch is UvEditor's window verbatim — dragWindow, a KEYED
     focusStack, tabbable, bottomDockable and a corner grip. -->
{#if !$shaderEditorClose && docked && dockVisible}
	<div id="shader-editor" data-key-scope="panel" role="region" aria-label="Shader editor (docked)" class="shader-editor ui-panel tp-ui tp-dock-panel" style:height={$dockHeight + 'px'}>
		<!-- top-edge resize hot zone (above the tab strip's z-20, so the band can never
		     swallow the drag) -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="resize-cue absolute -top-1 left-0 right-0 z-30 h-2 cursor-ns-resize hover:bg-accent/30"
			style="touch-action: none"
			title="Drag to resize"
			onpointerdown={startResize}
			onpointermove={doResize}
			onpointerup={endResize}
		></div>
		<div class="shader-topbar">
			<DockTabs />
			<!-- the domain switch + scope scroll sideways on a narrow screen (NOTES-38 #39);
			     the window actions stay pinned at the right -->
			<ScrollStrip class="shader-strip" gap="var(--space-2)" label="Shader editor tools">
				{@render domainSwitch()}
				<span class="shader-scope" id="shader-scope">{scopeLabel}</span>
			</ScrollStrip>
			<div class="shader-actions">
				<button class="tp-dock-btn"
					id="shader-undock"
					title="Undock into a floating window"
					aria-label="Undock the shader editor"
					onclick={() => setDocked(false)}><Icon name="app-window" size={16} /></button
				>
				{@render editorActions()}
			</div>
		</div>
		{@render body()}
	</div>
{:else if !$shaderEditorClose && !docked}
	<div
		id="shader-window"
		class="ui-panel tp-ui tp-window fixed flex flex-col overflow-hidden"
		use:dragWindow={{ key: 'shader', defaultRect: { left: 240, top: 150 } }}
		use:focusStack={'shader'}
		use:tabbable={{
			key: 'shader',
			title: 'Shader editor',
			openStore: shaderEditorClose,
			isOpen: (/** @type {boolean} */ v) => !v,
			close: () => shaderEditorClose.set(true)
		}}
		use:bottomDockable={{ key: 'shader' }}
		style="z-index: var(--z-window); max-width: 96vw; max-height: 88vh"
		style:width="{effW}px"
		style:height="{effH}px"
	>
		<!-- 38 R6: the one window header (ui/WindowChrome, tool) -->
		<WindowChrome
			size="tool"
			bare
			body={false}
			title="Shader editor"
			headerClass="ui-panel-header move-handle cursor-move select-none"
		>
			{#snippet heading()}
				<span class="wc-label">Shader editor</span>
				{@render domainSwitch()}
				<span class="shader-scope" id="shader-scope">{scopeLabel}</span>
				<span class="flex-1"></span>
			{/snippet}
			{#snippet actions()}
				<button class="wc-act-text" id="shader-dock" title="Dock to the bottom" aria-label="Dock the shader editor" onclick={() => setDocked(true)}><Icon name="panel-bottom" size={16} />Dock</button>
				{@render editorActions()}
			{/snippet}
		</WindowChrome>
		{@render body()}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="resize-cue absolute bottom-0 right-0 z-10 h-3.5 w-3.5 cursor-se-resize rounded-tl bg-border-strong/40"
			style="touch-action: none"
			title="Drag to resize · double-click to reset size"
			onpointerdown={startWinResize}
			onpointermove={doWinResize}
			onpointerup={endWinResize}
			ondblclick={resetWinSize}
		></div>
	</div>
{/if}

{#if menu}
	<ContextMenu
		x={menu.x}
		y={menu.y}
		items={menu.items}
		sizeKey="shader"
		on:close={() => (menu = null)}
	/>
{/if}

<style>
	.shader-editor {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: var(--z-bottom, 35);
		display: flex;
		flex-direction: column;
		/* 38 R6: surface + top line from .tp-dock-panel (src/styles/windows.css); a docked
		   view sits flush, so no window corners or shadow from ui-panel */
		border-radius: 0;
		box-shadow: none;
	}
	.shader-topbar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 8px;
		border-bottom: 1px solid var(--border);
		flex: 0 0 auto;
	}
	.shader-scope {
		font-size: 11px;
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.shader-topbar > :global(.shader-strip) {
		flex: 1 1 auto;
	}
	.shader-actions {
		margin-left: auto;
		display: flex;
		gap: 4px;
	}
	.shader-body {
		flex: 1;
		min-height: 0;
		display: flex;
	}
	.shader-side {
		flex: 0 0 148px;
		overflow-y: auto;
		background: color-mix(in srgb, var(--bg-app) 18%, transparent);
	}
	.shader-side-left {
		border-right: 1px solid var(--border);
		/* #20 P7: the tree is a fixed-height section and the palette scrolls under it,
		   so the COLUMN owns the layout and the palette owns the scrolling */
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.shader-side-scroll {
		min-height: 0;
		flex: 1 1 auto;
		overflow-y: auto;
	}
	.shader-side-right {
		flex-basis: 172px;
		border-left: 1px solid var(--border);
	}
	.shader-divider {
		flex: 0 0 12px;
		background: color-mix(in srgb, var(--text) 4%, transparent);
		color: var(--text-muted);
		font-size: 10px;
	}
	.shader-divider:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.shader-canvas {
		position: relative;
		flex: 1;
		min-width: 0;
	}
	/* 38 NOTES-38 #36: compact — the canvas alone, the side panels a tap away */
	.shader-fabs {
		position: absolute;
		top: var(--space-2);
		left: var(--space-2);
		right: var(--space-2);
		z-index: 5;
		display: flex;
		justify-content: space-between;
		pointer-events: none;
	}
	.shader-fabs > :global(*) {
		pointer-events: auto;
		box-shadow: var(--shadow-window);
	}
	.shader-sheet-body {
		display: flex;
		flex-direction: column;
		min-height: 0;
		padding: 0 var(--space-3) var(--space-3);
	}
	/* a socket is an 8px dot: a finger gets an invisible 36px target around it (nothing changes
	   where it is drawn, and a mouse never sees it) */
	@media (pointer: coarse) {
		.shader-canvas :global(.svelte-flow__handle)::after {
			content: '';
			position: absolute;
			inset: -14px;
		}
	}
	.shader-errors {
		flex: 0 0 auto;
		background: color-mix(in srgb, var(--ink-bad) 15%, transparent);
		border-bottom: 1px solid color-mix(in srgb, var(--ink-bad) 40%, transparent);
		color: var(--ink-bad);
		font-size: 11px;
		padding: 3px 8px;
		max-height: 64px;
		overflow-y: auto;
	}
	.shader-domain {
		flex-shrink: 0;
	}
	.shader-post-pick {
		max-width: 11rem;
		flex-shrink: 1;
		border-radius: 0.25rem;
		border: 1px solid var(--border);
		background: var(--surface-inset);
		padding: 0 0.35rem;
		font-size: 0.7rem;
		color: var(--text);
	}
	.shader-preset-row {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.25rem;
	}
	.shader-preset {
		border-radius: 0.25rem;
		background: var(--surface-2);
		padding: 0.15rem 0.45rem;
		font-size: 0.7rem;
		color: var(--text);
	}
	.shader-preset:hover {
		background: var(--surface-active);
	}
	.shader-empty {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		text-align: center;
		padding: 0 24px;
	}
	.shader-create {
		border-radius: 8px;
		background: var(--accent-fill);
		padding: 8px 16px;
		font-size: 13px;
		font-weight: 500;
		color: var(--on-accent);
	}
	.shader-create:hover {
		filter: brightness(0.92);
	}
	.shader-props-tabs {
		display: flex;
		gap: 2px;
		padding: 4px;
		border-bottom: 1px solid var(--border);
	}
	.shader-props-tabs button {
		padding: 3px 7px;
		border-radius: 3px;
		color: var(--text-muted);
	}
	.shader-props-tabs button.active {
		background: var(--surface-hover);
		color: var(--text);
	}
	.shader-props-body {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 6px;
	}
	.shader-props-title {
		font-size: 11px;
		font-weight: 600;
		color: var(--text);
	}
	.shader-field {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
		font-size: 10px;
		color: var(--text-2);
	}
	.shader-field input[type='text'],
		.shader-field select {
		width: 88px;
		background: var(--surface-inset);
		border: 1px solid var(--border-input);
		border-radius: 3px;
		padding: 1px 3px;
		font-size: 10px;
		color: var(--text);
	}
	.shader-field input[type='color'] {
		width: 34px;
		height: 18px;
		padding: 0;
		border: 1px solid var(--border-strong);
		background: transparent;
	}
	.shader-hint {
		font-size: 9px;
		line-height: 1.35;
		color: var(--text-faint);
	}
	.shader-doc {
		font-size: 10px;
		line-height: 1.4;
		color: var(--text-2);
		background: color-mix(in srgb, var(--text) 4%, transparent);
		border-left: 2px solid var(--border-strong);
		border-radius: 0 3px 3px 0;
		padding: 4px 6px;
	}
	.shader-uniform-name {
		display: block;
		font-family: ui-monospace, monospace;
		font-size: 9px;
		color: var(--accent-text);
		background: var(--surface-inset);
		border-radius: 3px;
		padding: 1px 4px;
		/* selectable, so it can be copied: the graph canvas otherwise eats the drag */
		user-select: text;
		overflow-wrap: anywhere;
	}
</style>
