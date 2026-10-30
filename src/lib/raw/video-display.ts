/** MP4で指定された画素比率を表示寸法へ変換する。形式や放送局から16:9を決め打ちしない。 */
export function mp4DisplaySize(
  track: {
    width: number;
    height: number;
    pixelAspect?: { horizontal: number; vertical: number };
  } | null,
): { width: number; height: number } | null {
  if (track?.pixelAspect === undefined) return null;
  const {
    width,
    height,
    pixelAspect: { horizontal, vertical },
  } = track;
  if (
    ![width, height, horizontal, vertical].every(
      (v) => Number.isFinite(v) && v > 0,
    )
  )
    return null;
  const displayWidth = Math.round((width * horizontal) / vertical);
  // 壊れたpaspで巨大なcanvasを作らない。表せない場合は従来のデコーダーの寸法を使う。
  if (displayWidth < 1 || displayWidth > 65535 || height > 65535) return null;
  return { width: displayWidth, height };
}
