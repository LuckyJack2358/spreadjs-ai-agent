// ============================================================================
// 身份与权限：cookie 解析、当前用户解析、角色校验、名称模糊匹配
// ============================================================================
import { DEFAULT_ADMIN_ID } from "./db";
import type { Repo } from "./repo";
import type {
	Assignment,
	AssignmentView,
	MatchResult,
	User,
} from "./types";

export const UID_COOKIE = "sjs_uid";

/** 解析 Cookie 头中的指定键 */
export function parseCookie(req: Request, name: string): string | undefined {
	const header = req.headers.get("cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq);
		if (key === name) {
			const raw = trimmed.slice(eq + 1);
			try {
				return decodeURIComponent(raw);
			} catch {
				return raw;
			}
		}
	}
	return undefined;
}

/** 从请求中解析当前用户；cookie 缺失/无效时回落到 admin（便于首次演示） */
export function getCurrentUser(req: Request, repo: Repo): User {
	const uid = parseCookie(req, UID_COOKIE);
	const user = uid ? repo.getUser(uid) : null;
	return user ?? repo.getUser(DEFAULT_ADMIN_ID)!;
}

export class AuthError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "AuthError";
		this.status = status;
	}
}

/** 要求管理员；否则抛出 403 */
export function assertAdmin(user: User): void {
	if (user.role !== "admin") throw new AuthError(403, "需要管理员权限");
}

/** 要求已登录（本系统无密码，cookie 有效即可） */
export function assertAuthenticated(user: User): void {
	if (!user) throw new AuthError(401, "未登录");
}

/** 员工只可读自己的分派；管理员可读全部 */
export function assertCanReadAssignment(user: User, targetUserId: string): void {
	if (user.role === "admin") return;
	if (user.id !== targetUserId) throw new AuthError(403, "无权访问他人的任务");
}

/** 员工只能提交自己的分派（管理员不受限，便于演示） */
export function assertCanSubmitAssignment(user: User, assignment: Pick<Assignment, "userId">): void {
	if (user.role === "admin") return;
	if (assignment.userId !== user.id) throw new AuthError(403, "不能替他人提交");
}

/** scope 参数解析：员工强制 mine */
export function resolveScope(user: User, scope: string | null): "mine" | "all" {
	if (user.role === "admin") return scope === "mine" ? "mine" : "all";
	if (scope === "all") throw new AuthError(403, "员工无权查看全部数据");
	return "mine";
}

/** 名称模糊匹配（大小写不敏感，去空白） */
export function matchByName<T extends { id: string; name: string }>(
	query: string,
	candidates: T[],
): MatchResult<T> {
	const q = query.trim().toLowerCase();
	if (!q) return { status: "not_found", candidates: [] };
	const exact = candidates.filter((c) => c.name.trim().toLowerCase() === q);
	if (exact.length === 1) return { status: "matched", value: exact[0] };
	if (exact.length > 1) {
		return { status: "ambiguous", candidates: exact.map(({ id, name }) => ({ id, name })) };
	}
	const partial = candidates.filter((c) => {
		const n = c.name.trim().toLowerCase();
		return n.includes(q) || q.includes(n);
	});
	if (partial.length === 1) return { status: "matched", value: partial[0] };
	if (partial.length > 1) {
		return { status: "ambiguous", candidates: partial.map(({ id, name }) => ({ id, name })) };
	}
	return { status: "not_found", candidates: [] };
}

/** 便捷：从分派视图提取给前端的最小结构 */
export function toAssignmentSummary(a: AssignmentView) {
	return {
		id: a.id,
		templateId: a.templateId,
		templateName: a.templateName,
		userId: a.userId,
		userName: a.userName,
		status: a.status,
		assignedAt: a.assignedAt,
		submittedAt: a.submittedAt,
		note: a.note,
		fields: a.fields,
		sourceImages: a.sourceImages,
	};
}
