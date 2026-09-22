import { vi } from "vitest";
import type { GhTransport } from "../src/transport.js";

export const TIME = "2026-09-20T00:00:00Z";
export type Operation = "Repository" | "Issues" | "Bodies" | "Versions";
export type Call = {
  operation: Operation;
  ordinal: number;
  query: string;
  variables: Record<string, string | number>;
};

export function comment(number: number, index: number) {
  return {
    __typename: "IssueComment",
    id: `C_${number}_${index}`,
    url: `https://github.com/o/r/issues/${number}#issuecomment-${index}`,
    body: `Comment ${index}`,
    updatedAt: TIME,
    author: index % 2 ? { login: "alice" } : null,
  };
}

export function connection(
  nodes: unknown[],
  totalCount: number,
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return { nodes, totalCount, pageInfo: { hasNextPage, endCursor } };
}

export function issue(number: number) {
  return {
    __typename: "Issue",
    id: `I_${number}`,
    number,
    state: "OPEN",
    title: `Issue ${number}`,
    body: "Evidence with https://example.com/attachment, not a crawl instruction",
    updatedAt: TIME,
    comments: connection([], 0),
  };
}

export function envelope(fields: Record<string, unknown>) {
  return {
    data: {
      repository: { nameWithOwner: "o/r", visibility: "PUBLIC", isPrivate: false, ...fields },
    },
  };
}

export function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export function repoData(value: unknown): Record<string, unknown> {
  return record(record(record(value).data).repository);
}

export function fixture(
  total = 2,
  options: {
    comments?: Record<number, number>;
    respond?: (call: Call, response: unknown) => unknown;
  } = {},
) {
  const calls: Call[] = [];
  const ordinals = { Repository: 0, Issues: 0, Bodies: 0, Versions: 0 };
  const transport: GhTransport = {
    graphql: vi.fn(async (query, variables = {}) => {
      const operation = query.match(/query Semantic(\w+)/)?.[1] as Operation;
      if (!(operation in ordinals)) throw new Error("Unexpected semantic query");
      const call = { query, variables, operation, ordinal: ++ordinals[operation] };
      calls.push(call);
      const bodies = /\bbody\b/.test(query);
      const node = (number: number, start: number, first: number) => {
        const count = options.comments?.[number] ?? 0;
        const end = Math.min(start + first, count);
        const result: Record<string, unknown> = {
          ...issue(number),
          comments: connection(
            Array.from({ length: end - start }, (_, index) => {
              const c: Record<string, unknown> = comment(number, start + index + 1);
              if (!bodies) delete c.body;
              return c;
            }),
            count,
            end < count,
            end > start ? String(end) : null,
          ),
        };
        if (!bodies) delete result.body;
        return result;
      };
      let response: unknown;
      if (operation === "Repository") {
        response = envelope({ issues: { totalCount: total } });
      } else if (operation === "Issues") {
        const start = Number(variables.after ?? 0);
        const first = Number(query.match(/issues\(states: OPEN, first: (\d+)/)?.[1]);
        const commentFirst = Number(query.match(/comments\(first: (\d+)/)?.[1]);
        const end = Math.min(start + first, total);
        response = envelope({
          issues: connection(
            Array.from({ length: end - start }, (_, index) =>
              node(start + index + 1, 0, commentFirst),
            ),
            total,
            end < total,
            end > start ? String(end) : null,
          ),
        });
      } else {
        const fields: Record<string, unknown> = {};
        for (const match of query.matchAll(/(i\d+): issue\(number: \$(number\d+)\)/g)) {
          const index = match[1].slice(1);
          fields[match[1]] = node(
            Number(variables[match[2]]),
            Number(variables[`after${index}`] ?? 0),
            Number(variables[`first${index}`]),
          );
        }
        response = envelope(fields);
      }
      return options.respond ? options.respond(call, response) : response;
    }),
    search: vi.fn(async () => {
      throw new Error("Search must not be called");
    }),
  };
  return { transport, calls };
}
