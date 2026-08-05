import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, STUB_CHROME } from './helper.mjs';

const ctx = await loadLib(['lib/browser.js', 'lib/snowflake.js'], { chrome: STUB_CHROME });
const sf = ctx.CL.snowflake;

test('round trips a date through an id', () => {
  const when = Date.UTC(2023, 5, 15, 12, 0, 0);
  const id = sf.fromMillis(when);
  assert.equal(sf.toMillis(id), when);
});

test('decodes a real message id to its known creation time', () => {
  // Minted 2016-04-30T11:18:25.796Z. Hard coding a real one catches an epoch
  // or shift regression that a pure round trip would happily agree with.
  assert.equal(sf.toDate('175928847299117063').toISOString(), '2016-04-30T11:18:25.796Z');
});

test('clamps pre-epoch dates to zero instead of going negative', () => {
  assert.equal(sf.fromDate(new Date('1998-01-01')), '0');
});

test('compares by numeric value, not lexically', () => {
  // The trap: "9999999999999999999" sorts above "10000000000000000000" as a
  // string while being the smaller number, so a string sort walks a delete
  // queue backwards.
  const older = '999999999999999999';
  const newer = '1000000000000000000';
  assert.equal(sf.compare(older, newer), -1);
  assert.ok(older > newer, 'string comparison is the wrong answer we are guarding against');
});

test('survives ids past 2^53 without losing the low bits', () => {
  const base = 1234567890123456789n;
  const next = base + 1n;

  assert.equal(sf.compare(String(base), String(next)), -1);
  // The corruption being guarded against: a float cannot hold these two apart,
  // so any code path that lets an id touch Number() silently merges distinct
  // messages. That shows up later as "delete skipped some".
  assert.equal(Number(String(base)), Number(String(next)));
});

test('one millisecond of real time is 2^22 of id space', () => {
  const a = sf.fromMillis(sf.EPOCH + 1000);
  const b = sf.fromMillis(sf.EPOCH + 1001);
  assert.equal(BigInt(b) - BigInt(a), 1n << 22n);
});

test('rejects anything that is not a plain id before it reaches a URL', () => {
  assert.ok(sf.isValid('123'));
  assert.ok(!sf.isValid('12 3'));
  assert.ok(!sf.isValid('../../guilds'));
  assert.ok(!sf.isValid(123));
  assert.ok(!sf.isValid(''));
});
