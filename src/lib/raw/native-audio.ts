/**
 * ライブの映像は <video> のまま、音声だけ既存の WASM デコーダーと Web Audio で再生する。
 * Safari の MSE → MediaElementAudioSource が音声を渡さない問題を避けるための任意設定。
 * 同期は映像の時計に合わせ、AudioContext 上では連続する音声の間隔を保つ。
 */
import { Outlet, playbackSession } from "#lib/sound.js";

import {
  type AudioInput,
  type AudioOutput,
  audioPlan,
  MAX_PENDING_BYTES,
  type PcmChunk,
} from "./native-audio-protocol";
import { setNativeAudioMuted } from "./native-audio-state";

const TICK_MS = 20;
const PCM_LIMIT = 16 * 1024 * 1024;
const HISTORY_SECONDS = 30;
const SCHEDULE_AHEAD = 0.3;
const RESYNC_SECONDS = 0.08;

interface Frame extends PcmChunk {
  scheduled: number;
}
export class NativeAudio {
  private readonly context: AudioContext;
  private readonly worker: Worker;
  private readonly outlet: Outlet;
  private readonly muteGain: GainNode;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly bindings: [string, EventListener][] = [];
  private frames: Frame[] = [];
  private nodes = new Set<AudioBufferSourceNode>();
  private epoch = 0;
  private scheduleEpoch = 0;
  private inFlight = 0;
  private pcmBytes = 0;
  private gone = false;
  private waiting = true;
  private last: { at: number; position: number; rate: number } | null = null;
  private clockLatency = 0;
  constructor(
    private readonly video: HTMLVideoElement,
    private readonly failed: (reason: string) => void,
    decoder: string,
  ) {
    this.context = new AudioContext({ latencyHint: "interactive" });
    let outlet: Outlet | null = null;
    try {
      this.outlet = outlet = new Outlet(
        this.context,
        (audio) => document.body.append(audio),
        (paused) => {
          if (paused) video.pause();
          else void video.play().catch(() => undefined);
        },
        "live-audio-compat",
      );
      this.muteGain = this.context.createGain();
      this.muteGain.gain.value = 0;
      this.muteGain.connect(this.outlet.input);
      this.worker = new Worker(
        new URL("./native-audio-worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch (error) {
      outlet?.destroy();
      void this.context.close().catch(() => undefined);
      throw error;
    }
    this.worker.onmessage = (event: MessageEvent<AudioOutput>) =>
      this.receive(event.data);
    this.worker.onerror = () =>
      this.fail("音声デコーダーでエラーが発生しました");
    this.send({
      type: "load",
      base: decoder,
    });
    const bind = (event: string, fn: () => void) => {
      const listener: EventListener = fn;
      video.addEventListener(event, listener);
      this.bindings.push([event, listener]);
    };
    bind("playing", () => {
      this.waiting = false;
      this.wake();
      this.flush();
      this.tick();
    });
    for (const event of ["waiting", "seeking", "pause", "ended", "emptied"])
      bind(event, () => {
        this.waiting = true;
        this.flush();
      });
    bind("seeked", () => {
      this.waiting = video.readyState < 3;
      this.flush();
    });
    bind("ratechange", () => this.flush());
    this.timer = setInterval(() => this.tick(), TICK_MS);
    window.addEventListener("pointerdown", this.wake, true);
    window.addEventListener("keydown", this.wake, true);
    this.context.onstatechange = () => this.flush();
    void this.context.resume().catch(() => undefined);
  }
  private send(message: AudioInput, transfer: Transferable[] = []): void {
    if (!this.gone) this.worker.postMessage(message, transfer);
  }
  private readonly wake = (): void => {
    if (!this.gone && this.context.state !== "running")
      void this.context.resume().catch(() => undefined);
  };
  setVolume(level: number): void {
    this.outlet.level = level;
  }
  setMuted(muted: boolean): void {
    setNativeAudioMuted(this.video, muted);
    this.muteGain.gain.value = muted ? 0 : 1;
    this.video.muted = true;
    if (!muted) this.wake();
  }
  setBackground(on: boolean): void {
    playbackSession(on);
    this.outlet.want(on);
  }
  feed(bytes: Uint8Array, init: boolean): void {
    if (this.gone) return;
    if (init) {
      this.epoch++;
      this.flush();
      this.frames = [];
      this.pcmBytes = 0;
    }
    if (this.inFlight + bytes.byteLength > MAX_PENDING_BYTES) {
      this.fail("音声の読み込みが追いつきません");
      return;
    }
    const copy = bytes.slice();
    this.inFlight += copy.byteLength;
    this.send({ type: "segment", init, epoch: this.epoch, bytes: copy }, [
      copy.buffer,
    ]);
  }
  private receive(message: AudioOutput): void {
    if (this.gone) return;
    if (message.type === "ack") {
      this.inFlight = Math.max(0, this.inFlight - message.bytes);
      return;
    }
    if (message.type === "error") {
      this.fail(message.message);
      return;
    }
    if (message.epoch !== this.epoch) return;
    const frame = { ...message.chunk, scheduled: -1 };
    this.frames.push(frame);
    this.pcmBytes += frame.planes.reduce((n, p) => n + p.byteLength, 0);
    // ~30 seconds of stereo at 48 kHz. Pausing cannot grow memory indefinitely.
    while (this.pcmBytes > PCM_LIMIT && this.frames.length > 1)
      this.dropFirst();
    this.tick();
  }
  private dropFirst(): void {
    const first = this.frames.shift();
    if (first === undefined) return;
    this.pcmBytes -= first.planes.reduce((n, p) => n + p.byteLength, 0);
  }
  private flush(): void {
    for (const node of this.nodes) {
      try {
        node.stop();
      } catch {
        /* Already ended. */
      }
      node.disconnect();
    }
    this.nodes.clear();
    this.scheduleEpoch++;
    this.last = null;
  }
  private tick(): void {
    if (this.gone) return;
    const video = this.video,
      now = this.context.currentTime,
      position = video.currentTime;
    this.outlet.hold(video.paused || this.waiting);
    if (
      video.paused ||
      this.waiting ||
      video.readyState < 3 ||
      this.context.state !== "running"
    )
      return;
    const rate = video.playbackRate;
    if (
      this.last !== null &&
      Math.abs(
        this.last.position + (now - this.last.at) * this.last.rate - position,
      ) > RESYNC_SECONDS
    ) {
      this.flush();
    }
    // Keep one audio/video mapping. Re-reading video.currentTime for every
    // 21ms AAC frame turns timestamp jitter into audible gaps and overlaps.
    if (this.last === null) {
      this.last = { at: now, position, rate };
      this.clockLatency = Math.min(
        0.25,
        Math.max(
          0,
          (this.context.baseLatency || 0) + (this.context.outputLatency || 0),
        ),
      );
    }
    const audioPosition =
      this.last.position + (now - this.last.at) * this.last.rate;
    while (
      this.frames.length > 0 &&
      this.frames[0]!.pts < position - HISTORY_SECONDS
    )
      this.dropFirst();
    const latency = this.clockLatency;
    for (const frame of this.frames) {
      // Worker は音声の PTS 順に渡す。予約する先の範囲を超えたら、残りは次の刻みに回す。
      if (frame.pts > audioPosition + latency + SCHEDULE_AHEAD) break;
      if (frame.scheduled === this.scheduleEpoch) continue;
      const duration = frame.planes[0]!.length / frame.sampleRate;
      const plan = audioPlan(
        frame.pts,
        duration,
        audioPosition,
        rate,
        now,
        latency,
      );
      frame.scheduled = this.scheduleEpoch;
      if (plan === null) continue;
      const buffer = this.context.createBuffer(
        frame.planes.length,
        frame.planes[0]!.length,
        frame.sampleRate,
      );
      frame.planes.forEach((plane, ch) => buffer.copyToChannel(plane, ch));
      const node = this.context.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = rate;
      node.connect(this.muteGain);
      this.nodes.add(node);
      node.onended = () => {
        this.nodes.delete(node);
        node.disconnect();
      };
      node.start(plan.when, plan.offset, plan.duration);
    }
  }
  /** 自動再生を断られたら、通常の「音を出す」操作へ渡す。 */
  get blocked(): boolean {
    return this.context.state !== "running";
  }
  private fail(reason: string): void {
    if (this.gone) return;
    this.destroy();
    this.failed("音声の互換処理：" + reason);
  }
  destroy(): void {
    if (this.gone) return;
    this.gone = true;
    setNativeAudioMuted(this.video, null);
    this.flush();
    clearInterval(this.timer);
    for (const [event, listener] of this.bindings)
      this.video.removeEventListener(event, listener);
    window.removeEventListener("pointerdown", this.wake, true);
    window.removeEventListener("keydown", this.wake, true);
    this.worker.terminate();
    this.outlet.destroy();
    this.context.onstatechange = null;
    void this.context.close().catch(() => undefined);
    playbackSession(false);
    this.frames = [];
    this.pcmBytes = 0;
  }
}
