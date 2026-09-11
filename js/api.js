(function () {
  'use strict';

  var base = ((window.TICKETVAULT_CONFIG && window.TICKETVAULT_CONFIG.apiBase) || '').replace(/\/+$/, '');

  window.apiUrl = function (path) {
    return base + path;
  };
})();