// ============================================================================
// 字段值类型推断：模型漏填 valueType 时给出保守默认值
// ============================================================================
import { describe, expect, it } from "vitest";
import { inferValueType } from "@/lib/server/value-type";

describe("inferValueType", () => {
	it("日期 / 时间类", () => {
		expect(inferValueType("出差起止日期")).toBe("date");
		expect(inferValueType("费用发生日期1")).toBe("date");
		expect(inferValueType("提交时间")).toBe("date");
	});

	it("金额类", () => {
		expect(inferValueType("金额合计")).toBe("currency");
		expect(inferValueType("小写金额")).toBe("currency");
		expect(inferValueType("住宿费用")).toBe("currency");
	});

	it("数量 / 序号类", () => {
		expect(inferValueType("出差天数")).toBe("number");
		expect(inferValueType("票据张数1")).toBe("number");
		expect(inferValueType("编号")).toBe("number");
	});

	it("其余回落为 text；空名也算 text", () => {
		expect(inferValueType("报销人")).toBe("text");
		expect(inferValueType("出差事由")).toBe("text");
		expect(inferValueType("  ")).toBe("text");
	});
});
