import { describe, expect, it } from "vitest";
import { baseToolNames, gatewayToolNames } from "@/lib/tools/names";
import {
	ADMIN_FORM_TOOLS,
	allowedToolNamesForRole,
	EMPLOYEE_ALLOWED_TOOL_SET,
	EMPLOYEE_FORM_TOOLS,
	filterBaseToolNames,
	filterGatewayToolNames,
} from "@/lib/tools/role-tools";

describe("角色工具集过滤", () => {
	it("员工只保留填报工具 + read_ranges", () => {
		const filtered = filterBaseToolNames("user", baseToolNames);
		expect(new Set(filtered)).toEqual(new Set(EMPLOYEE_ALLOWED_TOOL_SET));
		expect(filtered).toContain("read_ranges");
		for (const t of EMPLOYEE_FORM_TOOLS) expect(filtered).toContain(t);
	});

	it("员工看不到写数据 / 管理类 / 网关类工具", () => {
		const filtered = filterBaseToolNames("user", baseToolNames);
		for (const t of [
			"write_data",
			"set_cell",
			"clear_cells",
			"export_file",
			"execute_code",
			"manage_format",
			"save_template",
			"list_templates",
			"list_users",
			"assign_template",
			"list_assignments",
		]) {
			expect(filtered).not.toContain(t);
		}
	});

	it("员工不可使用任何网关工具", () => {
		expect(filterGatewayToolNames("user", gatewayToolNames)).toEqual([]);
	});

	it("管理员获得全部基础工具与网关工具", () => {
		expect(filterBaseToolNames("admin", baseToolNames)).toEqual([...baseToolNames]);
		expect(filterGatewayToolNames("admin", gatewayToolNames)).toEqual([...gatewayToolNames]);
		for (const t of ADMIN_FORM_TOOLS) expect(filterBaseToolNames("admin", baseToolNames)).toContain(t);
	});

	it("allowedToolNamesForRole 反映角色可见集合", () => {
		const admin = allowedToolNamesForRole("admin");
		expect(new Set(admin)).toEqual(new Set(ADMIN_FORM_TOOLS));

		const user = allowedToolNamesForRole("user");
		expect(new Set(user)).toEqual(new Set(EMPLOYEE_ALLOWED_TOOL_SET));
		expect(user).toHaveLength(EMPLOYEE_FORM_TOOLS.length + 1);
	});
});