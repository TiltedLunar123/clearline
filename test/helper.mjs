/**
 * Loads the shipped lib files into a sandbox so the pure logic can be tested in
 * plain node.
 *
 * The libraries are classic scripts that hang themselves off a `CL` global,
 * which is what lets the same files run in a service worker, an event page and
 * the app tab without a bundler. Running them under node:vm tests the exact
 * bytes that ship rather than a parallel copy that can drift.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string[]} files paths under src/, in dependency order
 * @param {object} extras extra globals, e.g. a fake `chrome`
 */
export async function loadLib(files, extras = {}) {
  const context = vm.createContext({ URL, console, BigInt, Date, Math, JSON, ...extras });
  for (const rel of files) {
    const code = await fs.readFile(path.join(ROOT, 'src', rel), 'utf8');
    vm.runInContext(code, context, { filename: rel });
  }
  return context;
}

/**
 * Strip a value of its sandbox realm.
 *
 * Objects built inside node:vm carry that realm's Array and Object prototypes,
 * so deepStrictEqual rejects them as "same structure but not reference-equal"
 * even when the contents match. Round-tripping through JSON rebuilds them with
 * the host's intrinsics, which is what the assertions actually mean to compare.
 */
export const plain = (value) => JSON.parse(JSON.stringify(value));

/** browser.js insists on a namespace object existing, so give it a stub. */
export const STUB_CHROME = {
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    sync: { get: async () => ({}), set: async () => {} },
  },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  downloads: { download: async () => 1 },
};

/**
 * A clock the tests drive by hand.
 *
 * The limiter's whole job is waiting, so real timers would make the suite take
 * minutes and turn every timing assertion into a flake. `sleep` here just moves
 * the clock forward and yields, which makes the waits both instant and exactly
 * measurable.
 */
export function fakeClock(start = 1700000000000) {
  let t = start;
  const waits = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      waits.push(ms);
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
    waits,
    get total() {
      return waits.reduce((a, b) => a + b, 0);
    },
  };
}

/** Minimal Response stand-in: only the bits the limiter reads. */
export function fakeResponse(status, headers = {}, body = null) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const res = {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (map.has(k.toLowerCase()) ? map.get(k.toLowerCase()) : null) },
    json: async () => body,
  };
  res.clone = () => res;
  return res;
}
