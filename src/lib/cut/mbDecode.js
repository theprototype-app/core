// 77 K1 — the slice of Mediabunny the cut DECODES with. Named imports, so the bundler leaves out
// the muxers, the encoders, the audio sinks and the audio-only demuxers (the whole namespace was
// ~172 KB gz; the rules' budget for K1's lazy chunk is ~40-60 KB). Only video containers a clip
// arrives in: MP4 / MOV, WebM / MKV, Ogg.
import { Input, BlobSource, CanvasSink, MP4, QTFF, WEBM, MATROSKA, OGG } from 'mediabunny';

export { Input, BlobSource, CanvasSink };
export const FORMATS = [MP4, QTFF, WEBM, MATROSKA, OGG];
