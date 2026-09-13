import type { ProviderApiStyle, ProviderKind } from "./models";

/** Named services shown by the provider setup dialog. The list follows the
 * first-class endpoint catalog used by PI-Desktop, with two local endpoints
 * that are especially useful in a bring-your-own-model app. */
export interface ProviderPreset {
  id: string;
  vendorKey: string;
  name: string;
  baseUrl: string;
  kind: ProviderKind;
  apiStyle: ProviderApiStyle;
  requiresApiKey: boolean;
  aliases?: readonly string[];
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    vendorKey: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    kind: "openai",
    apiStyle: "responses",
    requiresApiKey: true,
  },
  {
    id: "anthropic",
    vendorKey: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    kind: "anthropic",
    apiStyle: "anthropic_messages",
    requiresApiKey: true,
    aliases: ["claude"],
  },
  {
    id: "google",
    vendorKey: "google",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    kind: "google",
    apiStyle: "google_generative_ai",
    requiresApiKey: true,
    aliases: ["gemini"],
  },
  {
    id: "openrouter",
    vendorKey: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
  },
  {
    id: "groq",
    vendorKey: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
  },
  {
    id: "xai",
    vendorKey: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
  },
  {
    id: "mistral",
    vendorKey: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
  },
  {
    id: "togetherai",
    vendorKey: "togetherai",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
    aliases: ["together"],
  },
  {
    id: "fireworks-ai",
    vendorKey: "fireworks-ai",
    name: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
    aliases: ["fireworks"],
  },
  {
    id: "opencode-go",
    vendorKey: "opencode-go",
    name: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    kind: "openai",
    apiStyle: "responses",
    requiresApiKey: true,
  },
  {
    id: "deepseek",
    vendorKey: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
  },
  {
    id: "nvidia",
    vendorKey: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
    aliases: ["nvidia-nim", "nim"],
  },
  {
    id: "zai",
    vendorKey: "zai",
    name: "Z.AI",
    baseUrl: "https://api.z.ai/api/paas/v4",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
  },
  {
    id: "zai-coding-plan",
    vendorKey: "zai-coding-plan",
    name: "Z.AI Coding Plan",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
  },
  {
    id: "alibaba-cn",
    vendorKey: "alibaba-cn",
    name: "Alibaba / DashScope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
    aliases: ["qwen", "dashscope"],
  },
  {
    id: "moonshotai-cn",
    vendorKey: "moonshotai-cn",
    name: "Moonshot AI",
    baseUrl: "https://api.moonshot.cn/v1",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
    aliases: ["kimi", "moonshot"],
  },
  {
    id: "zhipuai",
    vendorKey: "zhipuai",
    name: "Zhipu AI",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
    aliases: ["zhipu", "bigmodel"],
  },
  {
    id: "zhipuai-coding-plan",
    vendorKey: "zhipuai-coding-plan",
    name: "Zhipu AI Coding Plan",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
  },
  {
    id: "siliconflow-cn",
    vendorKey: "siliconflow-cn",
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
  },
  {
    id: "volcengine",
    vendorKey: "volcengine",
    name: "Volcengine Ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
    aliases: ["doubao", "ark"],
  },
  {
    id: "minimax-cn",
    vendorKey: "minimax-cn",
    name: "MiniMax",
    baseUrl: "https://api.minimaxi.com/anthropic/v1",
    kind: "anthropic",
    apiStyle: "anthropic_messages",
    requiresApiKey: true,
  },
  {
    id: "minimax-cn-openai",
    vendorKey: "minimax-cn",
    name: "MiniMax (OpenAI)",
    baseUrl: "https://api.minimaxi.com/v1",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
  },
  {
    id: "xiaomi",
    vendorKey: "xiaomi",
    name: "Xiaomi MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: true,
    aliases: ["mimo"],
  },
  {
    id: "kimi-for-coding",
    vendorKey: "kimi-for-coding",
    name: "Kimi For Coding",
    baseUrl: "https://api.kimi.com/coding/v1",
    kind: "anthropic",
    apiStyle: "anthropic_messages",
    requiresApiKey: true,
    aliases: ["kimi-coding"],
  },
  {
    id: "ollama",
    vendorKey: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: false,
    aliases: ["local"],
  },
  {
    id: "lm-studio",
    vendorKey: "lm-studio",
    name: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    kind: "openai",
    apiStyle: "chat_completions",
    requiresApiKey: false,
    aliases: ["local"],
  },
] as const;

export function providerPreset(id: string | undefined): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function matchProviderPreset(input: {
  vendorKey?: string;
  baseUrl?: string;
}): ProviderPreset | undefined {
  const key = input.vendorKey?.trim().toLowerCase();
  if (key) {
    const byKey = PROVIDER_PRESETS.find(
      (preset) => preset.vendorKey === key || preset.id === key || preset.aliases?.includes(key),
    );
    if (byKey) return byKey;
  }
  const normalized = input.baseUrl?.trim().replace(/\/+$/, "").toLowerCase();
  return normalized
    ? PROVIDER_PRESETS.find((preset) => preset.baseUrl.replace(/\/+$/, "").toLowerCase() === normalized)
    : undefined;
}
