import { describe, expect, it } from "vitest";
import { DEFAULT_TEXT_LIMIT, truncateText } from "@/lib/text-limit";

describe("truncateText", () => {
	it("短文本原样返回（引用不变，避免无谓的字符串复制）", () => {
		const text = "思考一下";
		const r = truncateText(text);
		expect(r.text).toBe(text);
		expect(r.truncated).toBe(false);
		expect(r.omitted).toBe(0);
	});

	it("超长文本按上限截断并给出省略字数", () => {
		const text = "a".repeat(DEFAULT_TEXT_LIMIT + 1234);
		const r = truncateText(text);
		expect(r.truncated).toBe(true);
		expect(r.text.length).toBe(DEFAULT_TEXT_LIMIT);
		expect(r.omitted).toBe(1234);
		expect(text.startsWith(r.text)).toBe(true);
	});

	it("自定义上限与边界值", () => {
		expect(truncateText("abcdef", 6).truncated).toBe(false);
		expect(truncateText("abcdef", 5)).toEqual({ text: "abcde", truncated: true, omitted: 1 });
		// limit <= 0 视为不截断，避免渲染空内容
		expect(truncateText("abcdef", 0).truncated).toBe(false);
	});
});
