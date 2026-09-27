import type { Model } from "./html.js";

export function parseModel(value: unknown): Model {
  if (!value || typeof value !== "object") throw new Error("expected a dashboard model");
  const m = value as Model;
  if (
    !m.provider ||
    typeof m.provider.id !== "string" ||
    !m.provider.id ||
    typeof m.provider.name !== "string" ||
    typeof m.provider.logo !== "string" ||
    typeof m.provider.repoUrl !== "string" ||
    !Array.isArray(m.provider.signals) ||
    typeof m.repo !== "string" ||
    !m.repo ||
    (m.id !== undefined && (typeof m.id !== "string" || !m.id)) ||
    !m.nodes ||
    typeof m.nodes !== "object" ||
    Array.isArray(m.nodes) ||
    !Array.isArray(m.groups) ||
    !Array.isArray(m.cleanup) ||
    !Array.isArray(m.seeds) ||
    !m.stats
  )
    throw new Error("invalid dashboard model");
  const unsafeKey = (key: string) =>
    ["__proto__", "prototype", "constructor", "toString", "valueOf"].includes(key);
  const safeUrl = (url: unknown) =>
    typeof url === "string" && (!url || /^https?:\/\/[^\s]+$/i.test(url));
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((v) => typeof v === "string");
  if (
    m.provider.signals.some(
      (s) =>
        !s ||
        typeof s.id !== "string" ||
        typeof s.label !== "string" ||
        !["warn", "danger"].includes(s.tone),
    ) ||
    (m.provider.views !== undefined &&
      (!strings(m.provider.views) ||
        !m.provider.views.length ||
        m.provider.views.some((v) => !["explore", "impact", "swarm", "rank"].includes(v)))) ||
    (m.provider.metrics !== undefined &&
      (!strings(m.provider.metrics) ||
        m.provider.metrics.some((v) => !["heat", "links", "blast", "depth"].includes(v)))) ||
    (m.provider.filters !== undefined &&
      (!strings(m.provider.filters) ||
        m.provider.filters.some((v) => !["solution", "review"].includes(v)))) ||
    m.cleanup.some((c) => !c || typeof c.text !== "string") ||
    (m.label !== undefined && typeof m.label !== "string") ||
    (m.coverage &&
      (!strings(m.coverage.messages) ||
        (m.coverage.warnings !== undefined && !strings(m.coverage.warnings))))
  )
    throw new Error("invalid dashboard metadata");
  if (!safeUrl(m.provider.repoUrl) || (m.url !== undefined && !safeUrl(m.url)))
    throw new Error("dashboard links must use HTTP or HTTPS");
  if (
    /<\s*[^>]*\b(?:on[\w-]+|href|src|style)\s*=|<\s*[!?]|&(?:#|colon)/i.test(m.provider.logo) ||
    [...m.provider.logo.matchAll(/<\s*\/?\s*([\w:-]+)/g)].some(
      (match) =>
        !["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon"].includes(
          match[1],
        ),
    )
  )
    throw new Error("provider logo must contain static SVG shapes");
  for (const [key, n] of Object.entries(m.nodes)) {
    if (
      unsafeKey(key) ||
      !n ||
      n.key !== key ||
      typeof n.title !== "string" ||
      typeof n.state !== "string" ||
      typeof n.repo !== "string" ||
      !["Issue", "PullRequest", "Unknown"].includes(n.kind) ||
      !Number.isFinite(n.depth) ||
      !Array.isArray(n.out) ||
      !Array.isArray(n.in) ||
      !Array.isArray(n.overlaps) ||
      !strings(n.flags) ||
      !strings(n.mentionedBy) ||
      !Array.isArray(n.external)
    )
      throw new Error(`invalid captured item: ${key}`);
    if (
      [n.identifier, n.stateLabel, n.stateType, n.author, n.verdict, n.read?.error].some(
        (v) => v !== undefined && typeof v !== "string",
      )
    )
      throw new Error(`invalid captured text: ${key}`);
    if (
      n.pr &&
      (![n.pr.review, n.pr.mergeable, n.pr.updated].every((v) => typeof v === "string") ||
        ![n.pr.adds, n.pr.dels, n.pr.files].every(
          (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
        ))
    )
      throw new Error(`invalid pull request metadata: ${key}`);
    if (
      (n.attachments !== undefined && !Array.isArray(n.attachments)) ||
      (n.read &&
        (!Array.isArray(n.read.coverage) ||
          n.read.coverage.some(
            (c) =>
              !c || typeof c.source !== "string" || !Number.isSafeInteger(c.pages) || c.pages < 0,
          )))
    )
      throw new Error(`invalid read metadata: ${key}`);
    if (
      !safeUrl(n.url) ||
      n.external.some((url) => !safeUrl(url)) ||
      n.attachments?.some(
        (link) =>
          !link ||
          !safeUrl(link.url) ||
          (link.title !== undefined && typeof link.title !== "string"),
      )
    )
      throw new Error(`captured links must use HTTP or HTTPS: ${key}`);
    if (
      n.heat &&
      !["comments", "participants", "reactions", "daysOpen", "inboundRefs"].every((k) => {
        const v = n.heat?.[k as keyof NonNullable<typeof n.heat>];
        return typeof v === "number" && Number.isFinite(v) && v >= 0;
      })
    )
      throw new Error(`invalid heat signals: ${key}`);
    if (
      n.out.some(
        (e) => !e || typeof e.to !== "string" || unsafeKey(e.to) || typeof e.via !== "string",
      ) ||
      n.in.some(
        (e) => !e || typeof e.from !== "string" || unsafeKey(e.from) || typeof e.via !== "string",
      ) ||
      n.overlaps.some(
        (o) =>
          !o ||
          typeof o.with !== "string" ||
          unsafeKey(o.with) ||
          !Array.isArray(o.shared) ||
          !o.shared.every((f) => typeof f === "string") ||
          !Number.isInteger(o.significant) ||
          o.significant < 0,
      )
    )
      throw new Error(`invalid captured relationships: ${key}`);
  }
  for (const g of m.groups)
    if (
      !g ||
      typeof g.label !== "string" ||
      typeof g.subtitle !== "string" ||
      !Array.isArray(g.members) ||
      !g.members.every((k) => typeof k === "string" && Object.hasOwn(m.nodes, k))
    )
      throw new Error("invalid captured cluster");
  return m;
}
