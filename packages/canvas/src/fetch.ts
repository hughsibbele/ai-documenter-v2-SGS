import { CanvasError } from "./error";
import type { CanvasConfig } from "./types";

export function normalizeHost(input: string): string {
  let h = input.trim().toLowerCase();
  h = h.replace(/^https?:\/\//, "");
  h = h.replace(/\/.*$/, "");
  if (!h) throw new CanvasError("Canvas host is empty.", 0);
  if (!/^[a-z0-9.-]+$/.test(h)) {
    throw new CanvasError(`Canvas host has invalid characters: ${input}`, 0);
  }
  return h;
}

export async function canvasFetch(
  config: CanvasConfig,
  pathOrUrl: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = pathOrUrl.startsWith("https://")
    ? pathOrUrl
    : `https://${config.host}/api/v1${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/**
 * Parse a Canvas Link header for the rel="next" URL.
 * Canvas paginates this way: `<https://...?page=2>; rel="next", <...>; rel="last"`.
 */
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m && m[1]) return m[1];
  }
  return null;
}

export async function paginate<T>(
  config: CanvasConfig,
  initialPath: string,
): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = initialPath;
  while (url) {
    const res = await canvasFetch(config, url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new CanvasError(
        `Canvas ${url} returned ${res.status}.`,
        res.status,
        body,
      );
    }
    const page = (await res.json()) as T[];
    out.push(...page);
    url = parseNextLink(res.headers.get("Link"));
  }
  return out;
}
