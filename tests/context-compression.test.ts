// ============================================================================
// 服务端会话上下文自动压缩：阈值触发、保留段对齐、增量摘要、工具结果裁剪、失败回退
// ============================================================================
import { describe, expect, it, vi } from "vitest";
import {
	estimateMessageTokens,
	maybeCompactMessages,
	normalizeCompactionCarry,
	normalizeModelToolOutputs,
	normalizeToolResultOutput,
	pruneModelToolResults,
	type Summarizer,
} from "@/lib/agent/context-compression";
import type { AppUIMessage } from "@/lib/agent/ui-message";

/** ASCII ~0.25 token/char：4000 字符 ≈ 1000 token */
function big(tag: string): string {
	const head = `${tag}:`;
	return head + "x".repeat(4000 - head.length);
}

const TINY = "t";

function textPart(text: string) {
	return { type: "text", text } as unknown as AppUIMessage["parts"][number];
}

function toolPart(toolName: string, toolCallId: string, output: unknown) {
	return {
		type: `tool-${toolName}`,
		toolCallId,
		state: "output-available",
		input: {},
		output,
	} as unknown as AppUIMessage["parts"][number];
}

function msg(id: string, role: "user" | "assistant", parts: AppUIMessage["parts"]): AppUIMessage {
	return { id, role, parts } as unknown as AppUIMessage;
}

function userMsg(id: string, text: string = TINY): AppUIMessage {
	return msg(id, "user", [textPart(text)]);
}

function assistantMsg(id: string, text: string = TINY): AppUIMessage {
	return msg(id, "assistant", [textPart(text)]);
}

/** 交替的 user/assistant 对话，每条消息 text 决定体积 */
function conversation(turns: number, text: (i: number) => string = (i) => big(`m${i}`)): AppUIMessage[] {
	const list: AppUIMessage[] = [];
	for (let i = 0; i < turns; i++) {
		list.push(userMsg(`u${i}`, text(i * 2)));
		list.push(assistantMsg(`a${i}`, text(i * 2 + 1)));
	}
	return list;
}

function recordingSummarizer(reply = (prev: string, chunk: string) => `S(${prev}|${chunk.length})`) {
	const calls: Array<{ previousSummary: string; chunkText: string }> = [];
	const summarize: Summarizer = vi.fn(async ({ previousSummary, chunkText }) => {
		calls.push({ previousSummary, chunkText });
		return reply(previousSummary, chunkText);
	});
	return { summarize, calls };
}

describe("maybeCompactMessages", () => {
	it("未超阈值时原样返回（不调用摘要器）", async () => {
		const messages = conversation(5); // 10_000 token
		const { summarize, calls } = recordingSummarizer();

		const out = await maybeCompactMessages({
			messages,
			modelName: "test",
			contextWindow: 100_000,
			overheadTokens: 0,
			summarize,
		});

		expect(calls).toHaveLength(0);
		expect(out.compacted).toBe(false);
		expect(out.summarized).toBe(false);
		expect(out.state).toBeNull();
		expect(out.messages).toBe(messages);
	});

	it("超阈值时压缩：保留最近若干轮原文 + 早期摘要，token 明显下降", async () => {
		const messages = conversation(5); // u0 a0 u1 a1 u2 a2 u3 a3 u4 a4，各 1000 token
		const { summarize, calls } = recordingSummarizer();

		const out = await maybeCompactMessages({
			messages,
			modelName: "test",
			contextWindow: 10_000, // 触发阈值 7200，实际 10_000
			overheadTokens: 0,
			summarize,
		});

		expect(out.compacted).toBe(true);
		expect(out.summarized).toBe(true);
		expect(calls).toHaveLength(1);
		// 摘要的是被丢弃的 u0..a2
		expect(calls[0].chunkText).toContain("m0:");
		expect(calls[0].chunkText).not.toContain("m6:");

		// 保留段为最后两轮（从 user 消息开始，工具调用/结果不会被拆散）
		expect(out.messages.map((m) => m.id)).toEqual(["u3", "a3", "u4", "a4"]);
		expect(out.messages[0].role).toBe("user");
		expect(out.droppedMessages).toBe(6);
		expect(out.state?.watermark).toBe("a2");
		expect(out.state?.keptFromMessageId).toBe("u3");
		expect(out.state?.droppedCount).toBe(6);
		expect(out.state?.summary.length).toBeGreaterThan(0);
		expect(out.tokensAfter).toBeLessThan(out.tokensBefore);
	});

	it("切点对齐到 user 消息（回合边界），不拆散工具调用对", async () => {
		// 用户消息在前、助手消息紧随其后但都很小：自然切点会落在助手消息上，
		// 必须向前回退到最近的 user 消息，保证保留段是完整回合
		const messages = [
			userMsg("u0", big("m0")),
			assistantMsg("a0", big("m1")),
			userMsg("u1", big("m2")),
			assistantMsg("a1", big("m3")),
			userMsg("u2", big("m4")),
			assistantMsg("a2", big("m5")),
			userMsg("u3", big("m6")),
			assistantMsg("a3", big("m7")),
		];
		const { summarize } = recordingSummarizer();

		const out = await maybeCompactMessages({
			messages,
			modelName: "test",
			contextWindow: 10_000, // 8000 token > 7200
			overheadTokens: 0,
			summarize,
		});

		expect(out.compacted).toBe(true);
		expect(out.messages[0].role).toBe("user");
		expect(out.messages[0].id).toBe("u2");
		expect(out.state?.keptFromMessageId).toBe("u2");
		// 保留段之后的消息全部保留（无缺口）
		expect(out.messages.map((m) => m.id)).toEqual(["u2", "a2", "u3", "a3"]);
	});

	it("增量摘要：水位线之后的新增历史追加进摘要，不重复摘要旧内容", async () => {
		const before = conversation(5);
		const first = recordingSummarizer(() => "第一版摘要");
		const firstOut = await maybeCompactMessages({
			messages: before,
			modelName: "test",
			contextWindow: 10_000,
			overheadTokens: 0,
			summarize: first.summarize,
		});
		expect(firstOut.state?.watermark).toBe("a2");

		// 追加一轮后再次压缩，回传上次的 summary + watermark
		const after = conversation(6);
		const second = recordingSummarizer(() => "第二版摘要");
		const secondOut = await maybeCompactMessages({
			messages: after,
			modelName: "test",
			contextWindow: 10_000,
			overheadTokens: 0,
			carry: { summary: "第一版摘要", watermark: "a2" },
			summarize: second.summarize,
		});

		expect(second.calls).toHaveLength(1);
		expect(second.calls[0].previousSummary).toBe("第一版摘要");
		// 只摘要水位线(a2)之后、新切点之前的 u3/a3
		expect(second.calls[0].chunkText).toContain("m6:");
		expect(second.calls[0].chunkText).not.toContain("m0:");
		expect(secondOut.state?.summary).toBe("第二版摘要");
		expect(secondOut.messages.map((m) => m.id)).toEqual(["u4", "a4", "u5", "a5"]);
	});

	it("水位线已覆盖新切点时不再调用摘要器（复用已有摘要）", async () => {
		const messages = conversation(5);
		const { summarize, calls } = recordingSummarizer();

		const out = await maybeCompactMessages({
			messages,
			modelName: "test",
			contextWindow: 10_000,
			overheadTokens: 0,
			carry: { summary: "已有摘要", watermark: "a2" },
			summarize,
		});

		expect(calls).toHaveLength(0);
		expect(out.compacted).toBe(true);
		expect(out.summarized).toBe(false);
		expect(out.state?.summary).toBe("已有摘要");
	});

	it("摘要失败时回退为不压缩（不影响对话）", async () => {
		const messages = conversation(5);
		const summarize = vi.fn(async () => {
			throw new Error("summarizer down");
		});

		const out = await maybeCompactMessages({
			messages,
			modelName: "test",
			contextWindow: 10_000,
			overheadTokens: 0,
			summarize,
		});

		expect(summarize).toHaveBeenCalledTimes(1);
		expect(out.compacted).toBe(false);
		expect(out.state).toBeNull();
		expect(out.messages).toBe(messages);
	});

	it("保留段内较早的大体积工具结果被裁剪，业务型工具不裁剪", async () => {
		const droppedToolOutput = { success: true, data: big("read") };
		const proposeOutput = {
			success: true,
			data: { assignmentId: "as_1", items: [{ field: "金额", address: "B2", value: "100" }], lowConfidenceCount: 0 },
		};
		const intactToolOutput = { success: true, data: big("keep") };

		const messages = [
			userMsg("u0", TINY),
			assistantMsg("a0", TINY),
			userMsg("u1", TINY),
			assistantMsg("a1", TINY),
			userMsg("u2", big("m4")),
			msg("a2", "assistant", [
				toolPart("read_ranges", "t-read-dropped", droppedToolOutput),
				toolPart("propose_fill_data", "t-propose", proposeOutput),
			]),
			userMsg("u3", TINY),
			msg("a3", "assistant", [toolPart("read_ranges", "t-read-intact", intactToolOutput)]),
			userMsg("u4", TINY),
			assistantMsg("a4", TINY),
		];

		const { summarize } = recordingSummarizer();
		const out = await maybeCompactMessages({
			messages,
			modelName: "test",
			contextWindow: 3_000,
			overheadTokens: 0,
			keepTokens: 2_500,
			summarize,
		});

		expect(out.messages.map((m) => m.id)).toEqual(["u2", "a2", "u3", "a3", "u4", "a4"]);

		const findOutput = (toolCallId: string) => {
			for (const m of out.messages) {
				for (const part of m.parts) {
					const p = part as { toolCallId?: string; output?: unknown };
					if (p.toolCallId === toolCallId) return p.output as Record<string, unknown>;
				}
			}
			throw new Error(`tool part not found: ${toolCallId}`);
		};

		// 较早的 read_ranges 结果被替换为预览占位
		const pruned = findOutput("t-read-dropped");
		expect(pruned.truncated).toBe(true);
		expect(pruned.originalChars).toBeGreaterThan(4_000);
		expect(String(pruned.preview)).toContain("read:");
		// 填报链路的关键工具结果原样保留
		expect(findOutput("t-propose")).toEqual(proposeOutput);
		// 位于最近 4 条内的工具结果不裁剪
		expect(findOutput("t-read-intact")).toEqual(intactToolOutput);
	});

	it("可压缩消息不足时不压缩", async () => {
		const messages = [userMsg("u0", big("m0")), assistantMsg("a0", big("m1"))];
		const { summarize, calls } = recordingSummarizer();

		const out = await maybeCompactMessages({
			messages,
			modelName: "test",
			contextWindow: 1_000,
			overheadTokens: 0,
			summarize,
		});

		expect(calls).toHaveLength(0);
		expect(out.compacted).toBe(false);
		expect(out.messages).toBe(messages);
	});
});

describe("estimateMessageTokens", () => {
	it("按文本字符估算（CJK 1.5 / 其他 0.25），工具结果计入", () => {
		expect(estimateMessageTokens([userMsg("u0", "abcd")])).toBe(1);
		expect(estimateMessageTokens([userMsg("u0", "你好")])).toBe(3);
		const withTool = [msg("a0", "assistant", [toolPart("read_ranges", "t1", { data: "abcd" })])];
		expect(estimateMessageTokens(withTool)).toBeGreaterThan(1);
	});
});

describe("normalizeCompactionCarry", () => {
	it("只接受非空的 summary + watermark", () => {
		expect(normalizeCompactionCarry(null)).toBeNull();
		expect(normalizeCompactionCarry("x")).toBeNull();
		expect(normalizeCompactionCarry({ summary: "", watermark: "a1" })).toBeNull();
		expect(normalizeCompactionCarry({ summary: "s", watermark: "" })).toBeNull();
		expect(normalizeCompactionCarry({ summary: "  s  ", watermark: "a1" })).toEqual({
			summary: "s",
			watermark: "a1",
		});
	});
});

describe("pruneModelToolResults", () => {
	const large = "x".repeat(4_100);

	it("裁剪早期的大工具结果，保留 toolCallId 与最近尾部", () => {
		const early = {
			role: "tool",
			content: [{ type: "tool-result", toolCallId: "old-1", toolName: "read_ranges", output: large }],
		} as never;
		const recent = {
			role: "tool",
			content: [{ type: "tool-result", toolCallId: "new-1", toolName: "read_ranges", output: large }],
		} as never;

		const result = pruneModelToolResults([early, { role: "user", content: "q" } as never, recent], 1);
		const oldPart = result[0].content[0] as { toolCallId: string; output: { type: string; value: Record<string, unknown> } };
		const newPart = result[2].content[0] as unknown as { output: string };
		expect(oldPart.toolCallId).toBe("old-1");
		expect(oldPart.output.type).toBe("json");
		expect(oldPart.output.value.truncated).toBe(true);
		expect(newPart.output).toBe(large);
	});

	it("裁剪后的 output 必须是合法 ToolResultOutput（否则上游会丢掉整个 content 字段）", () => {
		const validTypes = new Set(["text", "json", "content", "error-text", "error-json", "execution-denied"]);
		const toolMsg = {
			role: "tool",
			content: [
				{ type: "tool-result", toolCallId: "a", toolName: "read_ranges", output: large },
				{ type: "tool-result", toolCallId: "b", toolName: "search_data", output: { type: "json", value: { text: large } } },
				{ type: "tool-result", toolCallId: "c", toolName: "mcp__x__search", output: { type: "text", value: large } },
			],
		} as never;

		const result = pruneModelToolResults([toolMsg, { role: "user", content: "q" } as never], 0);
		for (const part of result[0].content as Array<{ output: { type?: unknown } }>) {
			expect(validTypes.has(String(part.output?.type))).toBe(true);
		}
	});

	it("遗留的无 type output 被归一化（而不是丢给上游）", () => {
		// 旧版本代码产物：无 type 的裁剪对象
		const legacy = {
			role: "tool",
			content: [{ type: "tool-result", toolCallId: "legacy-1", toolName: "read_ranges", output: { truncated: true, preview: "p" } }],
		} as never;

		const pruned = pruneModelToolResults([legacy, { role: "user", content: "q" } as never], 0);
		const parts = pruned[0].content as Array<{ output: { type: string; value: unknown } }>;
		expect(parts[0].output.type).toBe("json");
		expect(parts[0].output.value).toEqual({ truncated: true, preview: "p" });

		const normalized = normalizeModelToolOutputs([legacy]);
		expect(normalized[0]).not.toBe(legacy);

		expect(normalizeToolResultOutput("plain text")).toEqual({ type: "json", value: "plain text" });
		expect(normalizeToolResultOutput(undefined)).toEqual({ type: "json", value: null });
		expect(normalizeToolResultOutput({ type: "text", value: "ok" })).toEqual({ type: "text", value: "ok" });
	});

	it("合法输出不被改动（归一化只修形状）", () => {
		const ok = {
			role: "tool",
			content: [{ type: "tool-result", toolCallId: "ok-1", toolName: "read_ranges", output: { type: "text", value: "hi" } }],
		} as never;
		const messages = [ok];
		expect(normalizeModelToolOutputs(messages)).toBe(messages);
	});

	it("关键业务工具、小结果和无改动输入保持不变", () => {
		const important = {
			role: "tool",
			content: [{ type: "tool-result", toolCallId: "save-1", toolName: "save_template", output: { type: "text", value: large } }],
		} as never;
		const small = {
			role: "tool",
			content: [{ type: "tool-result", toolCallId: "small-1", toolName: "read_ranges", output: { type: "text", value: "small" } }],
		} as never;
		const messages = [important, small];
		const result = pruneModelToolResults(messages, 0);
		expect(result).toBe(messages);
		expect(result[0]).toBe(important);
		expect(result[1]).toBe(small);
		expect(pruneModelToolResults(messages, 2)).toBe(messages);
	});
});
