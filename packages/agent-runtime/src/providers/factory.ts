import type { ModelSpec, Provider } from "../types";
import { AnthropicProvider } from "./anthropic";
import { GoogleGenerativeAIProvider } from "./google";
import { OpenAICompatibleProvider } from "./openai";
import { OpenAIResponsesProvider } from "./responses";

export function createProvider(spec: ModelSpec): Provider {
  const style = spec.apiStyle;
  if (style === "google_generative_ai" || spec.kind === "google") {
    return new GoogleGenerativeAIProvider(spec);
  }
  if (style === "anthropic_messages" || spec.kind === "anthropic") {
    return new AnthropicProvider(spec);
  }
  if (style === "responses") return new OpenAIResponsesProvider(spec);
  return new OpenAICompatibleProvider(spec);
}
