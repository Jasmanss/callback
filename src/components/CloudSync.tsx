import { useEffect, useRef, useState, type FormEvent } from 'react';
import { fetchAnalytics, type Analytics } from '../cloud/api';
import { clearCloudConfig, readCloudConfig, saveCloudConfig } from '../cloud/config';
import { cloudEmail, confirmSignUp, resendCode, signIn, signOut, signUp } from '../cloud/cognito';
import { fullSync } from '../cloud/sync';
import type { Application } from '../types';

const SETUP_URL = 'https://github.com/Jasmanss/callback#cloud-sync-optional';

interface Props {
  apps: Application[];
  onMerged: (apps: Application[], changedLocally: number) => void;
  onCloudChange: (email: string | null) => void;
  onClose: () => void;
}

type Mode = 'signin' | 'signup' | 'confirm';

export function CloudSync({ apps, onMerged, onCloudChange, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [configured, setConfigured] = useState(() => readCloudConfig() !== null);
  const [configInput, setConfigInput] = useState('');
  const [email, setEmail] = useState(() => cloudEmail() ?? '');
  const [signedIn, setSignedIn] = useState(() => cloudEmail() !== null);
  const [mode, setMode] = useState<Mode>('signin');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [showAnalytics, setShowAnalytics] = useState(false);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Something went wrong.';
      if (message === 'CONFIRM') {
        setMode('confirm');
        setNotice('This account still needs its email code — check your inbox.');
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  function submitAuth(e: FormEvent) {
    e.preventDefault();
    const address = email.trim().toLowerCase();
    if (mode === 'signin') {
      void run(async () => {
        await signIn(address, password);
        setSignedIn(true);
        setPassword('');
        onCloudChange(address);
        const result = await fullSync(apps);
        onMerged(result.merged, result.changedLocally);
        setNotice('Signed in and synced.');
      });
    } else if (mode === 'signup') {
      void run(async () => {
        await signUp(address, password);
        setMode('confirm');
        setNotice(`We emailed a confirmation code to ${address}.`);
      });
    } else {
      void run(async () => {
        await confirmSignUp(address, code);
        await signIn(address, password);
        setSignedIn(true);
        setPassword('');
        setCode('');
        onCloudChange(address);
        const result = await fullSync(apps);
        onMerged(result.merged, result.changedLocally);
        setNotice('Account confirmed, signed in and synced.');
      });
    }
  }

  const syncNow = () =>
    run(async () => {
      const result = await fullSync(apps);
      onMerged(result.merged, result.changedLocally);
      setNotice(
        result.changedLocally > 0
          ? `Synced — pulled ${result.changedLocally} ${result.changedLocally === 1 ? 'change' : 'changes'} from the cloud.`
          : 'Synced — this device was already up to date.',
      );
    });

  const loadAnalytics = () =>
    run(async () => {
      setShowAnalytics(true);
      setAnalytics(await fetchAnalytics());
    });

  return (
    <dialog ref={dialog} className="modal" aria-labelledby="cloud-title" onClose={onClose}>
      <header className="modal-head">
        <h2 id="cloud-title">Cloud sync & analytics</h2>
        <button type="button" className="icon-btn" onClick={() => dialog.current?.close()} aria-label="Close">
          ×
        </button>
      </header>

      <div className="modal-body">
        {!configured ? (
          <>
            <p className="modal-note">
              Optional: sync your applications across devices and unlock analytics over your full history. It runs on
              your own AWS account — deploy the stack in this repo (<code>infra/</code>), then paste the{' '}
              <code>CloudConfig</code> output here.{' '}
              <a href={SETUP_URL} target="_blank" rel="noreferrer">
                Setup guide ↗
              </a>
            </p>
            <label className="visually-hidden" htmlFor="cloud-config">
              CloudConfig output
            </label>
            <textarea
              id="cloud-config"
              className="paste-box"
              rows={3}
              placeholder='{"region":"us-east-1","clientId":"…","apiUrl":"https://…"}'
              value={configInput}
              onChange={(e) => setConfigInput(e.target.value)}
            />
            <button
              type="button"
              className="btn primary"
              disabled={!configInput.trim()}
              onClick={() => {
                const problem = saveCloudConfig(configInput.trim());
                if (problem) setError(problem);
                else {
                  setConfigured(true);
                  setError('');
                }
              }}
            >
              Save configuration
            </button>
          </>
        ) : !signedIn ? (
          <form className="cloud-auth" onSubmit={submitAuth}>
            <p className="modal-note">
              {mode === 'signup'
                ? 'Create the account that owns your synced data.'
                : mode === 'confirm'
                  ? 'Enter the 6-digit code from your email.'
                  : 'Sign in to sync this device.'}
            </p>
            <div className="field">
              <label className="field-label" htmlFor="cloud-email">
                Email
              </label>
              <input
                id="cloud-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            {mode !== 'confirm' && (
              <div className="field">
                <label className="field-label" htmlFor="cloud-password">
                  Password {mode === 'signup' && <span className="field-hint">(10+ characters)</span>}
                </label>
                <input
                  id="cloud-password"
                  type="password"
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  required
                  minLength={mode === 'signup' ? 10 : undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            )}
            {mode === 'confirm' && (
              <>
                <div className="field">
                  <label className="field-label" htmlFor="cloud-code">
                    Confirmation code
                  </label>
                  <input
                    id="cloud-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="cloud-password2">
                    Password
                  </label>
                  <input
                    id="cloud-password2"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              </>
            )}
            <div className="cloud-actions">
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Confirm & sign in'}
              </button>
              {mode === 'signin' && (
                <button type="button" className="link-btn" onClick={() => setMode('signup')}>
                  Create an account
                </button>
              )}
              {mode === 'signup' && (
                <button type="button" className="link-btn" onClick={() => setMode('signin')}>
                  I already have one
                </button>
              )}
              {mode === 'confirm' && (
                <button type="button" className="link-btn" disabled={busy} onClick={() => void run(() => resendCode(email.trim().toLowerCase()))}>
                  Resend code
                </button>
              )}
            </div>
          </form>
        ) : (
          <>
            <p className="modal-note">
              Signed in as <b>{email}</b>. This device syncs on open and shortly after every change; other devices pick
              it up when they sync.
            </p>
            <div className="cloud-actions">
              <button type="button" className="btn primary" disabled={busy} onClick={() => void syncNow()}>
                {busy ? 'Working…' : 'Sync now'}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void loadAnalytics()}>
                View analytics
              </button>
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  signOut();
                  setSignedIn(false);
                  setShowAnalytics(false);
                  setAnalytics(null);
                  onCloudChange(null);
                }}
              >
                Sign out
              </button>
            </div>

            {showAnalytics && (
              <section className="cloud-analytics" aria-label="Personal analytics">
                {!analytics ? (
                  <p className="modal-note">{busy ? 'Querying your history (Athena takes a few seconds)…' : ''}</p>
                ) : analytics.bySource.length === 0 ? (
                  <p className="modal-note">
                    No history to analyze yet — events land here after the hourly batch that follows your first synced
                    status changes.
                  </p>
                ) : (
                  <>
                    <AnalyticsTable
                      title="Days to first response, by source"
                      dimension="Source"
                      rows={analytics.bySource.map((r) => ({ label: r.source ?? '', ...r }))}
                    />
                    <AnalyticsTable
                      title="Days to first response, by month applied"
                      dimension="Month"
                      rows={analytics.byMonth.map((r) => ({ label: r.month ?? '', ...r }))}
                    />
                    {analytics.note && <p className="field-hint">{analytics.note}</p>}
                  </>
                )}
              </section>
            )}
          </>
        )}

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="field-hint">{notice}</p>}
        {configured && (
          <button
            type="button"
            className="link-btn cloud-disconnect"
            onClick={() => {
              signOut();
              clearCloudConfig();
              setConfigured(false);
              setSignedIn(false);
              onCloudChange(null);
            }}
          >
            Disconnect this browser from the cloud
          </button>
        )}
      </div>
    </dialog>
  );
}

interface TableProps {
  title: string;
  dimension: string;
  rows: { label: string; applications: string; responses: string; median_days: string }[];
}

function AnalyticsTable({ title, dimension, rows }: TableProps) {
  return (
    <div className="cloud-table">
      <h3>{title}</h3>
      <table>
        <thead>
          <tr>
            <th>{dimension}</th>
            <th>Applications</th>
            <th>Responses</th>
            <th>Median days</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label || '—'}</td>
              <td className="mono">{row.applications}</td>
              <td className="mono">{row.responses}</td>
              <td className="mono">{row.median_days || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
