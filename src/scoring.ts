export interface Weights {
  comments: number;
  participants: number;
  reactions: number;
  inboundRefs: number;
  age: number;
}

export interface HeatSignals {
  comments: number;
  participants: number;
  reactions: number;
  inboundRefs: number;
  daysOpen: number;
}

export function createScoringEngine() {
  const keys = ["comments", "participants", "reactions", "inboundRefs", "age"] as const;
  const defaults: Weights = { comments: 3, participants: 2, reactions: 2, inboundRefs: 2, age: 1 };
  function validate(value: unknown): Partial<Weights> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("weights must be an object");
    for (const [key, weight] of Object.entries(value)) {
      if (!keys.includes(key as keyof Weights)) throw new Error(`unknown weight: ${key}`);
      if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 10)
        throw new Error(`${key} weight must be a finite number from 0 to 10`);
    }
    return value as Partial<Weights>;
  }
  function parts(h: HeatSignals, weights: Weights) {
    return [
      h.comments * weights.comments,
      h.participants * weights.participants,
      h.reactions * weights.reactions,
      h.inboundRefs * weights.inboundRefs,
      Math.min(12, h.daysOpen / 30) * weights.age,
    ];
  }
  const score = (h: HeatSignals, weights: Weights = defaults) =>
    Math.round(parts(h, weights).reduce((a, b) => a + b, 0) * 10) / 10;
  const fromArray = (values: number[]): Weights =>
    Object.fromEntries(keys.map((key, i) => [key, values[i]])) as unknown as Weights;
  return { version: 1, keys, defaults, validate, parts, score, fromArray };
}

export const scoring = createScoringEngine();
