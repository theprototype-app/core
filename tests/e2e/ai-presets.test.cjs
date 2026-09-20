// 29 (roadmap 29, G-3 hosted AI) — cloudApi v3.1: `api.aiPresets` + `api.setMeshJobStatus`.
//
// A signed-in cloud user should get the assistant with no key, URL or model to type.
// The plugin cannot write core's aiProviders / meshProviders itself (Svelte stores
// loaded from localStorage at module init — a key written after boot changes nothing
// until a reload), so core owns ONE plugin-managed preset per domain behind
// `aiPresets.userHas(tag)` / `aiPresets.seed(tag, {ai, mesh, activate, enable})`. The
// tag is `managedBy` on the config; a provider the user made carries none, so it is
// untouchable by construction. `setMeshJobStatus(fn)` is the plugin's one line under
// each mesh-job card. Both additive and typeof-probed: NO CLOUD_HOOKS_VERSION bump.
//
// What this suite pins:
//   1   the probe: the members exist, the version did not move
//   2   seed creates / updates / removes the managed entry; a config cannot smuggle an
//       id or a tag; the user's own entries are never touched
//   3   GUARD 1 (permission): activate:false never takes the slot — including through
//       the store's own "first provider becomes active" (the counterfactual leak)
//   4   GUARD 2 (the slot): a taken slot is not taken even when the caller may; a
//       freed slot is
//   5   enable flips the master toggle only when our entry became the active one
//   6   managedBy survives the store's whitelist and a reload
//   7   the mesh-job status line: renders under a RUNNING job, re-reads on every set,
//       null removes it, a throwing fn renders nothing and breaks nothing
//
// Run: APP_URL=https://theprototype.app:5219/ npm run e2e -- ai-presets
const h = require('./helpers.cjs');

const inPage = (peer, body, arg) =>
	peer.page.evaluate(
		([src, a]) => Object.getPrototypeOf(async function () {}).constructor('s', 'api', 'arg', src)(window.__stores, window.__api, a),
		[body, arg ?? null]
	);
const read = (peer, store) => inPage(peer, `let v; s.${store}.subscribe((x) => (v = x))(); return v;`);
const TAG = 'theprototype-cloud:hosted';
const AI = { label: 'ThePrototype hosted — experimental', baseUrl: 'https://ai.example.test/v1/', apiKey: 'tok-1', model: 'qwen3-mock' };
const MESH = { label: 'ThePrototype hosted — experimental', baseUrl: 'https://ai.example.test/trellis/', apiKey: 'tok-1', workflowJson: '{"1":{}}', outputNodeId: '' };
const RESET = `
	s.aiProviders.aiProviders.set([]); s.aiProviders.setAiActiveProvider(null); s.aiProviders.setAiEnabled(false);
	s.meshProviders.meshProviders.set([]); s.meshProviders.setMeshActiveProvider(null); s.meshProviders.setMeshGenEnabled(false);`;
/** everything a check wants to know about both domains */
const STATE = `
	const r = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
	const ai = r(s.aiProviders.aiProviders), mesh = r(s.meshProviders.meshProviders);
	return {
		ai: ai.map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, preset: p.preset, managedBy: p.managedBy ?? null })),
		aiActive: r(s.aiProviders.aiActiveProvider), aiEnabled: r(s.aiProviders.aiEnabled),
		mesh: mesh.map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseUrl, apiKey: p.apiKey, kind: p.kind, workflowJson: p.workflowJson, managedBy: p.managedBy ?? null })),
		meshActive: r(s.meshProviders.meshActiveProvider), meshEnabled: r(s.meshProviders.meshGenEnabled)
	};`;
const mine = (st, dom) => st[dom].find((p) => p.managedBy === TAG) ?? null;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.cloudPlugin?.makeCloudApi, { timeout: 30000 });
	await inPage(A, 'window.__api = s.cloudPlugin.makeCloudApi();' + RESET);

	console.log('\n=== 1. the probe ===');
	const probe = await inPage(A, 'return { version: api.version, seed: typeof api.aiPresets?.seed, userHas: typeof api.aiPresets?.userHas, status: typeof api.setMeshJobStatus, dialMeta: api.dialMeta }');
	h.check(probe.seed === 'function' && probe.userHas === 'function', `api.aiPresets.{seed, userHas} exist (${JSON.stringify(probe)})`);
	h.check(probe.status === 'function', 'api.setMeshJobStatus exists');
	h.check(probe.version === 3, `CLOUD_HOOKS_VERSION stays 3 — additive members, the plugin keeps compatibleHooks = 3 (${probe.version})`);
	h.check(probe.dialMeta === true, 'the seam-1 probe (dialMeta) rides the same api');
	h.check(JSON.stringify(await inPage(A, 'return api.aiPresets.userHas(arg)', TAG)) === '{"ai":false,"mesh":false}', 'userHas: nothing configured → {ai:false, mesh:false}');

	console.log('\n=== 2. seed: create, update, remove ===');
	const r1 = await inPage(A, 'return api.aiPresets.seed(arg.tag, { ai: arg.ai, mesh: arg.mesh, activate: { ai: true, mesh: true }, enable: true })', { tag: TAG, ai: AI, mesh: MESH });
	let st = await inPage(A, STATE);
	h.check(!!r1.ai.id && r1.ai.active && r1.enabled.ai, `seed returns the ai id, active, enabled (${JSON.stringify(r1.ai)} ${JSON.stringify(r1.enabled)})`);
	h.check(!!r1.mesh.id && r1.mesh.active && r1.enabled.mesh, `…and the mesh half (${JSON.stringify(r1.mesh)})`);
	const m1 = mine(st, 'ai');
	h.check(m1 && m1.id === r1.ai.id && m1.preset === 'custom' && m1.baseUrl === 'https://ai.example.test/v1' && m1.model === 'qwen3-mock' && m1.apiKey === 'tok-1', `the ai entry is a custom provider with the fields given, baseUrl normalised (${JSON.stringify(m1)})`);
	const mm1 = mine(st, 'mesh');
	h.check(mm1 && mm1.id === r1.mesh.id && mm1.kind === 'comfyui' && mm1.baseUrl === 'https://ai.example.test/trellis' && mm1.workflowJson === '{"1":{}}', `the mesh entry is a comfyui provider with the workflow (${JSON.stringify(mm1)})`);
	h.check(st.aiActive === r1.ai.id && st.meshActive === r1.mesh.id, 'both slots were empty → both taken');
	h.check(st.aiEnabled === true && st.meshEnabled === true, 'enable:true switched both masters on');
	h.check(JSON.stringify(await inPage(A, 'return api.aiPresets.userHas(arg)', TAG)) === '{"ai":false,"mesh":false}', 'userHas excludes our own tagged entry');
	// update: same id, fields move, nothing duplicated, nothing re-enabled
	const r2 = await inPage(A, 'return api.aiPresets.seed(arg.tag, { ai: { ...arg.ai, apiKey: "tok-2", model: "qwen3-next" }, mesh: arg.mesh, activate: { ai: true, mesh: true }, enable: true })', { tag: TAG, ai: AI, mesh: MESH });
	st = await inPage(A, STATE);
	h.check(r2.ai.id === r1.ai.id && st.ai.length === 1 && mine(st, 'ai').apiKey === 'tok-2' && mine(st, 'ai').model === 'qwen3-next', 'a second seed UPDATES the same entry in place (the token rotates, no duplicate row)');
	h.check(r2.enabled.ai === false && r2.enabled.mesh === false, 'enabled reports false when the master was already on (the plugin\'s once-per-device stamp reads it)');
	// a config cannot smuggle identity or ownership
	await inPage(A, 'api.aiPresets.seed(arg.tag, { ai: { ...arg.ai, id: "evil", managedBy: "somebody-else" }, mesh: arg.mesh })', { tag: TAG, ai: AI, mesh: MESH });
	st = await inPage(A, STATE);
	h.check(st.ai.length === 1 && st.ai[0].id === r1.ai.id && st.ai[0].managedBy === TAG, `id and managedBy in the config are ignored — core assigns both (${JSON.stringify(st.ai)})`);
	// remove
	const r3 = await inPage(A, 'return api.aiPresets.seed(arg, { ai: null, mesh: null })', TAG);
	st = await inPage(A, STATE);
	h.check(r3.ai.id === '' && r3.mesh.id === '' && st.ai.length === 0 && st.mesh.length === 0, 'null removes the managed entries');
	h.check(st.aiActive === null && st.meshActive === null, 'the freed slots read empty');
	h.check(st.aiEnabled === true, 'removal does NOT flip the master back off (that is the user\'s switch)');

	console.log('\n=== 3. guard 1: activate:false never takes the slot ===');
	await inPage(A, RESET);
	const r4 = await inPage(A, 'return api.aiPresets.seed(arg.tag, { ai: arg.ai, mesh: arg.mesh, activate: { ai: false, mesh: false }, enable: true })', { tag: TAG, ai: AI, mesh: MESH });
	st = await inPage(A, STATE);
	h.check(st.ai.length === 1 && st.mesh.length === 1, 'the entries are created');
	// THE COUNTERFACTUAL LEAK: addAiProvider/addMeshProvider activate a first provider on
	// their own, so without the seed restoring the pointer this would read our id
	h.check(st.aiActive === null && st.meshActive === null, `…but the EMPTY slot is not taken: the store's own first-provider activation is undone (${st.aiActive}, ${st.meshActive})`);
	h.check(r4.ai.active === false && r4.mesh.active === false && r4.enabled.ai === false && st.aiEnabled === false, 'seed reports inactive and the master stays off');
	const r5 = await inPage(A, 'return api.aiPresets.seed(arg.tag, { ai: arg.ai, mesh: arg.mesh, activate: { ai: true, mesh: true } })', { tag: TAG, ai: AI, mesh: MESH });
	st = await inPage(A, STATE);
	h.check(r5.ai.active && st.aiActive === r5.ai.id && r5.mesh.active && st.meshActive === r5.mesh.id, 'the same seed WITH permission takes the empty slot');

	console.log('\n=== 4. guard 2: a taken slot is never taken ===');
	await inPage(A, RESET);
	const own = await inPage(A, `
		const id = s.aiProviders.addAiProvider({ preset: 'custom', label: 'My own vLLM', baseUrl: 'http://192.168.1.50:8000/v1', apiKey: 'mine', model: 'my-model' });
		s.aiProviders.setAiActiveProvider(id);
		const mid = s.meshProviders.addMeshProvider({ kind: 'comfyui', label: 'My box', baseUrl: 'http://192.168.1.50:8188', apiKey: '', workflowJson: '{}' });
		s.meshProviders.setMeshActiveProvider(mid);
		return { id, mid, userHas: api.aiPresets.userHas(arg) };`, TAG);
	h.check(own.userHas.ai === true && own.userHas.mesh === true, 'userHas sees a provider of the user\'s own');
	// the plugin's real call: activate = !userHas
	const r6 = await inPage(A, 'return api.aiPresets.seed(arg.tag, { ai: arg.ai, mesh: arg.mesh, activate: { ai: false, mesh: false }, enable: true })', { tag: TAG, ai: AI, mesh: MESH });
	st = await inPage(A, STATE);
	h.check(st.aiActive === own.id && st.meshActive === own.mid, 'the user\'s provider stays ACTIVE');
	h.check(st.ai.length === 2 && st.ai.find((p) => p.id === own.id).apiKey === 'mine' && st.ai.find((p) => p.id === own.id).managedBy === null, 'the user\'s entry is untouched and untagged; ours sits beside it');
	h.check(r6.ai.active === false && st.aiEnabled === false, 'no activation, no enable');
	// a buggy caller that passes permission anyway: the slot is still not taken
	const r7 = await inPage(A, 'return api.aiPresets.seed(arg.tag, { ai: arg.ai, mesh: arg.mesh, activate: { ai: true, mesh: true }, enable: true })', { tag: TAG, ai: AI, mesh: MESH });
	st = await inPage(A, STATE);
	h.check(st.aiActive === own.id && st.meshActive === own.mid && r7.ai.active === false, 'guard 2 alone holds: permission does not take a slot somebody else holds');
	h.check(st.aiEnabled === false, '…and the master stays off, because we never became active');
	// "they just deleted the selected one": the store re-points to the first remaining
	await inPage(A, 's.aiProviders.removeAiProvider(arg.id); s.meshProviders.removeMeshProvider(arg.mid)', own);
	st = await inPage(A, STATE);
	h.check(st.aiActive === mine(st, 'ai').id, 'premise: deleting the user\'s provider re-points the slot at ours (the store\'s own rule)');
	const r8 = await inPage(A, 'return api.aiPresets.seed(arg.tag, { ai: arg.ai, mesh: arg.mesh, activate: { ai: true, mesh: true }, enable: true })', { tag: TAG, ai: AI, mesh: MESH });
	st = await inPage(A, STATE);
	h.check(r8.ai.active === true && r8.mesh.active === true && st.aiActive === r8.ai.id, 'a slot that is already ours counts as free');
	h.check(r8.enabled.ai === true && st.aiEnabled === true, 'and NOW enable flips the master, because we became the active one');

	console.log('\n=== 5. enable only when active ===');
	await inPage(A, RESET);
	await inPage(A, 'const id = s.aiProviders.addAiProvider({ preset: "custom", label: "Own", baseUrl: "http://x/v1", apiKey: "k", model: "m" }); s.aiProviders.setAiActiveProvider(id);');
	const r9 = await inPage(A, 'return api.aiPresets.seed(arg.tag, { ai: arg.ai, activate: { ai: true }, enable: true })', { tag: TAG, ai: AI });
	st = await inPage(A, STATE);
	h.check(r9.enabled.ai === false && st.aiEnabled === false, 'enable:true with a taken slot flips nothing');
	h.check(r9.mesh.id === '' && st.mesh.length === 0, 'an absent mesh config seeds no mesh entry');

	console.log('\n=== 6. managedBy survives the store and a reload ===');
	await inPage(A, RESET);
	const direct = await inPage(A, `
		const id = s.aiProviders.addAiProvider({ preset: 'custom', label: 'Tagged', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', managedBy: arg });
		const mid = s.meshProviders.addMeshProvider({ kind: 'comfyui', label: 'Tagged', baseUrl: 'http://x', apiKey: '', workflowJson: '{}', managedBy: arg });
		const r = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		return { ai: r(s.aiProviders.aiProviders).find((p) => p.id === id)?.managedBy, mesh: r(s.meshProviders.meshProviders).find((p) => p.id === mid)?.managedBy };`, TAG);
	h.check(direct.ai === TAG && direct.mesh === TAG, 'addAiProvider / addMeshProvider keep managedBy (the field whitelist used to drop it)');
	await h.freshReload(A);
	await A.page.waitForFunction(() => !!window.__stores?.cloudPlugin?.makeCloudApi, { timeout: 30000 });
	await inPage(A, 'window.__api = s.cloudPlugin.makeCloudApi();');
	st = await inPage(A, STATE);
	h.check(mine(st, 'ai') && mine(st, 'mesh'), 'the tag is persisted with the entry and survives a reload');
	h.check(JSON.stringify(await inPage(A, 'return api.aiPresets.userHas(arg)', TAG)) === '{"ai":false,"mesh":false}', '…so userHas still reads them as ours after the reload');
	await inPage(A, RESET);

	console.log('\n=== 7. the mesh-job status line ===');
	const line = () => A.page.locator('.mesh-job-plugin-line');
	const job = (status) => inPage(A, 's.meshJobs.meshJobs.set([{ id: "j1", prompt: "a chair", status: arg, progress: null, error: "" }])', status);
	await job('running');
	await A.page.waitForTimeout(200);
	h.check((await A.page.locator('.mesh-job').count()) === 1, 'premise: a running job renders its card');
	h.check((await line().count()) === 0, 'no plugin → no extra line (the card is byte-identical)');
	await inPage(A, 'api.setMeshJobStatus(() => "You are #3 in queue for the hosted AI")');
	await A.page.waitForTimeout(200);
	h.check((await line().count()) === 1 && (await line().textContent()).trim() === 'You are #3 in queue for the hosted AI', 'setMeshJobStatus(fn) renders fn() under the running job');
	await inPage(A, 'api.setMeshJobStatus(() => "Running on our hardware…")');
	await A.page.waitForTimeout(200);
	h.check((await line().textContent()).trim() === 'Running on our hardware…', 'setting the fn again re-reads it (every set is a poke)');
	// the line follows the job list too: a job that finishes loses it
	await job('done');
	await A.page.waitForTimeout(200);
	h.check((await A.page.locator('.mesh-job').count()) === 1 && (await line().count()) === 0, 'a finished job shows no queue line');
	await job('running');
	await inPage(A, 'api.setMeshJobStatus(() => null)');
	await A.page.waitForTimeout(200);
	h.check((await line().count()) === 0, 'a fn returning null renders nothing');
	await inPage(A, 'api.setMeshJobStatus(() => { throw new Error("plugin bug"); })');
	await A.page.waitForTimeout(200);
	h.check((await line().count()) === 0, 'a throwing fn renders nothing…');
	h.check(h.pageErrors(A).length === 0, '…and breaks nothing');
	await inPage(A, 'api.setMeshJobStatus("not a function")');
	h.check((await read(A, 'cloudHooks.meshJobStatus')) === null, 'a non-function clears the store');
	await inPage(A, 'api.setMeshJobStatus(() => "x"); api.setMeshJobStatus(null)');
	await A.page.waitForTimeout(200);
	h.check((await line().count()) === 0 && (await read(A, 'cloudHooks.meshJobStatus')) === null, 'null removes the line');
	await inPage(A, 's.meshJobs.meshJobs.set([])');

	await h.finish(browser);
});
