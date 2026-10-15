import { describe, expect, it } from "vitest";
import { compactPersistedMessages } from "@/lib/agent/session-store";
import { uploadUrlFor } from "@/lib/agent/image-ref";
import type { AppUIMessage } from "@/lib/agent/ui-message";

function message(parts: AppUIMessage["parts"]): AppUIMessage {
	return { id: "m1", role: "assistant", parts } as unknown as AppUIMessage;
}

describe("compactPersistedMessages", () => {
	it("图片保留 uploadId 引用并移除 data URL", () => {
		const dataUrl = "data:image/png;base64," + "A".repeat(10_000);
		const input = [message([
			{ type: "file", filename: "receipt.png", mediaType: "image/png", url: uploadUrlFor("img_1") },
			{ type: "file", filename: "fallback.png", mediaType: "image/png", url: dataUrl },
		] as never)];
		const out = compactPersistedMessages(input);
		expect((out[0].parts[0] as { url: string }).url).toBe(uploadUrlFor("img_1"));
		expect((out[0].parts[1] as { url: string }).url).not.toContain("base64");
		expect((input[0].parts[1] as { url: string }).url).toBe(dataUrl);
	});

	it("普通大工具结果裁剪，但业务字段地图和 submissionId 完整保留", () => {
		const input = [message([
			{
				type: "tool-read_ranges",
				state: "output-available",
				input: {},
				output: { success: true, data: "x".repeat(10_000) },
			} as never,
			{
				type: "tool-submit_submission",
				state: "output-available",
				input: {},
				output: {
					success: true,
					data: {
						submissionId: "sub_1",
						assignmentId: "asg_1",
						fields: [{ name: "金额", address: "B2", value: "100" }],
						images: [{ name: "receipt.png", dataUrl: "data:image/png;base64,AAAA" }],
					},
				},
			} as never,
		] as never)];
		const out = compactPersistedMessages(input);
		const readOutput = (out[0].parts[0] as { output: Record<string, unknown> }).output;
		expect(readOutput.truncated).toBe(true);
		const submitOutput = (out[0].parts[1] as { output: { data: Record<string, unknown> } }).output;
		expect(submitOutput.data.submissionId).toBe("sub_1");
		expect(submitOutput.data.assignmentId).toBe("asg_1");
		expect(submitOutput.data.fields).toEqual([{ name: "金额", address: "B2", value: "100" }]);
		expect(JSON.stringify(submitOutput)).not.toContain("base64");
	});
});
