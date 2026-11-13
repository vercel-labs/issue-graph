import {
  type GatewayEvaluationRequest,
  type GatewayQuestion,
  type SemanticAnswer,
  SemanticError,
  type SemanticEvaluation,
  type SemanticEvaluationInput,
  type SemanticTaxonomy,
} from "./semantic-types.js";

const MODEL = "typesafe-ai/jev";

function invalidEvaluation(): never {
  throw new SemanticError(
    "invalid-evaluation",
    "The evaluation does not match the requested evaluation contract.",
    "Review the evaluation schema and fixed model routing before retrying.",
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function has(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function criteriaKeys(question: GatewayQuestion): string[] {
  if (!record(question) || !text(question.instructions)) invalidEvaluation();
  switch (question.type) {
    case "boolean":
      return [];
    case "choice": {
      if (!record(question.criteria)) invalidEvaluation();
      const keys = Object.keys(question.criteria);
      if (keys.length < 2 || !keys.every(text) || !Object.values(question.criteria).every(text)) {
        invalidEvaluation();
      }
      return keys;
    }
    case "score":
      if (
        !Array.isArray(question.criteria) ||
        question.criteria.length < 2 ||
        question.criteria.length > 10 ||
        !Array.from(question.criteria).every(text)
      ) {
        invalidEvaluation();
      }
      return Array.from(question.criteria, (_, index) => String(index));
    default:
      return invalidEvaluation();
  }
}

export function buildEvaluationRequest(input: SemanticEvaluationInput): GatewayEvaluationRequest {
  if (
    !record(input) ||
    input.model !== MODEL ||
    !record(input.state) ||
    !record(input.questions) ||
    Object.keys(input.questions).length === 0
  ) {
    invalidEvaluation();
  }
  const questions = Object.fromEntries(
    Object.entries(input.questions).map(([id, local]) => {
      if (!text(id) || !record(local)) invalidEvaluation();
      let question: GatewayQuestion;
      switch (local.type) {
        case "boolean":
          question = { type: "boolean", instructions: local.instruction };
          break;
        case "choice":
          if (!record(local.options)) invalidEvaluation();
          question = {
            type: "choice",
            instructions: local.instruction,
            criteria: { ...local.options },
          };
          break;
        case "score":
          if (!Array.isArray(local.levels)) invalidEvaluation();
          question = {
            type: "score",
            instructions: local.instruction,
            criteria: [...local.levels],
          };
          break;
        default:
          return invalidEvaluation();
      }
      criteriaKeys(question);
      return [id, question];
    }),
  );
  return {
    model: MODEL,
    state: input.state,
    questions,
    providerOptions: { gateway: { only: ["typesafe-ai"] } },
  };
}

export const SEMANTIC_CACHE_EPOCH = "1";
export const SEMANTIC_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function fingerprintEvaluation(
  request: GatewayEvaluationRequest,
  taxonomy: SemanticTaxonomy | null,
  adapterVersion = "gateway-http-v1",
  cacheEpoch = SEMANTIC_CACHE_EPOCH,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      request,
      taxonomy,
      adapterVersion,
      cacheEpoch,
      projectionVersion: "1",
      rubricVersion: "1",
    }),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => has(value, key));
}

const DISTRIBUTION_EPSILON = 0.001;
const ROUNDING_STEP = 0.01;
const MAX_ROUNDING_DRIFT = 0.02;

function distributionDrift(values: number[]): number {
  return Math.abs(values.reduce((sum, value) => sum + value, 0) - 1);
}

function withinDistributionTolerance(values: number[]): boolean {
  return distributionDrift(values) <= DISTRIBUTION_EPSILON + Number.EPSILON * values.length;
}

function compatibleRoundedDistribution(values: number[]): boolean {
  const epsilon = Number.EPSILON * values.length;
  const halfStep = ROUNDING_STEP / 2;
  return (
    values.every((value) => Math.abs(value * 100 - Math.round(value * 100)) <= 1e-9) &&
    distributionDrift(values) <= Math.min(values.length * halfStep, MAX_ROUNDING_DRIFT) + epsilon &&
    values.reduce((sum, value) => sum + Math.max(0, value - halfStep), 0) <= 1 + epsilon &&
    values.reduce((sum, value) => sum + Math.min(1, value + halfStep), 0) >= 1 - epsilon
  );
}

function validateAnswer(question: GatewayQuestion, raw: unknown): SemanticAnswer {
  const keys = criteriaKeys(question);
  if (!record(raw) || raw.type !== question.type) invalidEvaluation();
  const allowed =
    question.type === "boolean"
      ? ["type", "probability", "confidence"]
      : question.type === "choice"
        ? ["type", "choice", "probabilities", "confidence"]
        : ["type", "score", "probabilities", "confidence"];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) invalidEvaluation();
  let providerConfidence: number | null = null;
  if (has(raw, "confidence")) {
    if (!probability(raw.confidence)) invalidEvaluation();
    providerConfidence = raw.confidence;
  }
  if (question.type === "boolean") {
    if (!has(raw, "probability") || !probability(raw.probability)) invalidEvaluation();
    return { type: "boolean", probability: raw.probability, providerConfidence };
  }
  if (!record(raw.probabilities) || !exactKeys(raw.probabilities, keys)) invalidEvaluation();
  const entries = Object.entries(raw.probabilities).map(([key, value]): [string, number] => {
    if (!probability(value)) invalidEvaluation();
    return [key, value];
  });
  const ranked = entries.map(([, value]) => value).sort((a, b) => b - a);
  if (!withinDistributionTolerance(ranked) && !compatibleRoundedDistribution(ranked)) {
    invalidEvaluation();
  }
  const distribution = {
    probabilities: Object.fromEntries(entries),
    topProbability: ranked[0],
    margin: ranked[0] - ranked[1],
    providerConfidence,
  };
  if (question.type === "choice") {
    if (!has(raw, "choice") || typeof raw.choice !== "string" || !keys.includes(raw.choice)) {
      invalidEvaluation();
    }
    return { type: "choice", choice: raw.choice, ...distribution };
  }
  if (
    !has(raw, "score") ||
    typeof raw.score !== "number" ||
    !Number.isFinite(raw.score) ||
    raw.score < 0 ||
    raw.score > keys.length - 1
  ) {
    invalidEvaluation();
  }
  return { type: "score", score: raw.score, levels: [...question.criteria], ...distribution };
}

function tokens(usage: Record<string, unknown>, key: string): number | null {
  if (!has(usage, key) || usage[key] === null) return null;
  const value = usage[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalidEvaluation();
  return value;
}

function modelIdentity(value: unknown): void {
  if (value !== MODEL) invalidEvaluation();
}

function cost(value: unknown): number {
  if (typeof value === "string") {
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) invalidEvaluation();
    value = Number(value);
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  )
    invalidEvaluation();
  return value;
}

export function validateEvaluation(
  request: GatewayEvaluationRequest,
  raw: unknown,
): SemanticEvaluation {
  try {
    modelIdentity(request.model);
    if (
      !record(request.providerOptions) ||
      !record(request.providerOptions.gateway) ||
      !Array.isArray(request.providerOptions.gateway.only) ||
      request.providerOptions.gateway.only.length !== 1 ||
      request.providerOptions.gateway.only[0] !== "typesafe-ai" ||
      !record(request.questions) ||
      Object.keys(request.questions).length === 0 ||
      !record(raw) ||
      !record(raw.answers) ||
      !exactKeys(raw.answers, Object.keys(request.questions))
    ) {
      invalidEvaluation();
    }
    const rawAnswers = raw.answers;
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        validateAnswer(question, rawAnswers[id]),
      ]),
    );
    let modelResolved: string | null = null;
    if (has(raw, "model")) {
      modelIdentity(raw.model);
      modelResolved = MODEL;
    }
    let tokenUsage: SemanticEvaluation["tokenUsage"] = { inputTokens: null, outputTokens: null };
    if (has(raw, "usage")) {
      if (!record(raw.usage)) invalidEvaluation();
      tokenUsage = {
        inputTokens: tokens(raw.usage, "inputTokens"),
        outputTokens: tokens(raw.usage, "outputTokens"),
      };
    }
    let reportedCostUsd: number | null = null;
    if (has(raw, "providerMetadata")) {
      if (!record(raw.providerMetadata)) invalidEvaluation();
      if (has(raw.providerMetadata, "gateway")) {
        const gateway = raw.providerMetadata.gateway;
        if (!record(gateway)) invalidEvaluation();
        if (has(gateway, "cost")) reportedCostUsd = cost(gateway.cost);
        if (has(gateway, "routing")) {
          if (!record(gateway.routing)) invalidEvaluation();
          for (const key of ["originalModelId", "canonicalSlug"]) {
            if (has(gateway.routing, key)) modelIdentity(gateway.routing[key]);
          }
          for (const key of ["resolvedProvider", "finalProvider"]) {
            if (has(gateway.routing, key) && gateway.routing[key] !== "typesafe-ai") {
              invalidEvaluation();
            }
          }
        }
      }
    }
    return { answers, modelResolved, tokenUsage, reportedCostUsd };
  } catch {
    return invalidEvaluation();
  }
}

export function decideSuggestion(
  evaluation: SemanticEvaluation,
  coverageComplete: boolean,
): {
  outcome: "suggested" | "needs-review";
  reasonCodes: string[];
  answers: Record<string, SemanticAnswer>;
  impactReportedStatus: "applicable" | "not-applicable";
} {
  const requestType = evaluation.answers.requestType;
  if (!has(evaluation.answers, "requestType") || requestType?.type !== "choice") {
    invalidEvaluation();
  }
  const applicable = requestType.choice === "bug";
  const answers = Object.fromEntries(
    Object.entries(evaluation.answers).filter(([id]) => id !== "impactReported" || applicable),
  );
  const reasons = new Set<string>();
  if (!coverageComplete) reasons.add("evidence-incomplete");
  for (const [id, answer] of Object.entries(evaluation.answers)) {
    if (
      answer.type !== "boolean" &&
      !withinDistributionTolerance(Object.values(answer.probabilities))
    ) {
      reasons.add(`${id}-distribution-rounded`);
    }
  }
  for (const id of ["requestType", "component"]) {
    const answer = answers[id];
    if (answer?.type === "choice" && ["multiple", "new", "insufficient"].includes(answer.choice)) {
      reasons.add(id === "requestType" ? "request-type-exception" : "component-exception");
    }
  }
  for (const answer of Object.values(answers)) {
    if (answer.type === "choice" || answer.type === "score") {
      const top = Math.max(...Object.values(answer.probabilities));
      if (Object.values(answer.probabilities).filter((value) => value === top).length > 1) {
        reasons.add("tied-top-probability");
      }
      if (answer.type === "choice" && answer.probabilities[answer.choice] !== top) {
        reasons.add("choice-probability-mismatch");
      }
      if (answer.type === "score") {
        const mean = Object.entries(answer.probabilities).reduce(
          (sum, [index, value]) => sum + Number(index) * value,
          0,
        );
        if (Math.abs(answer.score - mean) > 0.05 + Number.EPSILON * answer.levels.length) {
          reasons.add("score-probability-mismatch");
        }
      }
    }
  }
  const regression = answers.regressionReported;
  if (!applicable && regression?.type === "boolean" && regression.probability > 0.5) {
    reasons.add("signal-type-conflict");
  }
  return {
    outcome: reasons.size ? "needs-review" : "suggested",
    reasonCodes: [...reasons],
    answers,
    impactReportedStatus: applicable ? "applicable" : "not-applicable",
  };
}
