/** Minimal Streamable HTTP MCP client: one session, tool calls only. */

export class McpError extends Error {
  constructor(
    readonly code: string,
    message = `MCP request failed (${code})`,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export interface McpClientOptions {
  url: string;
  token: string;
  timeoutMs?: number;
  clientName?: string;
}

export interface McpClient {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

const PROTOCOL = "2025-06-18";

/** JSON-RPC payload from a JSON or single-event SSE response. */
async function payload(
  response: Response,
): Promise<{ result?: unknown; error?: { message?: string } }> {
  const text = await response.text();
  const event = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5))
    .pop();
  try {
    return JSON.parse(event ?? text);
  } catch {
    throw new McpError("INVALID_PAYLOAD");
  }
}

export function mcpClient(options: McpClientOptions): McpClient {
  const timeoutMs = options.timeoutMs ?? 30_000;
  let session: Promise<string | null> | undefined;
  let id = 0;

  async function post(body: unknown, sessionId: string | null): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(options.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          "mcp-protocol-version": PROTOCOL,
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      throw new McpError(name === "AbortError" || name === "TimeoutError" ? "TIMEOUT" : "NETWORK");
    }
    if (response.status === 401) throw new McpError("AUTHENTICATION");
    if (response.status === 403) throw new McpError("FORBIDDEN");
    if (response.status === 429) throw new McpError("RATE_LIMITED");
    if (!response.ok && response.status !== 202) throw new McpError(`HTTP_${response.status}`);
    return response;
  }

  function open(): Promise<string | null> {
    session ??= (async () => {
      const response = await post(
        {
          jsonrpc: "2.0",
          id: ++id,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL,
            capabilities: {},
            clientInfo: { name: options.clientName ?? "issue-graph", version: "1" },
          },
        },
        null,
      );
      const sessionId = response.headers.get("mcp-session-id");
      const init = await payload(response);
      if (init.error || !init.result) throw new McpError("INITIALIZE");
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
      return sessionId;
    })();
    return session;
  }

  return {
    async call(tool, args) {
      const sessionId = await open();
      const response = await post(
        { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } },
        sessionId,
      );
      const message = await payload(response);
      if (message.error) throw new McpError("TOOL_ERROR");
      const result = message.result as {
        isError?: boolean;
        structuredContent?: unknown;
        content?: { type?: string; text?: string }[];
      };
      const text = (result?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
      if (result?.isError) {
        // Tool errors carry readable text, such as "not found"; keep the code generic.
        throw new McpError(/not found/i.test(text) ? "NOT_FOUND" : "TOOL_ERROR");
      }
      if (result?.structuredContent !== undefined) return result.structuredContent;
      try {
        return JSON.parse(text);
      } catch {
        throw new McpError("INVALID_PAYLOAD");
      }
    },
  };
}
