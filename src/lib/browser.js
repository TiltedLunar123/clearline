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
  const isFirefox = typeof browser !== 'undefined' && typeof chrome === 'undefined';
  return { api, isFirefox };
})();
