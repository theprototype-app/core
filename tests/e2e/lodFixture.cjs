// 33 — the LOD-group suites' shared FIXTURE PACK: a dense ball + two offline LOD files made
// in-page with the app's own GLTFExporter, served through page.route under PACKS_BASE, plus
// in-page helpers (`window.__lg`) that render the real scene from a chosen distance and read
// what a mesh DREW mid-render. Not a suite (no `.test.`), so the runner never picks it up.

/** @param {any} page */
async function setupLodFixture(page) {
	const fixture = await page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		const { GLTFExporter } = s.GLTFExporterModule;
		const make = async (w, hgt) => {
			const scene = new THREE.Scene();
			const root = new THREE.Group();
			root.name = 'Ball';
			const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, w, hgt), new THREE.MeshStandardMaterial({ color: 0x8899aa, name: 'BallMat' }));
			mesh.name = 'Body';
			root.add(mesh);
			scene.add(root);
			const buf = await new GLTFExporter().parseAsync(scene, { binary: true });
			const bytes = new Uint8Array(buf);
			let bin = '';
			for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
			return { b64: btoa(bin), tris: mesh.geometry.index.count / 3 };
		};
		return { base: s.packs.PACKS_BASE, lod0: await make(96, 48), lod1: await make(32, 16), lod2: await make(10, 5) };
	});
	const base = fixture.base.replace(/\/+$/, '');
	const hits = { lod1: 0, lod2: 0, list: 0 };
	const glb = (b64) => ({ status: 200, contentType: 'model/gltf-binary', body: Buffer.from(b64, 'base64') });
	const rows = [{ name: 'Ball', label: 'Ball', variants: { 'glTF-Binary': 'ball.glb' }, lods: [{ file: 'ball.lod2.glb', ratio: 0.03 }, { file: 'ball.lod1.glb', ratio: 0.12 }] }];
	await page.route(base + '/index.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ name: 'lodtest', title: 'LOD test', value: 'lodtest/default.json' }]) }));
	await page.route(base + '/lodtest/default.json', (r) => {
		hits.list++;
		r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
	});
	await page.route(base + '/lodtest/Ball/glTF-Binary/ball.glb', (r) => r.fulfill(glb(fixture.lod0.b64)));
	await page.route(base + '/lodtest/Ball/glTF-Binary/ball.lod1.glb', (r) => {
		hits.lod1++;
		r.fulfill(glb(fixture.lod1.b64));
	});
	await page.route(base + '/lodtest/Ball/glTF-Binary/ball.lod2.glb', (r) => {
		hits.lod2++;
		r.fulfill(glb(fixture.lod2.b64));
	});
	await page.evaluate((base) => {
		const s = window.__stores;
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const trisOf = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
		window.__lg = {
			read,
			base,
			byName(name) {
				return read(s.objectsGroup).getObjectByName(name);
			},
			byUuid(uuid) {
				return read(s.objectsGroup).getObjectByProperty('uuid', uuid);
			},
			/** the triangles ONE render() drew from `dist` m in front of `target` (shadow pass incl.) */
			renderFrom(dist, target = [0, 1, 0], fov = 50) {
				const THREE = s.THREE;
				const r = read(s.globalRenderer);
				const scene = read(s.globalScene);
				const cam = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 5000);
				cam.position.set(target[0], target[1], target[2] + dist);
				cam.lookAt(...target);
				cam.updateMatrixWorld(true);
				const auto = r.info.autoReset;
				r.info.autoReset = true;
				r.render(scene, cam);
				const tris = r.info.render.triangles;
				r.info.autoReset = auto;
				return tris;
			},
			/** what the root's first mesh DREW in that render (read in its onBeforeRender =
			 * mid-draw): triangles, own material or not, the material's name/colour, world y */
			drawnFrom(root, dist, target) {
				const r = typeof root === 'string' ? window.__lg.byName(root) || window.__lg.byUuid(root) : root;
				let mesh = null;
				r.traverse((o) => {
					if (o.isMesh && !mesh) mesh = o;
				});
				const own = mesh.material;
				const seen = [];
				const prev = mesh.onBeforeRender;
				mesh.onBeforeRender = function (...a) {
					seen.push({
						tris: trisOf(this.geometry),
						ownMaterial: this.material === own,
						material: this.material?.name ?? '',
						color: this.material?.color?.getHexString?.() ?? null,
						y: Number(this.matrixWorld.elements[13].toFixed(3))
					});
					return prev.apply(this, a);
				};
				const t = target ?? [r.position.x, r.position.y, r.position.z];
				const total = window.__lg.renderFrom(dist, t);
				mesh.onBeforeRender = prev;
				return { total, seen, afterTris: trisOf(mesh.geometry), afterOwn: mesh.material === own };
			},
			/** placePackItem's path: fetch the row's glb, importFile with the pack ref + group */
			async placeBall(name = 'Ball', at = [0, 1, 0], withGroup = true) {
				const pack = { name: 'lodtest', base: base + '/lodtest', listUrl: base + '/lodtest/default.json', source: 'default' };
				const items = await s.packs.loadPackItems(pack);
				const item = items.find((i) => i.name === 'Ball');
				const res = await fetch(item.glbUrl);
				const uuid = await s.fileHandler.importFile(new File([await res.blob()], name + '.glb'), name, 'glb', at, undefined, {
					packRef: s.packRefs.packRefFromUrl(item.glbUrl, { pack: 'lodtest', item: 'Ball' }),
					...(withGroup ? { lod: s.lodGroup.placementGroupFor(item.glbUrl, item.lods) } : {})
				});
				s.lodGroup.scanLodGroups();
				return { uuid, itemLods: item.lods ?? null };
			},
			/** wait until every level of `uuid`'s group is built */
			async built(uuid, timeout = 15000) {
				s.lodGroup.buildAllLevels(uuid);
				const end = performance.now() + timeout;
				while (performance.now() < end) {
					const info = s.lodGroup.lodGroupInfo(uuid);
					if (info && info.levels.every((l) => l.status === 'ready' || l.status === 'failed')) return info;
					await new Promise((r) => setTimeout(r, 100));
				}
				return s.lodGroup.lodGroupInfo(uuid);
			}
		};
	}, base);
	return { fixture, hits, base };
}

module.exports = { setupLodFixture };
