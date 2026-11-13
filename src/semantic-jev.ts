import { stripVTControlCharacters } from "node:util";
import { type GatewayEvaluationRequest, SemanticError } from "./semantic-types.js";

export type SemanticGatewayDiagnostic = Readonly<{
  trust: "untrusted";
  availability: "available" | "unavailable";
  unavailableReason?: "too-large" | "invalid-json" | "read-budget" | "read-error";
  code?: string;
  type?: string;
  message?: string;
  requestId?: string;
  generationId?: string;
  vercelId?: string;
  retryAfterRaw?: string;
  providerReported?: Readonly<{
    provider?: string;
    model?: string;
    originalModelId?: string;
    resolvedProvider?: string;
    canonicalSlug?: string;
    finalProvider?: string;
  }>;
}>;

export type JevTiming = Readonly<{ headersMs: number | null; totalMs: number }>;

export type JevOptions = {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  nowMs?: number;
  onAttempt?: () => void;
  onHttpError?: (error: JevError) => void;
  onTiming?: (timing: JevTiming) => void;
};

export { JEV_ADAPTER_VERSION } from "./semantic-version.js";
export const JEV_ENDPOINT = "https://ai-gateway.vercel.sh/v1/evaluate";
export const JEV_MAX_RESPONSE_BYTES = 262144;
export const JEV_TIMEOUT_MS = 30000;
export const JEV_MAX_REQUEST_BYTES = 24000;
export const JEV_MAX_DIAGNOSTIC_BYTES = 8192;
export const JEV_DIAGNOSTIC_READ_MS = 500;

const messages = {
  "gateway-http-error": "The evaluation gateway returned an unsuccessful HTTP status.",
  "gateway-timeout": "The evaluation gateway deadline expired.",
  "gateway-aborted": "The evaluation gateway request was aborted.",
  "gateway-response-too-large": "The evaluation gateway response exceeded the byte limit.",
  "gateway-invalid-json": "The evaluation gateway response was not valid JSON.",
  "gateway-network-error": "The evaluation gateway transport failed.",
  "input-too-large": "The evaluation request exceeded the byte limit.",
  "gateway-invalid-request":
    "The evaluation request must use the fixed model and provider routing.",
  "gateway-invalid-api-key": "A valid evaluation gateway API key is required.",
  "gateway-invalid-timeout": "The evaluation timeout must be an integer from 1 through 30000 ms.",
  "gateway-attempt-error": "The evaluation attempt callback failed before sending the request.",
  "gateway-http-callback-error":
    "The evaluation HTTP error callback must complete synchronously without throwing.",
} as const;

type JevErrorCode = keyof typeof messages;

export class JevError extends SemanticError {
  readonly attempted: boolean;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly diagnostic?: SemanticGatewayDiagnostic;

  constructor(
    code: JevErrorCode,
    details: {
      attempted: boolean;
      status?: number | null;
      retryAfterSeconds?: number | null;
      diagnostic?: SemanticGatewayDiagnostic;
    },
  ) {
    super(
      code,
      messages[code],
      "Review the evaluation configuration and request outcome before retrying.",
    );
    this.name = "JevError";
    this.attempted = details.attempted;
    this.status = details.status ?? null;
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
    if (details.diagnostic !== undefined) this.diagnostic = details.diagnostic;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fixedRouting(value: unknown): boolean {
  if (!record(value) || value.model !== "typesafe-ai/jev") return false;
  if (
    Object.keys(value).some(
      (key) => !["model", "state", "questions", "providerOptions"].includes(key),
    )
  ) {
    return false;
  }
  const providerOptions = value.providerOptions;
  if (!record(providerOptions) || Object.keys(providerOptions).length !== 1) return false;
  const gateway = providerOptions.gateway;
  return (
    record(gateway) &&
    Object.keys(gateway).length === 1 &&
    Array.isArray(gateway.only) &&
    gateway.only.length === 1 &&
    gateway.only[0] === "typesafe-ai"
  );
}

export function parseRetryAfterSeconds(value: string | null, nowMs = Date.now()): number | null {
  if (value === null) return null;
  if (value.length > 1024) return Number.POSITIVE_INFINITY;
  const raw = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (
    !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      raw,
    )
  ) {
    return null;
  }
  const date = Date.parse(raw);
  if (
    !Number.isFinite(date) ||
    !Number.isFinite(nowMs) ||
    new Date(date).toUTCString().slice(5) !== raw.slice(5)
  ) {
    return null;
  }
  return Math.max(0, (date - nowMs) / 1000);
}

function diagnosticSanitizer(apiKey: string, body: string) {
  const sensitive = new Set([apiKey]);
  const payload = JSON.parse(body) as Record<string, unknown>;
  const pending: unknown[] = [payload.state, payload.questions];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string" && value.length > 0) sensitive.add(value);
    else if (Array.isArray(value)) pending.push(...value);
    else if (record(value)) pending.push(...Object.values(value));
  }
  const exact = new RegExp(
    [...sensitive]
      .sort((a, b) => b.length - a.length)
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "g",
  );
  return (value: unknown, kind: "token" | "retry-after" = "token"): string | undefined => {
    if (typeof value !== "string") return undefined;
    if (value.length > JEV_MAX_DIAGNOSTIC_BYTES) return "[omitted]";
    let text = value;
    for (let index = 0; index < 4; index++) {
      const decoded = text
        .replace(/\\u([\da-f]{4})/gi, (_, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        )
        .replace(/(?:%[\da-f]{2})+/gi, (encoded) => {
          try {
            return decodeURIComponent(encoded);
          } catch {
            return "[redacted]";
          }
        });
      if (decoded === text) break;
      text = decoded;
    }
    if (/%[\da-f]{2}|\\u[\da-f]{4}/i.test(text)) return "[omitted]";
    const redact = (input: string) =>
      input
        .replace(/\bbearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
        .replace(/(?:sk|vck)[_-][a-z\d._~+/-]+=*/gi, "[redacted]")
        .replace(exact, "[redacted]");
    text = redact(
      stripVTControlCharacters(redact(text)).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ""),
    );
    if (text.includes("[redacted]")) return "[redacted]";
    if (text.length > 128) return "[omitted]";
    if (text.length > 0 && [...sensitive].some((input) => input.includes(text)))
      return "[redacted]";
    if (kind === "retry-after") return parseRetryAfterSeconds(text, 0) === null ? undefined : text;
    return /^[a-z\d][a-z\d._:/|-]{0,127}$/i.test(text) ? text : undefined;
  };
}

function diagnosticFields(
  value: Record<string, unknown>,
  clean: ReturnType<typeof diagnosticSanitizer>,
): Partial<SemanticGatewayDiagnostic> {
  const error = record(value.error) ? value.error : value;
  const metadata = record(value.providerMetadata) ? value.providerMetadata : {};
  const gateway = record(metadata.gateway) ? metadata.gateway : {};
  const routing = record(gateway.routing) ? gateway.routing : {};
  const providerReported = Object.fromEntries(
    ["provider", "model", "originalModelId", "resolvedProvider", "canonicalSlug", "finalProvider"]
      .map((key) => [key, clean(routing[key] ?? error[key] ?? value[key])])
      .filter(([, field]) => field !== undefined),
  );
  return {
    code: clean(error.code),
    type: clean(error.type),
    requestId: clean(error.requestId ?? value.requestId),
    generationId: clean(error.generationId ?? value.generationId),
    ...(Object.keys(providerReported).length > 0
      ? { providerReported: Object.freeze(providerReported) }
      : {}),
  };
}

export async function evaluateWithJev(
  request: GatewayEvaluationRequest,
  options: JevOptions,
): Promise<unknown> {
  const start = performance.now();
  const elapsed = () => {
    const value = performance.now() - start;
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  };
  let headersMs: number | null = null;
  try {
    return await evaluateRequest(request, options, () => {
      headersMs = elapsed();
    });
  } finally {
    try {
      void Promise.resolve(options.onTiming?.({ headersMs, totalMs: elapsed() })).catch(() => {});
    } catch {}
  }
}

async function evaluateRequest(
  request: GatewayEvaluationRequest,
  options: JevOptions,
  onHeaders: () => void,
): Promise<unknown> {
  let attempted = false;
  const failures = new WeakSet<JevError>();
  const failure = (
    code: JevErrorCode,
    details?: {
      status: number;
      retryAfterSeconds: number | null;
      diagnostic?: SemanticGatewayDiagnostic;
    },
  ) => {
    const error = new JevError(code, { attempted, ...details });
    failures.add(error);
    return error;
  };
  if (options.signal?.aborted) throw failure("gateway-aborted");
  const timeoutMs = options.timeoutMs === undefined ? JEV_TIMEOUT_MS : options.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > JEV_TIMEOUT_MS) {
    throw failure("gateway-invalid-timeout");
  }
  if (typeof options.apiKey !== "string" || !/^[A-Za-z0-9._~+/-]+=*$/.test(options.apiKey)) {
    throw failure("gateway-invalid-api-key");
  }
  let body: string;
  try {
    const serialized = JSON.stringify(request);
    if (typeof serialized !== "string") throw failure("gateway-invalid-request");
    body = serialized;
  } catch {
    throw failure("gateway-invalid-request");
  }
  if (new TextEncoder().encode(body).byteLength > JEV_MAX_REQUEST_BYTES) {
    throw failure("input-too-large");
  }
  if (!fixedRouting(JSON.parse(body))) throw failure("gateway-invalid-request");
  let headers: Headers;
  try {
    headers = new Headers({
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    });
  } catch {
    throw failure("gateway-invalid-api-key");
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw failure("gateway-network-error");
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let responseBody: ReadableStream<Uint8Array> | null = null;
  let interrupted: JevError | undefined;
  let bodyCancelled = false;
  const cancelBody = () => {
    if (!responseBody || bodyCancelled) return;
    bodyCancelled = true;
    try {
      const pending = reader ? reader.cancel() : responseBody?.cancel();
      void pending?.catch(() => {});
    } catch {}
  };
  let interrupt: (code: "gateway-timeout" | "gateway-aborted") => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    interrupt = (code) => {
      if (interrupted) return;
      interrupted = failure(code);
      reject(interrupted);
      controller.abort();
      cancelBody();
    };
  });
  const abort = () => interrupt("gateway-aborted");
  const timer = setTimeout(() => interrupt("gateway-timeout"), timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const perform = async (): Promise<unknown> => {
    if (interrupted) throw interrupted;
    try {
      const completion: unknown = options.onAttempt?.();
      if (completion !== undefined) await completion;
    } catch {
      throw failure("gateway-attempt-error");
    }
    if (interrupted) throw interrupted;
    attempted = true;
    let response: Response;
    try {
      response = await fetcher(JEV_ENDPOINT, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw interrupted ?? failure("gateway-network-error");
    }
    onHeaders();
    responseBody = response.body;
    if (interrupted) {
      cancelBody();
      throw interrupted;
    }
    if (!response.ok) {
      const retryAfterRaw = response.headers.get("retry-after");
      const retryAfterSeconds =
        response.status === 429
          ? parseRetryAfterSeconds(retryAfterRaw, options.nowMs ?? Date.now())
          : null;
      try {
        const completion: unknown = options.onHttpError?.(
          Object.freeze(
            failure("gateway-http-error", { status: response.status, retryAfterSeconds }),
          ),
        );
        if (
          completion !== null &&
          (typeof completion === "object" || typeof completion === "function") &&
          "then" in completion &&
          typeof completion.then === "function"
        ) {
          void Promise.resolve(completion).catch(() => {});
          throw failure("gateway-http-callback-error", {
            status: response.status,
            retryAfterSeconds,
          });
        }
      } catch {
        throw failure("gateway-http-callback-error", {
          status: response.status,
          retryAfterSeconds,
        });
      }
      if (interrupted) throw interrupted;
      const clean = diagnosticSanitizer(options.apiKey, body);
      const base = {
        trust: "untrusted" as const,
        requestId: clean(response.headers.get("x-request-id")),
        generationId: clean(response.headers.get("x-generation-id")),
        vercelId: clean(response.headers.get("x-vercel-id")),
        retryAfterRaw: clean(retryAfterRaw, "retry-after"),
      };
      const unavailable = (
        unavailableReason: SemanticGatewayDiagnostic["unavailableReason"],
      ): SemanticGatewayDiagnostic =>
        Object.freeze({ ...base, availability: "unavailable", unavailableReason });
      let finished = false;
      let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
      const readDiagnostic = async (): Promise<SemanticGatewayDiagnostic> => {
        const length = response.headers.get("content-length");
        if (length !== null && /^\d+$/.test(length) && Number(length) > JEV_MAX_DIAGNOSTIC_BYTES) {
          return unavailable("too-large");
        }
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let text = "";
        let bytes = 0;
        try {
          reader = responseBody?.getReader();
          if (reader) {
            while (!finished && !interrupted) {
              const chunk = await reader.read();
              if (finished || interrupted) return unavailable("read-budget");
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > JEV_MAX_DIAGNOSTIC_BYTES) return unavailable("too-large");
              try {
                text += decoder.decode(chunk.value, { stream: true });
              } catch {
                return unavailable("invalid-json");
              }
              const first = text.trimStart()[0];
              if (first !== undefined && first !== "{") return unavailable("invalid-json");
            }
          }
        } catch {
          return unavailable("read-error");
        }
        try {
          const value: unknown = JSON.parse(text + decoder.decode());
          if (!record(value)) return unavailable("invalid-json");
          const fields = diagnosticFields(value, clean);
          return Object.freeze({
            ...base,
            ...fields,
            requestId: fields.requestId ?? base.requestId,
            generationId: fields.generationId ?? base.generationId,
            availability: "available",
          });
        } catch {
          return unavailable("invalid-json");
        }
      };
      let diagnostic: SemanticGatewayDiagnostic;
      try {
        diagnostic = await Promise.race([
          stopped,
          new Promise<SemanticGatewayDiagnostic>((resolve) => {
            diagnosticTimer = setTimeout(
              () => resolve(unavailable("read-budget")),
              JEV_DIAGNOSTIC_READ_MS,
            );
          }),
          readDiagnostic(),
        ]);
      } finally {
        finished = true;
        clearTimeout(diagnosticTimer);
      }
      if (interrupted) throw interrupted;
      throw failure("gateway-http-error", {
        status: response.status,
        retryAfterSeconds,
        diagnostic,
      });
    }
    const length = response.headers.get("content-length");
    if (length !== null && /^\d+$/.test(length) && Number(length) > JEV_MAX_RESPONSE_BYTES) {
      throw failure("gateway-response-too-large");
    }
    reader = responseBody?.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    if (reader) {
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          throw interrupted ?? failure("gateway-network-error");
        }
        if (interrupted) throw interrupted;
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > JEV_MAX_RESPONSE_BYTES) throw failure("gateway-response-too-large");
        try {
          text += decoder.decode(chunk.value, { stream: true });
        } catch {
          throw failure("gateway-invalid-json");
        }
      }
    }
    try {
      return JSON.parse(text + decoder.decode()) as unknown;
    } catch {
      throw failure("gateway-invalid-json");
    }
  };
  try {
    return await Promise.race([perform(), stopped]);
  } catch (error) {
    controller.abort();
    cancelBody();
    throw error instanceof JevError && failures.has(error)
      ? error
      : failure("gateway-network-error");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    try {
      reader?.releaseLock();
    } catch {}
  }
}
