import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildEvaluationInput } from "./semantic.js";
import {
  buildEvaluationRequest,
  decideSuggestion,
  fingerprintEvaluation,
  validateEvaluation,
} from "./semantic-evaluation.js";
import {
  type GatewayEvaluationRequest,
  SemanticError,
  type SemanticEvaluationInput,
  type SemanticEvidence,
  type SemanticTaxonomy,
} from "./semantic-types.js";

const taxonomy: SemanticTaxonomy = {
  schemaVersion: 1,
  repo: "sample/public-repo",
  version: "synthetic-1",
  components: [
    { id: "ui", description: "User interface" },
    { id: "api", description: "API" },
  ],
};

function evidence(): SemanticEvidence {
  return {
    key: "sample/public-repo#1",
    id: "synthetic-issue",
    url: "https://github.com/sample/public-repo/issues/1",
    number: 1,
    state: "OPEN",
    title: "Synthetic report",
    body: "A workflow stopped working.",
    updatedAt: "2026-09-21T00:00:00Z",
    comments: [
      {
        id: "synthetic-comment",
        url: "https://github.com/sample/public-repo/issues/1#issuecomment-1",
        author: null,
        updatedAt: "2026-09-21T00:00:00Z",
        body: "Synthetic corroborating evidence.",
      },
    ],
    commentsCoverage: {
      captured: 1,
      total: 1,
      hasNextPage: false,
      pages: 1,
      complete: true,
      reasonCodes: [],
    },
    captureWindow: {
      startedAt: "2026-09-21T00:00:00Z",
      completedAt: "2026-09-21T00:01:00Z",
    },
    status: "ready",
    reasonCodes: [],
  };
}

const input = () => buildEvaluationInput(evidence(), taxonomy);
const request = () => buildEvaluationRequest(input());

function response(req = request()) {
  const answers: Record<string, Record<string, unknown>> = Object.fromEntries(
    Object.entries(req.questions).map(([id, question]) => {
      if (question.type === "boolean") return [id, { type: "boolean", probability: 0.98 }];
      if (question.type === "score") {
        return [
          id,
          {
            type: "score",
            score: 2.97,
            probabilities: { "0": 0, "1": 0.01, "2": 0.01, "3": 0.98 },
          },
        ];
      }
      const selected = Object.keys(question.criteria)[0];
      return [
        id,
        {
          type: "choice",
          choice: selected,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((key) => [key, key === selected ? 1 : 0]),
          ),
        },
      ];
    }),
  );
  return {
    model: "typesafe-ai/jev",
    answers,
    usage: { inputTokens: 123, outputTokens: 45 },
    providerMetadata: {
      gateway: {
        routing: {
          originalModelId: "typesafe-ai/jev",
          resolvedProvider: "typesafe-ai",
          canonicalSlug: "typesafe-ai/jev",
          finalProvider: "typesafe-ai",
        },
        cost: "0.00001155",
        marketCost: "0.00002",
        generationId: "synthetic-generation",
      },
    },
  };
}

function expectInvalid(run: () => unknown) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SemanticError);
  expect(caught).toMatchObject({
    code: "invalid-evaluation",
    message: "The evaluation does not match the requested evaluation contract.",
    hint: "Review the evaluation schema and fixed model routing before retrying.",
  });
  expect(String(caught)).not.toContain("SECRET");
  expect(JSON.stringify(caught)).not.toContain("SECRET");
}

function select(raw: ReturnType<typeof response>, id: string, choice: string) {
  const answer = raw.answers[id];
  answer.choice = choice;
  answer.probabilities = Object.fromEntries(
    Object.keys(answer.probabilities as Record<string, number>).map((key) => [
      key,
      key === choice ? 1 : 0,
    ]),
  );
}

function policy(raw = response(), complete = true) {
  return decideSuggestion(validateEvaluation(request(), raw), complete);
}

describe("evaluation wire request", () => {
  test("maps exact wire names and fixed routing without claims or mutation", () => {
    const local = input();
    const before = structuredClone(local);
    const wire = buildEvaluationRequest(local);
    expect(wire).toEqual({
      model: "typesafe-ai/jev",
      state: local.state,
      questions: Object.fromEntries(
        Object.entries(local.questions).map(([id, question]) => [
          id,
          {
            type: question.type,
            instructions: question.instruction,
            ...(question.type === "choice" ? { criteria: question.options } : {}),
            ...(question.type === "score" ? { criteria: question.levels } : {}),
          },
        ]),
      ),
      providerOptions: { gateway: { only: ["typesafe-ai"] } },
    });
    expect(wire.questions.regressionReported).not.toHaveProperty("criteria");
    expect(JSON.stringify(wire)).not.toContain('"instruction":');
    expect(JSON.stringify(wire)).not.toContain('"zdr"');
    expect(local).toEqual(before);
  });

  test.each([
    null,
    { type: "unknown", instruction: "SECRET" },
    { type: "boolean", instruction: 1 },
    { type: "boolean", instruction: " " },
    { type: "choice", instruction: "x", options: {} },
    { type: "choice", instruction: "x", options: { a: "one" } },
    { type: "choice", instruction: "x", options: ["one", "two"] },
    { type: "choice", instruction: "x", options: { a: "one", b: 2 } },
    { type: "choice", instruction: "x", options: { a: "one", "": "two" } },
    { type: "score", instruction: "x", levels: ["one"] },
    { type: "score", instruction: "x", levels: Array(11).fill("level") },
    { type: "score", instruction: "x", levels: ["one", null] },
    { type: "score", instruction: "x", levels: Array(2) },
    { type: "score", instruction: "x", levels: { "0": "one", "1": "two" } },
  ])("rejects invalid local questions %#", (question) => {
    expectInvalid(() =>
      buildEvaluationRequest({
        ...input(),
        questions: { test: question },
      } as SemanticEvaluationInput),
    );
  });

  test.each([2, 10])("accepts %i ordered score criteria", (count) => {
    const levels = Array.from({ length: count }, (_, index) => `Level ${index}`);
    const wire = buildEvaluationRequest({
      ...input(),
      questions: { test: { type: "score", instruction: "Score", levels } },
    });
    expect(wire.questions.test).toEqual({ type: "score", instructions: "Score", criteria: levels });
    const probabilities = Object.fromEntries(
      levels.map((_, index) => [String(index), index === 0 ? 1 : 0]),
    );
    expect(
      validateEvaluation(wire, { answers: { test: { type: "score", score: 0, probabilities } } })
        .answers.test,
    ).toMatchObject({ levels, probabilities });
  });

  test("rejects switched models, empty questions and nonobject state", () => {
    expectInvalid(() => buildEvaluationRequest({ ...input(), model: "SECRET/other" }));
    expectInvalid(() => buildEvaluationRequest({ ...input(), questions: {} }));
    expectInvalid(() =>
      buildEvaluationRequest({ ...input(), state: null } as unknown as SemanticEvaluationInput),
    );
  });
});

describe("evaluation validation", () => {
  test("validates all types and preserves distributions, confidence and provenance", () => {
    const raw = response();
    for (const answer of Object.values(raw.answers)) answer.confidence = 0.12;
    const before = structuredClone(raw);
    const result = validateEvaluation(request(), raw);
    expect(result).toMatchObject({
      modelResolved: "typesafe-ai/jev",
      reportedCostUsd: 0.00001155,
      tokenUsage: { inputTokens: 123, outputTokens: 45 },
      answers: {
        requestType: {
          type: "choice",
          choice: "bug",
          topProbability: 1,
          margin: 1,
          providerConfidence: 0.12,
        },
        regressionReported: { type: "boolean", probability: 0.98, providerConfidence: 0.12 },
        impactReported: {
          type: "score",
          score: 2.97,
          topProbability: 0.98,
          margin: 0.97,
          providerConfidence: 0.12,
        },
      },
    });
    expect(result.answers.impactReported).toMatchObject({
      probabilities: raw.answers.impactReported.probabilities,
    });
    expect(raw).toEqual(before);
    expect(result).not.toHaveProperty("providerMetadata");
    expect(result).not.toHaveProperty("weightsVersion");
  });

  test("missing metadata remains unknown, never zero or an invented resolved model", () => {
    const result = validateEvaluation(request(), { answers: response().answers });
    expect(result).toMatchObject({
      modelResolved: null,
      reportedCostUsd: null,
      tokenUsage: { inputTokens: null, outputTokens: null },
    });
    expect(result.answers.regressionReported).toMatchObject({ providerConfidence: null });
  });

  test.each([
    null,
    [],
    {},
    { answers: [] },
    { answers: null },
  ])("rejects malformed envelopes %#", (raw) => {
    expectInvalid(() => validateEvaluation(request(), raw));
  });

  test.each(["missing", "extra"])("rejects %s answer IDs", (change) => {
    const raw = response();
    if (change === "missing") delete raw.answers.regressionReported;
    else raw.answers.SECRET = { type: "boolean", probability: 1 };
    expectInvalid(() => validateEvaluation(request(), raw));
  });

  test.each([
    { type: "boolean", probability: 0.5 },
    { type: "choice", choice: "SECRET", probabilities: {} },
    { type: "choice", choice: 1, probabilities: {} },
    { type: "choice", choice: "bug", probabilities: [] },
    { type: "choice", choice: "bug" },
    null,
    "SECRET",
  ])("rejects wrong choice types %#", (answer) => {
    expectInvalid(() =>
      validateEvaluation(request(), {
        ...response(),
        answers: { ...response().answers, requestType: answer },
      }),
    );
  });

  test.each(["missing", "extra", "renamed"])("requires every exact enum key: %s", (change) => {
    const raw = response();
    const probabilities = raw.answers.requestType.probabilities as Record<string, number>;
    if (change !== "extra") delete probabilities.feature;
    if (change !== "missing") probabilities.SECRET = 0;
    expectInvalid(() => validateEvaluation(request(), raw));
  });

  test.each([
    NaN,
    Infinity,
    -Infinity,
    -0.01,
    1.01,
    "0.98",
    null,
    undefined,
  ])("rejects invalid probabilities and confidence %#", (value) => {
    for (const id of ["requestType", "impactReported", "regressionReported"]) {
      const raw = response();
      if (id === "regressionReported") raw.answers[id].probability = value;
      else
        (raw.answers[id].probabilities as Record<string, unknown>)[
          id === "requestType" ? "bug" : "3"
        ] = value;
      expectInvalid(() => validateEvaluation(request(), raw));
      const confidence = response();
      confidence.answers[id].confidence = value;
      expectInvalid(() => validateEvaluation(request(), confidence));
    }
  });

  test.each([0, 0.998, 0.5])("rejects distributions whose sum is %s", (sum) => {
    const raw = response();
    (raw.answers.requestType.probabilities as Record<string, number>).bug = sum;
    expectInvalid(() => validateEvaluation(request(), raw));
  });

  test("replays the wterm55 response without changing its rounded score distribution", () => {
    const raw = JSON.parse(
      readFileSync(
        new URL("../tests/fixtures/classify/jev-rounded-score.json", import.meta.url),
        "utf8",
      ),
    );
    const before = structuredClone(raw);
    const req = buildEvaluationRequest(buildEvaluationInput(evidence(), null));
    const result = validateEvaluation(req, raw);
    expect(result.answers.impactReported).toMatchObject({
      score: 2.23,
      probabilities: { "0": 0, "1": 0.05, "2": 0.66, "3": 0.28 },
      topProbability: 0.66,
    });
    expect(decideSuggestion(result, true)).toMatchObject({
      outcome: "needs-review",
      reasonCodes: ["impactReported-distribution-rounded"],
    });
    expect(raw).toEqual(before);
  });

  test.each([
    [0.24, 0.25, 0.25, 0.25],
    [0.24, 0.24, 0.25, 0.25],
    [0.26, 0.25, 0.25, 0.25],
    [0.26, 0.26, 0.25, 0.25],
  ])("keeps a bounded two-decimal score distribution for review: %j", (...values) => {
    const raw = response();
    const probabilities = Object.fromEntries(values.map((value, index) => [String(index), value]));
    raw.answers.impactReported.probabilities = probabilities;
    raw.answers.impactReported.score = values.reduce((sum, value, index) => sum + value * index, 0);
    const result = validateEvaluation(request(), raw);
    expect(result.answers.impactReported).toMatchObject({ probabilities });
    expect(decideSuggestion(result, true)).toMatchObject({ outcome: "needs-review" });
    expect(decideSuggestion(result, true).reasonCodes).toContain(
      "impactReported-distribution-rounded",
    );
  });

  test.each([0.98, 0.99])("flags rounded choice mass %s without changing it", (mass) => {
    const raw = response();
    (raw.answers.requestType.probabilities as Record<string, number>).bug = mass;
    const result = validateEvaluation(request(), raw);
    expect(result.answers.requestType).toMatchObject({
      topProbability: mass,
      probabilities: { bug: mass },
    });
    expect(decideSuggestion(result, true).reasonCodes).toContain(
      "requestType-distribution-rounded",
    );
  });

  test.each([
    [0.23, 0.24, 0.25, 0.25],
    [0.27, 0.26, 0.25, 0.25],
    [0.241, 0.249, 0.25, 0.25],
    [0.25, 0.25, 0.25, 0.248],
    [0, 0, 0, 0],
    [1, 1, 1, 1],
  ])("rejects unbounded or non-quantized score mass: %j", (...values) => {
    const raw = response();
    raw.answers.impactReported.probabilities = Object.fromEntries(
      values.map((value, index) => [String(index), value]),
    );
    expectInvalid(() => validateEvaluation(request(), raw));
  });

  test("does not widen the mass bound with a large choice catalog", () => {
    const raw = response();
    (raw.answers.requestType.probabilities as Record<string, number>).bug = 0.97;
    expectInvalid(() => validateEvaluation(request(), raw));
  });

  test("reports rounding even when impact is not applicable", () => {
    const raw = response();
    select(raw, "requestType", "feature");
    raw.answers.regressionReported.probability = 0.1;
    raw.answers.impactReported = {
      type: "score",
      score: 0,
      probabilities: { "0": 0.99, "1": 0, "2": 0, "3": 0 },
    };
    expect(policy(raw)).toMatchObject({
      outcome: "needs-review",
      impactReportedStatus: "not-applicable",
      reasonCodes: ["impactReported-distribution-rounded"],
    });
  });

  test("accepts tolerance without normalization", () => {
    const raw = response();
    const probabilities = raw.answers.requestType.probabilities as Record<string, number>;
    probabilities.bug = 0.999;
    const result = validateEvaluation(request(), raw);
    expect(result.answers.requestType).toMatchObject({
      probabilities,
      topProbability: 0.999,
      margin: 0.999,
    });
  });

  test.each([
    NaN,
    Infinity,
    -1,
    3.01,
    "2.97",
    null,
    undefined,
  ])("rejects invalid scores %#", (score) => {
    const raw = response();
    raw.answers.impactReported.score = score;
    expectInvalid(() => validateEvaluation(request(), raw));
  });

  test.each([
    { "0": 0, "1": 0, "3": 1 },
    { "0": 0, "1": 0, "2": 0, "3": 1, "4": 0 },
    { "0": 0, "1": 0, "2": 0, "03": 1 },
    { low: 0, medium: 0, high: 0, severe: 1 },
  ])("requires exact numeric score rungs %#", (probabilities) => {
    const raw = response();
    raw.answers.impactReported.probabilities = probabilities;
    expectInvalid(() => validateEvaluation(request(), raw));
  });

  test.each([
    "requestType",
    "regressionReported",
    "impactReported",
  ])("rejects additive answer prose for %s", (id) => {
    const raw = response();
    raw.answers[id].reasoning = "SECRET";
    expectInvalid(() => validateEvaluation(request(), raw));
  });

  test.each([
    0,
    0.00001155,
    "0",
    "0.00001155",
    "12.50",
  ])("accepts nonnegative plain decimal costs %#", (value) => {
    const raw = response();
    expect(
      validateEvaluation(request(), { ...raw, providerMetadata: { gateway: { cost: value } } })
        .reportedCostUsd,
    ).toBe(Number(value));
  });

  test.each([
    null,
    undefined,
    NaN,
    Infinity,
    -1,
    "-1",
    "0x10",
    "1e-6",
    " 1",
    "1 ",
    "",
    ".5",
    "1.",
    "01",
    "+1",
    "Infinity",
    "9".repeat(400),
    {},
    true,
  ])("rejects malformed costs %#", (value) => {
    expectInvalid(() =>
      validateEvaluation(request(), {
        ...response(),
        providerMetadata: { gateway: { cost: value } },
      }),
    );
  });

  test("unknown additive metadata is discarded and market cost is not reported cost", () => {
    const raw = {
      ...response(),
      usage: { unknown: "SECRET" },
      providerMetadata: {
        other: "SECRET",
        gateway: { marketCost: "0.1", generationId: "SECRET", unknown: { error: "SECRET" } },
      },
      error: "SECRET",
      other: "SECRET",
    };
    const result = validateEvaluation(request(), raw);
    expect(result.reportedCostUsd).toBeNull();
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  test.each([
    {},
    { inputTokens: null, outputTokens: null },
    { inputTokens: 0 },
    { outputTokens: 2, totalTokens: "discarded" },
  ])("accepts missing or null known usage fields %#", (usage) => {
    const result = validateEvaluation(request(), { ...response(), usage });
    expect(result.tokenUsage).toEqual({
      inputTokens: "inputTokens" in usage ? usage.inputTokens : null,
      outputTokens: "outputTokens" in usage ? usage.outputTokens : null,
    });
  });

  test.each([
    null,
    [],
    "SECRET",
    { inputTokens: "1" },
    { outputTokens: -1 },
    { inputTokens: 1.5 },
    { outputTokens: Infinity },
    { inputTokens: NaN },
    { outputTokens: undefined },
    { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects malformed usage %#", (usage) => {
    expectInvalid(() => validateEvaluation(request(), { ...response(), usage }));
  });

  test.each([
    null,
    [],
    "SECRET",
    { gateway: null },
    { gateway: [] },
    { gateway: "SECRET" },
    { gateway: { routing: null } },
    { gateway: { routing: [] } },
    { gateway: { routing: "SECRET" } },
  ])("rejects malformed relevant metadata %#", (providerMetadata) => {
    expectInvalid(() => validateEvaluation(request(), { ...response(), providerMetadata }));
  });

  test.each([
    null,
    undefined,
    1,
    "SECRET",
    "other/jev",
    "typesafe-ai/other",
    "typesafe-ai/jev-v2",
    "typesafe-ai/jev\nSECRET",
    "x".repeat(1000),
  ])("rejects unsafe or switched model identities %#", (model) => {
    expectInvalid(() => validateEvaluation(request(), { ...response(), model }));
  });

  test.each([
    "originalModelId",
    "canonicalSlug",
    "resolvedProvider",
    "finalProvider",
  ])("rejects mismatched or malformed routing field %s", (key) => {
    for (const value of ["SECRET", null, 42, undefined]) {
      const raw = response();
      expectInvalid(() =>
        validateEvaluation(request(), {
          ...raw,
          providerMetadata: {
            gateway: { routing: { ...raw.providerMetadata.gateway.routing, [key]: value } },
          },
        }),
      );
    }
  });

  test("routing cannot invent a resolved model when the envelope omits it", () => {
    const { model: _model, ...raw } = response();
    expect(validateEvaluation(request(), raw).modelResolved).toBeNull();
  });

  test("request routing cannot allow a fallback", () => {
    const req = request();
    const changed = {
      ...req,
      providerOptions: { gateway: { only: ["typesafe-ai", "other"] } },
    } as unknown as GatewayEvaluationRequest;
    expectInvalid(() => validateEvaluation(changed, response()));
  });

  test("unexpected runtime errors cannot echo provider values", () => {
    expectInvalid(() =>
      validateEvaluation(request(), {
        get answers() {
          throw new Error("SECRET");
        },
      }),
    );
  });

  test("special own enum keys are preserved without prototype pollution", () => {
    const req = buildEvaluationRequest({
      ...input(),
      questions: {
        test: {
          type: "choice",
          instruction: "Choose",
          options: JSON.parse('{"__proto__":"first","constructor":"second"}'),
        },
      },
    });
    const probabilities = JSON.parse('{"__proto__":0.9,"constructor":0.1}');
    const result = validateEvaluation(req, {
      answers: { test: { type: "choice", choice: "__proto__", probabilities } },
    });
    expect(result.answers.test).toMatchObject({ probabilities, topProbability: 0.9, margin: 0.8 });
    expect(
      Object.hasOwn((result.answers.test as { probabilities: object }).probabilities, "__proto__"),
    ).toBe(true);
  });
});

describe("suggestion policy", () => {
  test("consistent answers are only suggested, never autoaccepted", () => {
    const result = policy();
    expect(result).toMatchObject({
      outcome: "suggested",
      reasonCodes: [],
      impactReportedStatus: "applicable",
    });
    expect(result.answers).toHaveProperty("impactReported");
    expect(result).not.toHaveProperty("reviewRequired");
    expect(result).not.toHaveProperty("accepted");
    expect(result).not.toHaveProperty("reasoning");
  });

  test.each(["multiple", "insufficient"])("reviews request type exception %s", (choice) => {
    const raw = response();
    select(raw, "requestType", choice);
    expect(policy(raw)).toMatchObject({
      outcome: "needs-review",
      reasonCodes: expect.arrayContaining(["request-type-exception"]),
    });
  });

  test.each(["multiple", "new", "insufficient"])("reviews component exception %s", (choice) => {
    const raw = response();
    select(raw, "component", choice);
    expect(policy(raw)).toMatchObject({
      outcome: "needs-review",
      reasonCodes: ["component-exception"],
    });
  });

  test("reviews incomplete coverage", () => {
    expect(policy(response(), false)).toMatchObject({
      outcome: "needs-review",
      reasonCodes: ["evidence-incomplete"],
    });
  });

  test.each([
    "requestType",
    "component",
  ])("reviews ties and choice mismatch in %s without parser rejection", (id) => {
    const raw = response();
    const probabilities = raw.answers[id].probabilities as Record<string, number>;
    const keys = Object.keys(probabilities);
    probabilities[keys[0]] = 0.5;
    probabilities[keys[1]] = 0.5;
    expect(policy(raw)).toMatchObject({
      outcome: "needs-review",
      reasonCodes: ["tied-top-probability"],
    });
    probabilities[keys[0]] = 0.1;
    probabilities[keys[1]] = 0.9;
    expect(policy(raw)).toMatchObject({
      outcome: "needs-review",
      reasonCodes: ["choice-probability-mismatch"],
    });
  });

  test("reviews score ties and weighted-mean mismatch, not low confidence", () => {
    const raw = response();
    raw.answers.impactReported = {
      type: "score",
      score: 2.5,
      probabilities: { "0": 0, "1": 0, "2": 0.5, "3": 0.5 },
    };
    expect(policy(raw).reasonCodes).toEqual(["tied-top-probability"]);
    raw.answers.impactReported.score = 2;
    expect(policy(raw).reasonCodes).toEqual(["tied-top-probability", "score-probability-mismatch"]);
  });

  test("score tolerance includes 0.05 and excludes greater differences", () => {
    const raw = response();
    raw.answers.impactReported = {
      type: "score",
      score: 2.05,
      probabilities: { "0": 0, "1": 0, "2": 1, "3": 0 },
    };
    expect(policy(raw).outcome).toBe("suggested");
    raw.answers.impactReported.score = 2.05001;
    expect(policy(raw).reasonCodes).toContain("score-probability-mismatch");
  });

  test("no generic confidence threshold applies", () => {
    const raw = response();
    for (const answer of Object.values(raw.answers)) answer.confidence = 0;
    raw.answers.component.probabilities = {
      ui: 0.21,
      api: 0.2,
      multiple: 0.2,
      new: 0.2,
      insufficient: 0.19,
    };
    expect(policy(raw).outcome).toBe("suggested");
  });

  test.each([
    "feature",
    "question",
    "documentation",
    "maintenance",
    "multiple",
    "insufficient",
  ])("omits impact for non-bug %s without mutating evaluation", (choice) => {
    const raw = response();
    select(raw, "requestType", choice);
    raw.answers.regressionReported.probability = 0.5;
    const evaluation = validateEvaluation(request(), raw);
    const before = structuredClone(evaluation);
    const result = decideSuggestion(evaluation, true);
    expect(result.impactReportedStatus).toBe("not-applicable");
    expect(result.answers).not.toHaveProperty("impactReported");
    expect(evaluation).toEqual(before);
    expect(result.reasonCodes).not.toContain("signal-type-conflict");
    raw.answers.regressionReported.probability = 0.5001;
    expect(policy(raw).reasonCodes).toContain("signal-type-conflict");
  });

  test("irrelevant non-bug impact does not drive review", () => {
    const raw = response();
    select(raw, "requestType", "feature");
    raw.answers.regressionReported.probability = 0;
    raw.answers.impactReported.score = 0;
    expect(policy(raw)).toMatchObject({
      outcome: "suggested",
      impactReportedStatus: "not-applicable",
    });
  });

  test("requires the standard requestType choice after validation", () => {
    const evaluation = validateEvaluation(request(), response());
    delete evaluation.answers.requestType;
    expectInvalid(() => decideSuggestion(evaluation, true));
    evaluation.answers.requestType = { type: "boolean", probability: 1, providerConfidence: null };
    expectInvalid(() => decideSuggestion(evaluation, true));
  });
});

describe("evaluation fingerprint", () => {
  test("hashes the complete versioned envelope using SHA-256", async () => {
    const wire = request();
    const expected = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify({
          request: wire,
          taxonomy,
          adapterVersion: "gateway-http-v1",
          cacheEpoch: "1",
          projectionVersion: "1",
          rubricVersion: "1",
        }),
      ),
    );
    const hash = await fingerprintEvaluation(wire, taxonomy);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(
      Array.from(new Uint8Array(expected), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
    expect(hash).toBe(
      await fingerprintEvaluation(structuredClone(wire), structuredClone(taxonomy)),
    );
  });

  test.each([
    "body",
    "comment",
    "comment-version",
    "model-version",
    "question",
    "routing",
    "coverage",
    "adapter",
    "epoch",
    "taxonomy-version",
    "taxonomy-description",
    "taxonomy-null",
  ])("invalidates on %s", async (change) => {
    const wire = request();
    const tax = structuredClone(taxonomy);
    const original = await fingerprintEvaluation(wire, tax);
    if (change === "body") wire.state.issue.body += " changed";
    if (change === "comment") wire.state.issue.comments[0].body += " changed";
    if (change === "comment-version")
      wire.state.issue.comments[0].updatedAt = "2027-01-01T00:00:00Z";
    if (change === "model-version") Object.assign(wire, { model: "typesafe-ai/jev-v2" });
    if (change === "question") wire.questions.requestType.instructions += " changed";
    if (change === "routing") Object.assign(wire.providerOptions.gateway, { only: ["other"] });
    if (change === "coverage") wire.state.issue.commentsCoverage.complete = false;
    if (change === "taxonomy-version") tax.version = "synthetic-2";
    if (change === "taxonomy-description") tax.components[0].description += " changed";
    expect(
      await fingerprintEvaluation(
        wire,
        change === "taxonomy-null" ? null : tax,
        change === "adapter" ? "gateway-http-v2" : "gateway-http-v1",
        change === "epoch" ? "2" : "1",
      ),
    ).not.toBe(original);
  });

  test("projection omits capture time, policy, pages and cursors, not evidence timestamps", async () => {
    const original = evidence();
    const changed = structuredClone(original);
    changed.captureWindow = {
      startedAt: "2027-01-01T00:00:00Z",
      completedAt: "2027-01-02T00:00:00Z",
    };
    changed.commentsCoverage.pages = 4;
    changed.reasonCodes = ["policy-changed"];
    Object.assign(changed, { policyVersion: "2", cursor: "next", evaluatedAt: "later" });
    Object.assign(changed.commentsCoverage, { endCursor: "next" });
    const first = buildEvaluationRequest(buildEvaluationInput(original, taxonomy));
    const second = buildEvaluationRequest(buildEvaluationInput(changed, taxonomy));
    expect(await fingerprintEvaluation(first, taxonomy)).toBe(
      await fingerprintEvaluation(second, taxonomy),
    );
    second.state.issue.updatedAt = "2027-01-01T00:00:00Z";
    expect(await fingerprintEvaluation(first, taxonomy)).not.toBe(
      await fingerprintEvaluation(second, taxonomy),
    );
  });
});
