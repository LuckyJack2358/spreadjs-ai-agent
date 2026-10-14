import { getRepo } from "@/lib/server/repo";
import { assertCanSubmitAssignment, getCurrentUser, resolveScope } from "@/lib/server/identity";
import { json, readJson, toErrorResponse } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 提交记录列表：管理员 scope=all；员工强制 mine */
export async function GET(req: Request) {
	try {
		const repo = getRepo();
		const user = getCurrentUser(req, repo);
		const url = new URL(req.url);
		const scope = resolveScope(user, url.searchParams.get("scope"));
		const list = repo.listSubmissions(scope === "mine" ? { userId: user.id } : {});
		return json({ submissions: list });
	} catch (e) {
		return toErrorResponse(e);
	}
}

/** 提交填写结果并锁定任务 */
export async function POST(req: Request) {
	try {
		const repo = getRepo();
		const user = getCurrentUser(req, repo);
		const body = await readJson<{
			assignmentId?: string;
			snapshot?: Record<string, unknown>;
			images?: string[];
		}>(req);
		const assignmentId = body.assignmentId?.trim();
		if (!assignmentId) return json({ error: "缺少 assignmentId" }, { status: 400 });
		if (!body.snapshot || typeof body.snapshot !== "object") {
			return json({ error: "缺少工作簿快照 snapshot" }, { status: 400 });
		}
		const assignment = repo.getAssignment(assignmentId);
		if (!assignment) return json({ error: "分派记录不存在" }, { status: 404 });
		assertCanSubmitAssignment(user, assignment);
		if (assignment.status !== "pending") {
			return json({ error: assignment.status === "revoked" ? "该任务已被撤回，无法提交" : "该任务已提交" }, { status: 409 });
		}

		const submission = repo.createSubmission({
			assignmentId: assignment.id,
			templateId: assignment.templateId,
			userId: assignment.userId,
			snapshot: body.snapshot,
			images: Array.isArray(body.images) ? body.images.filter((x) => typeof x === "string") : [],
		});
		repo.markSubmitted(assignment.id, submission.id);
		return json({ submission: repo.getSubmissionView(submission.id) });
	} catch (e) {
		return toErrorResponse(e);
	}
}
