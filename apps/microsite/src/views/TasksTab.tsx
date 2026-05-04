import { useCallback, useEffect, useState } from "react";
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  nudgeTask,
  patchTask,
  type TaskFull,
  type TaskStatus,
  type TaskSummary,
} from "../api.ts";
import type { AuthState } from "../state.ts";

const SECTION_ORDER: { status: TaskStatus; label: string; emptyOk: boolean }[] = [
  { status: "waiting_user", label: "Waiting on you", emptyOk: false },
  { status: "doing", label: "Doing", emptyOk: true },
  { status: "waiting_external", label: "Waiting on others", emptyOk: false },
  { status: "triage", label: "Triage", emptyOk: false },
];

export function TasksTab({ auth }: { auth: AuthState }) {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showAllDone, setShowAllDone] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [activeTask, setActiveTask] = useState<{ slug: string; full: TaskFull | null } | null>(
    null,
  );

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await listTasks(auth);
      setTasks(res.tasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tasks");
    }
  }, [auth]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Background poll every 30s while the tab is foregrounded.
  useEffect(() => {
    let active = true;
    const handle = window.setInterval(async () => {
      if (!active || document.hidden) return;
      try {
        const res = await listTasks(auth);
        if (active) setTasks(res.tasks);
      } catch {
        // swallow transient errors during background poll
      }
    }, 30_000);
    return () => {
      active = false;
      window.clearInterval(handle);
    };
  }, [auth]);

  if (tasks === null) {
    return (
      <div className="m-tasks">
        <Header onAdd={() => setComposeOpen(true)} onRefresh={() => void refresh()} refreshing={false} />
        <p className="m-muted m-tasks-empty">Loading…</p>
      </div>
    );
  }

  const byStatus = new Map<TaskStatus, TaskSummary[]>();
  for (const task of tasks) {
    const arr = byStatus.get(task.meta.status) ?? [];
    arr.push(task);
    byStatus.set(task.meta.status, arr);
  }
  for (const arr of byStatus.values()) {
    arr.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  const doneAll = byStatus.get("done") ?? [];
  const today = startOfLocalDay();
  const doneToday = doneAll.filter((t) => {
    const ts = t.meta.completedAt ?? t.updatedAt;
    return new Date(ts).getTime() >= today;
  });

  const visibleSections = SECTION_ORDER.filter(({ status, emptyOk }) => {
    const items = byStatus.get(status) ?? [];
    return items.length > 0 || emptyOk;
  });

  const totalActive = visibleSections.reduce(
    (acc, { status }) => acc + (byStatus.get(status)?.length ?? 0),
    0,
  );

  return (
    <div className="m-tasks">
      <Header onAdd={() => setComposeOpen(true)} onRefresh={() => void doRefresh()} refreshing={refreshing} />
      {error && <p className="m-error">{error}</p>}
      {totalActive === 0 && doneToday.length === 0 && (
        <div className="m-tasks-empty">
          <h2 className="m-empty-heading">Runner is on top of things.</h2>
          <p className="m-muted">No active tasks. Tap + to capture one.</p>
        </div>
      )}

      {visibleSections.map(({ status, label }) => {
        const items = byStatus.get(status) ?? [];
        if (items.length === 0) return null;
        return (
          <section key={status} className={`m-section m-section-${status}`}>
            <header className="m-section-header">
              <h3 className="m-section-title">{label}</h3>
              <span className="m-section-count">{items.length}</span>
            </header>
            <div className="m-cards">
              {items.map((task) => (
                <TaskCard
                  key={task.path}
                  task={task}
                  onOpen={() => setActiveTask({ slug: task.slug, full: null })}
                />
              ))}
            </div>
          </section>
        );
      })}

      {(doneToday.length > 0 || doneAll.length > 0) && (
        <section className="m-section m-section-done">
          <header className="m-section-header">
            <h3 className="m-section-title">
              {showAllDone ? "All done" : "Done today"}
            </h3>
            <span className="m-section-count">
              {showAllDone ? doneAll.length : doneToday.length}
            </span>
          </header>
          <div className="m-cards">
            {(showAllDone ? doneAll : doneToday).map((task) => (
              <TaskCard
                key={task.path}
                task={task}
                onOpen={() => setActiveTask({ slug: task.slug, full: null })}
              />
            ))}
          </div>
          {!showAllDone && doneAll.length > doneToday.length && (
            <button
              type="button"
              className="m-link-btn"
              onClick={() => setShowAllDone(true)}
            >
              Show all done ({doneAll.length})
            </button>
          )}
        </section>
      )}

      {composeOpen && (
        <Compose
          onClose={() => setComposeOpen(false)}
          onCreated={() => {
            setComposeOpen(false);
            void refresh();
          }}
          auth={auth}
        />
      )}

      {activeTask && (
        <TaskDetail
          auth={auth}
          slug={activeTask.slug}
          onClose={() => setActiveTask(null)}
          onMutated={() => {
            void refresh();
          }}
        />
      )}
    </div>
  );

  async function doRefresh() {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }
}

function startOfLocalDay(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function Header({
  onAdd,
  onRefresh,
  refreshing,
}: {
  onAdd: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <header className="m-tasks-header">
      <div>
        <p className="eyebrow">Runner</p>
        <h1 className="m-tasks-heading">Your list</h1>
      </div>
      <div className="m-tasks-actions">
        <button
          type="button"
          className="m-iconbtn"
          aria-label="Refresh"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? "…" : "↻"}
        </button>
        <button type="button" className="m-iconbtn m-iconbtn-primary" aria-label="New task" onClick={onAdd}>
          +
        </button>
      </div>
    </header>
  );
}

function TaskCard({ task, onOpen }: { task: TaskSummary; onOpen: () => void }) {
  const meta = task.meta;
  const isAgentNew =
    task.origin !== "web" && Date.now() - new Date(task.updatedAt).getTime() < 24 * 60 * 60_000;
  const subline = subText(task);
  return (
    <button type="button" className="m-card" onClick={onOpen}>
      <div className="m-card-row">
        <h4 className="m-card-title">{meta.name ?? task.slug}</h4>
        {isAgentNew && task.meta.status !== "done" && (
          <span className="m-pill m-pill-runner">Runner added</span>
        )}
      </div>
      {meta.nextStep && <p className="m-card-next">{meta.nextStep}</p>}
      <p className="m-card-meta">{subline}</p>
    </button>
  );
}

function subText(task: TaskSummary): string {
  const parts: string[] = [];
  if (task.meta.status === "done") {
    const at = task.meta.completedAt ?? task.updatedAt;
    parts.push(`Done ${relTime(at)}`);
  } else if (task.meta.nextCheckIn) {
    parts.push(`Next check-in ${relTime(task.meta.nextCheckIn)}`);
  } else {
    parts.push(`Updated ${relTime(task.updatedAt)}`);
  }
  return parts.join(" · ");
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const dt = t - Date.now();
  const abs = Math.abs(dt);
  const min = Math.round(abs / 60_000);
  const hr = Math.round(abs / 3_600_000);
  const day = Math.round(abs / 86_400_000);
  let unit = "s";
  let value = Math.round(abs / 1000);
  if (min < 60) {
    value = min;
    unit = "m";
  } else if (hr < 24) {
    value = hr;
    unit = "h";
  } else {
    value = day;
    unit = "d";
  }
  return dt >= 0 ? `in ${value}${unit}` : `${value}${unit} ago`;
}

function Compose({
  auth,
  onClose,
  onCreated,
}: {
  auth: AuthState;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="m-sheet" role="dialog" aria-modal="true">
      <div className="m-sheet-card">
        <header className="m-sheet-header">
          <button type="button" className="m-link-btn" onClick={onClose}>
            Cancel
          </button>
          <h2 className="m-sheet-title">New task</h2>
          <button
            type="button"
            className="m-link-btn m-link-btn-strong"
            disabled={!title.trim() || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await createTask(auth, { title: title.trim(), body: body.trim() || undefined });
                onCreated();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "…" : "Save"}
          </button>
        </header>
        <input
          autoFocus
          className="m-sheet-input"
          placeholder="What needs to happen?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
        />
        <textarea
          className="m-sheet-textarea"
          placeholder="Notes for Runner (optional)"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={4000}
          rows={5}
        />
        {error && <p className="m-error">{error}</p>}
        <p className="m-muted m-sheet-tip">
          Runner will pick up the task and figure out the next step within a minute or two.
        </p>
      </div>
    </div>
  );
}

function TaskDetail({
  auth,
  slug,
  onClose,
  onMutated,
}: {
  auth: AuthState;
  slug: string;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [task, setTask] = useState<TaskFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [draftStep, setDraftStep] = useState<string>("");
  const [draftBody, setDraftBody] = useState<string>("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await getTask(auth, slug);
        if (!active) return;
        setTask(res.task);
        setDraftStep(res.task.meta.nextStep ?? "");
        setDraftBody(res.task.body);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Failed");
      }
    })();
    return () => {
      active = false;
    };
  }, [auth, slug]);

  if (!task) {
    return (
      <div className="m-sheet" role="dialog" aria-modal="true">
        <div className="m-sheet-card">
          <header className="m-sheet-header">
            <button type="button" className="m-link-btn" onClick={onClose}>
              Close
            </button>
            <h2 className="m-sheet-title">Loading…</h2>
            <span />
          </header>
          {error && <p className="m-error">{error}</p>}
        </div>
      </div>
    );
  }

  async function applyPatch(
    patch: Omit<Parameters<typeof patchTask>[2], "revision">,
  ) {
    if (!task) return;
    setWorking(true);
    setError(null);
    try {
      const res = await patchTask(auth, slug, { revision: task.revision, ...patch });
      setTask(res.task);
      setDraftStep(res.task.meta.nextStep ?? "");
      setDraftBody(res.task.body);
      onMutated();
    } catch (err) {
      const e = err as Error & { status?: number; body?: { current?: TaskFull } };
      if (e.status === 409 && e.body?.current) {
        setTask(e.body.current);
        setError("Runner updated this while you were editing. Latest version loaded.");
      } else {
        setError(e.message);
      }
    } finally {
      setWorking(false);
    }
  }

  const statusOptions: { value: TaskStatus; label: string }[] = [
    { value: "triage", label: "Triage" },
    { value: "doing", label: "Doing" },
    { value: "waiting_user", label: "Waiting on you" },
    { value: "waiting_external", label: "Waiting on others" },
    { value: "done", label: "Done" },
  ];

  return (
    <div className="m-sheet" role="dialog" aria-modal="true">
      <div className="m-sheet-card">
        <header className="m-sheet-header">
          <button type="button" className="m-link-btn" onClick={onClose}>
            Close
          </button>
          <h2 className="m-sheet-title">{task.meta.name ?? task.slug}</h2>
          <span />
        </header>

        <div className="m-detail">
          <div className="m-detail-row">
            <label className="m-label">Status</label>
            <div className="m-status-pills">
              {statusOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`m-pill m-pill-status m-pill-${opt.value}${task.meta.status === opt.value ? " m-pill-active" : ""}`}
                  disabled={working}
                  onClick={() => void applyPatch({ status: opt.value })}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="m-detail-row">
            <label className="m-label">Next step</label>
            <textarea
              className="m-detail-input"
              value={draftStep}
              onChange={(e) => setDraftStep(e.target.value)}
              rows={2}
              placeholder="Runner will fill this in if blank"
            />
            {draftStep !== (task.meta.nextStep ?? "") && (
              <button
                type="button"
                className="m-link-btn m-link-btn-strong"
                disabled={working}
                onClick={() => void applyPatch({ nextStep: draftStep })}
              >
                Save next step
              </button>
            )}
          </div>

          <div className="m-detail-row">
            <label className="m-label">Notes</label>
            <textarea
              className="m-detail-input m-detail-input-large"
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              rows={8}
              placeholder="Empty so far."
            />
            {draftBody !== task.body && (
              <button
                type="button"
                className="m-link-btn m-link-btn-strong"
                disabled={working}
                onClick={() => void applyPatch({ body: draftBody })}
              >
                Save notes
              </button>
            )}
          </div>

          <div className="m-detail-row m-detail-meta">
            {task.meta.nextCheckIn && (
              <p className="m-muted">
                Next check-in: {new Date(task.meta.nextCheckIn).toLocaleString()}
              </p>
            )}
            {task.meta.completedAt && (
              <p className="m-muted">
                Completed: {new Date(task.meta.completedAt).toLocaleString()}
              </p>
            )}
            <p className="m-muted">
              Updated by {task.origin} · {new Date(task.updatedAt).toLocaleString()}
            </p>
          </div>

          {error && <p className="m-error">{error}</p>}

          <div className="m-detail-actions">
            <button
              type="button"
              className="m-btn"
              disabled={working}
              onClick={async () => {
                setWorking(true);
                try {
                  await nudgeTask(auth, slug);
                } finally {
                  setWorking(false);
                }
              }}
            >
              Nudge Runner
            </button>
            {task.meta.status !== "done" && (
              <button
                type="button"
                className="m-btn m-btn-secondary"
                disabled={working}
                onClick={() => void applyPatch({ status: "done" })}
              >
                I handled this
              </button>
            )}
            <button
              type="button"
              className="m-btn m-btn-ghost"
              disabled={working}
              onClick={async () => {
                if (!confirm("Drop this task?")) return;
                setWorking(true);
                try {
                  await deleteTask(auth, slug);
                  onMutated();
                  onClose();
                } finally {
                  setWorking(false);
                }
              }}
            >
              Drop
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
