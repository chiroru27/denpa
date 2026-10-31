import { expect, goto, test } from "./helpers";

test("音量調整の互換処理は既定オフで、このブラウザだけに保存し、解除できる", async ({
  page,
}) => {
  await goto(page, "/settings/general#version");
  const toggle = page.getByTestId("native-audio-compat-toggle");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await goto(page, "/settings/general#version");
  await expect(toggle).toBeChecked();
  expect(
    await page.evaluate(() => localStorage.getItem("native-audio-compat")),
  ).toBe("1");
  await toggle.uncheck();
  await goto(page, "/settings/general#version");
  await expect(toggle).not.toBeChecked();
  expect(
    await page.evaluate(() => localStorage.getItem("native-audio-compat")),
  ).toBe("0");
});
