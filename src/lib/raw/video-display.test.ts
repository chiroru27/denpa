import { expect, test } from "bun:test";

import { mp4DisplaySize } from "./video-display";

test("1440x1080・SAR4:3は1920x1080へ。デコーダーの表示寸法へ二重に掛けない", () => {
  expect(
    mp4DisplaySize({
      width: 1440,
      height: 1080,
      pixelAspect: { horizontal: 4, vertical: 3 },
    }),
  ).toEqual({ width: 1920, height: 1080 });
});
test("正方画素はそのまま。4:3の映像を16:9へ引き伸ばさない", () => {
  expect(
    mp4DisplaySize({
      width: 640,
      height: 480,
      pixelAspect: { horizontal: 1, vertical: 1 },
    }),
  ).toEqual({ width: 640, height: 480 });
  expect(
    mp4DisplaySize({
      width: 1920,
      height: 1080,
      pixelAspect: { horizontal: 1, vertical: 1 },
    }),
  ).toEqual({ width: 1920, height: 1080 });
});
test("SDの非正方画素も画素比率に従って直す", () => {
  expect(
    mp4DisplaySize({
      width: 720,
      height: 480,
      pixelAspect: { horizontal: 8, vertical: 9 },
    }),
  ).toEqual({ width: 640, height: 480 });
});
test("画素比率のない場合はデコーダーへ任せ、壊れた指定は使わない", () => {
  expect(mp4DisplaySize(null)).toBeNull();
  expect(mp4DisplaySize({ width: 1440, height: 1080 })).toBeNull();
  for (const horizontal of [0, NaN, Infinity, 0xffffffff]) {
    expect(
      mp4DisplaySize({
        width: 1440,
        height: 1080,
        pixelAspect: { horizontal, vertical: 1 },
      }),
    ).toBeNull();
  }
  expect(
    mp4DisplaySize({
      width: 1440,
      height: 1080,
      pixelAspect: { horizontal: 4, vertical: 0 },
    }),
  ).toBeNull();
});
