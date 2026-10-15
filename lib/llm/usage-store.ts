/** 请求级 token usage 存储。短生命周期内存缓存，避免并发请求互相覆盖。 */

export interface TokenUsage {
	requestId: string;
	sessionId?: string;
	runId?: string;
	model?: string;
	provider?: string;
	contextWindow?: number;
	contextWindowSource?: "env" | "model-map" | "default";
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	lastStepInputTokens?: number;
	totalInputTokens?: number;
	outputTokens?: number;
	stepCount?: number;
	totalDurationMs?: number;
	retries?: number;
	updatedAt: number;
}

const usageByRequest = new Map<string, TokenUsage>();
const MAX_ENTRIES = 100;

export function setUsage(usage: TokenUsage) {
	usageByRequest.set(usage.requestId, usage);
	while (usageByRequest.size > MAX_ENTRIES) {
		const first = usageByRequest.keys().next().value;
		if (!first) break;
		usageByRequest.delete(first);
	}
}

export function getUsage(requestId?: string): TokenUsage | null {
	if (requestId) return usageByRequest.get(requestId) ?? null;
	let latest: TokenUsage | null = null;
	for (const value of usageByRequest.values()) {
		if (!latest || value.updatedAt > latest.updatedAt) latest = value;
	}
	return latest;
}
