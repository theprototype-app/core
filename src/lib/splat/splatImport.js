// 102-splats: IMPORTING a Gaussian splat (a lazy chunk: explorer.js and the drop paths reach it by
// dynamic import, and Spark itself loads only when a file has to be READ — counting, reducing).
//
// Two halves:
//   prepareSplatFile(file)   the Library's gate. A .ply that is a MESH is refused with the way out; a
//                            file at or under 25 MB is stored as it is (the no-conversion rule); one over
//                            it is offered "reduce to fit" (convert to .spz -> drop the view-dependent colour
//                            -> keep the most opaque share) and stored as <name>.spz.
//   placeSplatItem(item, at) a Library splat into the scene: read its record (count, colour bands, the
//                            box it fills) and add a carrier through the ordinary import tail.
import { get } from 'svelte/store';
import { showToast } from '../../stores/appStore';
import { explorerItems, itemBlob, importFiles } from '../explorer';
import {
	SPLAT_EXT,
	SPLAT_CAP_BYTES,
	SPLAT_MAX_INPUT_BYTES,
	SPLAT_MIN_KEEP,
	readPlyHeader,
	plyKind,
	reducePlan,
	decimateOrder,
	splatCountText,
	mbText
} from './splatCore.js';

/** @type {Promise<any> | null} */
let sparkLoading = null;
const loadSpark = () => (sparkLoading ??= import('@sparkjsdev/spark'));

/** "scan.ply" -> "scan" @param {string} name */
const baseName = (name) => name.replace(SPLAT_EXT, '');

/**
 * Parse splat bytes on the CPU (no renderer needed): Spark's own reader, every format it knows.
 * @param {Uint8Array} bytes @param {string} fileName
 */
async function parseSplats(bytes, fileName) {
	const spark = await loadSpark();
	const packed = new spark.PackedSplats({ fileBytes: bytes, fileName });
	await packed.initialized;
	return packed;
}

/**
 * The record facts of parsed splats: count, colour bands, and a box over the splat CENTRES that
 * ignores the stray floaters a capture always has (0.5 % trimmed per axis — the box is the hit
 * proxy, and one floater 40 m out would make the whole room a click target).
 * @param {any} packed
 */
export function splatFacts(packed) {
	const count = packed.getNumSplats?.() ?? packed.numSplats ?? 0;
	const sh = Math.max(0, Math.min(3, packed.getNumSh?.() ?? packed.maxSh ?? 0));
	const step = Math.max(1, Math.floor(count / 200000)); // a sample is enough for a percentile
	/** @type {number[][]} */
	const axes = [[], [], []];
	packed.forEachSplat((/** @type {number} */ i, /** @type {any} */ c, /** @type {any} */ _s, /** @type {any} */ _q, /** @type {number} */ opacity) => {
		if (i % step || opacity < 0.05) return;
		axes[0].push(c.x);
		axes[1].push(c.y);
		axes[2].push(c.z);
	});
	/** @param {number[]} a @param {number} q */
	const at = (a, q) => a[Math.max(0, Math.min(a.length - 1, Math.round(q * (a.length - 1))))];
	const bounds = [-1, -1, -1, 1, 1, 1];
	if (axes[0].length) {
		for (let k = 0; k < 3; k++) {
			const a = axes[k].sort((x, y) => x - y);
			bounds[k] = at(a, 0.005);
			bounds[k + 3] = at(a, 0.995);
		}
	}
	return { count, sh, bounds };
}

/**
 * The plan's reduced bytes. Steps `spz` and `sh` are Spark's own transcoder (every splat kept);
 * `decimate` keeps the most opaque share (decimateOrder) and writes it with no colour bands.
 * @param {Uint8Array} bytes @param {string} fileName @param {{step: string, keep: number, sh: number}} plan
 * @returns {Promise<Uint8Array>}
 */
async function reduceBytes(bytes, fileName, plan) {
	const spark = await loadSpark();
	if (plan.step !== 'decimate') {
		const out = await spark.transcodeSpz({ inputs: [{ fileBytes: bytes, pathOrUrl: fileName }], maxSh: plan.sh });
		return new Uint8Array(out.fileBytes);
	}
	const packed = await parseSplats(bytes, fileName);
	const n = packed.getNumSplats();
	const opacities = new Float32Array(n);
	packed.forEachSplat((/** @type {number} */ i, /** @type {any} */ _c, /** @type {any} */ _s, /** @type {any} */ _q, /** @type {number} */ o) => {
		opacities[i] = o;
	});
	const kept = packed.extractSplats(decimateOrder(opacities, plan.keep), false);
	const out = await spark.writeSpz(kept, { maxSh: 0 });
	packed.dispose?.();
	kept.dispose?.();
	return new Uint8Array(out.fileBytes);
}

/** what each step keeps, in the dialog's words @param {{step: string, keep: number}} p */
function stepWords(p) {
	if (p.step === 'spz') return 'Convert to the compact .spz format. Every splat and colour is kept.';
	if (p.step === 'sh') return 'Convert to .spz and drop the colour that changes with the viewing angle. Every splat is kept; shiny spots look flatter.';
	return `Convert to .spz, drop the view-dependent colour, and keep the ${Math.round(p.keep * 100)} % most solid splats.`;
}

/**
 * The Library's gate for a splat file (explorer.js importFiles calls it through convertForImport).
 * null = store it as it is; [file] = store this smaller .spz instead; false = refused or cancelled
 * (already said).
 * @param {File} file @returns {Promise<File[] | null | false>}
 */
export async function prepareSplatFile(file) {
	if (file.size > SPLAT_MAX_INPUT_BYTES) {
		showToast(`${file.name} is ${mbText(file.size)}. Splat files up to ${mbText(SPLAT_MAX_INPUT_BYTES)} can be read here; cut it down in a splat editor first.`);
		return false;
	}
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (/\.ply$/i.test(file.name)) {
		const kind = plyKind(readPlyHeader(bytes));
		if (kind === 'mesh') {
			showToast(`${file.name} is a mesh, not a Gaussian splat. Import it as .glb or .obj.`);
			return false;
		}
		if (kind === 'unknown') {
			showToast(`Could not read ${file.name} as a Gaussian splat.`);
			return false;
		}
	}
	if (file.size <= SPLAT_CAP_BYTES) return null;
	let packed;
	try {
		packed = await parseSplats(bytes, file.name);
	} catch (error) {
		console.log('splat read failed', file.name, error);
		showToast(`Could not read ${file.name} as a Gaussian splat.`);
		return false;
	}
	const count = packed.getNumSplats();
	const sh = packed.getNumSh?.() ?? 0;
	packed.dispose?.();
	const plan = reducePlan({ bytes: file.size, count, sh });
	if (!plan.fits) {
		showToast(`${file.name} is too big to share: ${plan.why}`);
		return false;
	}
	const { showChoiceEx } = await import('../confirmDialog.js');
	const answer = await showChoiceEx({
		id: 'splat-reduce',
		title: 'This splat is over the 25 MB file limit',
		message: `${file.name} is ${mbText(file.size)} with ${splatCountText(count)}. Files over 25 MB cannot be stored or shared with the session, so the app can make a smaller copy (about ${mbText(plan.estimate)}):`,
		items: [stepWords(plan), 'The original file on your computer is not changed.'],
		choices: [{ value: 'reduce', label: 'Make a smaller copy' }],
		cancelLabel: 'Cancel'
	});
	if (answer?.value !== 'reduce') return false;
	showToast(`Making a smaller copy of ${file.name}...`);
	try {
		let p = plan;
		let out = await reduceBytes(bytes, file.name, p);
		// the estimate is good to ~20 %: walk down the ladder until the REAL size fits
		for (let tries = 0; out.byteLength > SPLAT_CAP_BYTES && tries < 4; tries++) {
			if (p.step === 'spz') p = { ...p, step: 'sh', sh: 0 };
			else {
				const keep = Math.floor(p.keep * (SPLAT_CAP_BYTES / out.byteLength) * 0.95 * 1000) / 1000;
				if (keep < SPLAT_MIN_KEEP) break;
				p = { ...p, step: 'decimate', sh: 0, keep };
			}
			out = await reduceBytes(bytes, file.name, p);
		}
		if (out.byteLength > SPLAT_CAP_BYTES) {
			showToast(`${file.name} could not be brought under 25 MB. Cut it down in a splat editor first, then import it again.`);
			return false;
		}
		return [new File([/** @type {BlobPart} */ (out)], baseName(file.name) + '.spz', { type: 'application/octet-stream' })];
	} catch (error) {
		console.log('splat reduce failed', file.name, error);
		showToast(`Could not make a smaller copy of ${file.name}.`);
		return false;
	}
}

/** record facts by content hash (a file is read once per tab) @type {Map<string, {count: number, sh: number, bounds: number[]}>} */
const factsCache = new Map();

/**
 * The splat record for a Library item (reads and parses the bytes once per hash).
 * @param {{id: string, name: string, hash: string}} item
 */
export async function splatRecordFor(item) {
	let facts = factsCache.get(item.hash);
	if (!facts) {
		const blob = await itemBlob(item.id);
		if (!blob) throw new Error('the file is missing from this device');
		const packed = await parseSplats(new Uint8Array(await blob.arrayBuffer()), item.name);
		facts = splatFacts(packed);
		packed.dispose?.();
		factsCache.set(item.hash, facts);
	}
	return { hash: item.hash, file: item.name, count: facts.count, sh: facts.sh, bounds: [...facts.bounds], crop: null, opacity: 1 };
}

/**
 * A Library splat into the scene: its box's bottom centre lands on the drop point (a scan's own
 * origin is wherever the capture put it), selected, replicated, one undo step.
 * @param {{id: string, name: string, hash: string}} item @param {number[] | null | undefined} [point]
 */
export async function placeSplatItem(item, point) {
	let rec;
	try {
		rec = await splatRecordFor(item);
	} catch (error) {
		console.log('splat read failed', item.name, error);
		showToast(`Could not read ${item.name} as a Gaussian splat.`);
		return null;
	}
	const [{ makeSplatCarrier }, { addImported }] = await Promise.all([import('./splatObject.js'), import('../fileHandler.svelte')]);
	const carrier = makeSplatCarrier(rec, baseName(item.name));
	const b = rec.bounds;
	const at = point ?? [0, 0, 0];
	addImported(carrier, baseName(item.name), [at[0] - (b[0] + b[3]) / 2, at[1] - b[1], at[2] - (b[2] + b[5]) / 2]);
	showToast(`Placed "${carrier.name}" (${splatCountText(rec.count)})`);
	return carrier;
}

/**
 * Splat FILES dropped or picked: into the Library (through its gate), then each into the scene.
 * @param {File[]} files @param {number[] | null} [point]
 */
export async function importSplatFiles(files, point = null) {
	const items = (await importFiles(files, null)).filter((/** @type {any} */ it) => it?.kind === 'splat');
	const placed = [];
	for (const item of items) {
		const live = get(explorerItems).find((it) => it.id === item.id) ?? item;
		const c = await placeSplatItem(live, point);
		if (c) placed.push(c);
	}
	return placed;
}
