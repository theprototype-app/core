<script>
	// 34 PF — THE PROFILER TAB. Record (light, or detailed for per-object attribution and CPU
	// phases), keep recordings (rename / pin / delete / export .tpprof / import — beacon
	// exports included), read one on a TIMELINE of fps / frame ms / calls / triangles / quality
	// against the Quest budget, pick a frame or a range and see what it cost: the TREE (scene →
	// module/game → object → mesh/material), the RANKED "who draws most", the CPU PHASES and the
	// events — and COMPARE two recordings. A row selects its object in the scene and opens its
	// settings (the LOD section when it has a LOD group).
	//
	// A DOCK VIEW like the Explorer (not Flow-family): docked it is a tab in the bottom dock,
	// undocked a floating window — FlowCode's shell, one domain over. Everything here is LOCAL:
	// a recording is a fact about this device and nothing replicates.
	//
	// THE DATA is the recorder's (34-perf-data, contract T1); the maths is profilerModel.js;
	// the headset lane streams into `liveSources` (profilerView.js).
	import { onMount, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import Icon from '../ui/Icon.svelte';
	import { profilerLiveOpen } from '$lib/perf/liveSink';
	import DockTabs from '../DockTabs.svelte';
	import WindowChrome from '../ui/WindowChrome.svelte';
	import Icon from '../ui/Icon.svelte';
	import ProfilerTimeline from './profiler/ProfilerTimeline.svelte';
	import ProfilerDetail from './profiler/ProfilerDetail.svelte';
	import ProfilerRecordings from './profiler/ProfilerRecordings.svelte';
	import ProfilerCompare from './profiler/ProfilerCompare.svelte';
	import { selectDrawn } from './profiler/profilerScene.js';
	import { profilerClose } from '../../stores/appStore.js';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable, resizeGroup, tabGroups } from '$lib/windowTabs';
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
	import { safeStorage } from '$lib/safeStorage';
	import {
		perfState,
		startRecording,
		stopRecording,
		captureNow,
		listRecordings,
		getRecording,
		deleteRecording,
		renameRecording,
		pinRecording,
		exportRecording,
		importRecording,
		saveDocument,
		lightWindow,
		DETAILED_MS
	} from '$lib/perf/recorder.js';
	import { encodeTpprof, MOMENT_MS, TPPROF_EXT } from '$lib/perf/tpprof.js';
	import { spanOf, framesIn, fmtSec, fmtCount } from '$lib/perf/profilerModel.js';
	import { liveSources, profilerRequest } from '$lib/perf/profilerView.js';

	// ---------------------------------------------------------------- dock / float (FlowCode's shell)

	let docked = $state(true);
	let winW = $state(980);
	let winH = $state(460);
	if (typeof localStorage !== 'undefined') {
		docked = safeStorage.getItem('profilerDocked') !== 'false';
		winW = parseInt(safeStorage.getItem('profilerWinW') ?? '980') || 980;
		winH = parseInt(safeStorage.getItem('profilerWinH') ?? '460') || 460;
	}
	function setDocked(/** @type {boolean} */ v) {
		docked = v;
		safeStorage.setItem('profilerDocked', String(v));
		if (v) activateDock('profiler');
		else forgetDockTab('profiler');
	}
	$effect(() => {
		const arm = $dockModeArm;
		if (!arm || arm.key !== 'profiler') return;
		dockModeArm.set(null);
		untrack(() => {
			if (arm.docked !== docked) setDocked(arm.docked);
			profilerClose.set(false);
		});
	});
	const myGroup = $derived($tabGroups.find((g) => g.members.includes('profiler')) ?? null);
	const effW = $derived(myGroup ? myGroup.rect.width : winW);
	const effH = $derived(myGroup ? myGroup.rect.height : winH);
	$effect(() => {
		setDockOccupant('profiler', !$profilerClose && docked, $dockHeight);
		return () => setDockOccupant('profiler', false);
	});
	const dockVisible = $derived($visibleDockKey === 'profiler' && !$dockMinimized);

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
		winW = Math.min(Math.max(560, baseW + e.movementX), window.innerWidth - 8);
		winH = Math.min(Math.max(300, baseH + e.movementY), window.innerHeight);
		resizeGroup('profiler', winW, winH);
	}
	function endWinResize(/** @type {any} */ e) {
		if (!winResizing) return;
		winResizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		safeStorage.setItem('profilerWinW', String(winW));
		safeStorage.setItem('profilerWinH', String(winH));
	}

	// ---------------------------------------------------------------- recordings

	let rows = $state(/** @type {any[]} */ ([]));
	/** 'rec:<id>' | 'live:<id>' | 'doc' */
	let selected = $state(/** @type {string | null} */ (null));
	let doc = $state.raw(/** @type {import('$lib/perf/tpprof.js').Tpprof | null} */ (null));
	/** an unsaved document someone asked us to show (a beacon report, a moment) */
	let extraDoc = $state.raw(/** @type {import('$lib/perf/tpprof.js').Tpprof | null} */ (null));
	let extraLabel = $state('');
	let view = $state({ from: 0, to: 1 });
	let sel = $state(/** @type {{from: number, to: number} | null} */ (null));
	let tab = $state(safeStorage.getItem('profilerTab') || 'tree');
	let picked = $state(/** @type {string | null} */ (null));
	let status = $state('');
	let statusTone = $state(/** @type {'info' | 'warn'} */ ('info'));
	/** @param {string} text @param {'info' | 'warn'} [tone] */
	function say(text, tone = 'info') {
		status = text;
		statusTone = tone;
	}

	async function refresh() {
		try {
			rows = await listRecordings();
		} catch {
			rows = [];
		}
	}

	/** @param {string | null} key */
	async function loadKey(key) {
		if (!key) return null;
		if (key.startsWith('rec:')) return /** @type {any} */ (await getRecording(key.slice(4)));
		if (key.startsWith('live:'))
			return get(liveSources).find((s) => s.id === key.slice(5))?.doc ?? null;
		if (key === 'doc') return extraDoc;
		return null;
	}

	/** @param {string} key */
	async function select(key) {
		selected = key;
		const d = await loadKey(key);
		if (selected !== key) return; // a later click won
		doc = d;
		sel = null;
		picked = null;
		view = d ? spanOf(d) : { from: 0, to: 1 };
		if (!d && key.startsWith('rec:'))
			say('That recording could not be read (it may have been cleared).', 'warn');
	}

	// keep a selected LIVE source current (the stream may update many times a second)
	let liveTimer = /** @type {any} */ (null);
	$effect(() => {
		const list = $liveSources;
		const key = selected;
		if (!key?.startsWith('live:')) return;
		const src = list.find((s) => s.id === key.slice(5));
		if (!src?.doc || src.doc === doc) return;
		if (liveTimer) return;
		liveTimer = setTimeout(() => {
			liveTimer = null;
			const cur = get(liveSources).find((s) => s.id === key.slice(5))?.doc;
			if (!cur || selected !== key) return;
			const old = doc ? spanOf(doc) : null;
			const following = !old || view.to >= old.to - 1;
			doc = cur;
			const next = spanOf(cur);
			if (following) {
				const w = Math.min(view.to - view.from, next.to - next.from) || next.to - next.from;
				view = old ? { from: Math.max(next.from, next.to - w), to: next.to } : next;
			}
		}, 250);
	});

	// someone asked for something (openProfiler)
	$effect(() => {
		const req = $profilerRequest;
		if (!req) return;
		profilerRequest.set(null);
		untrack(async () => {
			if (req.doc) {
				extraDoc = req.doc;
				extraLabel = req.label || req.doc.meta?.name || 'Opened report';
				await select('doc');
			} else if (req.live) await select('live:' + req.live);
			else if (req.recording) {
				await refresh();
				await select('rec:' + req.recording);
			}
		});
	});

	// the list follows the recorder (a save, a VR recording, a moment)
	let lastVersion = -1;
	let wasRecording = /** @type {string | null} */ (null);
	let startedHere = /** @type {string | null} */ (null);
	$effect(() => {
		const s = $perfState;
		untrack(() => {
			const rec = s.recording?.id ?? null;
			if (s.version !== lastVersion && (!rec || rec !== wasRecording || s.saved !== rows.length)) {
				lastVersion = s.version;
				void refresh().then(() => {
					// a detailed recording that stopped itself: show it
					if (!rec && wasRecording && wasRecording === startedHere) {
						startedHere = null;
						void select('rec:' + wasRecording);
						say('Saved.');
					}
					wasRecording = rec;
				});
			}
		});
	});

	onMount(() => {
		// the first time the Profiler docks, give the (shared) dock room for five graphs and a tree
		if (docked && !safeStorage.getItem('profilerDockSized')) {
			safeStorage.setItem('profilerDockSized', '1');
			if (get(dockHeight) < 400)
				dockHeight.set(Math.min(440, Math.round(window.innerHeight * 0.55)));
		}
		void refresh().then(() => {
			if (!selected && rows.length) void select('rec:' + rows[0].id);
		});
	});

	// ---------------------------------------------------------------- recording controls

	let recMode = $state(
		/** @type {'light' | 'detailed'} */ (
			safeStorage.getItem('profilerRecMode') === 'detailed' ? 'detailed' : 'light'
		)
	);
	let detailedSecs = $state(
		parseInt(safeStorage.getItem('profilerDetailedSecs') ?? '') || DETAILED_MS / 1000
	);
	const recording = $derived($perfState.recording);
	let now = $state(Date.now());
	$effect(() => {
		if (!recording) return;
		const t = setInterval(() => (now = Date.now()), 250);
		return () => clearInterval(t);
	});

	function record() {
		safeStorage.setItem('profilerRecMode', recMode);
		safeStorage.setItem('profilerDetailedSecs', String(detailedSecs));
		const id = startRecording({
			mode: recMode,
			durationMs: recMode === 'detailed' ? detailedSecs * 1000 : 0
		});
		startedHere = id;
		wasRecording = id;
		say(
			recMode === 'detailed'
				? `Recording in detail${detailedSecs ? ` for ${detailedSecs} s` : ''} — per-object captures every second cost frame time.`
				: 'Recording. Stop when you have what you need.'
		);
	}
	async function stop() {
		const id = await stopRecording();
		startedHere = null;
		await refresh();
		if (id) {
			await select('rec:' + id);
			say('Saved.');
		}
	}
	async function lastThirty() {
		const at = new Date();
		const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
		const d = lightWindow(MOMENT_MS, {
			name: `Last 30 s ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
		});
		if (!d.frames.length)
			return say('Nothing recorded yet — the app has not drawn a frame.', 'warn');
		const id = await saveDocument(d);
		await refresh();
		await select('rec:' + id);
		say('Saved the last 30 seconds the app always keeps.');
	}

	// ---------------------------------------------------------------- rename / pin / delete / export / import

	/** @param {string} id @param {string} name */
	async function rename(id, name) {
		await renameRecording(id, name);
		await refresh();
		if (selected === 'rec:' + id && doc) doc = { ...doc, meta: { ...doc.meta, name } };
	}
	/** @param {string} id @param {boolean} on */
	async function pin(id, on) {
		await pinRecording(id, on);
		await refresh();
	}
	/** @param {string} id */
	async function remove(id) {
		const name = rows.find((r) => r.id === id)?.name ?? 'recording';
		await deleteRecording(id);
		await refresh();
		if (selected === 'rec:' + id) {
			selected = null;
			doc = null;
		}
		if (compareA === 'rec:' + id) compareA = null;
		if (compareB === 'rec:' + id) compareB = null;
		say(`Deleted ${name}.`);
	}
	/** @param {Blob} blob @param {string} name */
	function download(blob, name) {
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = (name.replace(/[^\w.\- ]+/g, '_').trim() || 'recording') + TPPROF_EXT;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 2000);
	}
	/** @param {string} key */
	async function exportKey(key) {
		if (key.startsWith('rec:')) {
			const blob = await exportRecording(key.slice(4));
			if (blob) download(blob, rows.find((r) => 'rec:' + r.id === key)?.name ?? 'recording');
			return;
		}
		const d = await loadKey(key);
		if (!d) return;
		if (key.startsWith('live:')) {
			// a live stream is saved as a copy (it keeps changing; the copy does not)
			const copy = structuredClone(d);
			copy.meta.name =
				(copy.meta.name || get(liveSources).find((s) => 'live:' + s.id === key)?.label || 'Live') +
				' (copy)';
			const id = await saveDocument(copy);
			await refresh();
			say('Saved a copy of the stream.');
			await select('rec:' + id);
			return;
		}
		download(
			new Blob([/** @type {BlobPart} */ (encodeTpprof(d))], { type: 'application/x-tpprof' }),
			d.meta.name || extraLabel || 'report'
		);
	}

	/** @type {HTMLInputElement | null} */
	let fileInput = $state(null);
	/** @param {FileList | File[]} files */
	async function importFiles(files) {
		let last = null;
		let ok = 0;
		/** @type {string[]} */
		const bad = [];
		for (const f of Array.from(files)) {
			try {
				last = await importRecording(f);
				ok++;
			} catch (e) {
				bad.push(`${f.name}: ${/** @type {any} */ (e)?.message ?? e}`);
			}
		}
		await refresh();
		if (last) await select('rec:' + last);
		if (bad.length) say(`${ok ? `Imported ${ok}. ` : ''}Could not read ${bad.join('; ')}`, 'warn');
		else if (ok) say(`Imported ${ok} recording${ok === 1 ? '' : 's'}.`);
	}

	let dropping = $state(false);
	/** files dropped on the panel are recordings (direct listeners: the window's own drop handler must not see them) @param {HTMLElement} node */
	function fileDrop(node) {
		const isFiles = (/** @type {DragEvent} */ e) =>
			!!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
		/** @param {DragEvent} e */
		const over = (e) => {
			if (!isFiles(e)) return;
			e.preventDefault();
			e.stopPropagation();
			dropping = true;
		};
		const leave = () => (dropping = false);
		/** @param {DragEvent} e */
		const drop = (e) => {
			if (!isFiles(e)) return;
			e.preventDefault();
			e.stopPropagation();
			dropping = false;
			if (e.dataTransfer?.files.length) void importFiles(e.dataTransfer.files);
		};
		node.addEventListener('dragover', over);
		node.addEventListener('dragleave', leave);
		node.addEventListener('drop', drop);
		return {
			destroy() {
				node.removeEventListener('dragover', over);
				node.removeEventListener('dragleave', leave);
				node.removeEventListener('drop', drop);
			}
		};
	}

	// ---------------------------------------------------------------- compare

	let compareOn = $state(false);
	let compareA = $state(/** @type {string | null} */ (null));
	let compareB = $state(/** @type {string | null} */ (null));
	let docA = $state.raw(/** @type {any} */ (null));
	let docB = $state.raw(/** @type {any} */ (null));
	function toggleCompare() {
		compareOn = !compareOn;
		if (compareOn && !compareA && !compareB) {
			// a sensible start: the selected one as B, the next older as A
			const list = rows.map((r) => 'rec:' + r.id);
			if (selected && list.includes(selected)) {
				compareB = selected;
				compareA = list[list.indexOf(selected) + 1] ?? null;
			} else {
				compareB = list[0] ?? null;
				compareA = list[1] ?? null;
			}
		}
	}
	/** @param {'a' | 'b'} slot @param {string} key */
	function setCompare(slot, key) {
		if (slot === 'a') compareA = key;
		else compareB = key;
	}
	$effect(() => {
		const a = compareA;
		const b = compareB;
		if (!compareOn) return;
		untrack(async () => {
			docA = await loadKey(a);
			docB = await loadKey(b);
		});
	});
	/** @param {string | null} key */
	function labelOf(key) {
		if (!key) return '–';
		if (key.startsWith('rec:')) return rows.find((r) => 'rec:' + r.id === key)?.name ?? key;
		if (key.startsWith('live:'))
			return $liveSources.find((s) => 'live:' + s.id === key)?.label ?? key;
		return extraLabel;
	}

	// ---------------------------------------------------------------- picking in the scene

	/** @param {{uuid: string | null, label: string, scene: boolean}} row */
	function pick(row) {
		picked = row.uuid;
		if (!row.uuid) return say(`${row.label} is a material — pick an object to select it.`);
		const r = selectDrawn(row.uuid);
		if (r.ok) say(`Selected ${r.name}${r.lod ? ' — its LOD group is in the properties' : ''}.`);
		else if (r.reason === 'missing')
			say(
				`${row.label} is not in the open scene (the recording was made elsewhere, or it was deleted).`,
				'warn'
			);
		else
			say(
				`${row.label} belongs to ${r.owner} — module and editor content cannot be selected.`,
				'warn'
			);
	}
	/** @param {number} t */
	function jump(t) {
		if (!doc) return;
		const f = framesIn(doc.frames, t, t)[0];
		if (!f) return;
		sel = { from: f.t - f.ms, to: f.t };
		const w = view.to - view.from;
		const s = spanOf(doc);
		const from = Math.min(Math.max(s.from, f.t - w / 2), Math.max(s.from, s.to - w));
		view = { from, to: from + w };
	}
	/** @param {string} t */
	function setTab(t) {
		tab = t;
		safeStorage.setItem('profilerTab', t);
	}

	/**
	 * The panel keeps its own navigation keys. The editor's shortcuts listen on the WINDOW, and
	 * Tab there means "enter mesh edit" — so Tab-ing from one profiler button to the next put
	 * the selected object into edit mode. Bare navigation keys pressed on a control inside the
	 * panel stop at the DOCUMENT: after svelte's delegated handlers (they run at the app root,
	 * below it — a listener on the panel itself would kill them, the rename box's Enter first)
	 * and before the window. The browser still does its default (focus moves, a button
	 * presses), and combos (Ctrl+Z, Ctrl+S) still reach the editor.
	 * @param {HTMLElement} node
	 */
	function ownKeys(node) {
		const OWN = new Set([
			'Tab',
			'Enter',
			' ',
			'ArrowUp',
			'ArrowDown',
			'ArrowLeft',
			'ArrowRight',
			'Home',
			'End',
			'PageUp',
			'PageDown',
			'Escape',
			'Delete',
			'Backspace'
		]);
		/** @param {KeyboardEvent} e */
		const key = (e) => {
			if (e.ctrlKey || e.metaKey || e.altKey || !OWN.has(e.key)) return;
			const t = e.target instanceof HTMLElement ? e.target : null;
			if (
				t &&
				t !== node &&
				node.contains(t) &&
				t.closest('button, select, input, a, [role="slider"], [tabindex]')
			)
				e.stopPropagation();
		};
		document.addEventListener('keydown', key);
		return { destroy: () => document.removeEventListener('keydown', key) };
	}

	// side by side when there is room, stacked when there is not
	let mainW = $state(900);
	const wide = $derived(mainW >= 860);
	/** @param {HTMLElement} node */
	function measure(node) {
		const ro = new ResizeObserver(() => (mainW = node.clientWidth));
		ro.observe(node);
		return { destroy: () => ro.disconnect() };
	}

	const meta = $derived(doc?.meta ?? null);
	const moduleList = $derived(
		meta ? Object.entries(meta.modules ?? {}).map(([id, v]) => `${id} ${v}`) : []
	);
	/** a short device name out of a user agent @param {string} ua */
	function deviceName(ua) {
		if (/OculusBrowser|Quest/i.test(ua)) return (ua.match(/Quest[ \w]*/i)?.[0] ?? 'Quest').trim();
		if (/Android/i.test(ua)) return 'Android';
		if (/iPhone|iPad/i.test(ua)) return 'iOS';
		if (/Mac OS X/i.test(ua)) return 'macOS';
		if (/Windows/i.test(ua)) return 'Windows';
		if (/Linux/i.test(ua)) return 'Linux';
		return ua.slice(0, 24);
	}
	const qualityRange = $derived.by(() => {
		if (!doc) return '';
		let lo = Infinity;
		let hi = -Infinity;
		for (const f of doc.frames)
			if (typeof f.quality === 'number')
				((lo = Math.min(lo, f.quality)), (hi = Math.max(hi, f.quality)));
		return lo === Infinity ? '–' : lo === hi ? String(lo) : `${lo}–${hi}`;
	});
	const recElapsed = $derived(recording ? Math.max(0, now - recording.startedAt) : 0);
</script>

{#snippet controls()}
	{#if recording}
		<span id="profiler-recording" class="pf-rec-on" data-mode={recording.mode} role="status">
			<span class="pf-rec-dot" aria-hidden="true"></span>
			Recording {recording.mode} · {fmtSec(recElapsed)} · {fmtCount(recording.frames)} frames
		</span>
		{#if recording.mode === 'detailed'}
			<button
				class="ui-button-quiet"
				title="Take a per-object capture now"
				onclick={() => void captureNow()}
				><Icon name="camera" size={16} class="inline" aria-hidden="true" /> Capture</button
			>
		{/if}
		<button id="profiler-stop" class="ui-button-quiet pf-stop" onclick={stop}
			><Icon name="square" size={16} class="inline" aria-hidden="true" /> Stop</button
		>
	{:else}
		<div class="tp-seg" role="group" aria-label="Recording mode">
			<button
				class="tp-seg-btn"
				id="profiler-mode-light"
				aria-pressed={recMode === 'light'}
				title="Frame time, draw calls, triangles and quality — always cheap"
				onclick={() => (recMode = 'light')}>Light</button
			>
			<button
				class="tp-seg-btn"
				id="profiler-mode-detailed"
				aria-pressed={recMode === 'detailed'}
				title="Also per-object draw attribution and CPU phases — costs frame time"
				onclick={() => (recMode = 'detailed')}>Detailed</button
			>
		</div>
		{#if recMode === 'detailed'}
			<select class="pf-select" aria-label="Detailed recording length" bind:value={detailedSecs}>
				<option value={5}>5 s</option>
				<option value={10}>10 s</option>
				<option value={30}>30 s</option>
				<option value={0}>until stopped</option>
			</select>
		{/if}
		<button id="profiler-record" class="ui-button-quiet pf-record" onclick={record}
			><Icon name="circle" size={16} class="inline" aria-hidden="true" /> Record</button
		>
		<button
			id="profiler-last30"
			class="ui-button-quiet"
			title="Save the last 30 seconds the app always keeps (light)"
			onclick={lastThirty}><Icon name="history" size={16} class="inline" aria-hidden="true" /> Last 30 s</button
		>
	{/if}
	<button
		id="profiler-import"
		class="ui-button-quiet"
		title="Open .tpprof recordings or beacon exports (or drop them on the panel)"
		onclick={() => fileInput?.click()}
		><Icon name="upload" size={16} class="inline" aria-hidden="true" /> Import</button
	>
	<button
		id="profiler-compare-toggle"
		class="ui-button-quiet"
		aria-pressed={compareOn}
		class:pf-on={compareOn}
		onclick={toggleCompare}
		><Icon name="git-compare" size={16} class="inline" aria-hidden="true" /> Compare</button
	>
	<!-- 36 U5: the Live view (a peer's frames as they arrive) opens from here now — it used to be
	     a burger-menu row, away from the tool it belongs to -->
	<button
		id="profiler-open-live"
		class="ui-button-quiet"
		title="Watch a peer's frames live (a headset in your room)"
		onclick={() => profilerLiveOpen.set(true)}
		><Icon name="activity" size={16} class="inline" aria-hidden="true" /> Live</button
	>
	<input
		bind:this={fileInput}
		id="profiler-file"
		type="file"
		multiple
		accept=".tpprof,.json,.gz,application/json,application/gzip"
		class="hidden"
		onchange={(e) => {
			const input = /** @type {HTMLInputElement} */ (e.currentTarget);
			if (input.files?.length) void importFiles(input.files);
			input.value = '';
		}}
	/>
{/snippet}

{#snippet body()}
	<div class="pf-body" class:pf-dropping={dropping} use:fileDrop>
		<aside class="pf-side">
			<ProfilerRecordings
				{rows}
				live={$liveSources}
				{selected}
				{compareOn}
				{compareA}
				{compareB}
				onselect={(k) => void select(k)}
				onrename={(id, name) => void rename(id, name)}
				ondelete={(id) => void remove(id)}
				onpin={(id, on) => void pin(id, on)}
				onexport={(k) => void exportKey(k)}
				oncompare={setCompare}
			/>
			{#if selected === 'doc' && extraDoc}
				<p class="pf-extra">
					Showing <b>{extraLabel}</b> (not saved)
					<button
						class="ui-button-quiet"
						onclick={async () => {
							if (!extraDoc) return;
							const id = await saveDocument(structuredClone(extraDoc));
							await refresh();
							await select('rec:' + id);
						}}>Save</button
					>
				</p>
			{/if}
		</aside>
		<section class="pf-main" use:measure aria-label="Recording">
			{#if compareOn}
				{#if docA && docB}
					<ProfilerCompare
						a={docA}
						b={docB}
						aLabel={labelOf(compareA)}
						bLabel={labelOf(compareB)}
						onpick={pick}
					/>
				{:else}
					<p class="pf-hint">
						Pick <b>A</b> (the baseline) and <b>B</b> (the new one) in the list.
					</p>
				{/if}
			{:else if doc && meta}
				<div id="profiler-meta" class="pf-meta" title={meta.device}>
					<b class="pf-meta-name">{meta.name || 'Recording'}</b>
					<span>{meta.mode}{meta.kind && meta.kind !== 'recording' ? ' · ' + meta.kind : ''}</span>
					<span>{fmtSec(meta.durationMs ?? spanOf(doc).to)} · {doc.frames.length} frames</span>
					<span>v{meta.version} · {String(meta.build).slice(0, 7)}</span>
					<span title={moduleList.join('\n') || 'no modules'}
						>{moduleList.length} module{moduleList.length === 1 ? '' : 's'}</span
					>
					<span>{deviceName(meta.device)}{meta.gpu ? ' · ' + meta.gpu.slice(0, 40) : ''}</span>
					{#if meta.xr}<span>VR</span>{/if}
					{#if meta.refreshRate}<span>{meta.refreshRate} Hz</span>{/if}
					{#if meta.framebufferScale}<span>×{meta.framebufferScale}</span>{/if}
					<span>quality {qualityRange}</span>
					{#if meta.scene}<span>scene {meta.scene}</span>{/if}
					{#if meta.game}<span>game {meta.game}</span>{/if}
				</div>
				<div class="pf-split" class:pf-wide={wide}>
					<div class="pf-tl">
						<ProfilerTimeline
							{doc}
							{view}
							{sel}
							onview={(v) => (view = v)}
							onselect={(s) => (sel = s)}
						/>
					</div>
					<div class="pf-detail">
						<ProfilerDetail {doc} {sel} {tab} ontab={setTab} onpick={pick} onjump={jump} {picked} />
					</div>
				</div>
			{:else}
				<p class="pf-hint">
					Record a few seconds of the scene — <b>Light</b> costs nothing, <b>Detailed</b> also says
					which objects the draw calls go to. Or import a <code>.tpprof</code>.
				</p>
			{/if}
			{#if status}
				<p
					id="profiler-status"
					class="pf-status"
					class:pf-warn={statusTone === 'warn'}
					role="status"
				>
					{status}
				</p>
			{/if}
		</section>
	</div>
{/snippet}

{#if !$profilerClose}
	{#if docked}
		<div
			id="profiler-dock"
			use:ownKeys
			class="tp-themed fixed inset-x-0 bottom-0 tp-ui tp-dock-panel flex flex-col p-2 {dockVisible
				? ''
				: 'hidden'}"
			style="z-index: var(--z-bottom); height: {$dockHeight}px; border-top: 1px solid var(--tp-line)"
			data-key-scope="panel"
			role="region"
			aria-label="Profiler (docked)"
		>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="resize-cue hover:bg-primary-600/30 absolute -top-1 right-0 left-0 z-30 h-2 cursor-ns-resize"
				style="touch-action: none"
				title="Drag to resize"
				onpointerdown={startResize}
				onpointermove={doResize}
				onpointerup={endResize}
			></div>
			<DockTabs />
			<div class="pf-head flex shrink-0 items-center gap-1 pb-1">
				<span class="tp-dock-title">Profiler</span>
				<span class="w-2"></span>
				{@render controls()}
				<span class="flex-1"></span>
				<button class="tp-dock-btn"
					title="Undock into a floating window"
					aria-label="Undock the Profiler"
					onclick={() => setDocked(false)}><Icon name="app-window" size={16} /></button
				>
				<button class="tp-dock-btn"
					title="Close"
					aria-label="Close the Profiler"
					onclick={() => profilerClose.set(true)}><Icon name="x" size={16} /></button
				>
			</div>
			<div class="flex min-h-0 flex-1 flex-col">
				{@render body()}
			</div>
		</div>
	{:else}
		<div
			id="profiler-window"
			use:ownKeys
			class="ui-panel tp-themed pf-surface fixed flex flex-col overflow-hidden"
			use:dragWindow={{ key: 'profilerWin', defaultRect: { left: 120, top: 100 } }}
			use:focusStack={'profiler'}
			use:tabbable={{
				key: 'profiler',
				title: 'Profiler',
				openStore: profilerClose,
				isOpen: (v) => !v,
				close: () => profilerClose.set(true)
			}}
			use:bottomDockable={{ key: 'profiler' }}
			style="z-index: var(--z-window); max-width: 98vw; max-height: 90vh"
			style:width="{effW}px"
			style:height="{effH}px"
		>
			<!-- 38 R6: the one window header (ui/WindowChrome, tool) -->
			<WindowChrome
				size="tool"
				bare
				body={false}
				title="Profiler"
				headerClass="ui-panel-header move-handle cursor-move select-none"
				onclose={() => profilerClose.set(true)}
				closeLabel="Close the Profiler"
				closeAttrs={{ title: 'Close' }}
			>
				{#snippet heading()}
					<span class="wc-label">Profiler</span>
					{#if !myGroup}{@render controls()}{/if}
					<span class="flex-1"></span>
				{/snippet}
				{#snippet actions()}
					<button class="wc-act-text" title="Dock to the bottom" onclick={() => setDocked(true)}><Icon name="panel-bottom" size={16} />Dock</button>
				{/snippet}
			</WindowChrome>
			{#if myGroup}
				<div
					class="flex shrink-0 flex-wrap items-center gap-1 border-b border-gray-700/60 px-2 py-1"
				>
					{@render controls()}
				</div>
			{/if}
			<div class="flex min-h-0 flex-1 flex-col p-2">
				{@render body()}
			</div>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="resize-cue absolute right-0 bottom-0 z-10 h-3.5 w-3.5 cursor-se-resize rounded-tl bg-gray-500/40"
				style="touch-action: none"
				title="Drag to resize"
				onpointerdown={startWinResize}
				onpointermove={doWinResize}
				onpointerup={endWinResize}
			></div>
		</div>
	{/if}
{/if}

<style>
	.pf-body {
		display: grid;
		grid-template-columns: minmax(180px, 230px) 1fr;
		gap: 8px;
		min-height: 0;
		flex: 1 1 auto;
		height: 100%;
		border-radius: 4px;
	}
	.pf-dropping {
		outline: 2px dashed var(--accent, #3b82f6);
		outline-offset: -2px;
	}
	.pf-side {
		min-height: 0;
		overflow-y: auto;
		border-right: 1px solid var(--tp-line);
		padding-right: 4px;
	}
	.pf-main {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.pf-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 10px;
		font-size: 10.5px;
		color: var(--tp-muted);
		padding-bottom: 3px;
		flex: 0 0 auto;
		max-height: 32px;
		overflow: hidden;
	}
	.pf-meta-name {
		color: var(--tp-ink);
		font-weight: 600;
	}
	.pf-split {
		display: grid;
		grid-template-rows: minmax(120px, 45%) 1fr;
		gap: 6px;
		min-height: 0;
		flex: 1 1 auto;
	}
	.pf-split.pf-wide {
		grid-template-rows: none;
		grid-template-columns: minmax(300px, 1fr) minmax(360px, 46%);
	}
	.pf-tl,
	.pf-detail {
		min-height: 0;
		min-width: 0;
	}
	.pf-hint {
		margin: 12px 4px;
		font-size: 12px;
		color: var(--tp-muted);
	}
	.pf-status {
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--tp-muted);
		padding-top: 2px;
	}
	.pf-warn {
		color: var(--ink-warn);
	}
	.pf-extra {
		font-size: 11px;
		color: var(--tp-muted);
		margin-top: 6px;
	}
	.pf-select {
		width: auto;
		height: 20px;
		padding: 0 4px;
		font-size: 11px;
		border-radius: 3px;
		background: var(--tp-field);
		border: 1px solid var(--tp-line);
		color: var(--tp-ink);
	}
	.pf-record :global(svg) {
		color: var(--ink-bad);
		fill: var(--ink-bad);
	}
	.pf-rec-on {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11px;
		color: var(--ink-bad);
		font-variant-numeric: tabular-nums;
	}
	.pf-rec-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--ink-bad);
		animation: pf-pulse 1s ease-in-out infinite;
	}
	@keyframes pf-pulse {
		50% {
			opacity: 0.3;
		}
	}
	.pf-on {
		background: var(--accent-fill, #2563eb);
		color: var(--on-accent, #fff);
	}
	/* 36 U1: `ui-panel` is `@apply bg-gray-800`, which no theme remap reaches — the floating
	   window owns its surface like the toolbox shell does */
	.pf-surface {
		background: var(--tp-surface);
		color: var(--tp-ink);
		border-color: var(--tp-line);
	}
</style>
