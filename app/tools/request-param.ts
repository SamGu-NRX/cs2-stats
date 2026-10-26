// Request parsing for the dev and preview servers' file endpoints (vite.config.ts). Every endpoint
// that maps a query parameter to a path reads it through fileParam, so a malformed request is a 400
// before any filesystem access.
import type { IncomingMessage } from "node:http";

/**
 * The request's URL, or null when it does not parse: a path such as "//" reads as a URL with no host,
 * and new URL throws on it (ERR_INVALID_URL), which took the dev server down mid-request.
 */
export function requestUrl(req: Pick<IncomingMessage, "url">): URL | null {
  try {
    return new URL(req.url ?? "/", "http://localhost");
  } catch {
    return null;
  }
}

/** A C0 control character or DEL: never part of a file name the endpoints serve. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The query parameter `name` from a URL's raw search string, strictly decoded. URLSearchParams
 * decodes leniently (it passes "%ZZ" through as text), so a malformed escape would reach the
 * filesystem as a literal name; here it is null. A value holding a control character is null too.
 * A missing parameter is "".
 */
export function fileParam(search: string, name: string): string | null {
  for (const pair of search.replace(/^\?/, "").split("&")) {
    const at = pair.indexOf("=");
    const key = at < 0 ? pair : pair.slice(0, at);
    if (key !== name) continue;
    let value: string;
    try {
      value = decodeURIComponent((at < 0 ? "" : pair.slice(at + 1)).replace(/\+/g, " "));
    } catch {
      return null;
    }
    return CONTROL.test(value) ? null : value;
  }
  return "";
}
