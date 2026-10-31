/** Logical mute state for an audio companion; the video is intentionally muted. */
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
