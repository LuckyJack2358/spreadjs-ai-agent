import { describe, expect, it } from "vitest";
import { createDb } from "@/lib/server/db";
import { createRepo, RepoError, type Repo } from "@/lib/server/repo";

function freshRepo(): Repo {
	return createRepo(createDb(":memory:"));
}

function seedTemplate(repo: Repo, name = "差旅报销单") {
	return repo.upsertTemplate({
		name,
		description: "出差费用报销",
		snapshot: { version: "19.0.1", sheets: {} },
		fields: [{ name: "报销人", address: "B3", sheetName: name }],
		sourceImages: [],
		createdBy: "admin",
	});
}

function expectRepoError(fn: () => unknown, code: string) {
	try {
		fn();
	} catch (e) {
		expect(e).toBeInstanceOf(RepoError);
		expect((e as RepoError).code).toBe(code);
		return;
	}
	throw new Error(`期望抛出 RepoError(${code})，但没有抛错`);
}

describe("分派（assignments）状态机", () => {
	it("同一模板 + 同一人重复分派被拒；换人 / 换模板可成功", () => {
		const repo = freshRepo();
		const tpl = seedTemplate(repo);
		const tpl2 = seedTemplate(repo, "采购申请单");

		const first = repo.createAssignment({
			templateId: tpl.id,
			userId: "user1",
			assignedBy: "admin",
			note: "本月报销",
		});
		expect(first.status).toBe("pending");
		expect(first.userName).toBe("张三");
		expect(first.templateName).toBe("差旅报销单");
		expect(first.note).toBe("本月报销");

		expectRepoError(
			() =>
				repo.createAssignment({
					templateId: tpl.id,
					userId: "user1",
					assignedBy: "admin",
				}),
			"duplicate_pending",
		);

		// 换人：成功
		expect(
			repo.createAssignment({ templateId: tpl.id, userId: "user2", assignedBy: "admin" }).status,
		).toBe("pending");
		// 换模板：成功
		expect(
			repo.createAssignment({ templateId: tpl2.id, userId: "user1", assignedBy: "admin" }).status,
		).toBe("pending");

		expect(repo.listAssignments()).toHaveLength(3);
		expect(repo.listAssignments({ userId: "user1" })).toHaveLength(2);
		expect(repo.listAssignments({ status: "pending" })).toHaveLength(3);
	});

	it("模板 / 用户不存在时抛 not_found", () => {
		const repo = freshRepo();
		const tpl = seedTemplate(repo);
		expectRepoError(
			() => repo.createAssignment({ templateId: "tpl_x", userId: "user1", assignedBy: "admin" }),
			"not_found",
		);
		expectRepoError(
			() => repo.createAssignment({ templateId: tpl.id, userId: "user999", assignedBy: "admin" }),
			"not_found",
		);
	});

	it("提交后任务锁定：不可二次提交，也不可撤回", () => {
		const repo = freshRepo();
		const tpl = seedTemplate(repo);
		const asg = repo.createAssignment({ templateId: tpl.id, userId: "user1", assignedBy: "admin" });

		const sub = repo.createSubmission({
			assignmentId: asg.id,
			templateId: tpl.id,
			userId: "user1",
			snapshot: { filled: true },
			images: ["img_1"],
		});
		const locked = repo.markSubmitted(asg.id, sub.id);
		expect(locked.status).toBe("submitted");
		expect(locked.submissionId).toBe(sub.id);
		expect(locked.submittedAt).toBeTypeOf("number");

		expectRepoError(() => repo.markSubmitted(asg.id, "sub_again"), "assignment_locked");
		expectRepoError(() => repo.revokeAssignment(asg.id), "assignment_locked");
	});

	it("撤回后不可提交；撤回后可重新分派", () => {
		const repo = freshRepo();
		const tpl = seedTemplate(repo);
		const asg = repo.createAssignment({ templateId: tpl.id, userId: "user1", assignedBy: "admin" });

		const revoked = repo.revokeAssignment(asg.id);
		expect(revoked.status).toBe("revoked");
		expectRepoError(() => repo.markSubmitted(asg.id, "sub_1"), "assignment_locked");
		// 撤回后不再占用 pending 名额 → 可重新分派
		const again = repo.createAssignment({ templateId: tpl.id, userId: "user1", assignedBy: "admin" });
		expect(again.status).toBe("pending");
		expect(again.id).not.toBe(asg.id);
	});

	it("撤回不存在的分派抛 not_found；重复撤回保持 revoked", () => {
		const repo = freshRepo();
		const tpl = seedTemplate(repo);
		const asg = repo.createAssignment({ templateId: tpl.id, userId: "user1", assignedBy: "admin" });
		expectRepoError(() => repo.revokeAssignment("asg_missing"), "not_found");
		repo.revokeAssignment(asg.id);
		expect(repo.revokeAssignment(asg.id).status).toBe("revoked");
	});
});

describe("提交记录（submissions）", () => {
	it("提交记录带模板名 / 用户名 / 图片引用，并可跨用户筛选", () => {
		const repo = freshRepo();
		const tpl = seedTemplate(repo);
		repo.insertImage({
			id: "img_1",
			fileName: "filled.png",
			mimeType: "image/png",
			size: 1024,
			path: "/tmp/filled.png",
			uploadedBy: "user1",
		});

		const asg = repo.createAssignment({ templateId: tpl.id, userId: "user1", assignedBy: "admin" });
		const sub = repo.createSubmission({
			assignmentId: asg.id,
			templateId: tpl.id,
			userId: "user1",
			snapshot: { filled: 1 },
			images: ["img_1", "img_missing"],
		});
		repo.markSubmitted(asg.id, sub.id);

		const view = repo.getSubmissionView(sub.id)!;
		expect(view.templateName).toBe("差旅报销单");
		expect(view.userName).toBe("张三");
		expect(view.imageRefs).toEqual([{ id: "img_1", name: "filled.png" }]);
		expect(view.snapshot).toEqual({ filled: 1 });
		expect(view.images).toEqual(["img_1", "img_missing"]);

		expect(repo.listSubmissions()).toHaveLength(1);
		expect(repo.listSubmissions({ userId: "user1" })).toHaveLength(1);
		expect(repo.listSubmissions({ userId: "user2" })).toHaveLength(0);
		expect(repo.getSubmissionView("sub_missing")).toBeNull();
	});
});