import { normalizeApp } from '../storage';
import type { Application } from '../types';
import { readCloudConfig } from './config';
import { getIdToken } from './cognito';

/** Thin authenticated client for the Callback cloud API. */

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const config = readCloudConfig();
  if (!config) throw new Error('Cloud isn’t configured.');
  const token = await getIdToken();
  if (!token) throw new Error('SIGNED_OUT');
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) throw new Error('SIGNED_OUT');
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (data as { error?: string }).error ?? `Cloud request failed (${response.status}).`;
    throw new Error(message);
  }
  return data;
}

/** Everything stored in the cloud, re-validated on the way in. */
export async function pullApps(): Promise<Application[]> {
  const data = (await request('GET', '/applications')) as { applications?: unknown[] };
  return (data.applications ?? [])
    .map((raw) => normalizeApp(raw))
    .filter((a): a is Application => a !== null);
}

export async function pushApps(apps: Application[]): Promise<void> {
  await request('PUT', '/applications', { applications: apps });
}

export async function deleteCloudApp(id: string): Promise<void> {
  await request('DELETE', `/applications/${encodeURIComponent(id)}`);
}

export interface AnalyticsRow {
  source?: string;
  month?: string;
  applications: string;
  responses: string;
  median_days: string;
}

export interface Analytics {
  bySource: AnalyticsRow[];
  byMonth: AnalyticsRow[];
  note?: string;
}

export async function fetchAnalytics(): Promise<Analytics> {
  return (await request('GET', '/analytics')) as Analytics;
}
