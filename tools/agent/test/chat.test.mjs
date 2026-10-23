// The bridge's chat helpers (roadmap 56): wait clamps, the image spool, import_model's local path.
// Run: node test/chat.test.mjs
import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitMs, ImageSpool, messageContent, withImportPath, importModelArgs, chatTools, CHAT_TOOL_NAMES } from '../src/chat.js';

let pass = 0;
let fail = 0;
const check = (name, cond) => {
	if (cond) {
		pass++;
		console.log('PASS ' + name);
	} else {
		fail++;
		console.log('FAIL ' + name);
	}
};
const throws = (fn, re) => {
	try {
		fn();
		return false;
	} catch (e) {
		return re.test(e.message);
	}
};

check('chat tools: the four names, each with an object schema', chatTools().map((t) => t.name).join() === CHAT_TOOL_NAMES.join() && chatTools().every((t) => t.inputSchema.type === 'object'));
check('waitMs: default 240 s', waitMs(undefined) === 240000 && waitMs('x') === 240000);
check('waitMs: clamped to 1..600 s', waitMs(0.2) === 1000 && waitMs(9999) === 600000 && waitMs(30) === 30000);

// --- the spool ---
const root = join(mkdtempSync(join(tmpdir(), 'tpa-')), 'spool');
const spool = new ImageSpool({ root });
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const p = spool.write('../../etc', 'm/1', 1, { mimeType: 'image/jpeg', data: PNG });
check('spool: ids cannot climb out of the spool', p.startsWith(root + '/') && !p.includes('..'.concat('/')) && p.endsWith('m_1-1.jpg'));
check('spool: dir 0700, file 0600', (statSync(join(root)).mode & 0o777) === 0o700 && (statSync(p).mode & 0o777) === 0o600);
const content = messageContent({ id: 'm1', chatId: 'c1', from: 'a', role: 'editor', text: 'x', images: [{ mimeType: 'image/png', data: PNG }, { mimeType: 'image/png' }] }, spool);
check('messageContent: one block per real image, JSON first', content.length === 2 && content[1].type === 'image' && JSON.parse(content[0].text).images.length === 1);
check('messageContent without a spool: no path, still the block', !JSON.parse(messageContent({ id: 'm', chatId: 'c', images: [{ mimeType: 'image/png', data: PNG }] }, null)[0].text).images[0].path);
spool.cleanup();
check('spool: cleanup removes everything', !existsSync(root));

// --- import_model ---
const host = { name: 'import_model', description: 'Import a GLB.', inputSchema: { type: 'object', properties: { data: { type: 'string' }, url: { type: 'string' } } } };
const aug = withImportPath(host);
check('withImportPath: adds path, keeps the host fields', !!aug.inputSchema.properties.path && !!aug.inputSchema.properties.data && /path/.test(aug.description));
check('withImportPath: leaves the host schema object untouched', !host.inputSchema.properties.path);
check('withImportPath: other tools untouched', withImportPath({ name: 'x', inputSchema: {} }).inputSchema.properties === undefined);
const dir = mkdtempSync(join(tmpdir(), 'tpa-glb-'));
const glb = Buffer.alloc(32);
glb.write('glTF', 0, 'latin1');
writeFileSync(join(dir, 'Tree.glb'), glb);
writeFileSync(join(dir, 'fake.glb'), Buffer.from('not a model at all'));
const ok = importModelArgs({ path: join(dir, 'Tree.glb'), position: [1, 0, 0] });
check('import_model path → data (base64), name from the file, path gone', ok.data === glb.toString('base64') && ok.name === 'Tree' && !('path' in ok) && ok.position[0] === 1);
check('import_model: explicit name wins', importModelArgs({ path: join(dir, 'Tree.glb'), name: 'Oak' }).name === 'Oak');
check('import_model: not a GLB → refused before anything is sent', throws(() => importModelArgs({ path: join(dir, 'fake.glb') }), /not a binary glTF/));
check('import_model: missing file → readable', throws(() => importModelArgs({ path: join(dir, 'nope.glb') }), /cannot read/));
check('import_model: over 25 MB → refused without reading', throws(() => importModelArgs({ path: 'big.glb' }, { size: () => 26 * 1048576, read: () => { throw new Error('read'); } }), /limit is 25 MB/));
check('import_model: path + data → refused', throws(() => importModelArgs({ path: join(dir, 'Tree.glb'), data: 'AAAA' }), /one of path/));
check('import_model without path passes through untouched', JSON.stringify(importModelArgs({ url: 'https://x/y.glb' })) === '{"url":"https://x/y.glb"}');
rmSync(dir, { recursive: true, force: true });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
