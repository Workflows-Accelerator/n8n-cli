import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface UpdateCache {
  lastChecked: number;
  latestVersion: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
}

export interface ReleaseEntry {
  version: string;
  date?: string;
  content: string;
}

/**
 * Parses semver string into [major, minor, patch] numbers.
 */
export function parseSemver(v: string): [number, number, number] {
  if (!v) return [0, 0, 0];
  const clean = v.replace(/^[v^~]/, '').trim();
  const [core] = clean.split('-');
  const parts = core.split('.').map(n => parseInt(n, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/**
 * Returns true if candidate semver is strictly newer than current semver.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  if (!candidate || !current) return false;
  const [cMaj, cMin, cPatch] = parseSemver(candidate);
  const [curMaj, curMin, curPatch] = parseSemver(current);
  if (cMaj !== curMaj) return cMaj > curMaj;
  if (cMin !== curMin) return cMin > curMin;
  return cPatch > curPatch;
}

/**
 * Returns path to global update cache file.
 */
export function getUpdateCachePath(): string {
  return path.join(os.homedir(), '.n8ncli-update.json');
}

/**
 * Loads cached update state.
 */
export function loadUpdateCache(): UpdateCache {
  try {
    const p = getUpdateCachePath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (typeof data.lastChecked === 'number' && typeof data.latestVersion === 'string') {
        return data;
      }
    }
  } catch {}
  return { lastChecked: 0, latestVersion: '' };
}

/**
 * Saves update cache to disk.
 */
export function saveUpdateCache(cache: UpdateCache): void {
  try {
    const p = getUpdateCachePath();
    fs.writeFileSync(p, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {}
}

/**
 * Queries npm registry for the latest published package version with a timeout.
 */
export async function fetchLatestVersion(
  packageName: string = '@workflows-accelerator/n8n-cli',
  timeoutMs: number = 2000
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Checks if a newer version of n8ncli is available.
 */
export async function checkForUpdate(
  currentVersion: string,
  forceCheck: boolean = false,
  fetchFn: (packageName?: string, timeoutMs?: number) => Promise<string | null> = fetchLatestVersion
): Promise<UpdateCheckResult | null> {
  if (process.env.N8N_NO_UPDATE_NOTIFIER || process.env.CI) {
    return null;
  }

  const cache = loadUpdateCache();
  const now = Date.now();
  let latest = cache.latestVersion;

  if (forceCheck || now - cache.lastChecked > CHECK_INTERVAL_MS || !latest) {
    const fetched = await fetchFn();
    if (fetched) {
      latest = fetched;
      saveUpdateCache({ lastChecked: now, latestVersion: fetched });
    } else {
      saveUpdateCache({ lastChecked: now, latestVersion: cache.latestVersion || currentVersion });
    }
  }

  if (latest && isNewerVersion(latest, currentVersion)) {
    return {
      updateAvailable: true,
      currentVersion,
      latestVersion: latest,
    };
  }

  return {
    updateAvailable: false,
    currentVersion,
    latestVersion: latest || currentVersion,
  };
}

/**
 * Prints a clean, non-intrusive update alert banner to stderr.
 */
export function displayUpdateNotification(info: UpdateCheckResult): void {
  if (!info.updateAvailable) return;

  const line1 = `Update available: ${info.currentVersion} → ${info.latestVersion}`;
  const line2 = `Run 'n8ncli update' to upgrade`;
  const line3 = `Run 'n8ncli changelog' to see what changed`;

  const maxLen = Math.max(line1.length, line2.length, line3.length);
  const border = '─'.repeat(maxLen + 4);

  const banner = [
    '',
    `┌${border}┐`,
    `│  ${line1.padEnd(maxLen)}  │`,
    `│  ${line2.padEnd(maxLen)}  │`,
    `│  ${line3.padEnd(maxLen)}  │`,
    `└${border}┘`,
    '',
  ].join('\n');

  process.stderr.write(banner);
}

/**
 * Finds local CHANGELOG.md file in the package or repo.
 */
export function findChangelogPath(): string | null {
  const candidates = [
    path.resolve(__dirname, '../CHANGELOG.md'),
    path.resolve(__dirname, '../../CHANGELOG.md'),
    path.resolve(process.cwd(), 'CHANGELOG.md'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Parses markdown changelog into release entries.
 */
export function parseChangelog(markdown: string): ReleaseEntry[] {
  const entries: ReleaseEntry[] = [];
  const lines = markdown.split(/\r?\n/);
  let currentVersion = '';
  let currentDate = '';
  let currentLines: string[] = [];

  const flush = () => {
    if (currentVersion && currentLines.length > 0) {
      entries.push({
        version: currentVersion,
        date: currentDate,
        content: currentLines.join('\n').trim(),
      });
    }
    currentLines = [];
  };

  for (const line of lines) {
    const match = line.match(/^##\s+\[?v?(\d+\.\d+\.\d+)\]?(?:\s+-\s+(\d{4}-\d{2}-\d{2}))?/);
    if (match) {
      flush();
      currentVersion = match[1];
      currentDate = match[2] || '';
    } else if (currentVersion) {
      currentLines.push(line);
    }
  }
  flush();
  return entries;
}

/**
 * Retrieves changelog release entries, optionally filtered by version or limit.
 */
export function getChangelogEntries(fromVersion?: string, limit: number = 5): ReleaseEntry[] {
  const p = findChangelogPath();
  if (!p) return [];

  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const all = parseChangelog(raw);
    if (fromVersion) {
      return all.filter(e => isNewerVersion(e.version, fromVersion)).slice(0, limit);
    }
    return all.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Formats release entries for terminal output.
 */
export function formatChangelog(entries: ReleaseEntry[]): string {
  if (entries.length === 0) {
    return 'No changelog entries found. See https://github.com/Workflows-Accelerator/n8n-cli/releases for full details.';
  }

  const chunks: string[] = [];
  for (const e of entries) {
    const header = e.date ? `Version ${e.version} (${e.date})` : `Version ${e.version}`;
    chunks.push(`\n=== ${header} ===\n${e.content}`);
  }
  return chunks.join('\n');
}
