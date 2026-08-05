/**
 * Namespace shim.
 *
 * Firefox exposes `browser` with promises, Chrome exposes `chrome`. Chrome's
 * MV3 APIs already return promises when the callback is omitted, so aliasing is
 * enough and a full polyfill would be dead weight.
 */
var CL = (function () {
  'use strict';
  const api = typeof browser !== 'undefined' ? browser : chrome;
  // Deliberately no isFirefox flag. Both `browser` and `chrome` exist in
  // Firefox, and `browser` exists on Chromium too, so every cheap sniff of that
  // shape is wrong somewhere. Nothing here needs to know which browser it is:
  // the two real differences are in the manifest, and the build writes those.
  return { api };
})();
