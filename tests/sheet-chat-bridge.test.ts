import { describe, expect, it, vi } from "vitest";
import {
	addSheetToChat,
	buildSheetChatPrompt,
	getContextSheetName,
	setContextSheetName,
	subscribeSheetToChat,
} from "@/lib/agent/sheet-chat-bridge";

describe("buildSheetChatPrompt", () => {
	it("生成只预填、便于续写的提示词（不自动发送）", () => {
		expect(buildSheetChatPrompt("Sheet1")).toBe("请针对工作表「Sheet1」回答：");
	});

	it("保留工作表名内部空格，只处理调用方传入的原文", () => {
		expect(buildSheetChatPrompt("差旅报销单")).toBe("请针对工作表「差旅报销单」回答：");
	});
});

describe("setContextSheetName / getContextSheetName", () => {
	it("记录被右键的工作表名并去除首尾空白", () => {
		setContextSheetName("  明细  ");
		expect(getContextSheetName()).toBe("明细");
	});

	it("空值 / 空白 / null 一律清空，避免用到上一次的陈旧上下文", () => {
		setContextSheetName("明细");
		setContextSheetName(null);
		expect(getContextSheetName()).toBeNull();
		setContextSheetName("   ");
		expect(getContextSheetName()).toBeNull();
	});
});

describe("addSheetToChat / subscribeSheetToChat", () => {
	it("广播给所有订阅者，退订后不再收到", () => {
		const a = vi.fn();
		const b = vi.fn();
		const offA = subscribeSheetToChat(a);
		const offB = subscribeSheetToChat(b);

		addSheetToChat("Sheet1");
		expect(a).toHaveBeenCalledWith("Sheet1");
		expect(b).toHaveBeenCalledWith("Sheet1");

		offA();
		addSheetToChat("Sheet2");
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenLastCalledWith("Sheet2");
		offB();
	});

	it("工作表名为空时不广播", () => {
		const fn = vi.fn();
		const off = subscribeSheetToChat(fn);
		addSheetToChat("");
		addSheetToChat("   ");
		expect(fn).not.toHaveBeenCalled();
		off();
	});

	it("广播前去除首尾空白", () => {
		const fn = vi.fn();
		const off = subscribeSheetToChat(fn);
		addSheetToChat("  明细  ");
		expect(fn).toHaveBeenCalledWith("明细");
		off();
	});

	it("单个订阅者抛错不影响其它订阅者，也不把异常抛给调用方", () => {
		const bad = vi.fn(() => {
			throw new Error("boom");
		});
		const good = vi.fn();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const offBad = subscribeSheetToChat(bad);
		const offGood = subscribeSheetToChat(good);

		expect(() => addSheetToChat("Sheet1")).not.toThrow();
		expect(good).toHaveBeenCalledWith("Sheet1");

		offBad();
		offGood();
		errSpy.mockRestore();
	});
});
