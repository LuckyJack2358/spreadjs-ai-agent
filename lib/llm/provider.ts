/**
 * LLM Provider 统一路由。
 *
 * 路由逻辑（按优先级）：
 *   1. LLM_PROVIDER env 强制覆盖 → 直接使用指定 provider
 *   2. 模型名匹配 + baseURL 是官方地址 → 走原生 SDK（Anthropic / DeepSeek / Google）
 *   3. 模型名匹配但 baseURL 是第三方平台 → 走 OpenAI 兼容路径 + thinking 归一化
 *   4. 其他模型 → OpenAI 兼容路径
 *
 * 关键设计：第三方平台（硅基流动、百炼等）即使代理了 DeepSeek / Claude，
 * 其 API 协议是 OpenAI 兼容而非原生，必须走 openai 路径。
 * 仅当 baseURL 为空（使用 SDK 默认地址）或明确是官方域名时才走原生 SDK。
 *
 * env：
 *   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
 *   LLM_PROVIDER=anthropic|deepseek|google|openai  — 强制覆盖 provider 检测
 *   LLM_REASONING=true|false                       — 强制关闭 thinking 归一化（仅 openai 路径）
 *   VISION_API_KEY / VISION_BASE_URL / VISION_MODEL  — 独立视觉模型（仅主模型不支持图片时启用）
 */

import { extractReasoningMiddleware, wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createReasoningFetch } from "@/lib/agent/reasoning-fetch";
import { fixToolArgsMiddleware } from "@/lib/agent/fix-tool-args-middleware";

// ─── Provider 检测 ──────────────────────────────────────

export type ProviderType = "anthropic" | "deepseek" | "google" | "openai";

/** 模型名 → provider 映射（仅用于官方地址场景） */
const PROVIDER_PATTERNS: Array<[RegExp, ProviderType]> = [
	[/\bclaude\b/i, "anthropic"],
	[/\bdeepseek\b/i, "deepseek"],
	[/\bgemini\b/i, "google"],
	[/\bmodels\/gemini\b/i, "google"],
];

/**
 * 各原生 SDK 对应的官方域名。
 * baseURL 包含这些域名时才走原生 SDK，否则走 openai 兼容路径。
 * 不含 baseURL（undefined）视为使用 SDK 默认官方地址。
 */
const OFFICIAL_DOMAINS: Record<ProviderType, RegExp[]> = {
	anthropic: [/api\.anthropic\.com/i, /gcapi\.cn/i],
	deepseek: [/api\.deepseek\.com/i],
	google: [/generativelanguage\.googleapis\.com/i, /aiplatform\.googleapis\.com/i],
	openai: [],
};

/** 检查 baseURL 是否是该 provider 的官方地址 */
function isOfficialURL(baseURL: string | undefined, provider: ProviderType): boolean {
	if (!baseURL) return true; // 无 baseURL → 使用 SDK 默认地址
	return OFFICIAL_DOMAINS[provider].some(p => p.test(baseURL));
}

/**
 * 从模型名 + baseURL 推断 provider 类型。
 *
 * LLM_PROVIDER env 可强制覆盖（信任用户判断）。
 * 否则：模型名匹配 + baseURL 是官方地址 → 原生 SDK；
 *       模型名匹配但 baseURL 是第三方 → openai 兼容路径。
 */
export function detectProvider(model: string, baseURL?: string): ProviderType {
	const envOverride = process.env.LLM_PROVIDER as ProviderType | undefined;
	if (envOverride && ["anthropic", "deepseek", "google", "openai"].includes(envOverride)) {
		return envOverride;
	}
	for (const [pattern, provider] of PROVIDER_PATTERNS) {
		if (pattern.test(model)) {
			return isOfficialURL(baseURL, provider) ? provider : "openai";
		}
	}
	return "openai";
}

// ─── Model 构建 ──────────────────────────────────────────

export interface ModelConfig {
	model: string;
	apiKey: string | undefined;
	baseURL: string | undefined;
}

export function buildLLM(config: ModelConfig) {
	const provider = detectProvider(config.model, config.baseURL);

	switch (provider) {
		case "anthropic":
			return buildAnthropicModel(config);
		case "deepseek":
			return buildDeepSeekModel(config);
		case "google":
			return buildGoogleModel(config);
		case "openai":
		default:
			return buildOpenAIModel(config);
	}
}

// ─── Anthropic ──────────────────────────────────────────

function buildAnthropicModel(config: ModelConfig) {
	const provider = createAnthropic({
		apiKey: config.apiKey,
		baseURL: config.baseURL,
	});

	console.log(`[LLM] ${config.model} | provider=anthropic | baseURL=${config.baseURL ?? "default"}`);

	return wrapLanguageModel({
		model: provider.chat(config.model),
		middleware: [fixToolArgsMiddleware],
	});
}

// ─── DeepSeek ───────────────────────────────────────────

function buildDeepSeekModel(config: ModelConfig) {
	const provider = createDeepSeek({
		apiKey: config.apiKey,
		baseURL: config.baseURL,
	});

	console.log(`[LLM] ${config.model} | provider=deepseek | baseURL=${config.baseURL ?? "default"}`);

	return wrapLanguageModel({
		model: provider.chat(config.model),
		middleware: [fixToolArgsMiddleware],
	});
}

// ─── Google ─────────────────────────────────────────────

function buildGoogleModel(config: ModelConfig) {
	const provider = createGoogleGenerativeAI({
		apiKey: config.apiKey,
		baseURL: config.baseURL,
	});

	console.log(`[LLM] ${config.model} | provider=google | baseURL=${config.baseURL ?? "default"}`);

	return wrapLanguageModel({
		model: provider.chat(config.model),
		middleware: [fixToolArgsMiddleware],
	});
}

// ─── OpenAI 兼容（GLM / Qwen / Kimi / MiniMax / SiliconFlow / 代理）─────

/**
 * OpenAI 兼容路径无条件挂载 thinking 归一化：
 *   - createReasoningFetch：将 reasoning_content/reasoning 字段 + 非标准标签 → <think>
 *   - extractReasoningMiddleware：从 <think> 标签提取 reasoning 部分
 *
 * 对无 thinking 输出的模型零开销（快速路径跳过 JSON 解析）。
 * LLM_REASONING=false 可强制关闭。
 */
function buildOpenAIModel(config: ModelConfig) {
	const reasoning = process.env.LLM_REASONING !== "false";

	const provider = createOpenAI({
		apiKey: config.apiKey,
		baseURL: config.baseURL,
		fetch: reasoning ? createReasoningFetch() : undefined,
	});

	const middleware: LanguageModelMiddleware[] = [fixToolArgsMiddleware];
	if (reasoning) {
		middleware.unshift(
			extractReasoningMiddleware({ tagName: "think" }),
		);
	}

	console.log(`[LLM] ${config.model} | provider=openai | reasoning=${reasoning} | baseURL=${config.baseURL ?? "default"}`);

	return wrapLanguageModel({
		model: provider.chat(config.model),
		middleware,
	});
}
