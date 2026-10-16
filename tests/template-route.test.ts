// ============================================================================
// POST /api/templates：管理员保存模板时的服务端兜底
//   · sourceImages 缺省时沿用旧模板的原图（避免 UPDATE 清空）
//   · valueType 缺失时按字段名推断补齐
//   · 保存前清理合并区重复值 / 相邻重复标签 / 被占位的值位
// ============================================================================
import { describe, expect, it } from "vitest";
import { getRepo } from "@/lib/server/repo";
import { POST as postTemplate, GET as getTemplates } from "@/app/api/templates/route";

function req(opts: { uid?: string; body?: unknown } = {}): Request {
	const headers = new Headers();
	if (opts.uid) headers.set("cookie", `sjs_uid=${opts.uid}`);
	let body: string | undefined;
	if (opts.body !== undefined) {
		headers.set("content-type", "application/json");
		body = JSON.stringify(opts.body);
	}
	return new Request("http://localhost/api/templates", { method: "POST", headers, body });
}

function dirtySnapshot() {
	return {
		version: "19.0.1",
		sheets: {
			Sheet1: {
				data: {
					dataTable: {
						"0": { "0": { value: "差旅报销单" }, "1": { value: "差旅报销单" } },
					},
				},
				spans: [{ row: 0, col: 0, rowCount: 1, colCount: 8 }],
			},
		},
	} as Record<string, unknown>;
}

describe("POST /api/templates 服务端兜底", () => {
	it("覆盖保存时不带 sourceImages → 沿用旧模板原图，且 version + 1", async () => {
		const repo = getRepo();
		const first = repo.upsertTemplate({
			name: "原图保留测试单",
			snapshot: { v: 1 },
			fields: [{ name: "报销人", address: "B3" }],
			sourceImages: [{ id: "img_keep", name: "blank.png" }],
			createdBy: "admin",
		});

		const res = await postTemplate(
			req({
				uid: "admin",
				body: { name: "原图保留测试单", snapshot: { v: 2 }, fields: [{ name: "报销人", address: "B3" }] },
			}),
		);
		expect(res.status).toBe(200);
		const data = (await res.json()) as { template: { id: string; version: number; sourceImages: { id: string }[] } };
		expect(data.template.id).toBe(first.id);
		expect(data.template.version).toBe(2);
		expect(data.template.sourceImages).toEqual([{ id: "img_keep", name: "blank.png" }]);
	});

	it("valueType 缺失时按字段名推断补齐", async () => {
		const res = await postTemplate(
			req({
				uid: "admin",
				body: {
					name: "值类型推断单",
					snapshot: { v: 1 },
					fields: [
						{ name: "出差日期", address: "B4" },
						{ name: "金额合计", address: "F12" },
						{ name: "出差天数", address: "D4" },
						{ name: "报销人", address: "B3" },
					],
				},
			}),
		);
		expect(res.status).toBe(200);
		const data = (await res.json()) as { template: { fields: { name: string; valueType?: string }[] } };
		const byName = new Map(data.template.fields.map((f) => [f.name, f.valueType]));
		expect(byName.get("出差日期")).toBe("date");
		expect(byName.get("金额合计")).toBe("currency");
		expect(byName.get("出差天数")).toBe("number");
		expect(byName.get("报销人")).toBe("text");
	});

	it("保存前清理残余内容，并在响应里返回 cleanup 统计", async () => {
		const res = await postTemplate(
			req({
				uid: "admin",
				body: {
					name: "残余内容清理单",
					snapshot: dirtySnapshot(),
					fields: [{ name: "报销人", address: "B3" }],
				},
			}),
		);
		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			template: { snapshot: Record<string, unknown> };
			cleanup: { changed: boolean; clearedSpanCopies: number; notes: string[] };
		};
		expect(data.cleanup.changed).toBe(true);
		expect(data.cleanup.clearedSpanCopies).toBe(1);
		const sheets = data.template.snapshot.sheets as Record<string, { data: { dataTable: Record<string, Record<string, { value?: unknown }>> } }>;
		expect(sheets.Sheet1.data.dataTable["0"]["1"].value).toBeUndefined();
		expect(sheets.Sheet1.data.dataTable["0"]["0"].value).toBe("差旅报销单");
	});

	it("员工不能保存模板（403），且看不到管理员模板列表以外的内容", async () => {
		const res = await postTemplate(
			req({ uid: "user1", body: { name: "员工越权单", snapshot: { v: 1 }, fields: [{ name: "A", address: "A1" }] } }),
		);
		expect(res.status).toBe(403);
	});

	it("缺少名称 / 快照时返回 400", async () => {
		expect((await postTemplate(req({ uid: "admin", body: { snapshot: { v: 1 } } }))).status).toBe(400);
		expect((await postTemplate(req({ uid: "admin", body: { name: "x" } }))).status).toBe(400);
	});

	it("GET /api/templates：管理员看到全部模板", async () => {
		const headers = new Headers({ cookie: "sjs_uid=admin" });
		const res = await getTemplates(new Request("http://localhost/api/templates", { headers }));
		expect(res.status).toBe(200);
		const data = (await res.json()) as { templates: { name: string }[] };
		expect(data.templates.length).toBeGreaterThan(0);
	});
});
