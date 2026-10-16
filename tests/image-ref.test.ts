// ============================================================================
// 图片引用降级：历史轮图片 → 占位文本、uploadId → data URL 还原、
// 同轮非首个 step 的图片降级。核心诉求：图片数据不再每轮/每步重复随请求发送。
// 以及模板工作流源图的「不降级」例外（2026-10-15 事故：续跑请求丢掉源图后
// 模型会要求用户重新上传）。
// ============================================================================
import { describe, expect, it, vi } from "vitest";
import {
	FORM_IMAGE_INLINE_STEPS,
	IMAGE_INLINE_STEPS,
	collectImageIdsByName,
	collectUserImageIds,
	countInlinedImages,
	demoteAllUserImages,
	demoteHistoryImages,
	demoteImagesInModelMessages,
	hydrateImageRefs,
	imageInlineStepCount,
	isImageUIPart,
	parseUploadId,
	pickNamedImages,
	uploadUrlFor,
} from "@/lib/agent/image-ref";
import type { AppUIMessage } from "@/lib/agent/ui-message";
import type { ModelMessage } from "ai";

const DATA_URL = "data:image/jpeg;base64,AAAA";

function textPart(text: string) {
	return { type: "text", text } as unknown as AppUIMessage["parts"][number];
}

function filePart(name: string, url: string, mediaType = "image/jpeg") {
	return { type: "file", filename: name, mediaType, url } as unknown as AppUIMessage["parts"][number];
}

function userMsg(id: string, parts: AppUIMessage["parts"]): AppUIMessage {
	return { id, role: "user", parts } as unknown as AppUIMessage;
}

function assistantMsg(id: string, parts: AppUIMessage["parts"] = [textPart("ok")]): AppUIMessage {
	return { id, role: "assistant", parts } as unknown as AppUIMessage;
}

describe("uploadUrlFor / parseUploadId", () => {
	it("往返一致", () => {
		const id = "img_abc123";
		expect(uploadUrlFor(id)).toBe("/api/uploads/img_abc123");
		expect(parseUploadId(uploadUrlFor(id))).toBe(id);
	});

	it("非引用 URL 返回 null", () => {
		expect(parseUploadId(DATA_URL)).toBeNull();
		expect(parseUploadId("https://example.com/a.jpg")).toBeNull();
		expect(parseUploadId("/api/uploads/")).toBeNull();
		expect(parseUploadId(undefined)).toBeNull();
	});

	it("忽略 query / hash", () => {
		expect(parseUploadId("/api/uploads/img_1?t=1#x")).toBe("img_1");
	});
});

describe("isImageUIPart", () => {
	it("只认图片 file part", () => {
		expect(isImageUIPart(filePart("a.jpg", uploadUrlFor("x1")))).toBe(true);
		expect(isImageUIPart(filePart("a.pdf", "/api/uploads/x2", "application/pdf"))).toBe(false);
		expect(isImageUIPart(textPart("hi"))).toBe(false);
	});
});

describe("demoteHistoryImages", () => {
	it("只保留最新一轮 user 的图片，更早历史降级为占位文本", () => {
		const oldRef = uploadUrlFor("old1");
		const newRef = uploadUrlFor("new1");
		const messages = [
			userMsg("u1", [textPart("第一张"), filePart("old.jpg", oldRef)]),
			assistantMsg("a1"),
			userMsg("u2", [textPart("第二张"), filePart("new.jpg", newRef)]),
		];
		const out = demoteHistoryImages(messages);

		const first = out[0].parts[1] as { type: string; text: string };
		expect(first.type).toBe("text");
		expect(first.text).toContain("old1");
		expect(first.text).toContain("old.jpg");

		// 最新一轮的图片保持原样（仍带 uploadId，交给服务端 hydrate）
		expect(out[2].parts[1]).toEqual(filePart("new.jpg", newRef));
	});

	it("无历史图片时返回原数组引用（可据此跳过后续处理）", () => {
		const messages = [userMsg("u1", [textPart("hi")]), assistantMsg("a1")];
		expect(demoteHistoryImages(messages)).toBe(messages);
	});

	it("assistant 消息里的图片不受影响", () => {
		const messages = [
			assistantMsg("a1", [filePart("shot.png", uploadUrlFor("shot"))]),
			userMsg("u1", [filePart("x.jpg", uploadUrlFor("x"))]),
		];
		const out = demoteHistoryImages(messages);
		expect(out[0].parts[0]).toEqual(filePart("shot.png", uploadUrlFor("shot")));
	});
});

describe("hydrateImageRefs", () => {
	it("uploadId → data URL", () => {
		const messages = [userMsg("u1", [filePart("a.jpg", uploadUrlFor("img1"))])];
		const resolve = vi.fn(() => ({ mimeType: "image/png", dataUrl: DATA_URL }));
		const out = hydrateImageRefs(messages, resolve);
		expect(resolve).toHaveBeenCalledWith("img1");
		expect(out[0].parts[0]).toMatchObject({ url: DATA_URL, mediaType: "image/png" });
	});

	it("解析失败降级为占位文本，绝不把无效字符串当 base64 发出去", () => {
		const messages = [userMsg("u1", [filePart("a.jpg", uploadUrlFor("gone"))])];
		const out = hydrateImageRefs(messages, () => null);
		const part = out[0].parts[0] as { type: string; text: string };
		expect(part.type).toBe("text");
		expect(part.text).toContain("gone");
	});

	it("内联 data URL（上传失败回落）原样保留", () => {
		const messages = [userMsg("u1", [filePart("a.jpg", DATA_URL)])];
		const resolve = vi.fn(() => null);
		const out = hydrateImageRefs(messages, resolve);
		expect(resolve).not.toHaveBeenCalled();
		expect(out[0].parts[0]).toEqual(filePart("a.jpg", DATA_URL));
	});

	it("无引用时返回原数组引用", () => {
		const messages = [userMsg("u1", [textPart("hi")])];
		expect(hydrateImageRefs(messages, () => null)).toBe(messages);
	});
});

describe("demoteImagesInModelMessages", () => {
	it("user 消息里的图片 part 换成占位文本", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "看图" }, { type: "file", mediaType: "image/png", data: DATA_URL, filename: "a.png" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		] as unknown as ModelMessage[];
		const out = demoteImagesInModelMessages(messages);
		const content = out[0].content as Array<{ type: string; text?: string }>;
		expect(content[0]).toEqual({ type: "text", text: "看图" });
		expect(content[1].type).toBe("text");
		expect(content[1].text).toContain("a.png");
		// 未受影响的消息保持原对象
		expect(out[1]).toBe(messages[1]);
	});

	it("无图片时返回原数组引用", () => {
		const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }] as unknown as ModelMessage[];
		expect(demoteImagesInModelMessages(messages)).toBe(messages);
	});

	it("仅前若干个 step 内联图片（策略常量）", () => {
		expect(IMAGE_INLINE_STEPS).toBe(1);
	});
});
describe("demoteAllUserImages", () => {
	it("首轮完成后的所有 user 图片都只保留 uploadId 占位引用", () => {
		const messages = [
			userMsg("u1", [filePart("receipt.png", uploadUrlFor("img_1"))]),
			assistantMsg("a1"),
			userMsg("u2", [filePart("next.png", uploadUrlFor("img_2"))]),
		];
		const out = demoteAllUserImages(messages);
		expect((out[0].parts[0] as { type: string; text: string }).text).toContain("img_1");
		expect((out[2].parts[0] as { type: string; text: string }).text).toContain("img_2");
		expect(out[1]).toBe(messages[1]);
	});
});


describe("表单工作流源图不降级（keepImageIds）", () => {
	it("命中的历史图片保持引用，未命中的照常降级", () => {
		const keepRef = uploadUrlFor("src_img");
		const otherRef = uploadUrlFor("other_img");
		const messages = [
			userMsg("u1", [textPart("空白单据"), filePart("blank.jpg", keepRef)]),
			assistantMsg("a1"),
			userMsg("u2", [textPart("另一张"), filePart("other.jpg", otherRef)]),
			assistantMsg("a2"),
			userMsg("u3", [textPart("继续执行")]),
		];
		const out = demoteHistoryImages(messages, { keepImageIds: new Set(["src_img"]) });

		// 命中的源图仍是 file part（服务端会 hydrate 成真图）
		expect(out[0].parts[1]).toEqual(filePart("blank.jpg", keepRef));
		// 未命中的历史图片降级为占位文本
		const demoted = out[2].parts[1] as { type: string; text: string };
		expect(demoted.type).toBe("text");
		expect(demoted.text).toContain("other_img");
	});

	it("未传 keepImageIds 时行为不变（全部历史图片降级）", () => {
		const messages = [
			userMsg("u1", [filePart("blank.jpg", uploadUrlFor("src_img"))]),
			assistantMsg("a1"),
			userMsg("u2", [textPart("继续执行")]),
		];
		const out = demoteHistoryImages(messages);
		expect((out[0].parts[0] as { type: string }).type).toBe("text");
	});

	it("keepImageIds 与最新一轮重合时不重复处理（返回原数组引用）", () => {
		const ref = uploadUrlFor("src_img");
		const messages = [userMsg("u1", [filePart("blank.jpg", ref)])];
		expect(demoteHistoryImages(messages, { keepImageIds: new Set(["src_img"]) })).toBe(messages);
	});
});

describe("collectUserImageIds / collectImageIdsByName / countInlinedImages", () => {
	it("collectUserImageIds 只收 user 图片引用，去重且保持顺序", () => {
		const messages = [
			userMsg("u1", [filePart("a.jpg", uploadUrlFor("img_a"))]),
			assistantMsg("a1", [filePart("shot.png", uploadUrlFor("img_shot"))]),
			userMsg("u2", [textPart("继续"), filePart("a.jpg", uploadUrlFor("img_a")), filePart("b.jpg", uploadUrlFor("img_b"))]),
		];
		expect(collectUserImageIds(messages)).toEqual(["img_a", "img_b"]);
	});

	it("collectUserImageIds 忽略内联 data URL 与文本", () => {
		const messages = [userMsg("u1", [textPart("hi"), filePart("inline.jpg", DATA_URL)])];
		expect(collectUserImageIds(messages)).toEqual([]);
	});

	it("collectImageIdsByName 还原 文件名 → uploadId（刷新后复用已上传图片）", () => {
		const messages = [
			userMsg("u1", [filePart(" blank.jpg ", uploadUrlFor("img_a"))]),
			userMsg("u2", [filePart("inline.jpg", DATA_URL)]),
		];
		const map = collectImageIdsByName(messages);
		expect(map.get("blank.jpg")).toBe("img_a");
		expect(map.size).toBe(1);
	});

	it("countInlinedImages 只数仍带真图 data URL 的 user 图片", () => {
		const messages = [
			userMsg("u1", [filePart("ref.jpg", uploadUrlFor("img_a"))]),
			userMsg("u2", [filePart("inline.jpg", DATA_URL)]),
		];
		expect(countInlinedImages(messages)).toBe(1);
	});
});

describe("imageInlineStepCount", () => {
	it("模板工作流保留更多 step 的真图，普通聊天保持 IMAGE_INLINE_STEPS", () => {
		expect(imageInlineStepCount(true)).toBe(FORM_IMAGE_INLINE_STEPS);
		expect(imageInlineStepCount(false)).toBe(IMAGE_INLINE_STEPS);
		expect(FORM_IMAGE_INLINE_STEPS).toBeGreaterThan(IMAGE_INLINE_STEPS);
	});
});

describe("pickNamedImages", () => {
	it("优先用暂存区的 data URL，并带上已落盘的 imageId", () => {
		const out = pickNamedImages(
			["a.jpg"],
			new Map([["a.jpg", DATA_URL]]),
			new Map([["a.jpg", "img_a"]]),
			new Map(),
		);
		expect(out).toEqual([{ name: "a.jpg", dataUrl: DATA_URL, imageId: "img_a" }]);
	});

	it("暂存区为空时用历史消息里的 imageId 兜底（不再要求用户重新上传）", () => {
		const out = pickNamedImages(["blank.jpg"], new Map(), new Map(), new Map([["blank.jpg", "img_hist"]]));
		expect(out).toEqual([{ name: "blank.jpg", dataUrl: undefined, imageId: "img_hist" }]);
	});

	it("容忍首尾空格与大小写差异", () => {
		const out = pickNamedImages([" Blank.JPG "], new Map(), new Map(), new Map([["blank.jpg", "img_hist"]]));
		expect(out.map((i) => i.imageId)).toEqual(["img_hist"]);
	});

	it("三个来源都没有时跳过（保持原行为：不注入）", () => {
		expect(pickNamedImages(["missing.jpg"], new Map(), new Map(), new Map())).toEqual([]);
	});
});
