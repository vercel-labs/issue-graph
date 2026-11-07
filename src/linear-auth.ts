import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

/** OAuth for Linear's hosted MCP server: dynamic client registration, PKCE, loopback redirect. */
export const LINEAR_MCP_ISSUER = "https://mcp.linear.app";
const KEYCHAIN_SERVICE = "issue-graph";
const KEYCHAIN_ACCOUNT = "linear-mcp";

export interface LinearSession {
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
}

/** Where a session is kept: the macOS login Keychain, otherwise a 0600 file under ISSUE_GRAPH_HOME. */
export interface SessionStore {
  location: string;
  read(): LinearSession | null;
  write(session: LinearSession): void;
  clear(): boolean;
}

export function sessionStore(): SessionStore {
  if (process.platform === "darwin") {
    return {
      location: "macOS Keychain (issue-graph / linear-mcp)",
      read() {
        try {
          const raw = execFileSync(
            "security",
            ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          );
          return JSON.parse(raw.trim()) as LinearSession;
        } catch {
          return null;
        }
      },
      write(session) {
        execFileSync(
          "security",
          [
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
            JSON.stringify(session),
          ],
          { stdio: "ignore" },
        );
      },
      clear() {
        try {
          execFileSync(
            "security",
            ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT],
            {
              stdio: "ignore",
            },
          );
          return true;
        } catch {
          return false;
        }
      },
    };
  }
  const dir = join(process.env.ISSUE_GRAPH_HOME || join(homedir(), ".issue-graph"), "credentials");
  const file = join(dir, "linear-mcp.json");
  return {
    location: file,
    read() {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as LinearSession;
      } catch {
        return null;
      }
    },
    write(session) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(session), { mode: 0o600 });
      chmodSync(file, 0o600);
    },
    clear() {
      if (!existsSync(file)) return false;
      rmSync(file);
      return true;
    },
  };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

async function form(url: string, body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !json.access_token)
    throw new Error(`Linear sign-in failed (${json.error ?? `HTTP_${response.status}`})`);
  return json;
}

function session(clientId: string, token: TokenResponse, previous?: LinearSession): LinearSession {
  return {
    clientId,
    accessToken: token.access_token as string,
    refreshToken: token.refresh_token ?? previous?.refreshToken,
    expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
  };
}

export interface LoginIO {
  /** Opens the authorization URL; the URL is also printed so it can be opened by hand. */
  open(url: string): void;
  stderr(value: string): void;
}

/** Signs in through the browser and stores a read-only session. */
export async function loginLinear(
  store: SessionStore,
  io: LoginIO,
  timeoutMs = 300_000,
): Promise<LinearSession> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    const registration = await fetch(`${LINEAR_MCP_ISSUER}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "issue-graph",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "read",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const { client_id: clientId } = (await registration.json().catch(() => ({}))) as {
      client_id?: string;
    };
    if (!registration.ok || !clientId)
      throw new Error(`Linear sign-in failed (registration HTTP_${registration.status})`);

    const authorize = new URL(`${LINEAR_MCP_ISSUER}/authorize`);
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "read",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: LINEAR_MCP_ISSUER,
    }))
      authorize.searchParams.set(name, value);

    const code = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Linear sign-in timed out")), timeoutMs);
      server.on("request", (request, response) => {
        const url = new URL(request.url ?? "/", redirectUri);
        if (url.pathname !== "/callback") {
          response.writeHead(404).end();
          return;
        }
        const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
        response
          .writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" })
          .end(
            ok
              ? "<p>Linear is connected to issue-graph. You can close this tab.</p>"
              : "<p>Linear sign-in did not complete. Return to the terminal.</p>",
          );
        clearTimeout(timer);
        if (ok) resolve(url.searchParams.get("code") as string);
        else
          reject(
            new Error(
              `Linear sign-in failed (${url.searchParams.get("error") ?? "invalid state"})`,
            ),
          );
      });
    });
    io.stderr(`Opening Linear to approve read access. If nothing opens, visit:\n${authorize}\n`);
    io.open(authorize.toString());
    const token = await form(`${LINEAR_MCP_ISSUER}/token`, {
      grant_type: "authorization_code",
      code: await code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: LINEAR_MCP_ISSUER,
    });
    const result = session(clientId, token);
    store.write(result);
    return result;
  } finally {
    server.close();
  }
}

/** A usable access token, refreshed when it is about to expire; null when not signed in. */
export async function linearSessionToken(store: SessionStore): Promise<string | null> {
  const current = store.read();
  if (!current?.accessToken) return null;
  if (!current.expiresAt || current.expiresAt - Date.now() > 60_000) return current.accessToken;
  if (!current.refreshToken) return null;
  const token = await form(`${LINEAR_MCP_ISSUER}/token`, {
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
    client_id: current.clientId,
    resource: LINEAR_MCP_ISSUER,
  });
  const next = session(current.clientId, token, current);
  store.write(next);
  return next.accessToken;
}
