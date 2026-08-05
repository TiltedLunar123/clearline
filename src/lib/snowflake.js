/**
 * Discord snowflake ids.
 *
 * Every id encodes its own creation time in the top 42 bits, which is the only
 * reason date filtering is cheap here. The search endpoint takes `min_id` and
 * `max_id`, not timestamps, so a user picking "everything before March" turns
 * into one synthesised id rather than fetching a channel's whole history and
 * filtering client side.
 *
 * Ids exceed 2^53, so they are BigInt internally and strings at the boundary.
 * Passing one through a Number anywhere silently corrupts the low bits, and the
 * corruption looks like "delete skipped a few messages" rather than like a bug.
 */
CL.snowflake = (function () {
  'use strict';

  const EPOCH = 1420070400000; // 2015-01-01T00:00:00Z, Discord's zero point.
  const TIMESTAMP_SHIFT = 22n;

  /** Milliseconds since the Unix epoch for the moment this id was minted. */
  function toMillis(id) {
    return Number(BigInt(id) >> TIMESTAMP_SHIFT) + EPOCH;
  }

  function toDate(id) {
    return new Date(toMillis(id));
  }

  /**
   * Lowest id that could exist at or after `millis`.
   *
   * Anything before the epoch clamps to 0 rather than producing a negative
   * shift, because a user is allowed to type 1998 into a date box and the
   * honest answer to "everything before 1998" is "nothing", not a crash.
   */
  function fromMillis(millis) {
    const delta = Math.floor(millis) - EPOCH;
    if (delta <= 0) return '0';
    return String(BigInt(delta) << TIMESTAMP_SHIFT);
  }

  function fromDate(date) {
    return fromMillis(date instanceof Date ? date.getTime() : Number(date));
  }

  /**
   * Compare as ids, not as strings. Snowflakes are variable length once you
   * cross a power of ten, so "9999..." sorts above "10000..." lexically while
   * being the older message. Sorting a delete queue the wrong way round means
   * working backwards through a channel and tripping the stricter bucket that
   * Discord applies to old messages.
   */
  function compare(a, b) {
    const x = BigInt(a);
    const y = BigInt(b);
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  }

  /** Cheap shape check before an id reaches a URL. */
  function isValid(id) {
    return typeof id === 'string' && /^[0-9]{1,20}$/.test(id);
  }

  return { EPOCH, toMillis, toDate, fromMillis, fromDate, compare, isValid };
})();
