import { getRepo } from "@/lib/server/repo";
import { getCurrentUser } from "@/lib/server/identity";
import { json, toErrorResponse } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** 提交详情（管理员或本人） */
export async function GET(req: Request, { params }: Ctx) {
	try {
		const { id } = await params;
		const repo = getRepo();
		const user = getCurrentUser(req, repo);
		const submission = repo.getSubmissionView(id);
		if (!submission) return json({ error: "提交记录不存在" }, { status: 404 });
		if (user.role !== "admin" && submission.userId !== user.id) {
			return json({ error: "无权访问该提交记录" }, { status: 403 });
		}
		return json({ submission });
	} catch (e) {
		return toErrorResponse(e);
	}
}
