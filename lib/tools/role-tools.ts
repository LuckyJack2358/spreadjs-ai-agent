// ============================================================================
// 按角色过滤工具集：
// - 管理员：现有全部工具 + 管理类工具（save_template / assign_template ...）
// - 员工：仅填报工具 + read_ranges（只读核对模板结构）
// ============================================================================
import type { UserRole } from "@/lib/server/types";

/** 管理员专属：模板制作与分派 */
export const ADMIN_FORM_TOOLS = [
	"save_template",
	"list_templates",
	"list_users",
	"assign_template",
	"list_assignments",
] as const;

/** 员工专属：查看任务 / 载入模板 / 提交 */
export const EMPLOYEE_FORM_TOOLS = [
	"list_my_assignments",
	"load_template",
	"propose_fill_data",
	"submit_submission",
] as const;

export const ADMIN_FORM_TOOL_SET: ReadonlySet<string> = new Set(ADMIN_FORM_TOOLS);
export const EMPLOYEE_FORM_TOOL_SET: ReadonlySet<string> = new Set(EMPLOYEE_FORM_TOOLS);

/** 员工可用基础工具集合 = 填报工具 + read_ranges */
export const EMPLOYEE_ALLOWED_TOOL_SET: ReadonlySet<string> = new Set<string>([
	...EMPLOYEE_FORM_TOOLS,
	"read_ranges",
]);

/** 过滤基础工具（baseToolNames） */
export function filterBaseToolNames(role: UserRole, baseNames: readonly string[]): string[] {
	if (role === "admin") return [...baseNames];
	return baseNames.filter((n) => EMPLOYEE_ALLOWED_TOOL_SET.has(n));
}

/** 过滤网关工具：员工一律不可用 */
export function filterGatewayToolNames(role: UserRole, gatewayNames: readonly string[]): string[] {
	if (role === "admin") return [...gatewayNames];
	return [];
}

/** 员工视角下当前可调用的全部工具名（用于断言/调试） */
export function allowedToolNamesForRole(role: UserRole): string[] {
	if (role === "admin") return [...ADMIN_FORM_TOOLS];
	return [...EMPLOYEE_ALLOWED_TOOL_SET];
}
