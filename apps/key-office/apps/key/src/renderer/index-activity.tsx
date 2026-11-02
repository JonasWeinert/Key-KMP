// Live indexing progress: what is being read and indexed now, what comes next and why,
// and how long the batch has left. Shared by the Sources footer, its banner, rows,
// the inspector and Home.
import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { KIND_ICON, type IndexActivity, type IndexJob, type Invoke, type LibraryStatus } from "./library-api";

/** Polls the host's library status: quickly while indexing, gently otherwise. */
export function useLibraryStatus(invoke: Invoke, workspaceId: string | undefined, active = true) {
  const [status, setStatus] = useState<LibraryStatus>();
  useEffect(() => {
    if (!workspaceId || !active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let next: LibraryStatus | undefined;
      try {
        next = await invoke<LibraryStatus>("store_status", {}, workspaceId);
      } catch {}
      if (stopped) return;
      if (next) setStatus(next);
      const working = !!next && (next.busy || next.counts.indexing > 0);
      timer = setTimeout(poll, working ? 900 : 4000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [invoke, workspaceId, active]);
  return status;
}

/** 0–1 progress of one source: reading pages is the first half, embedding the second. */
export function jobProgress(activity: IndexActivity | undefined, id: string): { fraction: number; label: string } | undefined {
  if (!activity) return undefined;
  const reading = activity.reading?.id === id ? activity.reading : undefined;
  const embedding = activity.embedding?.id === id ? activity.embedding : undefined;
  if (embedding) return { fraction: 0.5 + 0.5 * ratio(embedding), label: stageLabel(embedding) };
  if (reading) return { fraction: 0.5 * ratio(reading), label: stageLabel(reading) };
  return undefined;
}
const ratio = (job: IndexJob) => (job.total ? Math.min(1, job.done / job.total) : 0);

export function stageLabel(job: IndexJob) {
  switch (job.stage) {
    case "opening":
      return "Opening…";
    case "reading":
      return job.total ? `Reading page ${Math.min(job.done + 1, job.total)} of ${job.total}` : "Reading text…";
    case "chunking":
      return "Splitting into passages…";
    case "embedding":
      return `Indexing ${job.done} of ${job.total} passages`;
    default:
      return "Queued";
  }
}
const PRIORITY_LABEL = { opened: "You opened this", selected: "Selected", visible: "On screen" } as const;

function remaining(activity: IndexActivity) {
  const left = Math.max(0, activity.batchTotal - activity.batchDone);
  const seconds = activity.secondsPerSource ? left * activity.secondsPerSource : undefined;
  return { left, eta: timeLeft(seconds) };
}
function timeLeft(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) return "";
  if (seconds < 50) return "less than a minute left";
  if (seconds < 90 * 60) return `about ${Math.max(1, Math.round(seconds / 60))} min left`;
  return `about ${Math.round(seconds / 360) / 10} h left`;
}
export const isActive = (a?: IndexActivity) => !!a && (a.batchTotal > a.batchDone || !!a.reading || !!a.embedding);

/** A small determinate ring; spins softly while the fraction is unknown. */
export function ProgressRing({ fraction, size = 16 }: { fraction?: number; size?: number }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const known = fraction !== undefined;
  return (
    <svg className="kx-ring" data-indeterminate={!known} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} className="kx-ring-track" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className="kx-ring-value"
        strokeDasharray={c}
        strokeDashoffset={known ? c * (1 - Math.max(0.04, fraction)) : c * 0.7}
      />
    </svg>
  );
}

function JobRow({ job, activity }: { job: IndexJob; activity: IndexActivity }) {
  const progress = jobProgress(activity, job.id);
  return (
    <li className="kx-activity-job">
      {progress ? <ProgressRing fraction={progress.fraction} size={18} /> : <Icon name={KIND_ICON[job.kind] ?? "doc"} size={14} />}
      <span>
        <strong>{job.title || "Untitled"}</strong>
        <small>
          {progress ? progress.label : "Waiting"}
          {job.priority && <em>{PRIORITY_LABEL[job.priority]}</em>}
        </small>
      </span>
    </li>
  );
}

/** The full picture: overall batch, the two pipeline stages, and the queue. */
export function ActivityPanel({ activity, modelReady, onPause }: { activity: IndexActivity; modelReady: boolean; onPause: (paused: boolean) => void }) {
  const { left, eta } = remaining(activity);
  const now = [activity.reading, activity.embedding].filter((j): j is IndexJob => !!j);
  const total = activity.batchTotal;
  return (
    <div className="kx-activity-panel">
      <header>
        <div>
          <strong>{activity.paused ? "Indexing paused" : left ? "Making your library searchable" : "All caught up"}</strong>
          <span>
            {total ? `${activity.batchDone.toLocaleString()} of ${total.toLocaleString()} sources` : "Every source is searchable"}
            {eta && !activity.paused ? ` · ${eta}` : ""}
          </span>
        </div>
        {(left > 0 || activity.paused) && (
          <button className="kx-activity-pause" onClick={() => onPause(!activity.paused)}>
            <Icon name={activity.paused ? "play" : "pause"} size={12} />
            {activity.paused ? "Resume" : "Pause"}
          </button>
        )}
      </header>
      {total > 0 && (
        <div className="kx-meter" aria-hidden="true">
          <span style={{ width: `${(activity.batchDone / total) * 100}%` }} />
        </div>
      )}
      {now.length > 0 && (
        <section>
          <h3>Now</h3>
          <ul>
            {now.map((job) => (
              <JobRow key={`${job.stage}:${job.id}`} job={job} activity={activity} />
            ))}
          </ul>
        </section>
      )}
      {activity.upNext.length > 0 && (
        <section>
          <h3>Up next</h3>
          <ul>
            {activity.upNext.map((job) => (
              <JobRow key={job.id} job={job} activity={activity} />
            ))}
          </ul>
        </section>
      )}
      <p className="kx-activity-note">
        {activity.vectorsPending > 0 && !modelReady
          ? `${activity.vectorsPending.toLocaleString()} passages are searchable by words now and gain meaning search once the search model is ready.`
          : "Sources you open, select or scroll to are indexed first."}
      </p>
    </div>
  );
}

/** Footer pill with the panel as its popover. */
export function ActivityPill({ status, onPause }: { status?: LibraryStatus; onPause: (paused: boolean) => void }) {
  const activity = status?.activity;
  if (!status) return null;
  const working = isActive(activity);
  const { left, eta } = activity ? remaining(activity) : { left: 0, eta: "" };
  const fraction = activity?.batchTotal ? activity.batchDone / activity.batchTotal : undefined;
  return (
    <details className="kx-menu kx-activity">
      <summary aria-label="Indexing activity">
        {activity?.paused ? (
          <>
            <Icon name="pause" size={11} /> Indexing paused
          </>
        ) : working ? (
          <>
            <ProgressRing fraction={fraction} size={13} />
            Indexing · {left.toLocaleString()} left{eta ? ` · ${eta.replace(" left", "")}` : ""}
          </>
        ) : (
          <>
            <span className="kx-status-dot" data-tone="ready" /> {status.counts.ready.toLocaleString()} searchable
          </>
        )}
      </summary>
      {activity && (
        <div className="kx-menu-popover kx-activity-popover">
          <ActivityPanel activity={activity} modelReady={status.model.state === "ready"} onPause={onPause} />
        </div>
      )}
    </details>
  );
}

/** A banner while a larger batch runs (Sources), or any batch (Home). */
export function ActivityBanner({ status, minimum = 1, onPause }: { status?: LibraryStatus; minimum?: number; onPause?: (paused: boolean) => void }) {
  const activity = status?.activity;
  if (!activity || !isActive(activity)) return null;
  const { left, eta } = remaining(activity);
  if (left < minimum && !activity.paused) return null;
  const current = activity.reading ?? activity.embedding;
  const fraction = activity.batchTotal ? activity.batchDone / activity.batchTotal : 0;
  return (
    <section className="kx-activity-banner" role="status" aria-label="Indexing progress">
      <ProgressRing fraction={fraction} size={30} />
      <div className="kx-activity-banner-text">
        <strong>
          {activity.paused ? "Indexing paused" : "Making your library searchable"}
          <span>
            {activity.batchDone.toLocaleString()} of {activity.batchTotal.toLocaleString()}
            {eta && !activity.paused ? ` · ${eta}` : ""}
          </span>
        </strong>
        {current && !activity.paused ? (
          <small>
            {stageLabel(current)} · <em>{current.title || "Untitled"}</em>
          </small>
        ) : (
          <small>Search covers each source as soon as it finishes.</small>
        )}
        <div className="kx-meter" aria-hidden="true">
          <span style={{ width: `${fraction * 100}%` }} />
        </div>
      </div>
      {onPause && (
        <button className="kx-activity-pause" onClick={() => onPause(!activity.paused)}>
          <Icon name={activity.paused ? "play" : "pause"} size={12} />
          {activity.paused ? "Resume" : "Pause"}
        </button>
      )}
    </section>
  );
}
