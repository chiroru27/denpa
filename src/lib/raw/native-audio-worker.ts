/// <reference lib="webworker" />
import {
  adtsHeader,
  type Fmp4Track,
  opusHead,
  readFragment,
  readInit,
} from "../ts/fmp4";
import {
  type AudioInput,
  type AudioOutput,
  MAX_PENDING_BYTES,
} from "./native-audio-protocol";
interface Decoder {
  _aac_open(): number;
  _opus_open(pointer: number, length: number): number;
  _audio_push(pointer: number, length: number): number;
  _audio_peek(): number;
  _malloc(length: number): number;
  _free(pointer: number): void;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
}
const scope = self as unknown as DedicatedWorkerGlobalScope;
let decoder: Decoder | null = null;
let audio: Fmp4Track | undefined;
let epoch = -1;
let pointer = 0;
let capacity = 0;
let held: Extract<AudioInput, { type: "segment" }>[] = [];
let heldBytes = 0;
let failed = false;
function post(message: AudioOutput, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}
function fail(message: string): void {
  if (failed) return;
  failed = true;
  held = [];
  post({ type: "error", message });
}
function put(bytes: Uint8Array): number {
  if (decoder === null) throw new Error("decoder not ready");
  if (bytes.length > capacity) {
    if (pointer !== 0) decoder._free(pointer);
    pointer = decoder._malloc(bytes.length);
    if (pointer === 0) throw new Error("audio allocation failed");
    capacity = bytes.length;
  }
  decoder.HEAPU8.set(bytes, pointer);
  return pointer;
}
function segment(message: Extract<AudioInput, { type: "segment" }>): void {
  const d = decoder;
  if (d === null || failed) return;
  const bytes = message.bytes;
  if (message.init) {
    epoch = message.epoch;
    audio = readInit(bytes).find((t) => t.kind === "audio");
    if (audio === undefined) throw new Error("audio track missing");
    if (audio.codec === "opus") {
      const head = opusHead(audio.config);
      if (head === null || d._opus_open(put(head), head.length) !== 0)
        throw new Error("Opus could not open");
    } else if (audio.codec.startsWith("mp4a")) {
      if (d._aac_open() !== 0) throw new Error("AAC could not open");
    } else throw new Error("unsupported audio codec: " + audio.codec);
    return;
  }
  if (message.epoch !== epoch || audio === undefined) return;
  for (const sample of readFragment(bytes, [audio])) {
    if (sample.track !== audio.id) continue;
    let frame = sample.data;
    if (audio.codec !== "opus") {
      const header = adtsHeader(audio.config, frame.length);
      if (header === null) throw new Error("unsupported AAC configuration");
      const packed = new Uint8Array(header.length + frame.length);
      packed.set(header);
      packed.set(frame, header.length);
      frame = packed;
    }
    const count = d._audio_push(put(frame), frame.length);
    if (count < 0) throw new Error("audio decode failed");
    if (count === 0) continue;
    const info = d._audio_peek() >> 2;
    const channels = d.HEAP32[info]!;
    const sampleRate = d.HEAP32[info + 1]!;
    if (
      channels < 1 ||
      channels > 8 ||
      sampleRate < 8000 ||
      sampleRate > 192000 ||
      count > 16384
    )
      throw new Error("invalid PCM format");
    const planes: Float32Array<ArrayBuffer>[] = [];
    for (let ch = 0; ch < channels; ch++) {
      planes.push(
        new Float32Array(
          d.HEAPU8.buffer,
          d.HEAP32[info + 3 + ch]!,
          count,
        ).slice(),
      );
    }
    post(
      {
        type: "pcm",
        epoch,
        chunk: { pts: sample.pts / audio.timescale, sampleRate, planes },
      },
      planes.map((p) => p.buffer),
    );
  }
}
async function load(base: string): Promise<void> {
  try {
    const url = new URL(base + "/decoder.mjs", scope.location.origin).href;
    const mod = (await import(/* @vite-ignore */ url)) as {
      default: (options: object) => Promise<Decoder>;
    };
    decoder = await mod.default({
      locateFile: (name: string) =>
        new URL(base + "/" + name, scope.location.origin).href,
    });
    const waiting = held;
    held = [];
    heldBytes = 0;
    for (const message of waiting) {
      segment(message);
      post({ type: "ack", bytes: message.bytes.byteLength });
    }
  } catch (error) {
    fail(String(error));
  }
}
scope.onmessage = (event: MessageEvent<AudioInput>) => {
  if (failed) return;
  const message = event.data;
  if (message.type === "load") {
    void load(message.base);
    return;
  }
  try {
    if (decoder === null) {
      heldBytes += message.bytes.byteLength;
      if (heldBytes > MAX_PENDING_BYTES)
        throw new Error("decoder startup queue exceeded limit");
      held.push(message);
    } else {
      segment(message);
      post({ type: "ack", bytes: message.bytes.byteLength });
    }
  } catch (error) {
    fail(String(error));
  }
};
