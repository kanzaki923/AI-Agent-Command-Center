/**
 * Whether a request to the dev server's `/__acc/connection` comes from the dev server's own
 * page. Vite answers CORS for every localhost origin, so without this check a page on any
 * other local port (a preview of an app an agent built, another dev server) could read the
 * daemon token. Browsers always send `Sec-Fetch-Site`, and `Origin` on cross-origin reads;
 * a request with neither is not from a web page (curl, the e2e harness) and is allowed.
 *
 * @param {{ headers: Record<string, string | string[] | undefined> }} req
 * @returns {boolean}
 */
export function isSameOriginRequest(req) {
  const header = (name) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const site = header('sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = header('origin');
  const host = header('host');
  if (origin !== undefined && (!host || origin !== `http://${host}`)) return false;
  return true;
}
