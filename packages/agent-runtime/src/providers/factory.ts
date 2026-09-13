import type { ModelSpec, Provider } from "../types";
import { AnthropicProvider } from "./anthropic";
import { OpenAICompatibleProvider } from "./openai";

export function createProvider(spec: ModelSpec): Provider {
  return spec.kind === "anthropic" ? new AnthropicProvider(spec) : new OpenAICompatibleProvider(spec);
}
