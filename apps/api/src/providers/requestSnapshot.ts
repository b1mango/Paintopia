export type UpstreamRequestSnapshot = {
  endpoint: string;
  method: string;
  parameters: unknown;
};

export function sanitizeRequestValue(value: unknown, secret = "", key = ""): unknown {
  if (/authorization|api.?key|token|secret|password|b64|base64/i.test(key)) return "[redacted]";
  if (value instanceof Blob) return { type: value.type, bytes: value.size };
  if (Array.isArray(value)) return value.map(item => sanitizeRequestValue(item, secret, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, sanitizeRequestValue(v, secret, k)]));
  if (typeof value !== "string") return value;
  let text = secret ? value.split(secret).join("[redacted]") : value;
  text = text.replace(/data:[^\s"']+;base64,[A-Za-z0-9+/=\s]+/gi, "[image data redacted]").replace(/[A-Za-z0-9+/]{200,}={0,2}/g, "[binary redacted]");
  text = text.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
  if (/^https?:\/\//i.test(text)) {
    try { const url = new URL(text); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; text = url.toString(); } catch { return "[invalid URL]"; }
  }
  return text;
}

export function observeImageRequests(fetchImpl: typeof fetch, secret: string, onRequest?: (snapshot: UpstreamRequestSnapshot) => void): typeof fetch {
  return async (url, init) => {
    let parameters: unknown = {};
    if (typeof init?.body === "string") {
      try { parameters = JSON.parse(init.body); } catch { parameters = "[unparsed body]"; }
    } else if (init?.body instanceof FormData) {
      const values: Record<string, unknown> = {};
      for (const [key, value] of init.body.entries()) values[key] = key in values ? [values[key], value] : value;
      parameters = values;
    }
    onRequest?.({ endpoint: String(sanitizeRequestValue(String(url), secret)), method: init?.method ?? "GET", parameters: sanitizeRequestValue(parameters, secret) });
    return fetchImpl(url, init);
  };
}
