import { describe, expect, it } from "vitest";
import { createDb, DEFAULT_ADMIN_ID, initSchema, seedDatabase } from "@/lib/server/db";
import { createRepo } from "@/lib/server/repo";

describe("SQLite 建表与种子数据", () => {
	const db = createDb(":memory:");
	const repo = createRepo(db);

	it("创建全部业务表", () => {
		const rows = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as Array<{ name: string }>;
		const names = rows.map((r) => r.name);
		for (const table of ["users", "templates", "images", "assignments", "submissions"]) {
			expect(names).toContain(table);
		}
	});

	it("种子 11 个身份：1 管理员 + 10 员工", () => {
		const users = repo.listUsers();
		expect(users).toHaveLength(11);
		expect(users.filter((u) => u.role === "admin")).toHaveLength(1);
		expect(users.filter((u) => u.role === "user")).toHaveLength(10);
	});

	it("管理员与员工的关键字段符合预期", () => {
		const admin = repo.getUser(DEFAULT_ADMIN_ID);
		expect(admin).not.toBeNull();
		expect(admin!.role).toBe("admin");

		const zhang = repo.getUser("user1");
		expect(zhang?.name).toBe("张三");
		expect(zhang?.role).toBe("user");
		expect(zhang?.department).toBe("销售部");

		expect(repo.getUser("user10")?.name).toBe("王十二");
		expect(repo.getUser("不存在")).toBeNull();
	});

	it("建表与种子可重复执行（幂等）", () => {
		initSchema(db);
		seedDatabase(db);
		expect(repo.listUsers()).toHaveLength(11);
		expect(repo.listUsers().filter((u) => u.role === "admin")).toHaveLength(1);
	});
});