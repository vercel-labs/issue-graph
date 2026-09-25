export const docsSlugs = [
  "",
  "get-started",
  "graph",
  "jira",
  "status",
  "backlog",
  "agents",
  "library",
  "security",
  "reference",
  "changelog",
] as const;

export function isSafePathSegments(segments: readonly string[]): boolean {
  return segments.length <= 16 && segments.every((part) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(part));
}

export function docsPath(slugs: readonly string[] = []): string {
  return slugs.length ? `/docs/${slugs.join("/")}` : "/docs";
}

export function markdownPath(pathname: string): string {
  return pathname === "/" ? "/index.md" : `${pathname}.md`;
}

export function isFlightRequest(headers: Headers): boolean {
  return (
    headers.has("rsc") ||
    headers.has("next-router-state-tree") ||
    headers.has("next-router-prefetch") ||
    headers.has("next-router-segment-prefetch") ||
    /\bprefetch\b/i.test(headers.get("purpose") ?? "") ||
    /\bprefetch\b/i.test(headers.get("sec-purpose") ?? "")
  );
}
