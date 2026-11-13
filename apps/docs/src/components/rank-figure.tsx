"use client";

import { useId, useMemo, useState } from "react";
import {
  clusterColor,
  defaultWeights,
  type HeatWeights,
  heatScore,
  showcase,
} from "@/lib/showcase";

const ROWS = 7;
const ROW_HEIGHT = 46;
const SIGNALS: Array<{ key: keyof HeatWeights; label: string }> = [
  { key: "comments", label: "Comments" },
  { key: "participants", label: "Participants" },
  { key: "reactions", label: "Reactions" },
  { key: "inboundRefs", label: "Inbound references" },
  { key: "age", label: "Age" },
];

export function RankFigure() {
  const [weights, setWeights] = useState<HeatWeights>(defaultWeights);
  const id = useId();
  const open = useMemo(() => showcase.items.filter((item) => item.state === "OPEN"), []);
  const ranked = useMemo(
    () =>
      open
        .map((item) => ({ item, score: heatScore(item.heat, weights) }))
        .sort((a, b) => b.score - a.score || a.item.number - b.item.number),
    [open, weights],
  );
  const position = new Map(ranked.map((entry, index) => [entry.item.number, index]));
  const top = ranked.slice(0, ROWS);
  const max = Math.max(1, top[0]?.score ?? 1);
  const changed = SIGNALS.some(({ key }) => weights[key] !== defaultWeights[key]);

  return (
    <figure className="ig-rank-figure" aria-labelledby={`${id}-caption`}>
      <div className="ig-rank-controls">
        {SIGNALS.map(({ key, label }) => (
          <label key={key} className="ig-rank-slider">
            <span>
              {label}
              <output>{weights[key]}</output>
            </span>
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={weights[key]}
              onChange={(event) =>
                setWeights((current) => ({ ...current, [key]: Number(event.target.value) }))
              }
            />
          </label>
        ))}
        <button
          type="button"
          className="ig-rank-reset"
          disabled={!changed}
          onClick={() => setWeights(defaultWeights)}
        >
          Reset weights
        </button>
      </div>
      <ol
        className="ig-rank-list"
        style={{ height: ROWS * ROW_HEIGHT }}
        aria-label="Open items ranked by Heat"
      >
        {open.map((item) => {
          const index = position.get(item.number) ?? 0;
          const visible = index < ROWS;
          const score = heatScore(item.heat, weights);
          return (
            <li
              key={item.number}
              className="ig-rank-row"
              aria-hidden={!visible}
              style={
                {
                  transform: `translateY(${Math.min(index, ROWS) * ROW_HEIGHT}px)`,
                  opacity: visible ? 1 : 0,
                  "--group-color": clusterColor(item.cluster),
                  "--bar": `${(score / max) * 100}%`,
                } as React.CSSProperties
              }
            >
              <span className="ig-rank-pos">{visible ? index + 1 : ""}</span>
              <span className="ig-rank-body">
                <span className="ig-rank-title">
                  <span className="ig-rank-num">#{item.number}</span> {item.title}
                </span>
                <span className="ig-rank-bar" aria-hidden="true" />
              </span>
              <span className="ig-rank-score">{score}</span>
            </li>
          );
        })}
      </ol>
      <figcaption id={`${id}-caption`} className="ig-figure-foot">
        <span>
          Open items from the {showcase.repo} clusters above, scored in your browser with the CLI's
          Heat formula. Bar colors match their clusters.
        </span>
      </figcaption>
    </figure>
  );
}
