// ============================================================================
// 图片落盘复用：附件阶段已拿到 imageId 时，save_template / submit_submission
// 不再把同一张图重新 POST /api/uploads（避免重复传几百 KB）
// ============================================================================
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadNamedImages } from "@/lib/tools/defs/form/save-template";

const DATA_URL = "data:image/jpeg;base64,AAAA";

function stubFetch() {
	const calls: Array<{ url: string; body: unknown }> = [];
	const fn = vi.fn(async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
		return new Response(JSON.stringify({ image: { id: "img_new", name: "new.jpg" } }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", fn);
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("uploadNamedImages", () => {
	it("已落盘的图片直接复用 imageId，不再重新上传", async () => {
		const calls = stubFetch();
		const refs = await uploadNamedImages(["a.jpg"], [{ name: "a.jpg", dataUrl: DATA_URL, imageId: "img_existing" }]);
		expect(refs).toEqual([{ id: "img_existing", name: "a.jpg" }]);
		expect(calls).toEqual([]);
	});

	it("只剩 imageId（刷新后靠历史消息兜底）时同样直接复用，不再上传", async () => {
		const calls = stubFetch();
		const refs = await uploadNamedImages(["blank.jpg"], [{ name: "blank.jpg", imageId: "img_hist" }]);
		expect(refs).toEqual([{ id: "img_hist", name: "blank.jpg" }]);
		expect(calls).toEqual([]);
	});

	it("文件名带空格也能命中已落盘的图片", async () => {
		const calls = stubFetch();
		const refs = await uploadNamedImages([" blank.jpg "], [{ name: "blank.jpg", imageId: "img_hist" }]);
		expect(refs).toEqual([{ id: "img_hist", name: "blank.jpg" }]);
		expect(calls).toEqual([]);
	});

	it("未落盘（上传失败回落）时仍走 POST /api/uploads", async () => {
		const calls = stubFetch();
		const refs = await uploadNamedImages(["a.jpg"], [{ name: "a.jpg", dataUrl: DATA_URL }]);
		expect(refs).toEqual([{ id: "img_new", name: "new.jpg" }]);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("/api/uploads");
		expect(calls[0].body).toEqual({ dataUrl: DATA_URL, fileName: "a.jpg" });
	});

	it("混合场景：只对缺失 imageId 的那张走上传", async () => {
		const calls = stubFetch();
		const refs = await uploadNamedImages(
			["a.jpg", "b.jpg"],
			[
				{ name: "a.jpg", dataUrl: DATA_URL, imageId: "img_a" },
				{ name: "b.jpg", dataUrl: DATA_URL },
			],
		);
		expect(refs.map((r) => r.id)).toEqual(["img_a", "img_new"]);
		expect(calls.map((c) => (c.body as { fileName: string }).fileName)).toEqual(["b.jpg"]);
	});

	it("没有名字或没有注入数据时不做任何请求", async () => {
		const calls = stubFetch();
		expect(await uploadNamedImages(undefined, [{ name: "a.jpg", dataUrl: DATA_URL }])).toEqual([]);
		expect(await uploadNamedImages(["missing.jpg"], [{ name: "a.jpg", dataUrl: DATA_URL }])).toEqual([]);
		expect(calls).toEqual([]);
	});
});
