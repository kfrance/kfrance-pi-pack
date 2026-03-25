import test from 'node:test';
import assert from 'node:assert/strict';

const coreModule = await import('../skills/chrome-cdp/scripts/cdp-core.mjs');

const {
  MIN_TARGET_PREFIX_LEN,
  formatPageList,
  getDisplayPrefixLength,
  getIpcPath,
  getPagesCachePath,
  getPortFileCandidates,
  resolvePrefix,
} = coreModule;

test('getPortFileCandidates includes common Linux Chrome-family locations', () => {
  const candidates = getPortFileCandidates({
    platform: 'linux',
    homeDir: '/home/tester',
    env: {},
  });

  assert.ok(candidates.includes('/home/tester/.config/google-chrome/DevToolsActivePort'));
  assert.ok(candidates.includes('/home/tester/.config/chromium/DevToolsActivePort'));
  assert.ok(candidates.includes('/home/tester/.config/microsoft-edge/DevToolsActivePort'));
  assert.ok(candidates.includes('/home/tester/.config/BraveSoftware/Brave-Browser/DevToolsActivePort'));
});

test('getPortFileCandidates includes common macOS Chrome-family locations', () => {
  const candidates = getPortFileCandidates({
    platform: 'darwin',
    homeDir: '/Users/tester',
    env: {},
  });

  assert.ok(candidates.includes('/Users/tester/Library/Application Support/Google/Chrome/DevToolsActivePort'));
  assert.ok(candidates.includes('/Users/tester/Library/Application Support/Chromium/DevToolsActivePort'));
  assert.ok(candidates.includes('/Users/tester/Library/Application Support/Microsoft Edge/DevToolsActivePort'));
});

test('getPortFileCandidates includes env overrides before platform defaults', () => {
  const candidates = getPortFileCandidates({
    platform: 'linux',
    homeDir: '/home/tester',
    env: {
      CDP_DEVTOOLS_ACTIVE_PORT: '/custom/one',
      CHROME_CDP_DEVTOOLS_ACTIVE_PORT: '/custom/two',
    },
  });

  assert.equal(candidates[0], '/custom/one');
  assert.equal(candidates[1], '/custom/two');
});

test('getIpcPath uses a named pipe on Windows and temp socket elsewhere', () => {
  assert.equal(getIpcPath({ platform: 'win32', tempDir: 'C:/Temp' }), '\\\\.\\pipe\\pi-chrome-cdp-daemon');
  assert.equal(getIpcPath({ platform: 'linux', tempDir: '/tmp/custom' }), '/tmp/custom/pi-chrome-cdp-daemon.sock');
  assert.equal(getPagesCachePath({ tempDir: '/tmp/custom' }), '/tmp/custom/pi-chrome-cdp-pages.json');
});

test('resolvePrefix rejects ambiguous or missing matches', () => {
  assert.equal(resolvePrefix('ABC12345', ['ABC12345FFFF', 'FFF00000']), 'ABC12345FFFF');
  assert.throws(() => resolvePrefix('ABC', ['ABC11111', 'ABC22222']), /Ambiguous prefix/);
  assert.throws(() => resolvePrefix('ZZZ', ['ABC11111']), /No target matching prefix/);
});

test('formatPageList uses a unique minimum target prefix', () => {
  const pages = [
    { targetId: 'ABCDEF123456', title: 'First tab', url: 'https://example.com/1' },
    { targetId: 'ABCDEE999999', title: 'Second tab', url: 'https://example.com/2' },
  ];

  const prefixLength = getDisplayPrefixLength(pages.map((page: { targetId: string }) => page.targetId));
  assert.ok(prefixLength >= MIN_TARGET_PREFIX_LEN);

  const output = formatPageList(pages);
  assert.match(output, /ABCDEF12/);
  assert.match(output, /ABCDEE99/);
  assert.match(output, /https:\/\/example.com\/1/);
});
