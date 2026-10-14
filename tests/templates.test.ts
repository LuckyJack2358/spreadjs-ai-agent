import { describe, expect, it } from "vitest";
import { createDb } from "@/lib/server/db";
import { createRepo } from "@/lib/server/repo";
import type { TemplateField } from "@/lib/server/types";

const fields: TemplateField[] = [
	{ name: "报销人", address: "B3", sheetName: "差旅报销单", valueType: "text" },
	{ name: "出差事由", address: "B4", sheetName: "差旅报销单" },
	{ name: "金额合计", address: "F12", sheetName: "差旅报销单", valueType: "number" },
];

function freshRepo() {
	const db = createDb(":memory:");
	return createRepo(db);
}

describe("模板 CRUD 与字段地图", () => {
	it("新建模板后可从列表/单条查询到，且字段地图 JSON 往返一致", () => {
		const repo = freshRepo();
		const created = repo.upsertTemplate({
			name: "差旅报销单",
			description: "出差费用报销",
			snapshot: { version: "19.0.1", sheets: {} },
			fields,
			sourceImages: [{ id: "img_1", name: "blank.png" }],
			createdBy: "admin",
		});

		expect(created.id).toMatch(/^tpl_/);
		expect(created.version).toBe(1);
		expect(created.fields).toEqual(fields);
		expect(repo.listTemplates()).toHaveLength(1);

		const fetched = repo.getTemplate(created.id)!;
		expect(fetched.fields).toEqual(fields);
		expect(fetched.sourceImages).toEqual([{ id: "img_1", name: "blank.png" }]);
		expect(fetched.snapshot).toEqual({ version: "19.0.1", sheets: {} });
	});

	it("按名称查询（唯一）", () => {
		const repo = freshRepo();
		repo.upsertTemplate({
			name: "采购申请单",
			snapshot: {},
			fields: [],
			sourceImages: [],
			createdBy: "admin",
		});
		expect(repo.getTemplateByName("采购申请单")?.name).toBe("采购申请单");
		expect(repo.getTemplateByName("不存在")).toBeNull();
	});

	it("同名保存为覆盖：id 不变、version + 1、内容更新", () => {
		const repo = freshRepo();
		const first = repo.upsertTemplate({
			name: "差旅报销单",
			description: "v1",
			snapshot: { v: 1 },
			fields,
			sourceImages: [],
			createdBy: "admin",
		});

		const second = repo.upsertTemplate({
			name: "差旅报销单",
			description: "v2",
			snapshot: { v: 2 },
			fields: [{ name: "备注", address: "A20" }],
			sourceImages: [],
			createdBy: "admin",
		});

		expect(second.id).toBe(first.id);
		expect(second.version).toBe(2);
		expect(second.description).toBe("v2");
		expect(second.snapshot).toEqual({ v: 2 });
		expect(second.fields).toEqual([{ name: "备注", address: "A20" }]);
		expect(repo.listTemplates()).toHaveLength(1);

		// 再次覆盖 → version 3
		const third = repo.upsertTemplate({
			name: "差旅报销单",
			snapshot: { v: 3 },
			fields: [],
			sourceImages: [],
			createdBy: "admin",
		});
		expect(third.version).toBe(3);
	});

	it("删除模板", () => {
		const repo = freshRepo();
		const t = repo.upsertTemplate({
			name: "临时模板",
			snapshot: {},
			fields: [],
			sourceImages: [],
			createdBy: "admin",
		});
		expect(repo.deleteTemplate(t.id)).toBe(true);
		expect(repo.deleteTemplate(t.id)).toBe(false);
		expect(repo.listTemplates()).toHaveLength(0);
	});
});