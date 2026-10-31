import { expect, test } from "bun:test";

import { isWebKit } from "./native-audio-choice";

test("WebKit (Safari・iPhone のほかのブラウザ) だけ音を別に鳴らす", () => {
  // macOS の Safari
  expect(
    isWebKit(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15",
    ),
  ).toBe(true);
  // iPhone の Safari と Chrome (中身は WebKit)
  expect(
    isWebKit(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1",
    ),
  ).toBe(true);
  expect(
    isWebKit(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1",
    ),
  ).toBe(true);
});

test("Chromium・Firefox は別に鳴らさない", () => {
  // Windows の Chrome・Edge
  expect(
    isWebKit(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    ),
  ).toBe(false);
  expect(
    isWebKit(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
    ),
  ).toBe(false);
  // テスラの車載ブラウザ (Chromium)
  expect(
    isWebKit(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Tesla/2026.32.1",
    ),
  ).toBe(false);
  // Firefox
  expect(
    isWebKit(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
    ),
  ).toBe(false);
});
