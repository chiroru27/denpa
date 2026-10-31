/** Explicit, per-browser preference. No user-agent or URL based activation. */
import { read, write } from "#lib/keep.js";
export const NATIVE_AUDIO_KEY = "native-audio-compat";
export function nativeAudioEnabled(): boolean {
  return read(NATIVE_AUDIO_KEY) === "1";
}
export function chooseNativeAudio(enabled: boolean): void {
  write(NATIVE_AUDIO_KEY, enabled ? "1" : "0");
}
