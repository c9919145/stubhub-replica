/* TicketVault frontend configuration.
 *
 * apiBase: the backend that serves /api/* and the session cookie.
 *   - ''            -> same origin (npm start locally serves both the site and the API)
 *   - 'https://...' -> a deployed Node backend, e.g. 'https://ticketvault-api.onrender.com'
 *
 * To make signup/login work from the static GitHub Pages site, deploy the Express
 * app to a Node host and set apiBase to that host's URL, then push this change.
 */
(() => {
  window.TICKETVAULT_CONFIG = Object.assign(window.TICKETVAULT_CONFIG || {}, {
    apiBase: ''
  });
})();