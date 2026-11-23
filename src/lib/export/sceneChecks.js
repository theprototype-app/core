// 63-publish (row 13) — THE SCENE RULES of the publish check: what a visitor would hit that the
// author cannot see from the editor. Pure rules over `ctx.scene` (a SceneFacts object gathered by
// sceneFacts.js from the live scene, or built by a test), in the checkCore.js row format, so the
// Publish tab and Export ▸ itch.io / CrazyGames / static show the same rows (63-export owns the
// size and portal rules; this file owns the scene rules). A LEAF: it imports only checkCore's
// types, so node (scripts/check-export.cjs) can load it too.
//
// THE RULES (id — severity — targets — what it catches):
//  scene-bundle-size     error   publish   the bundle is over the publish limit (the server
//                                          refuses the upload); items = the biggest assets
//  scene-texture-large   warn    all       textures over 2048 px on the long side — stored as
//                                          authored, so a 4K photo costs a phone ~64 MB of GPU
//  scene-no-spawn        warn    all       a game with no spawn point: players start wherever
//                                          the editor camera was at the last save
//  scene-spawn-bounds    warn    all       scene-lint's spawn-bounds: play.spawn outside play.bounds
//  scene-touch-missing   warn    all       a game for phones whose keys no touch button presses
//                                          (a Key Press past the six key buttons, a gamepad-only
//                                          input)
//  scene-module-missing  warn    publish   a module the scene uses that a visitor cannot get
//                                          (installed here from a zip or a private URL, not in
//                                          the module gallery) — its nodes do nothing for them.
//                                          An export carries its modules inside the zip, so
//                                          this is publish-only.
//  scene-asset-missing   warn    all       a sound / music / image the scene references whose
//                                          bytes are not on this device — the bundler skips it
//                                          silently, so the visitor gets silence or a blank
//  scene-script-random   warn    all       scene-lint's script-nondeterministic: a Script node
//                                          reading Math.random / Date.now / storage
//  scene-layer-helper    warn    all       scene-lint's layer-helper + layer-one-eye: an object
//                                          invisible in play, or drawn in one eye in a headset
//
// Severity words are scene-lint's. Publish NEVER blocks on any of them (checkCore.summarize).
// scene-lint.cjs keeps its own copy of the three lint rules for the author kit (it is a sync
// CJS script); tests/unit/sceneChecks.test.js holds the two to the same verdicts.

/** @typedef {import('./checkCore.js').CheckRow} CheckRow */
/** @typedef {import('./checkCore.js').CheckRule} CheckRule */
/** @typedef {import('./checkCore.js').CheckContext} CheckContext */

/**
 * @typedef {{
 *   isGame?: boolean,
 *   spawn?: {position: number[], yaw?: number} | null,
 *   bounds?: {min: number[], max: number[]} | null,
 *   dungeon?: boolean,
 *   bundleBytes?: number | null,
 *   biggest?: {label: string, bytes: number, where?: string}[],
 *   textures?: {uuid: string, name: string, slot?: number, width: number, height: number}[],
 *   assets?: {name: string, kind: string, hash: string, missing: boolean, uuid?: string, nodeId?: string}[],
 *   modules?: {id: string, name?: string, user: boolean, inGallery: boolean | null}[],
 *   touch?: {uncovered: string[]} | null,
 *   scripts?: {id: string, code: string, graph?: string}[],
 *   layers?: {uuid: string, name: string, mask: number}[]
 * }} SceneFacts
 */

const MB = 1024 * 1024;
/** the cloud's upload cap (client-plugin publish.js MAX_BYTES, the scenes collection's file max) */
export const PUBLISH_MAX_BYTES = 25 * MB;
/** the long side a published texture should not pass */
export const TEXTURE_MAX_PX = 2048;
/** helperLayer.js HELPER_LAYER (that module is not a leaf; the unit test holds the two equal) */
const HELPER_LAYER = 30;
const RANDOM_RE = /\b(Math\.random|Date\.now|new Date|performance\.now|localStorage|sessionStorage)\b/g;

/** @param {number} n */
const mb = (n) => (n / MB).toFixed(1) + ' MB';
/** @param {string[]} xs @param {number} [k] */
const listOf = (xs, k = 4) => (xs.length <= k ? xs.join(', ') : xs.slice(0, k).join(', ') + ` and ${xs.length - k} more`);
/** @param {CheckContext} ctx @returns {SceneFacts} */
const factsOf = (ctx) => ctx.scene || {};

/** @type {CheckRule[]} */
export const SCENE_RULES = [
	{
		id: 'scene-bundle-size',
		owner: 'scene',
		targets: ['publish'],
		run(ctx) {
			const f = factsOf(ctx);
			const limit = Number(ctx.limits?.publishBytes) || PUBLISH_MAX_BYTES;
			if (!(Number(f.bundleBytes) > limit)) return [];
			const big = (f.textures || []).some((t) => Math.max(t.width, t.height) > TEXTURE_MAX_PX);
			return [
				{
					id: 'scene-bundle-size',
					owner: 'scene',
					severity: 'error',
					title: `The scene is ${mb(Number(f.bundleBytes))}; publishing takes up to ${mb(limit)}`,
					detail: 'The upload will be refused. The biggest parts are listed below.',
					items: (f.biggest || []).slice(0, 5),
					...(big ? { fix: { name: 'scene-shrink-textures', label: 'Shrink large textures' } } : {})
				}
			];
		}
	},
	{
		id: 'scene-texture-large',
		owner: 'scene',
		run(ctx) {
			const big = (factsOf(ctx).textures || []).filter((t) => Math.max(t.width, t.height) > TEXTURE_MAX_PX);
			if (!big.length) return [];
			return [
				{
					id: 'scene-texture-large',
					owner: 'scene',
					severity: 'warn',
					title: big.length === 1 ? `A texture is larger than ${TEXTURE_MAX_PX} px` : `${big.length} textures are larger than ${TEXTURE_MAX_PX} px`,
					detail: 'Textures are stored as you added them. Large ones are slow to download and can run out of memory on a phone or a headset.',
					items: big.slice(0, 8).map((t) => ({ label: `${t.name} (${t.width} x ${t.height})`, where: t.uuid })),
					fix: { name: 'scene-shrink-textures', label: `Shrink to ${TEXTURE_MAX_PX} px` }
				}
			];
		}
	},
	{
		id: 'scene-no-spawn',
		owner: 'scene',
		run(ctx) {
			const f = factsOf(ctx);
			if (!f.isGame || f.spawn || f.dungeon) return [];
			return [
				{
					id: 'scene-no-spawn',
					owner: 'scene',
					severity: 'warn',
					title: 'This game has no spawn point',
					detail: 'Players start wherever your editor camera was at the last save.',
					fix: { name: 'scene-set-spawn', label: 'Start players here' }
				}
			];
		}
	},
	{
		id: 'scene-spawn-bounds',
		owner: 'scene',
		run(ctx) {
			const f = factsOf(ctx);
			const at = f.spawn?.position;
			const b = f.bounds;
			if (!Array.isArray(at) || at.length !== 3 || !b || !Array.isArray(b.min) || !Array.isArray(b.max)) return [];
			const outside = [0, 1, 2].filter((i) => at[i] < b.min[i] || at[i] > b.max[i]);
			if (!outside.length) return [];
			return [
				{
					id: 'scene-spawn-bounds',
					owner: 'scene',
					severity: 'warn',
					title: 'The spawn point is outside the play area',
					detail: `Players would start where they cannot move (outside on ${outside.map((i) => 'xyz'[i]).join(', ')}).`,
					fix: { name: 'scene-set-spawn', label: 'Start players here' }
				}
			];
		}
	},
	{
		id: 'scene-touch-missing',
		owner: 'scene',
		run(ctx) {
			const f = factsOf(ctx);
			const phone = ctx.phone ?? ctx.target === 'publish';
			const keys = f.touch?.uncovered || [];
			if (!phone || !f.isGame || !keys.length) return [];
			return [
				{
					id: 'scene-touch-missing',
					owner: 'scene',
					severity: 'warn',
					title: 'Phone players cannot press every control',
					detail: `No on-screen button for ${listOf(keys)}.`,
					fix: { name: 'scene-touch-layout', label: 'Edit touch controls' }
				}
			];
		}
	},
	{
		id: 'scene-module-missing',
		owner: 'scene',
		targets: ['publish'],
		run(ctx) {
			const lack = (factsOf(ctx).modules || []).filter((m) => m.user && m.inGallery === false);
			if (!lack.length) return [];
			return [
				{
					id: 'scene-module-missing',
					owner: 'scene',
					severity: 'warn',
					title: lack.length === 1 ? `Visitors will not have the module ${lack[0].name || lack[0].id}` : `Visitors will not have ${lack.length} modules`,
					detail: 'It was installed on this device from a file or a private link, not from the module gallery. Its nodes will do nothing for visitors.',
					items: lack.map((m) => ({ label: m.name || m.id })),
					fix: { name: 'scene-open-modules', label: 'Open Modules' }
				}
			];
		}
	},
	{
		id: 'scene-asset-missing',
		owner: 'scene',
		run(ctx) {
			const gone = (factsOf(ctx).assets || []).filter((a) => a.missing);
			if (!gone.length) return [];
			return [
				{
					id: 'scene-asset-missing',
					owner: 'scene',
					severity: 'warn',
					title: gone.length === 1 ? `A file the scene uses is not on this device: ${gone[0].name}` : `${gone.length} files the scene uses are not on this device`,
					detail: 'They are left out of what you publish, so visitors get silence or a blank in their place.',
					items: gone.slice(0, 8).map((a) => ({ label: `${a.name} (${a.kind})`, ...(a.uuid ? { where: a.uuid } : {}) })),
					fix: { name: 'scene-fetch-assets', label: 'Ask connected people for them' }
				}
			];
		}
	},
	{
		id: 'scene-script-random',
		owner: 'scene',
		run(ctx) {
			/** @type {CheckRow[]} */
			const out = [];
			for (const s of factsOf(ctx).scripts || []) {
				const hits = [...new Set([...String(s.code || '').matchAll(RANDOM_RE)].map((m) => m[1]))];
				if (hits.length)
					out.push({
						id: 'scene-script-random',
						owner: 'scene',
						severity: 'warn',
						title: `A Script node reads ${listOf(hits)}`,
						detail: 'Every player runs the scene and gets a different answer. Use the node\'s seeded random or the session clock.',
						where: s.graph && s.graph !== 'scene' ? s.graph : undefined,
						fix: { name: 'scene-open-node', label: 'Show the node', args: { nodeId: s.id, graph: s.graph || 'scene' } }
					});
			}
			return out;
		}
	},
	{
		id: 'scene-layer-helper',
		owner: 'scene',
		run(ctx) {
			const bad = (factsOf(ctx).layers || []).filter((o) => layerProblem(o.mask));
			if (!bad.length) return [];
			return [
				{
					id: 'scene-layer-helper',
					owner: 'scene',
					severity: 'warn',
					title: bad.length === 1 ? `${bad[0].name} will not show for players` : `${bad.length} objects will not show for players`,
					detail: 'They sit on an editor-only layer, or are drawn in one eye only in a headset. Select one and add it again, or delete it.',
					items: bad.slice(0, 8).map((o) => ({ label: o.name, where: o.uuid }))
				}
			];
		}
	}
];

/**
 * scene-lint's two layer rules as one question. @param {number} mask a three Layers mask
 * @returns {'' | 'helper' | 'one-eye'}
 */
export function layerProblem(mask) {
	const m = Number(mask) >>> 0;
	if (m & (1 << HELPER_LAYER)) return 'helper';
	const eyes = m & 0b110;
	if (!(m & 1) && eyes && eyes !== 0b110) return 'one-eye';
	return '';
}
