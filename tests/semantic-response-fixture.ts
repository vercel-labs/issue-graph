import type { GatewayEvaluationRequest } from "../src/semantic-types.js";

export type RawEvaluation = {
  model: string;
  answers: Record<string, Record<string, unknown>>;
  usage: { inputTokens: number; outputTokens: number };
  providerMetadata?: { gateway: { cost: string | number; routing?: Record<string, string> } };
};

export function rawEvaluation(
  request: GatewayEvaluationRequest,
  {
    choices = {},
    cost = "0.125",
    choiceConfidence,
  }: {
    choices?: Record<string, string>;
    cost?: string | number | null;
    choiceConfidence?: number;
  } = {},
): RawEvaluation {
  return {
    model: "typesafe-ai/jev",
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => {
        if (question.type === "boolean") return [id, { type: "boolean", probability: 0.2 }];
        if (question.type === "score") {
          return [
            id,
            { type: "score", score: 1.75, probabilities: { "0": 0, "1": 0.25, "2": 0.75, "3": 0 } },
          ];
        }
        const choice = choices[id] ?? (id === "requestType" ? "bug" : "cli");
        const alternate = Object.keys(question.criteria).find((key) => key !== choice);
        return [
          id,
          {
            type: "choice",
            choice,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((key) => [
                key,
                key === choice ? 0.8 : key === alternate ? 0.2 : 0,
              ]),
            ),
            ...(choiceConfidence === undefined ? {} : { confidence: choiceConfidence }),
          },
        ];
      }),
    ),
    usage: { inputTokens: 120, outputTokens: 30 },
    ...(cost === null ? {} : { providerMetadata: { gateway: { cost } } }),
  };
}
