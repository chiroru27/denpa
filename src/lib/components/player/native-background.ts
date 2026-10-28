/** Bounded recovery for native video paused around iOS backgrounding.
 * This never loops, never resumes an explicit media-control pause, and never
 * requests playback just because a source is buffering.
 */
export interface NativeBackgroundVideo extends EventTarget {
  readonly paused: boolean;
  readonly ended: boolean;
  readonly muted: boolean;
  readonly readyState: number;
  play(): Promise<void>;
}
export interface NativeMediaActions {
  setActionHandler(
    action: "play" | "pause",
    handler: (() => void) | null,
  ): void;
}
interface Options {
  video: NativeBackgroundVideo;
  page: EventTarget;
  visibility: EventTarget & { readonly visibilityState: string };
  media: NativeMediaActions | undefined;
  enabled: () => boolean;
  userPaused: () => boolean;
  pause: () => void;
  resume: () => void;
  interrupted: () => boolean;
  now: () => number;
  report?: (event: string) => void;
}
const owners = new WeakMap<NativeMediaActions, object>();
const BEFORE_HIDE = 300;
const AFTER_HIDE = 1500;

export function nativeBackgroundRecovery(options: Options): () => void {
  const { video, page, visibility, media } = options;
  const token = {};
  let closed = false;
  let controls = false;
  let remotePause = false;
  let gone = false;
  let hidden = visibility.visibilityState === "hidden";
  let wasPlaying = !video.paused && !video.ended;
  let pauseAt = -Infinity;
  let recentlyPlaying = false;
  let until = -Infinity;
  let tried = false;
  const removers: Array<() => void> = [];
  const report = (event: string) => {
    if (!closed) options.report?.(event);
  };

  function willing(): boolean {
    return (
      !closed &&
      !gone &&
      controls &&
      options.enabled() &&
      !options.userPaused() &&
      !remotePause &&
      !options.interrupted() &&
      !video.ended &&
      !video.muted &&
      video.readyState >= 2
    );
  }
  function requestPlay(reason: string): void {
    report(reason);
    try {
      void video.play().then(
        () => report("background-resume-resolved"),
        (error: unknown) =>
          report(
            "background-resume-rejected:" +
              (error instanceof Error ? error.name : "unknown").slice(0, 40),
          ),
      );
    } catch {
      report("background-resume-threw");
    }
  }
  function recover(): void {
    if (
      !hidden ||
      tried ||
      options.now() > until ||
      !video.paused ||
      !willing()
    )
      return;
    tried = true; // Set before play(), including synchronous play/pause events.
    requestPlay("background-resume-attempt");
  }
  function playing(): void {
    wasPlaying = true;
    remotePause = false;
    recentlyPlaying = false;
  }
  function paused(): void {
    recentlyPlaying = wasPlaying && !options.userPaused() && !remotePause;
    pauseAt = options.now();
    wasPlaying = false;
    recover();
  }
  function changed(): void {
    const next = visibility.visibilityState === "hidden";
    if (next && !hidden) {
      const recent = recentlyPlaying && options.now() - pauseAt <= BEFORE_HIDE;
      until = wasPlaying || recent ? options.now() + AFTER_HIDE : -Infinity;
      tried = false;
    } else if (!next) {
      until = -Infinity;
      gone = false;
    }
    hidden = next;
    recover();
  }
  function listen(
    target: EventTarget,
    event: string,
    handler: () => void,
  ): void {
    target.addEventListener(event, handler);
    removers.push(() => target.removeEventListener(event, handler));
  }
  listen(video, "play", playing);
  listen(video, "playing", playing);
  listen(video, "pause", paused);
  listen(video, "ended", () => {
    wasPlaying = false;
    until = -Infinity;
  });
  listen(visibility, "visibilitychange", changed);
  listen(page, "pagehide", () => {
    gone = true;
    until = -Infinity;
  });
  listen(page, "pageshow", () => {
    gone = false;
    changed();
  });

  if (media !== undefined) {
    try {
      media.setActionHandler("pause", () => {
        remotePause = true;
        until = -Infinity;
        report("media-control-pause");
        if (!options.userPaused()) options.pause();
      });
      media.setActionHandler("play", () => {
        remotePause = false;
        report("media-control-play");
        if (options.userPaused()) options.resume();
        else requestPlay("media-control-native-play");
      });
      owners.set(media, token);
      controls = true;
    } catch {
      // Do not auto-resume if an explicit external stop cannot be distinguished.
      try {
        media.setActionHandler("pause", null);
        media.setActionHandler("play", null);
      } catch {
        /* unsupported */
      }
      report("media-controls-unavailable");
    }
  }
  return () => {
    closed = true;
    until = -Infinity;
    for (const remove of removers) remove();
    if (media !== undefined && owners.get(media) === token) {
      owners.delete(media);
      try {
        media.setActionHandler("pause", null);
        media.setActionHandler("play", null);
      } catch {
        /* unsupported */
      }
    }
  };
}
