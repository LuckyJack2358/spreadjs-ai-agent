import type { LanguageModelUsage } from "ai";
import { getUsage, setUsage } from "@/lib/llm/usage-store";
import type { ContextWindowSource } from "@/lib/config";

export interface UsageTrackerOptions {
	requestId: string;
	sessionId?: string;
	runId?: string;
	model?: string;
	provider?: string;
	contextWindow?: number;
	contextWindowSource?: ContextWindowSource;
}

/**
 * 每次请求的 token 用量追踪。
 *
 * - recordStep：每步记录 inputTokens（最后一步的值才是真实上下文占用）
 * - finalize：汇总写入 usage store + 输出 cache 命中指标
 */
export class UsageTracker {
	private lastStepInputTokens = 0;
	private totalInputTokens = 0;
	private outputTokens = 0;
	private stepCount = 0;
	private totalDurationMs = 0;
	private retries = 0;
	private readonly options: UsageTrackerOptions;

	constructor(options: UsageTrackerOptions) {
		this.options = options;
	}

	/** onStepFinish 调用：记录本步 inputTokens */
	recordStep(usage: { inputTokens?: number } | undefined): void {
		if (usage?.inputTokens) {
			this.lastStepInputTokens = usage.inputTokens;
			this.totalInputTokens += usage.inputTokens;
		}
		this.stepCount++;
	}

	getStepCount(): number {
		return this.stepCount;
	}

	updateRequestTiming(timing: { totalDurationMs?: number; retries?: number }): void {
		if (timing.totalDurationMs != null) this.totalDurationMs = timing.totalDurationMs;
		if (timing.retries != null) this.retries = timing.retries;
		const current = this.options.requestId;
		const usage = current ? getUsage(current) : null;
		if (usage) {
			setUsage({ ...usage, updatedAt: Date.now(), stepCount: this.stepCount, totalDurationMs: this.totalDurationMs, retries: this.retries });
		}
	}

	/** onFinish 调用：汇总并写入 usage store + 输出 cache 指标 */
	finalize(totalUsage: LanguageModelUsage): void {
		const promptTokens = this.lastStepInputTokens || (totalUsage.inputTokens ?? 0);
		console.log(`[usage] lastStep: ${this.lastStepInputTokens}, total: ${JSON.stringify(totalUsage)}`);
		this.outputTokens = totalUsage.outputTokens ?? 0;
		setUsage({
			...this.options,
			updatedAt: Date.now(),
			promptTokens,
			completionTokens: this.outputTokens,
			totalTokens: totalUsage.totalTokens ?? 0,
			lastStepInputTokens: this.lastStepInputTokens,
			totalInputTokens: this.totalInputTokens || totalUsage.inputTokens,
			outputTokens: this.outputTokens,
			stepCount: this.stepCount,
			totalDurationMs: this.totalDurationMs,
			retries: this.retries,
		});

		// cache 指标从 AI SDK 标准化的 inputTokenDetails 读取（跨 provider 通用）
		const { cacheReadTokens, cacheWriteTokens } = totalUsage.inputTokenDetails;
		if (cacheReadTokens != null || cacheWriteTokens != null) {
			console.log(`[cache] write=${cacheWriteTokens ?? 0} read=${cacheReadTokens ?? 0}`);
		}
	}
}
