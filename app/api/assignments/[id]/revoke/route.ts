import { getRepo } from "@/lib/server/repo";
import { assertAdmin, getCurrentUser } from "@/lib/server/identity";
import { json, toErrorResponse } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** 撤回分派（管理员）。已提交的任务不可撤回。 */
export async function POST(req: Request, { params }: Ctx) {
	try {
		const { id } = await params;
		const repo = getRepo();
		const user = getCurrentUser(req, repo);
		assertAdmin(user);
		const assignment = repo.revokeAssignment(id);
		return json({ assignment });
	} catch (e) {
		return toErrorResponse(e);
	}
}
