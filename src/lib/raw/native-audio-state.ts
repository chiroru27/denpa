/**
 * 音を別に鳴らしているときの、使う人から見た消音 (`native-audio.ts`)。`<video>` はわざと消音にしてあるので、
 * `video.muted` では分からない。別に鳴らしていない要素は undefined
 */
const states = new WeakMap<object, boolean>();
export function nativeAudioMuted(video: object): boolean | undefined {
  return states.get(video);
}
export function setNativeAudioMuted(
  video: object,
  muted: boolean | null,
): void {
  if (muted === null) states.delete(video);
  else states.set(video, muted);
}
