import type { Application } from '../types';
import { pullApps, pushApps } from './api';

/**
 * Sync model: last-write-wins per application, decided by `updatedAt` —
 * simple, symmetric across devices, and honest about its limits (no
 * tombstones: deleting on one device while another still holds the card
 * can bring it back on that device's next push; see README limitations).
 */
export function mergeRemote(
  local: Application[],
  remote: Application[],
): { merged: Application[]; changedLocally: number } {
  const byId = new Map(local.map((a) => [a.id, a]));
  let changedLocally = 0;
  for (const theirs of remote) {
    const mine = byId.get(theirs.id);
    if (!mine) {
      byId.set(theirs.id, theirs);
      changedLocally++;
    } else if (theirs.updatedAt > mine.updatedAt) {
      byId.set(theirs.id, theirs);
      changedLocally++;
    }
  }
  return { merged: [...byId.values()], changedLocally };
}

export interface SyncResult {
  merged: Application[];
  changedLocally: number;
}

/** Pull → merge → push the merged list back so every device converges. */
export async function fullSync(local: Application[]): Promise<SyncResult> {
  const remote = await pullApps();
  const { merged, changedLocally } = mergeRemote(local, remote);
  await pushApps(merged);
  return { merged, changedLocally };
}
