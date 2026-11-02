// The on-device search model downloads once, on first launch. One poller feeds the
// sidebar pill, the Home card and the Sources card with progress, speed and time left.
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

export interface ModelStatus {
  state: string;
  received: number;
  total: number;
  error?: string | null;
}
export interface ModelProgress extends ModelStatus {
  percent: number;
  /** Bytes per second over the last few seconds. */
  rate: number;
  secondsLeft?: number;
}
type Invoke = <T>(command: string, args?: Record<string, unknown>, workspaceId?: string) => Promise<T>;

export function useModelProgress(invoke: Invoke, workspaceId?: string, active = true): ModelProgress | undefined {
  const [progress, setProgress] = useState<ModelProgress>();
  const samples = useRef<{ at: number; bytes: number }[]>([]);
  useEffect(() => {
    if (!workspaceId || !active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let status: ModelStatus | undefined;
      try {
        status = (await invoke<{ model: ModelStatus }>("store_status", {}, workspaceId)).model;
      } catch {}
      if (stopped) return;
      if (status) {
        const now = performance.now();
        const received = status.received;
        const recent = [...samples.current.filter((s) => now - s.at < 8000 && s.bytes <= received), { at: now, bytes: received }];
        samples.current = recent;
        const seconds = (now - recent[0].at) / 1000;
        const rate = seconds > 0.5 ? (received - recent[0].bytes) / seconds : 0;
        setProgress({
          ...status,
          percent: status.total ? Math.min(100, (received / status.total) * 100) : 0,
          rate,
          secondsLeft: rate > 0 && status.total ? (status.total - received) / rate : undefined,
        });
      }
      // Quick while bytes are moving, slow once there is nothing left to show.
      timer = setTimeout(poll, status?.state === "ready" ? 30000 : status?.state === "downloading" ? 700 : 3000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [invoke, workspaceId, active]);
  return progress;
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1e6).toLocaleString()} MB`;
function timeLeft(seconds?: number, short = false) {
  if (seconds === undefined || !Number.isFinite(seconds)) return "";
  if (seconds < 10) return short ? "<10 s" : "a few seconds left";
  if (seconds < 90) return short ? `${Math.round(seconds / 5) * 5} s` : `about ${Math.round(seconds / 5) * 5} s left`;
  return short ? `${Math.round(seconds / 60)} min` : `about ${Math.round(seconds / 60)} min left`;
}
const pending = (p?: ModelProgress): p is ModelProgress => !!p && ["downloading", "missing", "failed"].includes(p.state);

/** A card for Home and Sources while the model is downloading or retrying. */
export function ModelProgressCard({ progress, compact }: { progress?: ModelProgress; compact?: boolean }) {
  if (!pending(progress)) return null;
  const failed = progress.state === "failed";
  const started = progress.state === "downloading" && progress.total > 0;
  const detail = failed
    ? `The download stopped (${progress.error || "network error"}). Key retries automatically.`
    : started
      ? [`${megabytes(progress.received)} of ${megabytes(progress.total)}`, progress.rate > 0 && `${(progress.rate / 1e6).toFixed(1)} MB/s`, timeLeft(progress.secondsLeft)]
          .filter(Boolean)
          .join(" · ")
      : "Starting the download…";
  return (
    <section className="kx-model-card" data-compact={compact} data-failed={failed} role="status" aria-label="Search model download">
      <span className="kx-model-icon">
        <Icon name="sparkle" size={compact ? 14 : 17} />
      </span>
      <div className="kx-model-text">
        <strong>{failed ? "Search model download paused" : "Setting up on-device search"}</strong>
        <span>{detail}</span>
        {!compact && <small>Searching by words works now. Matches by meaning join in once the model (about 310 MB, downloaded once) is ready.</small>}
      </div>
      {!failed && <b className="kx-model-percent">{started ? `${Math.floor(progress.percent)}%` : ""}</b>}
      <div className="kx-meter" aria-hidden="true" data-indeterminate={!started}>
        <span style={{ width: `${started ? progress.percent : 30}%` }} />
      </div>
    </section>
  );
}

/** The sidebar footer's compact progress, visible from every view. */
export function ModelProgressPill({ progress }: { progress?: ModelProgress }) {
  if (!pending(progress)) return null;
  const started = progress.state === "downloading" && progress.total > 0;
  const label = progress.state === "failed" ? "Search model: retrying" : started ? `Search model ${Math.floor(progress.percent)}%` : "Search model: starting";
  return (
    <div className="kx-model-pill" role="status" title={started ? `${megabytes(progress.received)} of ${megabytes(progress.total)} · ${timeLeft(progress.secondsLeft)}` : label}>
      <span>
        <Icon name="sparkle" size={12} />
        {label}
        {started && <em>{timeLeft(progress.secondsLeft, true)}</em>}
      </span>
      <div className="kx-meter" aria-hidden="true" data-indeterminate={!started}>
        <span style={{ width: `${started ? progress.percent : 30}%` }} />
      </div>
    </div>
  );
}
