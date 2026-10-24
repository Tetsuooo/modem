// Encodes the Mix tab's export (WAV or MP3) off the page's own thread, so the page doesn't
// freeze while a long show is encoded (it used to — Matej, 2026-10-24) and can show
// progress. The page (exportMix() in index.html) sends the rendered mix in slices of ~10 s;
// each slice comes back encoded as a part of the file, and the page asks for the next.
//
// Messages in:  { type: 'start', format: 'wav'|'mp3', sampleRate, numChannels, numFrames, bitrate }
//               { type: 'data', chans: [Float32Array, …] }   one slice, per channel
//               { type: 'end' }
// Messages out: { type: 'ready', part? }   (WAV: its header)
//               { type: 'encoded', part }   one slice's bytes
//               { type: 'done', part? }     (MP3: the encoder's last bytes)
//               { type: 'error', message }
/* global lamejs */
let format = 'wav';
let numChannels = 2;
let encoder = null;

function toInt16(data) {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function wavHeader(sampleRate, channels, numFrames) {
  const blockAlign = channels * 2;
  const dataSize = numFrames * blockAlign;
  const view = new DataView(new ArrayBuffer(44));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, dataSize, true);
  return new Uint8Array(view.buffer);
}

// one slice → bytes: WAV = interleaved 16-bit samples, MP3 = lamejs frames
function encodeSlice(chans) {
  if (format === 'wav') {
    const frames = chans[0].length;
    const out = new Int16Array(frames * numChannels);
    for (let i = 0, o = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        const s = Math.max(-1, Math.min(1, chans[c][i]));
        out[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }
    return new Uint8Array(out.buffer);
  }
  const left = toInt16(chans[0]);
  const right = numChannels > 1 ? toInt16(chans[1]) : null;
  const CHUNK = 1152; // one MP3 frame's worth of samples
  const pieces = [];
  let size = 0;
  for (let i = 0; i < left.length; i += CHUNK) {
    const buf = right ? encoder.encodeBuffer(left.subarray(i, i + CHUNK), right.subarray(i, i + CHUNK)) : encoder.encodeBuffer(left.subarray(i, i + CHUNK));
    if (buf.length) { pieces.push(new Uint8Array(buf)); size += buf.length; }
  }
  const out = new Uint8Array(size);
  let o = 0;
  pieces.forEach((p) => { out.set(p, o); o += p.length; });
  return out;
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'start') {
      format = m.format;
      numChannels = Math.min(2, m.numChannels);
      if (format === 'mp3') {
        importScripts('/vendor/lame.min.js');
        encoder = new lamejs.Mp3Encoder(numChannels, m.sampleRate, m.bitrate || 192);
        self.postMessage({ type: 'ready' });
      } else {
        const header = wavHeader(m.sampleRate, numChannels, m.numFrames);
        self.postMessage({ type: 'ready', part: header }, [header.buffer]);
      }
    } else if (m.type === 'data') {
      const part = encodeSlice(m.chans);
      self.postMessage({ type: 'encoded', part }, [part.buffer]);
    } else if (m.type === 'end') {
      if (format === 'mp3') {
        const tail = new Uint8Array(encoder.flush());
        self.postMessage({ type: 'done', part: tail }, [tail.buffer]);
      } else {
        self.postMessage({ type: 'done' });
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
