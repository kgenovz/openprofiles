/**
 * Errors from talking to Stremio. `kind` drives what the user is told; the
 * message never contains a response body (Stremio echoes submitted fields,
 * including passwords and auth keys).
 */
export class StremioError extends Error {
  constructor(kind, userMessage, { method, status, code } = {}) {
    super(`${userMessage} [${method || 'stremio'}${status ? ` HTTP ${status}` : ''}${code != null ? ` code ${code}` : ''}]`);
    this.kind = kind; // 'auth' | 'unreachable' | 'busy' | 'api' | 'bad_response'
    this.userMessage = userMessage;
    this.method = method;
    this.status = status;
    this.code = code;
  }
}

export const MESSAGES = {
  auth: 'Stremio sign-in has expired. Sign in again on the settings page.',
  badLogin: 'Stremio rejected that email or password.',
  unreachable: "Couldn't reach Stremio. Check the server's internet connection and try again.",
  busy: 'Stremio is busy. Try again in a minute.',
  badResponse: 'Stremio sent a response OpenProfiles could not read. Try again later.',
};
