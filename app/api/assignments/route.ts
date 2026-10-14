import { getRepo, RepoError } from "@/lib/server/repo";
import { assertAdmin, getCurrentUser, matchByName, resolveScope } from "@/lib/server/identity";
import { json, readJson, toErrorResponse } from "@/lib/server/http";
import type { AssignmentStatus, CreateAssignmentResult, TemplateRecord, User } from "@/lib/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES: AssignmentStatus[] = ["pending", "submitted", "revoked"];

/** 分派列表：管理员 scope=all；员工强制 mine */
export async function GET(req: Request) {
	try {
		const repo = getRepo();
		const user = getCurrentUser(req, repo);
		const url = new URL(req.url);
		const scope = resolveScope(user, url.searchParams.get("scope"));
		const statusRaw = url.searchParams.get("status");
		const status = statusRaw && STATUSES.includes(statusRaw as AssignmentStatus)
			? (statusRaw as AssignmentStatus)
			: undefined;
		const list = repo.listAssignments({
			...(scope === "mine" ? { userId: user.id } : {}),
			...(status ? { status } : {}),
		});
		return json({ assignments: list });
	} catch (e) {
		return toErrorResponse(e);
	}
}

/** 创建分派（管理员）：支持模板名 + 人名，模糊匹配失败/歧义时返回候选 */
export async function POST(req: Request) {
	try {
		const repo = getRepo();
		const user = getCurrentUser(req, repo);
		assertAdmin(user);
		const body = await readJson<{
			templateId?: string;
			templateName?: string;
			userIds?: string[];
			userNames?: string[];
			note?: string;
		}>(req);

		const result: CreateAssignmentResult = { created: [], unresolvedUsers: [] };

		// 1. 解析模板
		let template: TemplateRecord | null = null;
		if (body.templateId) {
			template = repo.getTemplate(body.templateId);
			if (!template) result.unresolvedTemplate = { query: body.templateId, candidates: [] };
		} else if (body.templateName) {
			const match = matchByName(body.templateName, repo.listTemplates());
			if (match.status === "matched" && match.value) {
				template = match.value;
			} else {
				result.unresolvedTemplate = { query: body.templateName, candidates: match.candidates ?? [] };
			}
		} else {
			result.unresolvedTemplate = { query: "", candidates: repo.listTemplates().map((t) => ({ id: t.id, name: t.name })) };
		}

		// 2. 解析用户
		const allUsers = repo.listUsers();
		const targets: User[] = [];
		if (body.userIds?.length) {
			for (const id of body.userIds) {
				const u = repo.getUser(id);
				if (u) targets.push(u);
				else result.unresolvedUsers.push({ query: id, candidates: [] });
			}
		} else if (body.userNames?.length) {
			for (const name of body.userNames) {
				const match = matchByName(name, allUsers);
				if (match.status === "matched" && match.value) targets.push(match.value);
				else result.unresolvedUsers.push({ query: name, candidates: match.candidates ?? [] });
			}
		}

		if (!template) return json({ ...result, error: "未找到匹配的模板" }, { status: 400 });
		if (targets.length === 0) return json({ ...result, error: "未找到匹配的用户" }, { status: 400 });

		// 3. 落库（重复 pending 跳过而非整体失败）
		const skipped: Array<{ userId: string; userName: string; reason: string }> = [];
		for (const t of targets) {
			try {
				result.created.push(
					repo.createAssignment({
						templateId: template.id,
						userId: t.id,
						assignedBy: user.id,
						note: body.note ?? null,
					}),
				);
			} catch (e) {
				if (e instanceof RepoError) {
					skipped.push({ userId: t.id, userName: t.name, reason: e.message });
				} else {
					throw e;
				}
			}
		}

		return json({ ...result, skipped });
	} catch (e) {
		return toErrorResponse(e);
	}
}
