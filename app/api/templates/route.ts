import { getRepo } from "@/lib/server/repo";
import { assertAdmin, getCurrentUser } from "@/lib/server/identity";
import { json, readJson, toErrorResponse } from "@/lib/server/http";
import type { ImageRef, TemplateField } from "@/lib/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeFields(raw: unknown): TemplateField[] {
	if (!Array.isArray(raw)) return [];
	const out: TemplateField[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const r = item as Record<string, unknown>;
		const name = typeof r.name === "string" ? r.name.trim() : "";
		const address = typeof r.address === "string" ? r.address.trim() : "";
		if (!name || !address) continue;
		out.push({
			name,
			address,
			...(typeof r.sheetName === "string" && r.sheetName ? { sheetName: r.sheetName } : {}),
			...(typeof r.valueType === "string" && r.valueType ? { valueType: r.valueType } : {}),
		});
	}
	return out;
}

function normalizeImageRefs(raw: unknown): ImageRef[] {
	if (!Array.isArray(raw)) return [];
	const out: ImageRef[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const r = item as Record<string, unknown>;
		const id = typeof r.id === "string" ? r.id : "";
		if (!id) continue;
		out.push({ id, name: typeof r.name === "string" ? r.name : id });
	}
	return out;
}

/** 模板列表：管理员看全部；员工仅看与自己分派相关的模板 */
export async function GET(req: Request) {
	try {
		const repo = getRepo();
		const user = getCurrentUser(req, repo);
		if (user.role === "admin") return json({ templates: repo.listTemplates() });
		const ids = new Set(repo.listAssignments({ userId: user.id }).map((a) => a.templateId));
		return json({ templates: repo.listTemplates().filter((t) => ids.has(t.id)) });
	} catch (e) {
		return toErrorResponse(e);
	}
}

/** 保存模板（管理员）：同名覆盖并 version + 1 */
export async function POST(req: Request) {
	try {
		const repo = getRepo();
		const user = getCurrentUser(req, repo);
		assertAdmin(user);
		const body = await readJson<{
			name?: string;
			description?: string;
			snapshot?: Record<string, unknown>;
			fields?: unknown;
			sourceImages?: unknown;
		}>(req);
		const name = body.name?.trim();
		if (!name) return json({ error: "缺少模板名称" }, { status: 400 });
		if (!body.snapshot || typeof body.snapshot !== "object") {
			return json({ error: "缺少工作簿快照 snapshot" }, { status: 400 });
		}
		const fields = normalizeFields(body.fields);
		const sourceImages = normalizeImageRefs(body.sourceImages);
		const template = repo.upsertTemplate({
			name,
			description: body.description ?? null,
			snapshot: body.snapshot,
			fields,
			sourceImages,
			createdBy: user.id,
		});
		return json({ template });
	} catch (e) {
		return toErrorResponse(e);
	}
}
