import { z } from "zod/v4";
import type { ToolDef } from "../../types";
import { apiFetch, describeApiError } from "./api";

export interface UserSummary {
	id: string;
	name: string;
	role: "admin" | "user";
	department: string | null;
}

const inputSchema = z.object({});

const listUsers: ToolDef<z.infer<typeof inputSchema>, { users: UserSummary[] }> = {
	name: "list_users",
	displayName: "查询用户",
	description: "列出系统中的全部用户（1 名管理员 + 10 名员工）。分派模板前可用它核对收件人姓名。",
	inputSchema,
	handler: async () => {
		try {
			const { users } = await apiFetch<{ users: UserSummary[] }>("/api/users");
			return { success: true, data: { users } };
		} catch (e) {
			return { success: false, error: describeApiError(e) };
		}
	},
};

export default listUsers;
