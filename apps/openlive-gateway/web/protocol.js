export const PROTOCOL_VERSION = "1.0";

const HEADER_BYTES = 60;
const MAGIC = [0x4f, 0x4c, 0x49, 0x56];

export function encodeInputAudio({
  sequence,
  mediaTimeUs,
  pcm,
  sampleRate,
  frameDurationMs,
  speechProbability,
  outputLevel,
  echoProbability,
}) {
  const packet = new ArrayBuffer(HEADER_BYTES + pcm.byteLength);
  const view = new DataView(packet);
  const bytes = new Uint8Array(packet);
  bytes.set(MAGIC, 0);
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setBigUint64(8, BigInt(sequence), true);
  view.setBigUint64(16, BigInt(mediaTimeUs), true);
  view.setUint32(40, sampleRate, true);
  view.setUint16(44, frameDurationMs, true);
  view.setUint8(46, 1);
  view.setFloat32(48, speechProbability, true);
  view.setFloat32(52, outputLevel, true);
  view.setFloat32(56, echoProbability, true);
  bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), HEADER_BYTES);
  return packet;
}

export function decodeOutputAudio(packet) {
  const view = new DataView(packet);
  const bytes = new Uint8Array(packet);
  if (packet.byteLength < HEADER_BYTES || !MAGIC.every((value, index) => bytes[index] === value)) {
    throw new Error("Invalid Openlive media packet");
  }
  if (view.getUint8(4) !== 1 || view.getUint8(5) !== 2) {
    throw new Error("Unsupported Openlive output media packet");
  }
  return {
    sequence: Number(view.getBigUint64(8, true)),
    mediaTimeUs: Number(view.getBigUint64(16, true)),
    generationId: uuidFromBytes(bytes.subarray(24, 40)),
    sampleRate: view.getUint32(40, true),
    // frameDurationMs and channels are present in the binary header at
    // offsets 44 and 46 but not surfaced on the decoded object — no
    // consumer reads them. They remain on the wire for protocol 1.0
    // compatibility and may be re-surfaced in a future revision.
    pcm: new Int16Array(packet.slice(HEADER_BYTES)),
  };
}

function uuidFromBytes(bytes) {
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
