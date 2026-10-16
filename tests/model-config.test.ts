import { afterEach, describe, expect, it, vi } from "vitest";
import { getContextWindow, getContextWindowInfo } from "@/lib/config";
import { isVisionCapable, shouldUseSeparateVisionModel } from "@/lib/llm/capabilities";

afterEach(() => {
	vi.unstubAllEnvs();
});

// 数字来源：DeepSeek 与智谱官方文档（2026-10 核对）
describe("上下文窗口映射", () => {
	it("deepseek-v4.1-flash / deepseek-flash / deepseek-v4-pro 按 1M 计算", () => {
		expect(getContextWindow("deepseek-v4.1-flash")).toBe(1_000_000);
		expect(getContextWindow("deepseek-flash")).toBe(1_000_000);
		expect(getContextWindow("deepseek-v4-pro")).toBe(1_000_000);
		expect(getContextWindowInfo("deepseek-v4.1-flash").source).toBe("model-map");
	});

	it("glm-5.3 / glm-5.2 按 1M，glm-5 / glm-5.1 / glm-4.7 按 200K 计算", () => {
		expect(getContextWindow("glm-5.3-flash")).toBe(1_000_000);
		expect(getContextWindow("glm-5.3")).toBe(1_000_000);
		expect(getContextWindow("glm-5.2")).toBe(1_000_000);
		expect(getContextWindow("glm-5")).toBe(200_000);
		expect(getContextWindow("glm-5.1")).toBe(200_000);
		expect(getContextWindow("glm-4.7")).toBe(200_000);
	});

	it("glm-4.5 及更早、deepseek-v3 系列保持 128K", () => {
		expect(getContextWindow("glm-4.5")).toBe(128_000);
		expect(getContextWindow("deepseek-v3")).toBe(128_000);
		expect(getContextWindow("deepseek-chat")).toBe(128_000);
	});

	it("未知模型回退默认值并标记来源为 default", () => {
		const info = getContextWindowInfo("some-unknown-model");
		expect(info).toEqual({ value: 128_000, source: "default" });
	});

	it("MODEL_CONTEXT_WINDOW 覆盖模型表，空字符串视为未配置", () => {
		vi.stubEnv("MODEL_CONTEXT_WINDOW", "256000");
		expect(getContextWindowInfo("deepseek-v4.1-flash")).toEqual({ value: 256_000, source: "env" });
		expect(getContextWindowInfo("some-unknown-model")).toEqual({ value: 256_000, source: "env" });

		vi.stubEnv("MODEL_CONTEXT_WINDOW", "");
		expect(getContextWindowInfo("deepseek-v4.1-flash")).toEqual({ value: 1_000_000, source: "model-map" });
	});
});

describe("视觉能力判定", () => {
	it("原生支持图片的模型识别为 vision capable", () => {
		expect(isVisionCapable("deepseek-v4.1-flash")).toBe(true);
		expect(isVisionCapable("deepseek-flash")).toBe(true);
		expect(isVisionCapable("deepseek-v4-flash-vision-exp")).toBe(true);
		expect(isVisionCapable("glm-5.3-flash")).toBe(true);
		expect(isVisionCapable("glm-4.6v")).toBe(true);
		expect(isVisionCapable("gpt-4o")).toBe(true);
	});

	it("纯文本模型不识别为 vision capable", () => {
		expect(isVisionCapable("deepseek-v3")).toBe(false);
		expect(isVisionCapable("deepseek-v4-pro")).toBe(false);
		expect(isVisionCapable("glm-5.3")).toBe(false);
		expect(isVisionCapable("glm-5.2")).toBe(false);
		expect(isVisionCapable("glm-4.7")).toBe(false);
	});
});

describe("独立视觉模型启用判定", () => {
	const vision = "glm-5.3-flash";

	it("主模型原生支持图片时不再单独挂 VISION_MODEL", () => {
		expect(shouldUseSeparateVisionModel("deepseek-v4.1-flash", vision)).toBe(false);
		expect(shouldUseSeparateVisionModel("glm-5.3-flash", vision)).toBe(false);
	});

	it("主模型不支持图片时回退到 VISION_MODEL", () => {
		expect(shouldUseSeparateVisionModel("glm-4.7", vision)).toBe(true);
		expect(shouldUseSeparateVisionModel("deepseek-v3", vision)).toBe(true);
	});

	it("未配置 VISION_MODEL 时不启用独立视觉模型", () => {
		expect(shouldUseSeparateVisionModel("glm-4.7", undefined)).toBe(false);
	});

	it("VISION_FORCE=true 可强制启用独立视觉模型", () => {
		vi.stubEnv("VISION_FORCE", "true");
		expect(shouldUseSeparateVisionModel("deepseek-v4.1-flash", vision)).toBe(true);

		vi.stubEnv("VISION_FORCE", "false");
		expect(shouldUseSeparateVisionModel("deepseek-v4.1-flash", vision)).toBe(false);
	});
});
