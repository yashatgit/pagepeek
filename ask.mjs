// ask.mjs: answer a plain-English question about a page from screenshots of it.

import Anthropic from "@anthropic-ai/sdk";
import { readEnv } from "./env.mjs";

const MODEL = readEnv("PAGEPEEK_MODEL") ?? "claude-haiku-5-5";

const SYSTEM = `You answer one question about a web page, using only screenshots of it. The
images are consecutive screenfuls of the same page from the top down, overlapping slightly. A
header that stays fixed while scrolling appears in each one.

Answer from what is visible in the screenshots and nothing else. Give the answer alone, with no
lead-in: for "what is the price?" reply "179 AED", not "The price is 179 AED". If the question
asks for a number only, reply with digits only.

Set found to false when the screenshots do not show the answer. That includes a page that is
still loading, an error page, a cookie wall covering the content, and an "access denied",
robot-check or captcha page. In those cases put one short sentence in answer saying what the
screenshots show instead. Never read out or guess the characters of a captcha.`;

const ANSWER_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      found: { type: "boolean" },
      answer: { type: "string" },
    },
    required: ["found", "answer"],
    additionalProperties: false,
  },
};

export const canAsk = () => Boolean(readEnv("ANTHROPIC_API_KEY"));

let client;

// -> {found, answer, model, usage: {input_tokens, output_tokens}}
export async function askAboutScreenshots(jpegs, query) {
  client ??= new Anthropic({ apiKey: readEnv("ANTHROPIC_API_KEY") });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    output_config: { effort: "low", format: ANSWER_FORMAT },
    messages: [
      {
        role: "user",
        content: [
          ...jpegs.map((jpeg) => ({
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") },
          })),
          { type: "text", text: query },
        ],
      },
    ],
  });

  const usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
  if (response.stop_reason === "refusal") {
    return { found: false, answer: "the model declined to answer", model: response.model, usage };
  }
  // Thinking is on by default for this model, so the JSON is not always the first block.
  const text = response.content.find((block) => block.type === "text")?.text;
  if (response.stop_reason === "max_tokens" || !text) throw new Error("model returned no complete answer");
  return { ...JSON.parse(text), model: response.model, usage };
}

// One line a caller can show for a failed model call, without a stack or a key.
export function describeAskError(error) {
  if (error instanceof Anthropic.AuthenticationError) return "Anthropic API rejected the key";
  if (error instanceof Anthropic.RateLimitError) return "Anthropic API rate limit, try again later";
  if (error instanceof Anthropic.APIError) return `Anthropic API error ${error.status ?? ""}: ${error.message}`.trim();
  return String(error?.message || error);
}
