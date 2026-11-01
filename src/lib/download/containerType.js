// Roadmap 56 C14: Android Chrome rewrites a download's extension to match its Blob type, so a
// `.tp` typed application/zip lands as `<name>.tp.zip`. A zip container with OUR extension is
// handed over as plain bytes; a real `.zip` stays application/zip.

/** @param {string} fileName @returns {string} the Blob type for downloading this file */
export function containerType(fileName) {
	return /\.zip$/i.test(String(fileName ?? '')) ? 'application/zip' : 'application/octet-stream';
}
