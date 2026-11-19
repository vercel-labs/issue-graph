import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { YouTrackReadError } from "../youtrack.js";
import { youTrackReader } from "./youtrack.js";

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
}

const seen: Seen[] = [];
let server: Server;
let origin: string;
let hits = 0;

function handler(request: IncomingMessage, response: ServerResponse) {
  seen.push({ method: request.method, url: request.url, headers: request.headers });
  const path = new URL(request.url ?? "/", "http://x").pathname;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(body));
  };
  if (path.endsWith("/api/ok")) return json(200, [{ id: "1" }]);
  if (path.endsWith("/api/401")) return json(401, { error: "secret-token-value" });
  if (path.endsWith("/api/403")) return json(403, {});
  if (path.endsWith("/api/404")) return json(404, {});
  if (path.endsWith("/api/400")) return json(400, {});
  if (path.endsWith("/api/flaky"))
    return ++hits === 1 ? json(429, {}, { "retry-after": "0" }) : json(200, { ok: true });
  if (path.endsWith("/api/slow-limit")) return json(429, {}, { "retry-after": "3600" });
  if (path.endsWith("/api/down")) return json(503, {});
  if (path.endsWith("/api/redirect")) {
    response.writeHead(302, { location: `${origin}/api/ok` });
    return response.end();
  }
  if (path.endsWith("/api/big")) return json(200, { text: "x".repeat(2000) });
  if (path.endsWith("/api/html")) {
    response.writeHead(200, { "content-type": "text/html" });
    return response.end("<html>");
  }
  if (path.endsWith("/api/hang")) return;
  json(404, {});
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const reader = (path = "", extra: Partial<Parameters<typeof youTrackReader>[0]> = {}) =>
  youTrackReader({ baseUrl: `${origin}${path}`, token: "perm:abc", maxBackoffMs: 50, ...extra });

async function failure(promise: Promise<unknown>): Promise<YouTrackReadError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(YouTrackReadError);
  return error as YouTrackReadError;
}

describe("youTrackReader", () => {
  test("sends one authenticated GET to <base>/api with the query encoded", async () => {
    seen.length = 0;
    const result = await reader("/youtrack/").get("ok", {
      fields: "id,project(shortName)",
      $top: "100",
    });
    expect(result).toEqual([{ id: "1" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("/youtrack/api/ok?fields=id%2Cproject%28shortName%29&%24top=100");
    expect(seen[0].headers.authorization).toBe("Bearer perm:abc");
    expect(seen[0].headers.accept).toBe("application/json");
    expect(reader().label).toBe("YouTrack REST API");
    expect(reader("/youtrack/").baseUrl).toBe(`${origin}/youtrack`);
  });

  test("maps HTTP failures to codes without leaking the response or the token", async () => {
    for (const [path, code] of [
      ["401", "AUTHENTICATION"],
      ["403", "FORBIDDEN"],
      ["404", "NOT_FOUND"],
      ["400", "HTTP_400"],
    ] as const) {
      const error = await failure(reader().get(path));
      expect(error.code).toBe(code);
      expect(error.message).not.toContain("secret-token-value");
      expect(error.message).not.toContain("perm:abc");
    }
  });

  test("retries 429 once the server allows it and fails fast when the wait is too long", async () => {
    hits = 0;
    expect(await reader().get("flaky")).toEqual({ ok: true });
    expect(hits).toBe(2);
    seen.length = 0;
    expect((await failure(reader().get("slow-limit"))).code).toBe("RATE_LIMITED");
    expect(seen).toHaveLength(1);
  });

  test("retries 5xx a bounded number of times", async () => {
    seen.length = 0;
    const error = await failure(reader("", { maxRetries: 1, maxBackoffMs: 5000 }).get("down"));
    expect(error.code).toBe("UPSTREAM");
    expect(seen).toHaveLength(2);
    seen.length = 0;
    await failure(reader("", { maxRetries: 0 }).get("down"));
    expect(seen).toHaveLength(1);
  });

  test("a path cannot leave <base>/api, so the token only reaches the API root", async () => {
    seen.length = 0;
    const api = reader("/youtrack");
    for (const path of ["../../not-youtrack", "../ok", "%2e%2e/ok", "a/../../../ok"])
      expect((await failure(api.get(path))).code, path).toBe("INVALID_PATH");
    expect(seen).toEqual([]);
    expect(await reader("/youtrack").get("a/../ok")).toEqual([{ id: "1" }]);
  });

  test("does not follow redirects, so the token is never forwarded", async () => {
    seen.length = 0;
    expect((await failure(reader().get("redirect"))).code).toBe("NETWORK");
    expect(seen).toHaveLength(1);
  });

  test("rejects oversized and non-JSON bodies and times out", async () => {
    expect((await failure(reader("", { maxBytes: 100 }).get("big"))).code).toBe("TOO_LARGE");
    expect((await failure(reader().get("html"))).code).toBe("INVALID_PAYLOAD");
    expect((await failure(reader("", { timeoutMs: 50 }).get("hang"))).code).toBe("TIMEOUT");
  });

  test("validates the base URL, token, and limits at construction", () => {
    for (const baseUrl of [
      "acme.youtrack.cloud",
      "https://u:p@x",
      "https://x/?a=1",
      "http://acme.youtrack.cloud",
      "http://10.0.0.5",
    ])
      expect(() => youTrackReader({ baseUrl, token: "t" }), baseUrl).toThrow(/YouTrack URL/);
    for (const token of ["", " ", "a b", "a\nb"])
      expect(() => youTrackReader({ baseUrl: origin, token }), JSON.stringify(token)).toThrow(
        /token/,
      );
    expect(() => youTrackReader({ baseUrl: origin, token: "t", timeoutMs: 0 })).toThrow(RangeError);
    expect(() => youTrackReader({ baseUrl: origin, token: "t", maxRetries: 4 })).toThrow(
      RangeError,
    );
    expect(() => youTrackReader({ baseUrl: origin, token: "t", maxBytes: 0 })).toThrow(RangeError);
  });
});
