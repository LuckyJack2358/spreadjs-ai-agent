// ============================================================================
// 权限矩阵：直接调用 route handler，用 cookie 伪装身份，断言 HTTP 状态码。
// route handler 内部使用 getRepo() 单例 → 依赖 tests/setup.ts 注入的临时 DB。
// ============================================================================
import { beforeAll, describe, expect, it } from "vitest";
import { getRepo } from "@/lib/server/repo";
import { assertAdmin, assertCanSubmitAssignment, AuthError, resolveScope } from "@/lib/server/identity";
import type { User } from "@/lib/server/types";
import { GET as getUsers } from "@/app/api/users/route";
import { GET as getTemplates, POST as postTemplate } from "@/app/api/templates/route";
import { GET as getAssignments, POST as postAssignment } from "@/app/api/assignments/route";
import { POST as revokeAssignment } from "@/app/api/assignments/[id]/revoke/route";
import { GET as getSubmissions, POST as postSubmission } from "@/app/api/submissions/route";

const ADMIN: User = { id: "admin", name: "系统管理员", role: "admin", department: "信息中心", createdAt: 0 };
const EMPLOYEE: User = { id: "user1", name: "张三", role: "user", department: "销售部", createdAt: 0 };

function req(path: string, opts: { uid?: string; method?: string; body?: unknown } = {}): Request {
	const headers = new Headers();
	if (opts.uid) headers.set("cookie", `sjs_uid=${opts.uid}`);
	let body: string | undefined;
	if (opts.body !== undefined) {
		headers.set("content-type", "application/json");
		body = JSON.stringify(opts.body);
	}
	return new Request(`http://localhost${path}`, { method: opts.method ?? "GET", headers, body });
}

async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

let templateId = "";
let zhangAssignmentId = "";

beforeAll(() => {
	const repo = getRepo();
	const tpl = repo.upsertTemplate({
		name: "权限测试模板",
		snapshot: { v: 1 },
		fields: [{ name: "报销人", address: "B3" }],
		sourceImages: [],
		createdBy: "admin",
	});
	templateId = tpl.id;
	const asg = repo.createAssignment({ templateId: tpl.id, userId: "user1", assignedBy: "admin" });
	zhangAssignmentId = asg.id;
});

describe("身份解析（GET /api/identity 等价逻辑：cookie 回落 admin）", () => {
	it("/api/users 返回 11 个身份（1 管理员 + 10 员工）", async () => {
		const res = await getUsers();
		expect(res.status).toBe(200);
		const data = await body<{ users: User[] }>(res);
		expect(data.users).toHaveLength(11);
		expect(data.users.filter((u) => u.role === "admin")).toHaveLength(1);
	});
});

describe("权限矩阵：员工受限，管理员全通", () => {
	it("员工建模板 → 403；管理员建模板 → 200", async () => {
		const denied = await postTemplate(
			req("/api/templates", { method: "POST", uid: "user1", body: { name: "员工偷建", snapshot: {} } }),
		);
		expect(denied.status).toBe(403);

		const ok = await postTemplate(
			req("/api/templates", {
				method: "POST",
				uid: "admin",
				body: { name: "管理员建模板", snapshot: { v: 2 }, fields: [{ name: "金额", address: "F1" }] },
			}),
		);
		expect(ok.status).toBe(200);
		const data = await body<{ template: { name: string; version: number } }>(ok);
		expect(data.template.name).toBe("管理员建模板");
		expect(data.template.version).toBe(1);
	});

	it("员工分派 → 403；管理员分派 → 200", async () => {
		const denied = await postAssignment(
			req("/api/assignments", {
				method: "POST",
				uid: "user1",
				body: { templateId, userIds: ["user2"] },
			}),
		);
		expect(denied.status).toBe(403);

		const ok = await postAssignment(
			req("/api/assignments", {
				method: "POST",
				uid: "admin",
				body: { templateName: "权限测试模板", userNames: ["李四"] },
			}),
		);
		expect(ok.status).toBe(200);
		const data = await body<{ created: Array<{ userId: string; status: string }> }>(ok);
		expect(data.created).toHaveLength(1);
		expect(data.created[0].userId).toBe("user2");
		expect(data.created[0].status).toBe("pending");
	});

	it("员工查 scope=all → 403；管理员 scope=all → 200 且能看到全部分派", async () => {
		const denied = await getAssignments(req("/api/assignments?scope=all", { uid: "user1" }));
		expect(denied.status).toBe(403);

		const ok = await getAssignments(req("/api/assignments?scope=all", { uid: "admin" }));
		expect(ok.status).toBe(200);
		const data = await body<{ assignments: unknown[] }>(ok);
		expect(data.assignments.length).toBeGreaterThanOrEqual(2);
	});

	it("员工默认 scope=mine 只看到自己的任务", async () => {
		const res = await getAssignments(req("/api/assignments", { uid: "user1" }));
		expect(res.status).toBe(200);
		const data = await body<{ assignments: Array<{ userId: string }> }>(res);
		expect(data.assignments.length).toBeGreaterThan(0);
		expect(data.assignments.every((a) => a.userId === "user1")).toBe(true);
	});

	it("员工提交他人分派 → 403；提交自己的分派 → 200 并锁定", async () => {
		const repo = getRepo();
		const othersAssignment = repo.listAssignments({ userId: "user2" }).find((a) => a.status === "pending")!;
		expect(othersAssignment).toBeDefined();

		const denied = await postSubmission(
			req("/api/submissions", {
				method: "POST",
				uid: "user1",
				body: { assignmentId: othersAssignment.id, snapshot: { x: 1 } },
			}),
		);
		expect(denied.status).toBe(403);

		const ok = await postSubmission(
			req("/api/submissions", {
				method: "POST",
				uid: "user1",
				body: { assignmentId: zhangAssignmentId, snapshot: { filled: true }, images: [] },
			}),
		);
		expect(ok.status).toBe(200);
		const data = await body<{ submission: { assignmentId: string; userName: string } }>(ok);
		expect(data.submission.assignmentId).toBe(zhangAssignmentId);
		expect(data.submission.userName).toBe("张三");

		// 二次提交 → 409（任务已锁定）
		const again = await postSubmission(
			req("/api/submissions", {
				method: "POST",
				uid: "user1",
				body: { assignmentId: zhangAssignmentId, snapshot: { filled: true } },
			}),
		);
		expect(again.status).toBe(409);
	});

	it("员工撤回他人任务 → 403；管理员撤回 → 200", async () => {
		const repo = getRepo();
		const target = repo.listAssignments({ userId: "user2" }).find((a) => a.status === "pending")!;

		const denied = await revokeAssignment(req(`/api/assignments/${target.id}/revoke`, { method: "POST", uid: "user1" }), {
			params: Promise.resolve({ id: target.id }),
		});
		expect(denied.status).toBe(403);

		const ok = await revokeAssignment(req(`/api/assignments/${target.id}/revoke`, { method: "POST", uid: "admin" }), {
			params: Promise.resolve({ id: target.id }),
		});
		expect(ok.status).toBe(200);
		const data = await body<{ assignment: { status: string } }>(ok);
		expect(data.assignment.status).toBe("revoked");
	});

	it("员工模板列表被过滤为自己任务涉及的模板", async () => {
		const res = await getTemplates(req("/api/templates", { uid: "user1" }));
		expect(res.status).toBe(200);
		const data = await body<{ templates: Array<{ id: string }> }>(res);
		expect(data.templates.map((t) => t.id)).toContain(templateId);
		// 管理员新建但未分派给 user1 的模板不应出现
		const repo = getRepo();
		const adminOnly = repo.getTemplateByName("管理员建模板")!;
		expect(data.templates.map((t) => t.id)).not.toContain(adminOnly.id);
	});

	it("员工提交记录 scope=mine 只含自己；管理员可见全部", async () => {
		const mine = await getSubmissions(req("/api/submissions?scope=mine", { uid: "user1" }));
		expect(mine.status).toBe(200);
		const mineData = await body<{ submissions: Array<{ userId: string }> }>(mine);
		expect(mineData.submissions.every((s) => s.userId === "user1")).toBe(true);

		const all = await getSubmissions(req("/api/submissions?scope=all", { uid: "admin" }));
		expect(all.status).toBe(200);
	});
});

describe("identity 守卫单元行为", () => {
	it("assertAdmin 对员工抛 403", () => {
		expect(() => assertAdmin(EMPLOYEE)).toThrow(AuthError);
		try {
			assertAdmin(EMPLOYEE);
		} catch (e) {
			expect((e as AuthError).status).toBe(403);
		}
		expect(() => assertAdmin(ADMIN)).not.toThrow();
	});

	it("resolveScope：员工 all → 403，mine/缺省 → mine；管理员 → all/mine", () => {
		expect(resolveScope(EMPLOYEE, null)).toBe("mine");
		expect(resolveScope(EMPLOYEE, "mine")).toBe("mine");
		expect(() => resolveScope(EMPLOYEE, "all")).toThrow(AuthError);
		expect(resolveScope(ADMIN, "all")).toBe("all");
		expect(resolveScope(ADMIN, null)).toBe("all");
		expect(resolveScope(ADMIN, "mine")).toBe("mine");
	});

	it("assertCanSubmitAssignment：员工不能提交他人分派", () => {
		expect(() => assertCanSubmitAssignment(EMPLOYEE, { userId: "user2" })).toThrow(AuthError);
		expect(() => assertCanSubmitAssignment(EMPLOYEE, { userId: "user1" })).not.toThrow();
		expect(() => assertCanSubmitAssignment(ADMIN, { userId: "user2" })).not.toThrow();
	});
});