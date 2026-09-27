import { readPref, writePref } from '../storage';

/**
 * Cloud is OPT-IN. Until someone deploys the CDK stack and pastes its
 * `CloudConfig` output here, this returns null and the entire cloud
 * surface stays dormant — the app remains exactly the local-only tracker.
 */
export interface CloudConfig {
  region: string;
  clientId: string;
  apiUrl: string;
}

export function readCloudConfig(): CloudConfig | null {
  try {
    const raw = readPref('cloudConfig');
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<CloudConfig>;
    if (
      typeof data.region === 'string' &&
      /^[a-z0-9-]+$/.test(data.region) &&
      typeof data.clientId === 'string' &&
      data.clientId.length > 0 &&
      typeof data.apiUrl === 'string' &&
      data.apiUrl.startsWith('https://')
    ) {
      return { region: data.region, clientId: data.clientId, apiUrl: data.apiUrl.replace(/\/$/, '') };
    }
    return null;
  } catch {
    return null;
  }
}

/** Returns an error message, or null when saved. */
export function saveCloudConfig(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as Partial<CloudConfig>;
    if (!data.region || !data.clientId || !data.apiUrl) {
      return 'That doesn’t look like the CloudConfig output — it needs region, clientId and apiUrl.';
    }
    writePref('cloudConfig', JSON.stringify(data));
    return readCloudConfig() ? null : 'The pasted config didn’t validate.';
  } catch {
    return 'Paste the CloudConfig output exactly as `cdk deploy` printed it (a JSON object).';
  }
}

export function clearCloudConfig(): void {
  writePref('cloudConfig', '');
}
