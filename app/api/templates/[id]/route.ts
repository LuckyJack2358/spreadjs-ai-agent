import { getRepo } from "@/lib/server/repo";
import { assertAdmin, getCurrentUser } from "@/lib/server/identity";
import { json, toErrorResponse } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
	try {
		const { id } = await params;
		const repo = getRepo();
		const user = getCurrentUser(req, repo);
		const template = repo.getTemplate(id);
		if (!template) return json({ error: "模板不存在" }, { status: 404 });
		if (user.role !== "admin") {
			const assigned = repo
				.listAssignments({ userId: user.id })
				.some((a) => a.templateId === template.id);
			if (!assigned) return json({ error: "无权访问该模板" }, { status: 403 });
		}
		return json({ template });
	} catch (e) {
		return toErrorResponse(e);
	}
}

export async function DELETE(req: Request, { params }: Ctx) {
	try {
		const { id } = await params;
		const repo = getRepo();
		const user = getCurrentUser(req, repo);
		assertAdmin(user);
		const ok = repo.deleteTemplate(id);
		if (!ok) return json({ error: "模板不存在" }, { status: 404 });
		return json({ success: true });
	} catch (e) {
		return toErrorResponse(e);
	}
}
