import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Attention } from './components/Attention';
import { Board } from './components/Board';
import { CloudSync } from './components/CloudSync';
import { deleteCloudApp, pushApps } from './cloud/api';
import { cloudEmail } from './cloud/cognito';
import { fullSync } from './cloud/sync';
import { Drawer } from './components/Drawer';
import { EmailSync } from './components/EmailSync';
import { EmptyState } from './components/EmptyState';
import { Summary } from './components/Summary';
import { TableView } from './components/TableView';
import { addDays, formatDate, formatLongDate, plural, todayISO } from './dates';
import { GHOST_AFTER_DAYS, autoGhostable, computeStats, needsAttention } from './stats';
import { applySuggestions } from './email/apply';
import { autoSyncEnabled, markSeen, runAutoSync } from './email/autosync';
import type { Suggestion } from './email/parse';
import { downloadFile, fromCSV, fromJSON, mergeApps, toCSV, toJSONBackup } from './io';
import { sampleApps } from './sample';
import { loadApps, newId, readPref, saveApps, writePref } from './storage';
import { STATUS_LABEL, impliesApplied, withStatus, type Application, type Draft, type Status } from './types';

type View = 'board' | 'table';
type Editing = { mode: 'new'; status: Status } | { mode: 'edit'; id: string } | null;

interface Toast {
  id: number;
  message: string;
  undo?: () => void;
}

export default function App() {
  const [apps, setApps] = useState<Application[]>(loadApps);
  const [view, setView] = useState<View>(() => (readPref('view') === 'table' ? 'table' : 'board'));
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const [emailOpen, setEmailOpen] = useState<false | 'gmail' | 'paste'>(false);
  const [syncing, setSyncing] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [cloudUser, setCloudUser] = useState<string | null>(() => cloudEmail());
  const [dailyTarget, setDailyTarget] = useState(() => {
    const saved = readPref('dailyTarget');
    if (saved === null) return 10;
    const n = Number.parseInt(saved, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(99, n) : 0;
  });
  const [toast, setToast] = useState<Toast | null>(null);
  const [storageOk, setStorageOk] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const today = todayISO();

  useEffect(() => setStorageOk(saveApps(apps)), [apps]);
  useEffect(() => writePref('view', view), [view]);
  useEffect(() => writePref('dailyTarget', String(dailyTarget)), [dailyTarget]);

  const appsRef = useRef(apps);
  useEffect(() => {
    appsRef.current = apps;
  }, [apps]);

  // Background Gmail sync: on open and every 15 minutes, silently — new
  // applications and status changes land on their own, with an undo.
  useEffect(() => {
    if (!autoSyncEnabled()) return;
    let stopped = false;
    let warned = false;

    async function sync() {
      try {
        const before = appsRef.current;
        const result = await runAutoSync(before);
        if (stopped) return;
        if (result.needsSignIn) {
          if (!warned) {
            warned = true;
            notify('Gmail sync is paused — open Data → Add from email and scan once to sign back in.');
          }
          return;
        }
        if (result.added > 0 || result.updated > 0) {
          setApps(result.apps);
          const parts = [
            result.added > 0 && `added ${plural(result.added, 'application')}`,
            result.updated > 0 && `updated ${result.updated}`,
          ].filter(Boolean);
          notify(`Gmail sync: ${parts.join(', ')}`, () => setApps(before));
        }
      } catch {
        // Background work stays quiet; the manual scan surfaces errors.
      }
    }

    const kickoff = window.setTimeout(sync, 1500);
    const interval = window.setInterval(sync, 15 * 60 * 1000);
    return () => {
      stopped = true;
      window.clearTimeout(kickoff);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cloud sync (opt-in): pull-merge-push once on open / sign-in…
  useEffect(() => {
    if (!cloudUser) return;
    let stopped = false;
    fullSync(appsRef.current)
      .then((result) => {
        if (stopped) return;
        if (result.changedLocally > 0) {
          const before = appsRef.current;
          setApps(result.merged);
          notify(`Cloud sync: pulled ${plural(result.changedLocally, 'change')} from your other devices`, () =>
            setApps(before),
          );
        }
      })
      .catch(() => {
        // Signed out elsewhere or offline: local mode continues untouched.
      });
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudUser]);

  // …and push quietly a few seconds after any local change.
  useEffect(() => {
    if (!cloudUser) return;
    const timer = window.setTimeout(() => {
      pushApps(apps).catch(() => undefined);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [apps, cloudUser]);

  // Applications with 4 months of silence are moved to Ghosted on open (undoable).
  useEffect(() => {
    const stale = autoGhostable(apps, today);
    if (stale.length === 0) return;
    const before = apps;
    const now = new Date().toISOString();
    const ids = new Set(stale.map((a) => a.id));
    setApps((prev) => prev.map((a) => (ids.has(a.id) ? withStatus(a, 'ghosted', now, today) : a)));
    notify(
      `Moved ${stale.length === 1 ? stale[0].company : plural(stale.length, 'application')} to Ghosted — no reply in ${Math.round(GHOST_AFTER_DAYS / 30)} months`,
      () => setApps(before),
    );
    // Run once, on the list loaded at startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 7000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // "/" focuses search, "n" adds an application.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === '/') {
        e.preventDefault();
        searchInput.current?.focus();
      } else if (e.key === 'n') {
        e.preventDefault();
        setEditing({ mode: 'new', status: 'applied' });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Close the Data menu when clicking elsewhere.
  useEffect(() => {
    function onPointer(e: PointerEvent) {
      if (menu.current?.open && !menu.current.contains(e.target as Node)) menu.current.open = false;
    }
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((a) =>
      [a.company, a.role, a.location, a.source, a.notes, a.contactName].some((field) => field.toLowerCase().includes(q)),
    );
  }, [apps, query]);
  const stats = useMemo(() => computeStats(apps, today), [apps, today]);
  const attention = useMemo(() => needsAttention(apps, today), [apps, today]);
  const editingApp = editing?.mode === 'edit' ? (apps.find((a) => a.id === editing.id) ?? null) : null;

  const notify = (message: string, undo?: () => void) => setToast({ id: Date.now(), message, undo });
  const closeMenu = () => menu.current && (menu.current.open = false);

  function replace(next: Application) {
    setApps((prev) => prev.map((a) => (a.id === next.id ? next : a)));
  }

  function saveDraft(draft: Draft) {
    const now = new Date().toISOString();
    if (editingApp) {
      replace(withStatus({ ...editingApp, ...draft, status: editingApp.status, updatedAt: now }, draft.status, now, today));
      notify(`Saved ${draft.company}`);
    } else {
      const app: Application = {
        ...draft,
        dateApplied: draft.dateApplied || (impliesApplied(draft.status) ? today : ''),
        id: newId(),
        history: [{ status: draft.status, at: now }],
        createdAt: now,
        updatedAt: now,
      };
      setApps((prev) => [app, ...prev]);
      notify(`Added ${app.company}`);
    }
    setEditing(null);
  }

  function moveApp(id: string, status: Status) {
    const before = apps.find((a) => a.id === id);
    if (!before || before.status === status) return;
    replace(withStatus(before, status, new Date().toISOString(), today));
    notify(`Moved ${before.company} to ${STATUS_LABEL[status]}`, () => replace(before));
  }

  function snooze(id: string, days: number) {
    const before = apps.find((a) => a.id === id);
    if (!before) return;
    const followUpDate = addDays(today, days);
    replace({ ...before, followUpDate, updatedAt: new Date().toISOString() });
    notify(`Next reminder for ${before.company}: ${formatDate(followUpDate)}`, () => replace(before));
  }

  function deleteApp(id: string) {
    const index = apps.findIndex((a) => a.id === id);
    if (index < 0) return;
    const removed = apps[index];
    setApps((prev) => prev.filter((a) => a.id !== id));
    setEditing(null);
    if (cloudUser) deleteCloudApp(id).catch(() => undefined);
    notify(`Deleted ${removed.company}`, () =>
      setApps((prev) => [...prev.slice(0, index), removed, ...prev.slice(index)]),
    );
  }

  function clearAll() {
    closeMenu();
    if (!window.confirm(`Delete all ${plural(apps.length, 'application')}? You can undo right after.`)) return;
    const before = apps;
    setApps([]);
    notify('Deleted all applications', () => setApps(before));
  }

  function loadSample() {
    setApps(sampleApps());
    notify('Loaded sample data. Clear it from the Data menu when you’re ready to add your own.');
  }

  async function importFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const content = await file.text();
      const incoming = /\.json$/i.test(file.name) ? fromJSON(content) : fromCSV(content);
      if (incoming.length === 0) {
        notify(`No applications found in ${file.name}. The first row needs column names such as Company and Role.`);
        return;
      }
      const before = apps;
      const result = mergeApps(apps, incoming);
      setApps(result.apps);
      const parts = [`Imported ${plural(result.added, 'application')}`];
      if (result.updated) parts.push(`updated ${result.updated}`);
      if (result.skipped) parts.push(`skipped ${plural(result.skipped, 'duplicate')}`);
      notify(parts.join(', '), () => setApps(before));
    } catch {
      notify(`Couldn’t read ${file.name}. Import a CSV with a header row, or a JSON backup from this tracker.`);
    }
  }

  function importFromEmail(suggestions: Suggestion[]) {
    const before = apps;
    const { apps: next, added, updated } = applySuggestions(apps, suggestions, today);
    // Gmail message ids in the keys: never re-propose these emails.
    markSeen(suggestions.map((s) => s.key).filter((key) => !key.includes('|')));
    setApps(next);
    const parts = [added > 0 && `added ${plural(added, 'application')}`, updated > 0 && `updated ${updated}`].filter(
      Boolean,
    );
    if (parts.length > 0) notify(`From email: ${parts.join(', ')}`, () => setApps(before));
  }

  async function syncNow() {
    if (!readPref('gmailClientId')) {
      // Not connected yet: the email dialog is the way in.
      setEmailOpen('gmail');
      return;
    }
    setSyncing(true);
    try {
      const before = appsRef.current;
      const result = await runAutoSync(before);
      if (result.needsSignIn) {
        notify('Google needs a quick sign-in — run the scan from here once.');
        setEmailOpen('gmail');
        return;
      }
      if (result.added > 0 || result.updated > 0) {
        setApps(result.apps);
        const parts = [
          result.added > 0 && `added ${plural(result.added, 'application')}`,
          result.updated > 0 && `updated ${result.updated}`,
        ].filter(Boolean);
        notify(`Gmail sync: ${parts.join(', ')}`, () => setApps(before));
      } else {
        notify('Gmail sync: nothing new since last check');
      }
    } catch {
      notify('Gmail sync failed — try the scan in Data → Add from email to see why.');
    } finally {
      setSyncing(false);
    }
  }

  function exportAs(kind: 'csv' | 'json') {
    closeMenu();
    if (kind === 'csv') {
      downloadFile(`applications-${today}.csv`, toCSV(apps), 'text/csv;charset=utf-8');
      notify(`Exported ${plural(apps.length, 'application')} to CSV`);
    } else {
      downloadFile(`applications-backup-${today}.json`, toJSONBackup(apps), 'application/json');
      notify('Exported JSON backup');
    }
  }

  const openNew = (status: Status = 'applied') => setEditing({ mode: 'new', status });
  const openImport = () => {
    closeMenu();
    fileInput.current?.click();
  };

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="wordmark">Callback</span>
            <span className="brand-date">{formatLongDate(today)}</span>
          </div>

          {apps.length > 0 && (
            <>
              <label className="search">
                <span className="visually-hidden">Search applications</span>
                <input
                  ref={searchInput}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search company, role, notes"
                />
                <kbd aria-hidden="true">/</kbd>
              </label>
              <div className="segmented" role="group" aria-label="Layout">
                <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}>
                  Board
                </button>
                <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
                  Table
                </button>
              </div>
            </>
          )}

          <button
            type="button"
            className="btn sync-btn"
            onClick={syncNow}
            disabled={syncing}
            title="Check Gmail for new application emails now"
          >
            <svg
              className={syncing ? 'is-spinning' : undefined}
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <polyline points="21 3 21 9 15 9" />
            </svg>
            {syncing ? 'Syncing…' : 'Sync'}
          </button>

          <details className="menu" ref={menu}>
            <summary className="btn">Data</summary>
            <div className="menu-panel">
              <button
                type="button"
                onClick={() => {
                  closeMenu();
                  setEmailOpen('gmail');
                }}
              >
                Add from email
                <small>Scan Gmail or paste an application email</small>
              </button>
              <button type="button" onClick={openImport}>
                Import CSV or JSON
                <small>Adds to your list and skips duplicates</small>
              </button>
              <button
                type="button"
                onClick={() => {
                  closeMenu();
                  setCloudOpen(true);
                }}
              >
                Cloud sync & analytics
                <small>{cloudUser ? `Signed in as ${cloudUser}` : 'Optional — use Callback on more devices'}</small>
              </button>
              <button type="button" disabled={!apps.length} onClick={() => exportAs('csv')}>
                Export CSV
                <small>Opens in Excel, Numbers, or Google Sheets</small>
              </button>
              <button type="button" disabled={!apps.length} onClick={() => exportAs('json')}>
                Export JSON backup
                <small>Full copy, including status history</small>
              </button>
              <hr />
              <button type="button" className="is-danger" disabled={!apps.length} onClick={clearAll}>
                Delete all applications
              </button>
            </div>
          </details>

          <button type="button" className="btn primary" onClick={() => openNew()}>
            Add application
          </button>
          <input ref={fileInput} type="file" accept=".csv,.json,text/csv,application/json" hidden onChange={importFile} />
        </div>
      </header>

      {!storageOk && (
        <p className="storage-warning" role="alert">
          This browser isn’t letting the tracker save (private browsing or full storage). Export a JSON backup before
          closing the tab.
        </p>
      )}

      <main className="page">
        {apps.length === 0 ? (
          <EmptyState
            onAdd={() => openNew()}
            onEmail={() => setEmailOpen('gmail')}
            onImport={openImport}
            onSample={loadSample}
          />
        ) : (
          <>
            <Summary apps={apps} stats={stats} target={dailyTarget} onTargetChange={setDailyTarget} />
            {attention.length > 0 && (
              <Attention
                items={attention}
                onOpen={(id) => setEditing({ mode: 'edit', id })}
                onSnooze={snooze}
                onGhost={(id) => moveApp(id, 'ghosted')}
              />
            )}
            {query && filtered.length === 0 ? (
              <div className="no-results">
                <p>No applications match “{query}”.</p>
                <button type="button" className="btn" onClick={() => setQuery('')}>
                  Clear search
                </button>
              </div>
            ) : view === 'board' ? (
              <Board
                apps={filtered}
                today={today}
                onOpen={(id) => setEditing({ mode: 'edit', id })}
                onMove={moveApp}
                onAdd={openNew}
              />
            ) : (
              <TableView apps={filtered} today={today} onOpen={(id) => setEditing({ mode: 'edit', id })} />
            )}
          </>
        )}
      </main>

      {cloudOpen && (
        <CloudSync
          apps={apps}
          onMerged={(merged, changed) => {
            if (changed > 0) {
              const before = apps;
              setApps(merged);
              notify(`Cloud sync: pulled ${plural(changed, 'change')}`, () => setApps(before));
            }
          }}
          onCloudChange={setCloudUser}
          onClose={() => setCloudOpen(false)}
        />
      )}

      {emailOpen && (
        <EmailSync
          apps={apps}
          initialTab={emailOpen}
          onImport={importFromEmail}
          onClose={() => setEmailOpen(false)}
        />
      )}

      {editing && (editing.mode === 'new' || editingApp) && (
        <Drawer
          key={editing.mode === 'edit' ? editing.id : 'new'}
          app={editingApp}
          initialStatus={editing.mode === 'new' ? editing.status : 'applied'}
          today={today}
          onSave={saveDraft}
          onClose={() => setEditing(null)}
          onDelete={deleteApp}
          onPasteEmail={() => setEmailOpen('paste')}
        />
      )}

      <div className="toast-region" aria-live="polite">
        {toast && (
          <div className="toast" key={toast.id}>
            <span>{toast.message}</span>
            {toast.undo && (
              <button
                type="button"
                onClick={() => {
                  toast.undo?.();
                  setToast(null);
                }}
              >
                Undo
              </button>
            )}
            <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => setToast(null)}>
              ×
            </button>
          </div>
        )}
      </div>
    </>
  );
}
