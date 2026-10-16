// ============================================================================
// 上游请求体序列化回归：
// tool 消息必须始终带 `content`。
//
// 2026-10-15 事故：pruneModelToolResults 把 tool-result 的 output 换成了无 `type` 的对象，
// @ai-sdk/openai 的 convertToOpenAIChatMessages 按 output.type 分支取值，类型不匹配时
// content 变量不被赋值 → 上游网关报
// `Failed to deserialize the JSON body ... messages[N]: missing field content`，点重试也一直失败。
// 这里用真实 provider + 拦截 fetch 的方式直接检查「发出去的请求体」。
// ============================================================================
import { describe, expect, it } from "vitest";
import { convertToModelMessages, streamText, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { normalizeModelToolOutputs, pruneModelToolResults } from "@/lib/agent/context-compression";

const HUGE_READ = "R".repeat(6_000);
const HUGE_MAP = "M".repeat(6_000);

const SSE_BODY = [
	`data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}`,
	"",
	`data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
	"",
	"data: [DONE]",
	"",
	"",
].join("\n\n");

/** 拦截 provider 发出的请求体（不请求真实网络） */
async function captureOutgoingMessages(messages: ModelMessage[], system = "SYS") {
	const bodies: string[] = [];
	const provider = createOpenAI({
		apiKey: "test",
		baseURL: "https://example.invalid/v1",
		fetch: (async (_url: unknown, init: { body?: unknown }) => {
			bodies.push(String(init?.body ?? ""));
			return new Response(SSE_BODY, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as never,
	});
	const result = streamText({ model: provider.chat("deepseek-v4.1-flash"), system, messages, maxRetries: 0 });
	await result.consumeStream();
	expect(bodies).toHaveLength(1);
	const body = JSON.parse(bodies[0]) as { messages: Array<Record<string, unknown>> };
	return body.messages;
}

function toolResult(id: string, name: string, output: unknown) {
	return {
		role: "tool",
		content: [{ type: "tool-result", toolCallId: id, toolName: name, output }],
	} as unknown as ModelMessage;
}

function assistantCall(id: string, name: string) {
	return {
		role: "assistant",
		content: [{ type: "tool-call", toolCallId: id, toolName: name, input: {} }],
	} as unknown as ModelMessage;
}

function user(text: string) {
	return { role: "user", content: text } as ModelMessage;
}

describe("上游请求体序列化", () => {
	it("裁剪历史工具结果后，每条消息仍然带 content", async () => {
		const messages: ModelMessage[] = [
			user("q0"),
			assistantCall("call-read", "read_ranges"),
			toolResult("call-read", "read_ranges", { type: "json", value: { rows: HUGE_READ } }),
			assistantCall("call-save", "save_template"),
			toolResult("call-save", "save_template", { type: "json", value: { templateId: "tpl_1", map: HUGE_MAP } }),
			user("q1"),
			assistantCall("call-tail", "read_ranges"),
			toolResult("call-tail", "read_ranges", { type: "text", value: "small" }),
			user("q2"),
			assistantCall("call-tail2", "read_ranges"),
			toolResult("call-tail2", "read_ranges", { type: "text", value: "small2" }),
		];

		const pruned = pruneModelToolResults(messages, 4);
		const outgoing = await captureOutgoingMessages(pruned);

		const missing = outgoing.map((m, i) => ({ i, role: m.role })).filter((_, i) => !("content" in outgoing[i]));
		expect(missing).toEqual([]);
		for (const m of outgoing) {
			expect(m.content).not.toBeUndefined();
		}

		// 行为保留：普通工具的大结果被裁剪（占位结果写进上游请求），关键业务工具结果不裁剪
		const serialized = JSON.stringify(outgoing);
		// read_ranges 的 6000 字符结果已被换成带预览的占位结果
		expect(serialized).toContain("truncated");
		expect(serialized).not.toContain(HUGE_READ);
		// 关键业务工具（save_template）的结果原样保留
		expect(serialized).toContain("tpl_1");
		expect(serialized).toContain(HUGE_MAP);
	});

	it("历史里遗留的无 type output 不会让整条请求被上游拒绝", async () => {
		const legacy = [
			user("q0"),
			assistantCall("call-legacy", "read_ranges"),
			{ role: "tool", content: [{ type: "tool-result", toolCallId: "call-legacy", toolName: "read_ranges", output: { truncated: true, preview: "p" } }] } as unknown as ModelMessage,
		];

		const outgoing = await captureOutgoingMessages(normalizeModelToolOutputs(legacy));
		const missing = outgoing.filter((m) => !("content" in m));
		expect(missing).toEqual([]);
		expect(JSON.stringify(outgoing)).toContain("truncated");
	});

	it("会话从 IndexedDB 恢复后重试：持久化裁剪过的 UI 工具结果转成模型消息仍带 content", async () => {
		// 用户点「重试」时，消息来自浏览器恢复的 UI messages（工具结果可能是持久化裁剪后的形状）。
		// 这里直接用 convertToModelMessages 复现该链路。
		const persisted = [
			{ id: "m1", role: "user", parts: [{ type: "text", text: "继续" }] },
			{
				id: "m2",
				role: "assistant",
				parts: [
					{
						type: "tool-read_ranges",
						toolCallId: "call-persisted",
						state: "output-available",
						input: { address: "A1" },
						// session-store.ts 的 compactToolOutput 产出的持久化形状（故意不带 type）
						output: { truncated: true, note: "工具结果已裁剪，仅保留持久化预览", originalChars: 9000, preview: "PREVIEW_TEXT" },
					},
				],
			},
		];

		const outgoing = await captureOutgoingMessages(
			normalizeModelToolOutputs(await convertToModelMessages(persisted as never)),
		);

		expect(outgoing.every((m) => "content" in m)).toBe(true);
		const serialized = JSON.stringify(outgoing);
		expect(serialized).toContain("PREVIEW_TEXT");
	});

	it("不同工具类型的 output 都会得到合法 content（含字符串、对象、数组、空值）", async () => {
		const cases: unknown[] = [
			"plain",
			{ a: 1 },
			[1, 2, 3],
			null,
			undefined,
			{ type: "content", value: [{ type: "text", text: "hi" }] },
		];
		for (const output of cases) {
			const msgs = normalizeModelToolOutputs([
				user("q"),
				assistantCall("c1", "read_ranges"),
				toolResult("c1", "read_ranges", output),
			]);
			const outgoing = await captureOutgoingMessages(msgs);
			expect(outgoing.every((m) => "content" in m)).toBe(true);
		}
	});
});
