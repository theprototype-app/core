// 56 C8: writes the committed GPS-tagged JPEG fixtures. Chromium encodes the pixels (a real baseline
// JPEG), exifBuilder adds a phone-style EXIF block with GPS. Run: node tests/fixtures/exif/build-gps-jpeg.mjs
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gpsApp1, spliceApp1 } from './exifBuilder.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage();
/** @param {number} w @param {number} h */
async function jpeg(w, h) {
	const b64 = await page.evaluate(
		async ([w, h]) => {
			const c = document.createElement('canvas');
			c.width = w;
			c.height = h;
			const g = c.getContext('2d');
			const grad = g.createLinearGradient(0, 0, w, h);
			grad.addColorStop(0, '#e05a2b');
			grad.addColorStop(1, '#2b6fe0');
			g.fillStyle = grad;
			g.fillRect(0, 0, w, h);
			g.fillStyle = '#fff';
			g.font = Math.round(h / 6) + 'px sans-serif';
			g.fillText('campfire', w / 10, h / 2);
			const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
			const buf = new Uint8Array(await blob.arrayBuffer());
			let s = '';
			for (const x of buf) s += String.fromCharCode(x);
			return btoa(s);
		},
		[w, h]
	);
	return Uint8Array.from(Buffer.from(b64, 'base64'));
}
const app1 = gpsApp1(52.520008, 13.404954); // a phone photo taken in Berlin
writeFileSync(here + 'gps-photo.jpg', spliceApp1(await jpeg(96, 64), app1));
writeFileSync(here + 'gps-photo-large.jpg', spliceApp1(await jpeg(4000, 3000), app1));
await browser.close();
console.log('wrote gps-photo.jpg + gps-photo-large.jpg');
