import data from "./example-showcase.json";

export type ShowcaseKind = "Issue" | "PullRequest";

export interface ShowcaseHeat {
  comments: number;
  participants: number;
  reactions: number;
  inboundRefs: number;
  daysOpen: number;
}

export interface ShowcaseItem {
  number: number;
  kind: ShowcaseKind;
  state: string;
  title: string;
  url: string;
  cluster: number;
  heat: ShowcaseHeat;
}

export interface ShowcaseCluster {
  label: string;
  rootCause: string;
  size: number;
  members: number[];
}

export interface Showcase {
  repo: string;
  command: string;
  capturedAt: string;
  captured: number;
  open: { total: number; issues: number; pullRequests: number };
  clusterCount: number;
  clusters: ShowcaseCluster[];
  items: ShowcaseItem[];
  edges: Array<[number, number]>;
}

export const showcase = data as Showcase;

/** Cluster colors match the dashboard: Geist hue scales in a fixed order (`src/dashboard-view.js`). */
const GROUP_HUES = ["blue", "amber", "purple", "green", "pink", "teal", "red"] as const;
export const clusterColor = (index: number) => {
  const hue = GROUP_HUES[index % GROUP_HUES.length];
  const step = Math.floor(index / GROUP_HUES.length) % 2 ? 900 : 700;
  return `var(--ds-${hue}-${step})`;
};

/** Default Heat weights, identical to the CLI scoring engine (`src/scoring.ts`). */
export const defaultWeights = {
  comments: 3,
  participants: 2,
  reactions: 2,
  inboundRefs: 2,
  age: 1,
};

export type HeatWeights = typeof defaultWeights;

/** Heat as the CLI computes it: weighted signals, age capped at 12 months. */
export function heatScore(h: ShowcaseHeat, w: HeatWeights = defaultWeights): number {
  const total =
    h.comments * w.comments +
    h.participants * w.participants +
    h.reactions * w.reactions +
    h.inboundRefs * w.inboundRefs +
    Math.min(12, h.daysOpen / 30) * w.age;
  return Math.round(total * 10) / 10;
}
