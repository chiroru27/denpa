import { expect, test } from "bun:test";

import { nativeBackgroundRecovery } from "./native-background";

class Video extends EventTarget {
  paused = false;
  ended = false;
  muted = false;
  readyState = 3;
  calls = 0;
  reject = false;
  play(): Promise<void> {
    this.calls++;
    if (this.reject) return Promise.reject(new Error("NotAllowedError"));
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
}
class Visibility extends EventTarget {
  visibilityState = "visible";
  hide(): void {
    this.visibilityState = "hidden";
    this.dispatchEvent(new Event("visibilitychange"));
  }
  show(): void {
    this.visibilityState = "visible";
    this.dispatchEvent(new Event("visibilitychange"));
  }
}
function fixture(hasControls = true) {
  const video = new Video();
  const document = new Visibility();
  const page = new EventTarget();
  const state = { time: 0, enabled: true, paused: false, interrupted: false };
  const handlers = new Map<string, (() => void) | null>();
  const media = {
    setActionHandler(action: "play" | "pause", fn: (() => void) | null) {
      handlers.set(action, fn);
    },
  };
  const reports: string[] = [];
  const stop = nativeBackgroundRecovery({
    video,
    page,
    visibility: document,
    media: hasControls ? media : undefined,
    enabled: () => state.enabled,
    userPaused: () => state.paused,
    pause: () => {
      state.paused = true;
      video.pause();
    },
    resume: () => {
      state.paused = false;
      void video.play();
    },
    interrupted: () => state.interrupted,
    now: () => state.time,
    report: (event) => reports.push(event),
  });
  return { video, document, page, state, handlers, media, reports, stop };
}

test("native pause 150ms before hide is retried once", () => {
  const f = fixture();
  f.state.time = 1000;
  f.video.pause();
  expect(f.video.calls).toBe(0);
  f.state.time = 1150;
  f.document.hide();
  expect(f.video.calls).toBe(1);
  f.video.pause();
  f.document.dispatchEvent(new Event("visibilitychange"));
  expect(f.video.calls).toBe(1);
  f.stop();
});
test("native pause after hide is also retried once", () => {
  const f = fixture();
  f.state.time = 1000;
  f.document.hide();
  expect(f.video.calls).toBe(0);
  f.state.time = 1100;
  f.video.pause();
  expect(f.video.calls).toBe(1);
  f.stop();
});
test("paused well before hiding is not resumed", () => {
  const f = fixture();
  f.video.pause();
  f.state.time = 1000;
  f.document.hide();
  expect(f.video.calls).toBe(0);
  f.stop();
});
test("page button pause is respected", () => {
  const f = fixture();
  f.state.paused = true;
  f.video.pause();
  f.state.time = 100;
  f.document.hide();
  expect(f.video.calls).toBe(0);
  f.stop();
});
test("external pause during transition cancels recovery", () => {
  const f = fixture();
  f.document.hide();
  f.handlers.get("pause")?.();
  expect(f.state.paused).toBe(true);
  expect(f.video.calls).toBe(0);
  f.stop();
});
test("external play can resume after the recovery window", () => {
  const f = fixture();
  f.state.paused = true;
  f.video.pause();
  f.document.hide();
  f.state.time = 5000;
  f.handlers.get("play")?.();
  expect(f.state.paused).toBe(false);
  expect(f.video.calls).toBe(1);
  f.stop();
});
test("late pauses and hidden samples do not start new retries", () => {
  const f = fixture();
  f.document.hide();
  f.state.time = 2000;
  f.video.pause();
  f.document.dispatchEvent(new Event("visibilitychange"));
  expect(f.video.calls).toBe(0);
  f.stop();
});
test("disabled, interrupted, muted and ended cases do not resume", () => {
  for (const kind of [
    "disabled",
    "interrupted",
    "muted",
    "ended",
    "empty",
  ] as const) {
    const f = fixture();
    if (kind === "disabled") f.state.enabled = false;
    if (kind === "interrupted") f.state.interrupted = true;
    if (kind === "muted") f.video.muted = true;
    if (kind === "ended") f.video.ended = true;
    if (kind === "empty") f.video.readyState = 0;
    f.document.hide();
    f.video.pause();
    expect(f.video.calls).toBe(0);
    f.stop();
  }
});
test("without media controls, do not risk overriding an external pause", () => {
  const f = fixture(false);
  f.document.hide();
  f.video.pause();
  expect(f.video.calls).toBe(0);
  f.stop();
});
test("pagehide or cleanup blocks further recovery", () => {
  const f = fixture();
  f.document.hide();
  f.page.dispatchEvent(new Event("pagehide"));
  f.video.pause();
  expect(f.video.calls).toBe(0);
  f.stop();
  f.document.show();
  f.video.paused = false;
  f.document.hide();
  f.video.pause();
  expect(f.video.calls).toBe(0);
  expect(f.handlers.get("pause")).toBeNull();
});
test("play rejection is recorded and never loops", async () => {
  const f = fixture();
  f.video.reject = true;
  f.document.hide();
  f.video.pause();
  await Promise.resolve();
  f.video.dispatchEvent(new Event("pause"));
  expect(f.video.calls).toBe(1);
  expect(
    f.reports.some((event) => event.startsWith("background-resume-rejected")),
  ).toBe(true);
  f.stop();
});
test("returning to visible allows a fresh later transition", () => {
  const f = fixture();
  f.document.hide();
  f.video.pause();
  expect(f.video.calls).toBe(1);
  f.document.show();
  f.state.time = 3000;
  f.document.hide();
  f.video.pause();
  expect(f.video.calls).toBe(2);
  f.stop();
});
