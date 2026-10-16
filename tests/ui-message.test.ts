import { describe, expect, it } from "vitest";
import {
	hasStreamingParts,
	isAgentTimeoutPart,
	markStreamingPartsDone,
	mergeReplyMetrics,
	type AppUIMessagePart,
	type ReplyMetrics,
} from "@/lib/agent/ui-message";

function textPart(text: string, state?: "streaming" | "done"): AppUIMessagePart {
	return { type: "text", text, state } as AppUIMessagePart;
}

function reasoningPart(text: string, state?: "streaming" | "done"): AppUIMessagePart {
	return { type: "reasoning", text, state } as AppUIMessagePart;
}

describe("markStreamingPartsDone（超时/中断后的悬空 part 收尾）", () => {
	it("把仍在 streaming 的 text / reasoning part 置为 done", () => {
		const parts = [reasoningPart("思考中", "streaming"), textPart("部分回复", "streaming")];
		const { parts: next, changed } = markStreamingPartsDone(parts);
		expect(changed).toBe(true);
		expect(next[0]).toMatchObject({ type: "reasoning", state: "done" });
		expect(next[1]).toMatchObject({ type: "text", state: "done" });
		// 原数组不被就地修改
		expect(parts[0]).toMatchObject({ state: "streaming" });
	});

	it("已完成或没有 state 的 part 保持不变（引用复用，避免无谓渲染）", () => {
		const done = reasoningPart("已完成", "done");
		const stateless = textPart("无 state");
		const { parts: next, changed } = markStreamingPartsDone([done, stateless]);
		expect(changed).toBe(false);
		expect(next).toBe(next);
		expect(next[0]).toBe(done);
		expect(next[1]).toBe(stateless);
	});

	it("工具 / data part 不受影响", () => {
		const toolPart = { type: "tool-read_ranges", toolCallId: "t1", state: "input-available" } as unknown as AppUIMessagePart;
		const dataPart = { type: "data-agent-progress", data: { phase: "inspect" } } as unknown as AppUIMessagePart;
		const { parts: next, changed } = markStreamingPartsDone([toolPart, dataPart]);
		expect(changed).toBe(false);
		expect(next[0]).toBe(toolPart);
		expect(next[1]).toBe(dataPart);
	});
});

describe("hasStreamingParts（防 Maximum update depth exceeded 的收敛条件）", () => {
	it("识别仍在 streaming 的 text / reasoning part", () => {
		expect(hasStreamingParts([reasoningPart("思考中", "streaming")])).toBe(true);
		expect(hasStreamingParts([textPart("部分回复", "streaming")])).toBe(true);
	});

	it("已完成 / 无 state / 非文本 part 都视为非流式", () => {
		expect(hasStreamingParts([])).toBe(false);
		expect(hasStreamingParts([reasoningPart("好了", "done")])).toBe(false);
		expect(hasStreamingParts([textPart("无 state")])).toBe(false);
	});

	it("收尾后必须不再有 streaming part（否则 ChatPanel 的 effect 会无限重跑）", () => {
		const parts = [reasoningPart("思考中", "streaming"), textPart("部分回复", "streaming")];
		expect(hasStreamingParts(parts)).toBe(true);
		const { parts: once } = markStreamingPartsDone(parts);
		expect(hasStreamingParts(once)).toBe(false);
		// 幂等：再收尾一次不会产生新变更，effect 第二次进入会直接 return
		const { changed } = markStreamingPartsDone(once);
		expect(changed).toBe(false);
	});
});

describe("isAgentTimeoutPart", () => {
	it("识别 data-agent-timeout 数据 part", () => {
		const part = {
			type: "data-agent-timeout",
			data: {
				runId: "r1",
				requestId: "r1",
				phase: "inspect",
				elapsedMs: 90_000,
				timeoutMs: 90_000,
				steps: 0,
				toolCalls: false,
				canContinue: true,
			},
		} as unknown as AppUIMessagePart;
		expect(isAgentTimeoutPart(part)).toBe(true);
	});

	it("普通文本 part 不误判", () => {
		expect(isAgentTimeoutPart(textPart("hello"))).toBe(false);
	});
});

function metrics(overrides: Partial<ReplyMetrics> = {}): ReplyMetrics {
	return {
		totalDurationMs: 1000,
		modelDurationMs: 800,
		toolDurationMs: 200,
		steps: 2,
		retries: 0,
		compacted: false,
		model: "gpt-5.6-sol",
		provider: "openai",
		contextWindow: 400_000,
		...overrides,
	};
}

describe("mergeReplyMetrics（自动续跑时合并同一轮回复的多次请求指标）", () => {
	it("prev 为空时直接采用 next", () => {
		const next = metrics();
		expect(mergeReplyMetrics(null, next)).toBe(next);
	});

	it("累加耗时 / 步数 / 重试，使「耗时」与「N 步」口径一致", () => {
		const merged = mergeReplyMetrics(
			metrics({ totalDurationMs: 1000, modelDurationMs: 700, toolDurationMs: 300, steps: 3, retries: 1 }),
			metrics({ totalDurationMs: 500, modelDurationMs: 400, toolDurationMs: 100, steps: 2, retries: 2 }),
		);
		expect(merged.totalDurationMs).toBe(1500);
		expect(merged.modelDurationMs).toBe(1100);
		expect(merged.toolDurationMs).toBe(400);
		expect(merged.steps).toBe(5);
		expect(merged.retries).toBe(3);
	});

	it("model / provider / contextWindow / requestId 取最新请求", () => {
		const merged = mergeReplyMetrics(
			metrics({ requestId: "req-1", model: "old-model", contextWindow: 128_000 }),
			metrics({ requestId: "req-2", model: "new-model", contextWindow: 400_000, contextWindowSource: "env" }),
		);
		expect(merged.requestId).toBe("req-2");
		expect(merged.model).toBe("new-model");
		expect(merged.contextWindow).toBe(400_000);
		expect(merged.contextWindowSource).toBe("env");
	});

	it("compacted / timedOut 取或，visionImages 取最大值", () => {
		const merged = mergeReplyMetrics(
			metrics({ compacted: false, timedOut: false, visionImages: 1 }),
			metrics({ compacted: true, timedOut: true, visionImages: 3 }),
		);
		expect(merged.compacted).toBe(true);
		expect(merged.timedOut).toBe(true);
		expect(merged.visionImages).toBe(3);
	});

	it("缺少 visionImages 时按 0 处理，不会出现 NaN", () => {
		const merged = mergeReplyMetrics(metrics(), metrics({ totalDurationMs: 10 }));
		expect(merged.visionImages).toBe(0);
		expect(Number.isNaN(merged.totalDurationMs)).toBe(false);
	});
});
