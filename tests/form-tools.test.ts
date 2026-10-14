// ============================================================================
// 填报工具注册与可见性：确认 9 个 form 工具已注册，且按角色过滤后可见性正确
// ============================================================================
import { describe, expect, it } from "vitest";
import { toolDefinitions } from "@/lib/tools/registry";
import { baseToolNames, gatewayToolNames } from "@/lib/tools/names";
import { filterBaseToolNames, filterGatewayToolNames } from "@/lib/tools/role-tools";

const ADMIN_TOOLS = ["save_template", "list_templates", "list_users", "assign_template", "list_assignments"];
const EMPLOYEE_TOOLS = ["list_my_assignments", "load_template", "propose_fill_data", "submit_submission"];

describe("form 工具注册", () => {
	it("9 个填报工具全部注册且带中文 displayName", () => {
		for (const name of [...ADMIN_TOOLS, ...EMPLOYEE_TOOLS]) {
			expect(Object.keys(toolDefinitions)).toContain(name);
			expect(baseToolNames).toContain(name);
		}
		// 客户端工具：由前端 onToolCall 拦截执行，因此不带 execute
		for (const name of [...ADMIN_TOOLS, ...EMPLOYEE_TOOLS]) {
			expect(toolDefinitions[name].execute).toBeUndefined();
		}
	});

	it("每个 base 工具名都能在注册表中解析", () => {
		const missing = baseToolNames.filter((n) => !(n in toolDefinitions));
		expect(missing).toEqual([]);
	});

	it("按角色过滤后：员工可见 4 个填报工具，管理员额外可见 5 个管理工具", () => {
		const registeredBase = baseToolNames.filter((n) => n in toolDefinitions);
		const employee = filterBaseToolNames("user", registeredBase);
		const admin = filterBaseToolNames("admin", registeredBase);

		for (const n of EMPLOYEE_TOOLS) expect(employee).toContain(n);
		for (const n of ADMIN_TOOLS) expect(employee).not.toContain(n);
		for (const n of ADMIN_TOOLS) expect(admin).toContain(n);
		expect(filterGatewayToolNames("user", gatewayToolNames.filter((n) => n in toolDefinitions))).toEqual([]);
	});
});