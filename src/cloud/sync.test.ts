import { describe, expect, it } from 'vitest';
import type { Application } from '../types';
import { mergeRemote } from './sync';

const app = (id: string, updatedAt: string, company = 'Acme'): Application =>
  ({
    id,
    company,
    role: '',
    url: '',
    location: '',
    workMode: '',
    salary: '',
    source: '',
    status: 'applied',
    dateApplied: '',
    followUpDate: '',
    contactName: '',
    contactEmail: '',
    resumeVersion: '',
    priority: 2,
    notes: '',
    history: [],
    createdAt: updatedAt,
    updatedAt,
  }) as Application;

describe('mergeRemote', () => {
  it('adds applications that only exist remotely', () => {
    const { merged, changedLocally } = mergeRemote([app('a', '2026-01-01')], [app('b', '2026-01-02')]);
    expect(merged.map((a) => a.id).sort()).toEqual(['a', 'b']);
    expect(changedLocally).toBe(1);
  });

  it('keeps the newer copy per id, whichever side it is on', () => {
    const { merged } = mergeRemote(
      [app('a', '2026-01-05', 'LocalNewer'), app('b', '2026-01-01', 'LocalOlder')],
      [app('a', '2026-01-01', 'RemoteOlder'), app('b', '2026-01-05', 'RemoteNewer')],
    );
    const byId = Object.fromEntries(merged.map((a) => [a.id, a.company]));
    expect(byId).toEqual({ a: 'LocalNewer', b: 'RemoteNewer' });
  });

  it('reports zero local changes when local is already up to date', () => {
    const { changedLocally } = mergeRemote([app('a', '2026-01-05')], [app('a', '2026-01-01')]);
    expect(changedLocally).toBe(0);
  });
});
