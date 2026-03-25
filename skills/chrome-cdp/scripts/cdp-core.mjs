import { existsSync, readFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';

export const MIN_TARGET_PREFIX_LEN = 8;

export function getPortFileCandidates({
  platform = process.platform,
  env = process.env,
  homeDir = homedir(),
} = {}) {
  const candidates = [];
  for (const value of [
    env.CDP_DEVTOOLS_ACTIVE_PORT,
    env.CHROME_CDP_DEVTOOLS_ACTIVE_PORT,
    env.CHROME_DEVTOOLS_ACTIVE_PORT,
  ]) {
    if (value) candidates.push(value);
  }

  if (platform === 'darwin') {
    candidates.push(
      resolve(homeDir, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
      resolve(homeDir, 'Library/Application Support/Google/Chrome Beta/DevToolsActivePort'),
      resolve(homeDir, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
      resolve(homeDir, 'Library/Application Support/Chromium/DevToolsActivePort'),
      resolve(homeDir, 'Library/Application Support/BraveSoftware/Brave-Browser/DevToolsActivePort'),
      resolve(homeDir, 'Library/Application Support/Microsoft Edge/DevToolsActivePort'),
      resolve(homeDir, 'Library/Application Support/Vivaldi/DevToolsActivePort'),
      resolve(homeDir, 'Library/Application Support/com.operasoftware.Opera/DevToolsActivePort'),
    );
  } else if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || resolve(homeDir, 'AppData/Local');
    candidates.push(
      resolve(localAppData, 'Google/Chrome/User Data/DevToolsActivePort'),
      resolve(localAppData, 'Google/Chrome Beta/User Data/DevToolsActivePort'),
      resolve(localAppData, 'Google/Chrome SxS/User Data/DevToolsActivePort'),
      resolve(localAppData, 'Chromium/User Data/DevToolsActivePort'),
      resolve(localAppData, 'BraveSoftware/Brave-Browser/User Data/DevToolsActivePort'),
      resolve(localAppData, 'Microsoft/Edge/User Data/DevToolsActivePort'),
      resolve(localAppData, 'Vivaldi/User Data/DevToolsActivePort'),
      resolve(localAppData, 'Programs/Opera/DevToolsActivePort'),
    );
  } else {
    candidates.push(
      resolve(homeDir, '.config/google-chrome/DevToolsActivePort'),
      resolve(homeDir, '.config/google-chrome-beta/DevToolsActivePort'),
      resolve(homeDir, '.config/google-chrome-unstable/DevToolsActivePort'),
      resolve(homeDir, '.config/chromium/DevToolsActivePort'),
      resolve(homeDir, '.config/BraveSoftware/Brave-Browser/DevToolsActivePort'),
      resolve(homeDir, '.config/microsoft-edge/DevToolsActivePort'),
      resolve(homeDir, '.config/vivaldi/DevToolsActivePort'),
      resolve(homeDir, '.config/opera/DevToolsActivePort'),
    );
  }

  return [...new Set(candidates)];
}

export function findDevToolsActivePortFile(options = {}) {
  const candidates = getPortFileCandidates(options);
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error(
      `Could not find DevToolsActivePort. Checked:\n${candidates.map((candidate) => `- ${candidate}`).join('\n')}`,
    );
  }
  return match;
}

export function readBrowserWsUrl(options = {}) {
  const portFile = findDevToolsActivePortFile(options);
  const lines = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error(`Invalid DevToolsActivePort file: ${portFile}`);
  }
  return {
    portFile,
    wsUrl: `ws://127.0.0.1:${lines[0]}${lines[1]}`,
  };
}

export function getIpcPath({
  platform = process.platform,
  tempDir = tmpdir(),
} = {}) {
  return platform === 'win32'
    ? '\\\\.\\pipe\\pi-chrome-cdp-daemon'
    : join(tempDir, 'pi-chrome-cdp-daemon.sock');
}

export function getPagesCachePath({ tempDir = tmpdir() } = {}) {
  return join(tempDir, 'pi-chrome-cdp-pages.json');
}

export function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter((candidate) => candidate.toUpperCase().startsWith(upper));
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  }
  return matches[0];
}

export function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map((id) => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map((id) => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

export function formatPageList(pages) {
  const prefixLen = getDisplayPrefixLength(pages.map((page) => page.targetId));
  return pages.map((page) => {
    const id = page.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const title = page.title.substring(0, 54).padEnd(54);
    return `${id}  ${title}  ${page.url}`;
  }).join('\n');
}
