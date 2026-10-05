// @ts-nocheck — test glue run in two places (node vitest + an injected browser script), typed by
// the env it is handed (src/lib/sdk/lifecycleEnv.js), not by imports it cannot have.
// THE MODULE LIFECYCLE CONTRACT (34 R6, contract T2) — one table, two runners.
//
// Every member of the module SDK declares what it does to a module's lifecycle
// (`sdkX.surface` beside each slice in src/lib/sdk/). This file holds the PROOF for every
// member that declares 'registers': a fixture that makes the registration from inside a
// real module, checks CORE's registry shows it, unloads the module (`unloadModule`), and
// checks the registry is back where it was. A 'registers' member with no fixture, a member
// with no declaration, or a declaration naming a member that is gone, all FAIL.
//
// Deliberately a plain script with no imports or exports: node vitest loads it
// (tests/unit/moduleLifecycle.test.js) and the browser suite injects it with
// `addScriptTag` (tests/e2e/module-lifecycle.test.cjs), and both hand it the same `env`
// (src/lib/sdk/lifecycleEnv.js). Node runs every fixture whose modules it can load; the
// browser runs ALL of them.
//
// A fixture: `{needs?, call(api, t), present(t), absent?(t), cleanup?(t)}`. `call` runs
// inside the module's register(); `present` reads core's state (never the journal); `absent`
// defaults to `!present`. `needs` names env.mods entries, or 'browser' / 'objects' / 'scene'
// / 'raf' / 'media'. `t = {id, env, api, data}` carries state between the steps.
(function () {
	/** the four kinds a member may declare (see SURFACE_KINDS in src/lib/sdk/lifecycle.js) */
	const KINDS = ['registers', 'action', 'content', 'read', 'value'];

	/** Walk one api slice into member paths, the way makeApi assembles it. */
	function membersOf(obj) {
		const out = [];
		const walk = (o, prefix, depth) => {
			for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(o))) {
				const path = prefix + k;
				if (d.get) {
					out.push(path);
					continue;
				}
				const v = d.value;
				if (typeof v === 'function') {
					out.push(path);
					// 36 U8: a member may hang a sub-member off a function (`api.input.actions` —
					// `api.input()` stays the snapshot). Enumerable own props only: length/name/
					// prototype are not, so plain methods add nothing here.
					if (depth < 1) for (const fk of Object.keys(v)) if (typeof v[fk] === 'function') out.push(path + '.' + fk);
				} else if (v && typeof v === 'object' && depth < 1 && !v.isObject3D && k !== 'THREE') walk(v, path + '.', depth + 1);
				else out.push(path);
			}
		};
		walk(obj, '', 0);
		return out;
	}

	/** Every slice's members against its declaration. */
	function checkSurface(env) {
		const report = { members: 0, noSurface: [], undeclared: [], stale: [], badKind: [], registers: [] };
		for (const [name, slice] of env.SDK_TABLE) {
			const declared = slice.surface;
			const probeId = '__surface_probe__';
			const members = membersOf(slice(env.makeContext(probeId, probeId)));
			report.members += members.length;
			if (!declared || typeof declared !== 'object') {
				report.noSurface.push(name);
				continue;
			}
			for (const m of members) {
				if (!(m in declared)) report.undeclared.push(name + ': ' + m);
				else if (!KINDS.includes(declared[m])) report.badKind.push(name + ': ' + m + ' = ' + declared[m]);
				else if (declared[m] === 'registers') report.registers.push(m);
			}
			for (const m of Object.keys(declared)) if (!members.includes(m)) report.stale.push(name + ': ' + m);
		}
		return report;
	}

	function fixtures(env) {
		const { get, THREE } = env;
		const R = env.registries;
		const M = env.mods;
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		/** a throwaway mesh in objectsGroup (local only — nothing is sent) */
		const scratch = (t) => {
			const group = get(M.sceneStore.objectsGroup);
			const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial());
			mesh.name = 'lc-scratch-' + t.id;
			mesh.position.set(0, -40, 0);
			group.add(mesh);
			t.data.scratch = mesh;
			return mesh;
		};
		const dropScratch = (t) => t.data.scratch?.parent?.remove(t.data.scratch);
		/** a coalesced store listener: present = poking the store reaches it */
		const listenerFixture = (needs, register, poke) => ({
			needs,
			call(api, t) {
				t.data.calls = 0;
				t.data.off = register(api, () => t.data.calls++);
			},
			async present(t) {
				const before = t.data.calls;
				poke(t);
				await sleep(160); // coalesce: one frame or its 100 ms timer
				return t.data.calls > before;
			}
		});

		/** 34 R2 kit pieces: each piece's FIRST event listener (`on<Event>`), counted in the kit */
		const kitFixtures = {};
		const kitRt = M.kitRuntime;
		for (const spec of kitRt ? kitRt.kit.specs() : []) {
			const ev = spec.calls.find((c) => c.kind === 'event');
			if (!ev) continue;
			const method = 'on' + ev.name.charAt(0).toUpperCase() + ev.name.slice(1);
			const key = spec.piece + '.' + ev.name;
			// the entity pieces keep their listeners in the entities runtime (kit/entityHub.js)
			const count = () => kitRt.kit.listenerCount(key) + (kitRt.kitEntitiesRuntime?.()?.listenerCount?.() ?? 0);
			kitFixtures['kit.' + spec.piece] = {
				needs: ['kitRuntime'],
				call(api, t) {
					t.data.before = count();
					api.kit[spec.piece][method](() => {});
				},
				present: (t) => count() > t.data.before
			};
		}

		return {
			...kitFixtures,
			// 36 (U10): an engine piece lent to behaviours (behaviours/engines.js)
			'kit.provide': {
				needs: ['engines'],
				call(api, t) {
					api.kit.provide({ piece: 'lc' + String(t.id).replace(/[^a-z0-9]/gi, '').toLowerCase(), group: 'LC', calls: [{ name: 'ping', kind: 'action', label: 'Ping' }] }, { ping() {} });
				},
				present: (t) => M.engines.enginesDebug().some((p) => p.piece === 'lc' + String(t.id).replace(/[^a-z0-9]/gi, '').toLowerCase())
			},
			// ---- nodes ---------------------------------------------------------------------
			registerNodeGroup: {
				call: (api, t) => api.registerNodeGroup({ group: 'LC ' + t.id, items: [{ type: 'lc-node-' + t.id, label: 'x' }] }),
				present: (t) => get(R.moduleNodeGroups).some((g) => g.items.some((i) => i.type === 'lc-node-' + t.id))
			},
			registerEffect: {
				call: (api, t) => api.registerEffect('lc-eff-' + t.id, () => {}, { inputs: { target: 'object' } }),
				present: (t) => !!R.moduleEffects['lc-eff-' + t.id]
			},
			registerValueNode: {
				needs: ['moduleNodeIO'],
				call: (api, t) => api.registerValueNode('lc-val-' + t.id, () => 1),
				present: (t) => !!M.moduleNodeIO.moduleValueNodes['lc-val-' + t.id]
			},
			registerNodeDefs: {
				needs: ['customNodes'],
				call: (api, t) => api.registerNodeDefs([{ key: 'k', name: 'LC', params: [], code: '' }]),
				present: (t) => !!M.customNodes.findNodeDef('mod-' + t.id + '-k')
			},
			// ---- scene ---------------------------------------------------------------------
			registerPrimitive: {
				needs: ['customGeometries'],
				call: (api, t) =>
					api.registerPrimitive('LcPrim' + t.id, () => new THREE.BoxGeometry(), { label: 'LC', command: '/create LcPrim' + t.id }),
				present: (t) =>
					!!M.customGeometries.customGeometryBuilders['LcPrim' + t.id] &&
					get(R.modulePrimitiveGroups).some((g) => g.items.some((i) => i.moduleId === t.id))
			},
			registerClickHandler: {
				call(api, t) {
					t.data.fn = () => false;
					api.registerClickHandler(t.data.fn);
				},
				present: (t) => R.moduleClickHandlers.includes(t.data.fn)
			},
			registerDropHandler: {
				call(api, t) {
					t.data.fn = () => false;
					api.registerDropHandler(t.data.fn);
				},
				present: (t) => R.moduleDropHandlers.includes(t.data.fn)
			},
			registerFrameTask: {
				call(api, t) {
					t.data.fn = () => {};
					api.registerFrameTask(t.data.fn);
				},
				present: (t) => R.moduleFrameTasks.includes(t.data.fn)
			},
			registerInteractiveGroup: {
				needs: ['moduleContent'],
				call(api, t) {
					const scene = M.sceneStore && get(M.sceneStore.globalScene);
					if (scene) {
						const g = new THREE.Group();
						g.name = 'lc-group-' + t.id;
						g.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial()));
						scene.add(g);
						t.data.group = g;
					}
					api.registerInteractiveGroup('lc-group-' + t.id);
				},
				present: (t) =>
					R.moduleInteractiveGroups.includes('lc-group-' + t.id) &&
					!!M.moduleContent.moduleGroupOf('lc-group-' + t.id) &&
					(!t.data.group || !!t.data.group.parent),
				// the module's scene-root content goes with it (and its GPU resources: removeAndDispose)
				absent: (t) =>
					!R.moduleInteractiveGroups.includes('lc-group-' + t.id) &&
					!M.moduleContent.moduleGroupOf('lc-group-' + t.id) &&
					(!t.data.group || !t.data.group.parent)
			},
			registerSystemGroup: {
				needs: ['moduleContent'],
				call: (api, t) => api.registerSystemGroup('lc-sys-' + t.id),
				present: (t) => R.systemGroupNames.includes('lc-sys-' + t.id) && !!M.moduleContent.moduleGroupOf('lc-sys-' + t.id)
			},
			registerListedGroup: {
				needs: ['moduleContent'],
				call: (api, t) => api.registerListedGroup('lc-list-' + t.id, { label: 'LC' }),
				present: (t) => !!M.moduleContent.moduleGroupOf('lc-list-' + t.id)
			},
			onSceneClear: {
				call(api, t) {
					t.data.fn = () => {};
					api.onSceneClear(t.data.fn);
				},
				present: (t) => R.sceneClearHandlers.includes(t.data.fn)
			},
			// ---- player / net --------------------------------------------------------------
			setSpawn: {
				needs: ['playSettings'],
				call: (api) => api.setSpawn([1, 0, 1], 0),
				present: (t) => get(M.playSettings.runtimeSpawn)?.owner === t.id
			},
			onMessage: {
				call(api, t) {
					t.data.fn = () => {};
					api.onMessage(t.data.fn);
				},
				present: (t) => !!R.messageHandlers[t.id]?.includes(t.data.fn)
			},
			registerStateSync: {
				call(api, t) {
					t.data.sync = { getState: () => null, applyState: () => {} };
					api.registerStateSync(t.data.sync);
				},
				present: (t) => R.stateSyncs[t.id] === t.data.sync
			},
			// ---- ui ------------------------------------------------------------------------
			registerMenu: {
				call: (api) => api.registerMenu('LC', () => {}),
				present: (t) => get(R.moduleMenuItems).some((i) => i.moduleId === t.id)
			},
			registerToolbox: {
				needs: ['moduleToolboxes'],
				call(api, t) {
					// the shortcut only where shortcuts.js loads (its import would reject in node)
					const shortcut = M.shortcuts ? 'Ctrl+Alt+Shift+F9' : undefined;
					t.data.box = api.registerToolbox({ id: 'box', title: 'LC ' + t.id, mount: () => {}, shortcut });
				},
				// the box AND its shortcut (the shortcut was never removed before 34 R6) — the
				// shortcut half is read where shortcuts.js loads (the browser)
				present: (t) =>
					get(M.moduleToolboxes.moduleToolboxes).some((b) => b.moduleId === t.id) &&
					(!M.shortcuts || M.shortcuts.shortcuts.some((s) => s.id === 'module:' + t.id + ':toolbox:' + t.data.box)),
				absent: (t) =>
					!get(M.moduleToolboxes.moduleToolboxes).some((b) => b.moduleId === t.id) &&
					(!M.shortcuts || !M.shortcuts.shortcuts.some((s) => s.id === 'module:' + t.id + ':toolbox:' + t.data.box))
			},
			registerVRMenuEntry: {
				needs: ['vrRadialMenu'],
				call: (api) => api.registerVRMenuEntry({ id: 'lc', label: 'LC', action: () => {} }),
				present: (t) => !!M.vrRadialMenu.findMenuEntry(t.id + ':lc')
			},
			// ---- input ---------------------------------------------------------------------
			registerBindings: {
				needs: ['shortcuts'],
				call: (api) => api.registerBindings([{ label: 'LC', keys: 'Ctrl+Alt+Shift+F8' }]),
				present: (t) => M.shortcuts.shortcuts.some((s) => s.group === 'Module: ' + t.id)
			},
			'input.actions': {
				needs: ['touchActions'],
				call: (api) => api.input.actions(['jump', { id: 'lc', label: 'LC', keys: ['F21'] }], { preset: 'platformer' }),
				present: (t) => get(M.touchActions.touchDeclarations).some((d) => d.owner === t.id)
			},
			onInput: {
				needs: ['inputRuntime', 'browser'],
				call(api, t) {
					t.data.calls = 0;
					api.onInput((kind, code) => {
						if (code === 'F21') t.data.calls++;
					});
				},
				present(t) {
					const before = t.data.calls;
					window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F21', key: 'F21' }));
					window.dispatchEvent(new KeyboardEvent('keyup', { code: 'F21', key: 'F21' }));
					return t.data.calls > before;
				}
			},
			claimInput: {
				needs: ['inputRuntime'],
				call: (api) => api.claimInput('sticks'),
				present: () => M.inputRuntime.isClaimed('sticks')
			},
			// ---- feel / sound / view -------------------------------------------------------
			onHit: {
				needs: ['knock', 'objects'],
				call(api, t) {
					scratch(t);
					t.data.calls = 0;
					api.onHit(() => t.data.calls++);
				},
				async present(t) {
					await sleep(30); // the listener attaches when knock's primed import settles
					const before = t.data.calls;
					M.knock.noteRemoteHit({ uuid: t.data.scratch.uuid, speed: 1 }, 'lc-peer');
					return t.data.calls > before;
				},
				cleanup: dropScratch
			},
			'music.play': {
				needs: ['gameMusic', 'sceneStore', 'browser'],
				call(api, t) {
					// music plays only in Interact/Play (it is refused from Edit)
					t.data.mode = get(M.sceneStore.editorMode);
					M.sceneStore.editorMode.set('interact');
					t.data.ok = api.music.play('ambient', { volume: 0 });
				},
				present: (t) => t.data.ok && get(M.gameMusic.gameMusicState)?.owner === t.id,
				absent: (t) => get(M.gameMusic.gameMusicState)?.owner !== t.id,
				cleanup: (t) => M.sceneStore.editorMode.set(t.data.mode ?? 'edit')
			},
			followCam: {
				needs: ['possess', 'objects'],
				call(api, t) {
					const mesh = scratch(t);
					t.data.ok = api.followCam(mesh.uuid);
				},
				present: (t) => t.data.ok && get(M.possess.followingCam) === t.data.scratch.uuid,
				absent: (t) => get(M.possess.followingCam) !== t.data.scratch.uuid,
				cleanup: dropScratch
			},
			vrPanel: {
				needs: ['vrPointer'],
				call(api, t) {
					t.data.panel = new THREE.Group();
					api.vrPanel(t.data.panel);
				},
				present: (t) => M.vrPointer.overlayPanelsDebug().includes(t.data.panel)
			},
			// ---- game ----------------------------------------------------------------------
			'game.onChange': listenerFixture(
				['gameState'],
				(api, fn) => api.game.onChange(fn),
				(t) => M.gameState.setGameVar('lc-' + t.id, Math.random())
			),
			'game.levels': {
				needs: ['gameShell'],
				call: (api) => api.game.levels({ list: [{ id: 'a', label: 'A' }], current: 'a' }),
				present: (t) => get(M.gameShell.gameLevels)?.owner === t.id
			},
			'game.addSetting': {
				needs: ['gameSettings'],
				call: (api, t) => api.game.addSetting({ id: 'lc' + t.id, label: 'LC', type: 'toggle', default: false }),
				present: (t) => get(M.gameSettings.gameSettingRows).some((r) => r.id === 'lc' + t.id)
			},
			'game.onSettingsChange': listenerFixture(
				['gameSettings'],
				(api, fn) => api.game.onSettingsChange(fn),
				(t) => M.gameSettings.gameSettingValues.update((v) => ({ ...v, ['lc' + t.id]: Math.random() }))
			),
			'game.setHelp': {
				needs: ['gameShell'],
				call: (api) => api.game.setHelp('LC help'),
				present: (t) => get(M.gameShell.gameHelp)?.owner === t.id
			},
			'game.onRestart': {
				needs: ['gameShell'],
				call(api, t) {
					t.data.before = M.gameShell.gameShellDebug().restartHooks;
					api.game.onRestart(() => {});
				},
				present: (t) => M.gameShell.gameShellDebug().restartHooks === t.data.before + 1,
				absent: (t) => M.gameShell.gameShellDebug().restartHooks === t.data.before
			},
			'game.openMenu': {
				needs: ['gameShell'],
				call: (api) => api.game.openMenu(),
				present: () => M.gameShell.gameShellDebug().forcedGame === true
			},
			// ---- storage / lod / quality / peerVars / flow ---------------------------------
			lod: {
				needs: ['lod', 'browser'],
				call(api, t) {
					t.data.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshBasicMaterial());
					api.lod(t.data.mesh, { minTriangles: 100 });
				},
				present: (t) => M.lod.lodStats().meshes.some((m) => m.uuid === t.data.mesh.uuid)
			},
			'quality.onChange': {
				needs: ['qualityGovernor'],
				call(api, t) {
					t.data.calls = 0;
					api.quality.onChange(() => t.data.calls++);
				},
				present(t) {
					const before = t.data.calls;
					const q = get(M.qualityGovernor.qualityState);
					// a level change and straight back: the subscriber hears the change
					M.qualityGovernor.qualityState.set({ ...q, level: q.level + 1 });
					M.qualityGovernor.qualityState.set(q);
					return t.data.calls > before;
				}
			},
			// 36-water: a volume listener; notify() fires every listener with the current list
			'water.onChange': {
				needs: ['waterVolumes'],
				call(api, t) {
					t.data.calls = 0;
					api.water.onChange(() => t.data.calls++);
				},
				present(t) {
					const before = t.data.calls;
					M.waterVolumes.waterVolumes.notify();
					return t.data.calls > before;
				}
			},
			'peerVars.onChange': listenerFixture(
				['peerVars'],
				(api, fn) => api.peerVars.onChange(fn),
				(t) => M.peerVars.setPeerVar('lc' + t.id, Math.random())
			),
			'flow.onChange': listenerFixture(
				['flowStore'],
				(api, fn) => api.flow.onChange(fn),
				() => M.flowStore.flowGraphs.update((g) => ({ ...g }))
			),
			possess: {
				needs: ['possess', 'objects'],
				call(api, t) {
					const mesh = scratch(t);
					t.data.ok = api.possess(mesh.uuid, { camera: 'none' });
				},
				present: (t) => t.data.ok && !!get(M.possess.possessed),
				absent: () => !get(M.possess.possessed),
				cleanup: dropScratch
			},
			// ---- backends / post / audio devices -------------------------------------------
			registerUnwrapBackend: {
				needs: ['uvUnwrap'],
				call: (api) => api.registerUnwrapBackend('lc', 'LC', () => ({ uvs: [], islands: 0 })),
				present: (t) => M.uvUnwrap.unwrapBackends().some((b) => b.key === 'mod-' + t.id + '-lc')
			},
			registerShaderBackend: {
				needs: ['shaderBackends'],
				call: (api) => api.registerShaderBackend('lc', 'LC', () => null),
				present: (t) => M.shaderBackends.shaderBackendList().some((b) => b.key === 'mod-' + t.id + '-lc')
			},
			registerAudioDevice: {
				needs: ['audioDevices'],
				call: (api) => api.registerAudioDevice({ kind: 'lc', label: 'LC', build: () => ({}) }),
				present: (t) => !!M.audioDevices.deviceSpec('mod-' + t.id + '-lc')
			},
			registerPostEffect: {
				needs: ['scenePost'],
				call: (api) => api.registerPostEffect('lc', { label: 'LC', make: () => null }),
				present: (t) => M.scenePost.postEffectKinds().some((k) => k.kind === 'mod-' + t.id + '-lc')
			},
			registerPostBackend: {
				needs: ['postBackends'],
				call: (api) => api.registerPostBackend('lc', 'LC', () => null),
				present: (t) => M.postBackends.postBackendList().some((b) => b.key === 'mod-' + t.id + '-lc')
			},
			// ---- audio ---------------------------------------------------------------------
			'audio.voice': {
				needs: ['audioEngine'],
				call(api, t) {
					const voice = api.audio.voice({ freq: 220, gain: 0 });
					t.data.voice = voice;
					t.data.disposed = false;
					const dispose = voice.dispose;
					voice.dispose = () => {
						t.data.disposed = true;
						dispose.call(voice);
					};
				},
				present: (t) => !!t.data.voice && !t.data.disposed
			},
			'audio.schedule': {
				needs: ['musicClock', 'browser'],
				call(api, t) {
					t.data.before = M.musicClock.clockDebug().scheduler.events;
					api.audio.schedule(10000, () => {});
				},
				present: (t) => M.musicClock.clockDebug().scheduler.events === t.data.before + 1,
				absent: (t) => M.musicClock.clockDebug().scheduler.events === t.data.before
			},
			'audio.captureMic': {
				needs: ['micCapture', 'media'],
				async call(api, t) {
					t.data.stream = await api.audio.captureMic();
				},
				present: (t) => !!t.data.stream && t.data.stream.getAudioTracks().some((tr) => tr.readyState === 'live'),
				// the module's COPY stops; the shared raw stream is not the module's to stop
				cleanup: () => M.micCapture.releaseMicStream()
			},
			'audio.record': {
				needs: ['micCapture', 'media'],
				call(api, t) {
					t.data.job = api.audio.record({ maxSeconds: 20, name: 'lc-take' }).catch(() => null);
				},
				present: () => get(M.micCapture.recording).active === true,
				cleanup: async (t) => {
					await t.data.job;
					M.micCapture.releaseMicStream();
				}
			},
			// ---- hud -----------------------------------------------------------------------
			'hud.rows': {
				needs: ['flowRuntime'],
				call: (api, t) => api.hud.rows('lc-list-' + t.id, [{ label: 'a', value: 1 }]),
				present: (t) => M.flowRuntime.hudRowsOf('lc-list-' + t.id).length > 0
			},
			'hud.registerDebugLine': {
				needs: ['moduleHudKinds'],
				call: (api, t) => api.hud.registerDebugLine(() => 'lc ' + t.id),
				present: (t) => M.moduleHudKinds.moduleDebugLineTexts().includes('lc ' + t.id)
			},
			'hud.registerAction': {
				needs: ['moduleHudKinds'],
				call: (api) => api.hud.registerAction({ key: 'lc', label: 'LC', role: 'press', node: 'hudbutton' }),
				present: (t) => M.moduleHudKinds.moduleHudActionList().some((a) => a.moduleId === t.id)
			},
			registerHudElement: {
				needs: ['moduleHudKinds'],
				call: (api) => api.registerHudElement('lc', { label: 'LC', mount: () => () => {} }),
				present: (t) => !!M.moduleHudKinds.moduleHudKindDef('mod-' + t.id + '-lc')
			},
			// ---- own (34 R6) ---------------------------------------------------------------
			onUnload: {
				call(api, t) {
					t.data.ran = false;
					api.onUnload(() => (t.data.ran = true));
				},
				present: (t) => !t.data.ran,
				absent: (t) => t.data.ran
			},
			'timers.setTimeout': {
				call(api, t) {
					t.data.fired = false;
					api.timers.setTimeout(() => (t.data.fired = true), 300);
				},
				present: (t) => !t.data.fired && t.api.timers.pending().timeouts === 1,
				async absent(t) {
					await sleep(400);
					return !t.data.fired;
				}
			},
			'timers.setInterval': {
				call(api, t) {
					t.data.calls = 0;
					api.timers.setInterval(() => t.data.calls++, 15);
				},
				async present(t) {
					const before = t.data.calls;
					await sleep(80);
					return t.data.calls > before;
				},
				async absent(t) {
					const before = t.data.calls;
					await sleep(80);
					return t.data.calls === before;
				}
			},
			'timers.requestAnimationFrame': {
				needs: ['raf'],
				call(api, t) {
					t.data.calls = 0;
					const loop = () => {
						t.data.calls++;
						api.timers.requestAnimationFrame(loop);
					};
					api.timers.requestAnimationFrame(loop);
				},
				async present(t) {
					const before = t.data.calls;
					await sleep(120);
					return t.data.calls > before;
				},
				async absent(t) {
					const before = t.data.calls;
					await sleep(120);
					return t.data.calls === before;
				}
			},
			listen: {
				call(api, t) {
					t.data.target = new EventTarget();
					t.data.calls = 0;
					api.listen(t.data.target, 'lc', () => t.data.calls++);
				},
				present(t) {
					const before = t.data.calls;
					t.data.target.dispatchEvent(new Event('lc'));
					return t.data.calls > before;
				}
			},
			// 34 R7: a model loaded for the module is held under its id until the unload releases it
			// (a real file fetch: the browser runs it)
			loadModel: {
				needs: ['modelLoader', 'browser'],
				async call(api, t) {
					t.data.handle = await api.loadModel('/library/default/ThePrototypeLogo/glTF-Binary/ThePrototype-Logo.glb', { lod: false });
				},
				present: (t) => (M.modelLoader.modelStats().owners[t.id] ?? []).length > 0
			},
			own: {
				call(api, t) {
					const parent = new THREE.Group();
					const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
					t.data.disposed = 0;
					mesh.geometry.addEventListener('dispose', () => t.data.disposed++);
					mesh.material.addEventListener('dispose', () => t.data.disposed++);
					parent.add(mesh);
					t.data.mesh = api.own(mesh);
				},
				present: (t) => !!t.data.mesh.parent && t.data.disposed === 0,
				// out of the scene AND its GPU resources freed
				absent: (t) => !t.data.mesh.parent && t.data.disposed === 2
			}
		};
	}

	/** which `needs` the env cannot meet (an empty list = runnable here) */
	function unmet(env, needs) {
		const out = [];
		for (const n of needs ?? []) {
			if (n === 'browser') {
				if (!env.browser) out.push(n);
			} else if (n === 'objects' || n === 'scene') {
				const s = env.mods.sceneStore;
				const v = s && env.get(n === 'objects' ? s.objectsGroup : s.globalScene);
				if (!v) out.push(n);
			} else if (n === 'raf') {
				if (typeof requestAnimationFrame !== 'function') out.push(n);
			} else if (n === 'media') {
				if (!env.browser || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') out.push(n);
			} else if (!env.mods[n]) out.push(n);
		}
		return out;
	}

	/** poll `fn` until it reads true or `ms` passes */
	async function until(fn, ms = 4000) {
		const end = Date.now() + ms;
		for (;;) {
			let ok = false;
			try {
				ok = !!(await fn());
			} catch {
				ok = false;
			}
			if (ok) return true;
			if (Date.now() > end) return false;
			await new Promise((r) => setTimeout(r, 30));
		}
	}

	/**
	 * Run the contract: the surface check, then every 'registers' member's fixture inside a
	 * real module (initModules -> present -> unloadModule -> absent, journal empty).
	 * @param {any} env @param {{only?: string[]}} [opts]
	 */
	async function runContract(env, opts = {}) {
		const surface = checkSurface(env);
		const table = fixtures(env);
		const out = { surface, missingFixture: [], results: {} };
		let n = 0;
		for (const path of surface.registers) {
			const fx = table[path];
			if (!fx) {
				out.missingFixture.push(path);
				continue;
			}
			if (opts.only && !opts.only.includes(path)) continue;
			const missing = unmet(env, fx.needs);
			if (missing.length) {
				out.results[path] = { skipped: 'needs ' + missing.join(', ') };
				continue;
			}
			const id = 'lc-' + path.replace(/[^\w]/g, '-') + '-' + ++n;
			const t = { id, env, api: null, data: {}, ret: null };
			const r = { journaled: false, up: false, down: false, empty: false, error: '' };
			try {
				const mod = {
					id,
					name: 'Lifecycle ' + path,
					version: '0.0.0',
					register(api) {
						t.api = api;
						t.ret = fx.call(api, t);
					}
				};
				env.sdk.initModules([mod]);
				if (!env.sdk.isModuleLoaded(id)) throw new Error('register() threw');
				await t.ret;
				r.journaled = env.lifecycle.registrationCount(id) > 0;
				r.up = await until(() => fx.present(t));
				r.disposed = env.sdk.unloadModule(id);
				r.down = await until(() => (fx.absent ? fx.absent(t) : Promise.resolve(fx.present(t)).then((v) => !v)));
				r.empty = env.lifecycle.registrationCount(id) === 0;
			} catch (error) {
				r.error = String(error?.message ?? error);
				if (env.sdk.isModuleLoaded(id)) env.sdk.unloadModule(id);
			}
			try {
				await fx.cleanup?.(t);
			} catch {}
			r.ok = !r.error && r.journaled && r.up && r.down && r.empty;
			out.results[path] = r;
		}
		return out;
	}

	globalThis.__sdkLifecycle = { KINDS, membersOf, checkSurface, fixtures, runContract, unmet };
})();
