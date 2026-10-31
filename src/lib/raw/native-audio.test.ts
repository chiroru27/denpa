import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  chooseNativeAudio,
  NATIVE_AUDIO_KEY,
  nativeAudioEnabled,
} from "#lib/native-audio-choice.js";

import { NativeAudio } from "./native-audio";
import type { AudioInput, AudioOutput } from "./native-audio-protocol";
import { nativeAudioMuted } from "./native-audio-state";
class Node {
  gain = { value: 1 };
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
  playbackRate = { value: 1 };
  buffer: unknown;
  stopped = false;
  starts: number[][] = [];
  onended: (() => void) | null = null;
  connect() {}
  disconnect() {}
  stop() {
    this.stopped = true;
  }
  start(...args: number[]) {
    this.starts.push(args);
  }
}
class Context {
  static all: Context[] = [];
  static failGraph = false;
  state = "running";
  currentTime = 50;
  baseLatency = 0;
  outputLatency = 0;
  destination = new Node();
  sources: Node[] = [];
  onstatechange: (() => void) | null = null;
  constructor() {
    Context.all.push(this);
  }
  createGain() {
    return new Node();
  }
  createDynamicsCompressor() {
    if (Context.failGraph) throw new Error("audio graph unavailable");
    return new Node();
  }
  createBuffer() {
    return { copyToChannel() {} };
  }
  createBufferSource() {
    const node = new Node();
    this.sources.push(node);
    return node;
  }
  async resume() {
    this.state = "running";
  }
  async close() {
    this.state = "closed";
  }
}
class TestWorker {
  static all: TestWorker[] = [];
  messages: AudioInput[] = [];
  terminated = false;
  onmessage: ((event: { data: AudioOutput }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    TestWorker.all.push(this);
  }
  postMessage(message: AudioInput) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  pcm(epoch: number, pts: number) {
    this.onmessage?.({
      data: {
        type: "pcm",
        epoch,
        chunk: { pts, sampleRate: 48000, planes: [new Float32Array(1024)] },
      },
    });
  }
}
class Video extends EventTarget {
  currentTime = 10;
  readyState = 4;
  paused = false;
  muted = false;
  playbackRate = 1;
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  async play() {
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
  }
}
const originals = new Map<string, PropertyDescriptor | undefined>();
let audio: InstanceType<typeof NativeAudio> | null;
function set(name: string, value: unknown) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}
beforeEach(() => {
  Context.all = [];
  Context.failGraph = false;
  TestWorker.all = [];
  audio = null;
  set("AudioContext", Context);
  set("Worker", TestWorker);
  set("window", new EventTarget());
  set("navigator", { userAgent: "test", audioSession: { type: "auto" } });
  set("document", { body: { append() {} } });
});
afterEach(() => {
  audio?.destroy();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});
function setup(decoder = "/api/live/mpeg2") {
  const video = new Video(),
    errors: string[] = [];
  audio = new NativeAudio(
    video as unknown as HTMLVideoElement,
    (reason) => errors.push(reason),
    decoder,
  );
  const worker = TestWorker.all[0]!,
    context = Context.all[0]!;
  audio.feed(new Uint8Array([1]), true);
  video.dispatchEvent(new Event("playing"));
  return { video, worker, context, errors, audio };
}
test("uses the existing WASM endpoint and schedules PCM on the video timeline", () => {
  const { worker, context, audio } = setup();
  expect(worker.messages.find((m) => m.type === "load")?.base).toBe(
    "/api/live/mpeg2",
  );
  audio.setMuted(false);
  worker.pcm(1, 10.1);
  expect(context.sources).toHaveLength(1);
  expect(context.sources[0]!.starts[0]![0]).toBeCloseTo(50.1, 8);
});
test("reset cancels old audio and ignores late messages from the old channel", () => {
  const { worker, context, audio } = setup();
  worker.pcm(1, 10.1);
  audio.feed(new Uint8Array([2]), true);
  expect(context.sources[0]!.stopped).toBe(true);
  worker.pcm(1, 10.1);
  expect(context.sources).toHaveLength(1);
  worker.pcm(2, 10.15);
  expect(context.sources).toHaveLength(2);
});
test("pause cancels scheduled sound, resume uses the new video position", () => {
  const { video, worker, context } = setup();
  worker.pcm(1, 10.1);
  video.pause();
  expect(context.sources[0]!.stopped).toBe(true);
  video.currentTime = 10.1;
  void video.play();
  expect(context.sources).toHaveLength(2);
  expect(context.sources[1]!.starts[0]![1]).toBeCloseTo(0.005, 8);
});
test("bounded compressed queue fails explicitly and cleans up", () => {
  const { audio, errors, worker, context } = setup();
  audio.feed(new Uint8Array(8 * 1024 * 1024), false);
  expect(errors).toHaveLength(1);
  expect(worker.terminated).toBe(true);
  expect(context.state).toBe("closed");
});
test("destroy prevents late frames from starting audio", () => {
  const { worker, context, audio } = setup();
  audio.destroy();
  worker.pcm(1, 10.1);
  expect(context.sources).toHaveLength(0);
  expect(worker.terminated).toBe(true);
});

test("video timestamp jitter cannot make gaps between consecutive PCM frames", () => {
  const { video, worker, context } = setup();
  worker.pcm(1, 10.1);
  const firstStart = context.sources[0]!.starts[0]![0]!;
  context.currentTime = 50.01;
  video.currentTime = 10.012; // 2ms of sampling jitter, not an actual seek.
  worker.pcm(1, 10.1 + 1024 / 48000);
  expect(context.sources[1]!.starts[0]![0]).toBeCloseTo(
    firstStart + 1024 / 48000,
    8,
  );
});

test("logical mute remains separate from the intentionally muted video and is released", () => {
  const { audio, video } = setup();
  audio.setMuted(false);
  expect(video.muted).toBe(true);
  expect(nativeAudioMuted(video)).toBe(false);
  audio.setMuted(true);
  expect(nativeAudioMuted(video)).toBe(true);
  audio.destroy();
  expect(nativeAudioMuted(video)).toBe(undefined);
});

test("a recovered video play event also wakes the separate audio context", () => {
  const { video, context } = setup();
  context.state = "suspended";
  video.dispatchEvent(new Event("playing"));
  expect(context.state).toBe("running");
});

test("the workaround is off by default and only the saved checkbox enables it", () => {
  const location = { pathname: "/live", search: "?nativeAudio=1" };
  Object.defineProperty(window, "location", {
    value: location,
    configurable: true,
  });
  const saved = new Map<string, string>();
  set("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  expect(nativeAudioEnabled()).toBe(false); // Old URLs no longer enable it.
  chooseNativeAudio(true);
  expect(saved.get(NATIVE_AUDIO_KEY)).toBe("1");
  expect(nativeAudioEnabled()).toBe(true);
  location.search = "";
  expect(nativeAudioEnabled()).toBe(true); // Ordinary live URL.
  chooseNativeAudio(false);
  expect(nativeAudioEnabled()).toBe(false);
  chooseNativeAudio(true);
  // The player receives this choice only from the live page; no URL is read here.
  expect(Context.all).toHaveLength(0);
});

test("blocked audio is exposed to the ordinary mute/unmute controls", () => {
  const { audio, context } = setup();
  expect(audio.blocked).toBe(false);
  context.state = "suspended";
  expect(audio.blocked).toBe(true);
  audio.setMuted(false);
  expect(audio.blocked).toBe(false);
});

test("the player supplies the decoder endpoint, including its base path", () => {
  const { worker } = setup("/tv/api/live/mpeg2");
  expect(worker.messages.find((m) => m.type === "load")?.base).toBe(
    "/tv/api/live/mpeg2",
  );
});

test("audio graph setup failure closes the partially created context", () => {
  Context.failGraph = true;
  let threw = false;
  try {
    new NativeAudio(
      new Video() as unknown as HTMLVideoElement,
      () => {},
      "/api/live/mpeg2",
    );
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  expect(Context.all[0]!.state).toBe("closed");
  expect(TestWorker.all).toHaveLength(0);
});
