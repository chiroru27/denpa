import { expect, test } from "bun:test";

import type { Fmp4Track } from "#lib/ts/fmp4.js";

import { Fmp4Video } from "./fmp4";

test("Safari型とChrome型の表示寸法でも、pasp指定の映像を同じ幅で描く", () => {
  const previous = globalThis.VideoDecoder;
  const created: FakeDecoder[] = [];
  class FakeDecoder {
    state = "unconfigured";
    decodeQueueSize = 0;
    config: VideoDecoderConfig | null = null;
    constructor(readonly init: VideoDecoderInit) {
      created.push(this);
    }
    configure(config: VideoDecoderConfig) {
      this.config = config;
      this.state = "configured";
    }
    close() {
      this.state = "closed";
    }
  }
  globalThis.VideoDecoder = FakeDecoder as unknown as typeof VideoDecoder;
  try {
    for (const returnedWidth of [1440, 1920]) {
      const draws: number[][] = [];
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: (_: unknown, ...args: number[]) => draws.push(args),
        }),
      };
      const video = new Fmp4Video(canvas as unknown as OffscreenCanvas, {
        audio: { open: () => true, push() {} },
        fail: (message) => {
          throw new Error(message);
        },
        drew() {},
        record() {},
        full() {},
      });
      const track: Fmp4Track = {
        id: 1,
        kind: "video",
        timescale: 90000,
        codec: "avc1.640029",
        config: new Uint8Array(),
        width: 1440,
        height: 1080,
        pixelAspect: { horizontal: 4, vertical: 3 },
        channels: 0,
        sampleRate: 0,
        defaults: { duration: 1500, size: 0, flags: 0 },
      };
      video.configure([track]);
      const decoder = created.at(-1)!;
      expect(decoder.config?.displayAspectWidth).toBe(1920);
      expect(decoder.config?.displayAspectHeight).toBe(1080);
      let closed = false;
      decoder.init.output({
        displayWidth: returnedWidth,
        displayHeight: 1080,
        timestamp: 0,
        close() {
          closed = true;
        },
      } as unknown as VideoFrame);
      video.tick(null);
      expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
      expect(draws).toEqual([[0, 0, 1920, 1080]]);
      expect(closed).toBe(true);
    }
  } finally {
    globalThis.VideoDecoder = previous;
  }
});
