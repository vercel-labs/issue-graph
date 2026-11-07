"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clusterColor, type ShowcaseItem, showcase } from "@/lib/showcase";

const WIDTH = 640;
const HEIGHT = 380;
const SLOTS = [
  [150, 132],
  [338, 108],
  [512, 150],
  [236, 290],
  [452, 296],
] as const;
const SPACING = 12.5;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** Timeline in seconds: appear, link, settle into clusters, label. */
const T = { appear: 0.7, link: 1.5, settle: 3.1, label: 3.7 };

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const ease = (v: number) => (v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2);
const span = (t: number, from: number, to: number) => clamp((t - from) / (to - from));

function hash(n: number, salt: number) {
  let x = Math.imul(n, 2654435761) + Math.imul(salt, 40503);
  x = Math.imul(x ^ (x >>> 15), 2246822507);
  x = Math.imul(x ^ (x >>> 13), 3266489909);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function layout(items: ShowcaseItem[]) {
  const byCluster = new Map<number, ShowcaseItem[]>();
  for (const item of items) {
    const list = byCluster.get(item.cluster) ?? [];
    list.push(item);
    byCluster.set(item.cluster, list);
  }
  const target = new Map<number, [number, number]>();
  const scatter = new Map<number, [number, number]>();
  for (const [cluster, members] of byCluster) {
    const [cx, cy] = SLOTS[cluster % SLOTS.length];
    members.forEach((item, i) => {
      const r = SPACING * Math.sqrt(i + 0.6);
      target.set(item.number, [cx + r * Math.cos(i * GOLDEN), cy + r * Math.sin(i * GOLDEN)]);
    });
  }
  for (const item of items)
    scatter.set(item.number, [
      36 + hash(item.number, 1) * (WIDTH - 72),
      40 + hash(item.number, 2) * (HEIGHT - 80),
    ]);
  return { target, scatter };
}

function Mark({ kind, x, y, r }: { kind: ShowcaseItem["kind"]; x: number; y: number; r: number }) {
  if (kind === "PullRequest") {
    const d = r * 1.3;
    return <path d={`M${x},${y - d}L${x + d},${y} ${x},${y + d} ${x - d},${y}Z`} />;
  }
  return <circle cx={x} cy={y} r={r} />;
}

const { target, scatter } = layout(showcase.items);

export function ClusterFigure() {
  const { items, clusters, edges } = showcase;
  const ref = useRef<HTMLElement>(null);
  const frame = useRef(0);
  // Server and no-JS render show the final, clustered state.
  const [t, setT] = useState(T.label + 1);
  const [played, setPlayed] = useState(false);

  const play = useCallback(() => {
    cancelAnimationFrame(frame.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setT(T.label + 1);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = (now - start) / 1000;
      setT(elapsed);
      if (elapsed < T.label + 0.6) frame.current = requestAnimationFrame(tick);
    };
    setT(0);
    frame.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node || played) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        setPlayed(true);
        play();
      },
      { threshold: 0.35 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [play, played]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const appear = ease(span(t, 0, T.appear));
  const link = ease(span(t, T.appear, T.link));
  const settle = ease(span(t, T.link, T.settle));
  const label = ease(span(t, T.settle, T.label));
  const at = (n: number): [number, number] => {
    const [sx, sy] = scatter.get(n) ?? [0, 0];
    const [tx, ty] = target.get(n) ?? [0, 0];
    return [sx + (tx - sx) * settle, sy + (ty - sy) * settle];
  };

  return (
    <figure ref={ref} className="ig-cluster-figure" aria-labelledby="ig-cluster-caption">
      <div className="ig-figure-bar">
        <span className="ig-figure-repo">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 .2a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.5 7.5 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.5 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.8-3.6 4 .3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 .2"
            />
          </svg>
          {showcase.repo}
        </span>
        <span className="ig-figure-meta">
          {showcase.captured} captured · {showcase.clusterCount} clusters
        </span>
        <button
          type="button"
          className="ig-figure-replay"
          onClick={play}
          aria-label="Replay the clustering animation"
        >
          Replay
        </button>
      </div>
      <svg
        className="ig-cluster-canvas"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-labelledby="ig-cluster-caption"
      >
        <title>{`Open issues and pull requests in ${showcase.repo} grouped into ${clusters.length} root-cause clusters`}</title>
        <g className="ig-cluster-edges" style={{ opacity: link * (1 - settle * 0.45) }}>
          {edges.map(([a, b]) => {
            const [x1, y1] = at(a);
            const [x2, y2] = at(b);
            return <line key={`${a}-${b}`} x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
        </g>
        <g className="ig-cluster-halos" style={{ opacity: label }}>
          {clusters.map((cluster, i) => {
            const [cx, cy] = SLOTS[i % SLOTS.length];
            const r = SPACING * Math.sqrt(cluster.members.length + 0.6) + 16;
            return (
              <circle
                key={cluster.label}
                cx={cx}
                cy={cy}
                r={r}
                style={{ "--group-color": clusterColor(i) } as React.CSSProperties}
              />
            );
          })}
        </g>
        <g className="ig-cluster-nodes">
          {items.map((item) => {
            const [x, y] = at(item.number);
            const open = item.state === "OPEN";
            return (
              <g
                key={item.number}
                className="ig-cluster-node"
                data-open={open}
                style={
                  {
                    opacity: appear,
                    "--group-color": clusterColor(item.cluster),
                    "--mix": `${Math.round(settle * 100)}%`,
                  } as React.CSSProperties
                }
              >
                <title>{`#${item.number} · ${item.kind === "PullRequest" ? "PR" : "Issue"} · ${item.title}`}</title>
                <Mark kind={item.kind} x={x} y={y} r={5} />
              </g>
            );
          })}
        </g>
        <g className="ig-cluster-labels" style={{ opacity: label }}>
          {clusters.map((cluster, i) => {
            const [cx, cy] = SLOTS[i % SLOTS.length];
            const r = SPACING * Math.sqrt(cluster.members.length + 0.6) + 16;
            return (
              <text key={cluster.label} x={cx} y={cy - r - 8} textAnchor="middle">
                <tspan style={{ fill: clusterColor(i) }}>● </tspan>
                {cluster.label}
                <tspan className="ig-cluster-count"> {cluster.size}</tspan>
              </text>
            );
          })}
        </g>
      </svg>
      <figcaption id="ig-cluster-caption" className="ig-figure-foot">
        <span>
          {showcase.clusters.length} of the {showcase.clusterCount} root-cause clusters an agent
          proposed for {showcase.repo}, captured {showcase.capturedAt}.
        </span>
        <span className="ig-figure-legend" aria-hidden="true">
          <svg viewBox="-6 -6 12 12" aria-hidden="true">
            <circle r="4" />
          </svg>
          Issue
          <svg viewBox="-6 -6 12 12" aria-hidden="true">
            <path d="M0,-5L5,0 0,5 -5,0Z" />
          </svg>
          PR
        </span>
      </figcaption>
    </figure>
  );
}
