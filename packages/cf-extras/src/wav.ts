// PCM WAV for dictation (design 5.4). Dictation accepts only uncompressed PCM WAV because it is the one format whose
// length the Worker can know before paying for a transcription: the audio is exactly the bytes after the data chunk
// header divided by the bytes per second the fmt chunk implies. A compressed clip (WebM, Ogg, MP4, MP3) carries its
// duration only in container fields a sender can forge, so its cost is unknown until whisper has decoded it. The
// browser records with MediaRecorder, decodes the clip, downmixes it to mono at 16 kHz (what whisper reads) and
// encodes it with `encodePcm16Wav`: 30 s is 960,044 bytes, under the 1 MB body cap. Pure, so the web can import it.
// Track cf6-extras.

/** The sample rate the browser resamples dictation to (whisper reads 16 kHz). */
export const DICTATION_SAMPLE_RATE = 16_000;

export interface PcmWavInfo {
  format: "pcm" | "float";
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Where the audio starts (just past the data chunk header). */
  dataOffset: number;
  /** Every byte after the data chunk header as audio, so trailing chunks count too: an upper bound. */
  seconds: number;
}

const ascii = (b: Uint8Array, o: number, s: string) => [...s].every((ch, k) => b[o + k] === ch.charCodeAt(0));

/**
 * The format and an upper bound of the length of a PCM or float WAV, or null when the bytes are not one with a
 * consistent header (any other codec inside RIFF, a fmt chunk after the data, a byte rate or block align that does
 * not match the sample rate, channels and bits). The bound never trusts the data chunk's declared size or the byte
 * rate field: it uses the real byte count and the rate the format implies, which is what a decoder plays.
 */
export function pcmWavInfo(b: Uint8Array): PcmWavInfo | null {
  if (b.length < 44 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WAVE")) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let fmt: Omit<PcmWavInfo, "dataOffset" | "seconds"> | null = null;
  let off = 12;
  while (off + 8 <= b.length) {
    const size = dv.getUint32(off + 4, true);
    if (ascii(b, off, "fmt ")) {
      if (size < 16 || off + 24 > b.length) return null;
      const tag = dv.getUint16(off + 8, true), channels = dv.getUint16(off + 10, true), sampleRate = dv.getUint32(off + 12, true);
      const byteRate = dv.getUint32(off + 16, true), blockAlign = dv.getUint16(off + 20, true), bitsPerSample = dv.getUint16(off + 22, true);
      const format = tag === 1 ? "pcm" : tag === 3 ? "float" : null;
      if (!format || channels < 1 || channels > 2 || sampleRate < 8_000 || sampleRate > 48_000) return null;
      if (format === "pcm" ? ![8, 16, 24, 32].includes(bitsPerSample) : ![32, 64].includes(bitsPerSample)) return null;
      const frame = (channels * bitsPerSample) / 8;
      if (blockAlign !== frame || byteRate !== sampleRate * frame) return null;
      fmt = { format, sampleRate, channels, bitsPerSample };
    } else if (ascii(b, off, "data")) {
      if (!fmt) return null;
      const dataOffset = off + 8;
      return { ...fmt, dataOffset, seconds: (b.length - dataOffset) / (fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8)) };
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/** Mono samples in [-1, 1] as a 16-bit PCM WAV. */
export function encodePcm16Wav(samples: Float32Array | readonly number[], sampleRate: number = DICTATION_SAMPLE_RATE): Uint8Array {
  const n = samples.length;
  const out = new Uint8Array(44 + n * 2);
  const dv = new DataView(out.buffer);
  const put = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  put(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); put(8, "WAVE");
  put(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  put(36, "data"); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, Number(samples[i]) || 0));
    dv.setInt16(44 + i * 2, v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff), true);
  }
  return out;
}
