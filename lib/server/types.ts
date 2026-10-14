// ============================================================================
// 服务端共享类型（纯类型，无运行时依赖，可被客户端工具引用）
// ============================================================================

export type UserRole = "admin" | "user";

export type AssignmentStatus = "pending" | "submitted" | "revoked";

/** 工作簿快照（SpreadJS workbook.toJSON() 的结果） */
export type WorkbookJSON = Record<string, unknown>;

export interface User {
	id: string;
	name: string;
	role: UserRole;
	department: string | null;
	createdAt: number;
}

/** 模板字段地图条目：字段名 → 目标单元格地址 */
export interface TemplateField {
	name: string;
	address: string;
	sheetName?: string;
	valueType?: string;
}

/** 模板中引用的原始单据图片 */
export interface ImageRef {
	id: string;
	name: string;
}

export interface TemplateRecord {
	id: string;
	name: string;
	description: string | null;
	snapshot: WorkbookJSON;
	fields: TemplateField[];
	sourceImages: ImageRef[];
	version: number;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
}

/** images 表行 */
export interface StoredImage {
	id: string;
	fileName: string;
	mimeType: string;
	size: number;
	path: string;
	uploadedBy: string | null;
	createdAt: number;
}

export interface Assignment {
	id: string;
	templateId: string;
	userId: string;
	assignedBy: string;
	assignedAt: number;
	status: AssignmentStatus;
	submittedAt: number | null;
	submissionId: string | null;
	note: string | null;
}

export interface Submission {
	id: string;
	assignmentId: string;
	templateId: string;
	userId: string;
	snapshot: WorkbookJSON;
	images: string[];
	createdAt: number;
}

/** 分派记录 + 关联展示信息 */
export interface AssignmentView extends Assignment {
	templateName: string;
	userName: string;
	fields: TemplateField[];
	sourceImages: ImageRef[];
}

/** 提交记录 + 关联展示信息 */
export interface SubmissionView extends Submission {
	templateName: string;
	userName: string;
	imageRefs: ImageRef[];
}

/** 名称模糊匹配结果 */
export interface MatchResult<T> {
	status: "matched" | "not_found" | "ambiguous";
	value?: T;
	candidates?: Array<{ id: string; name: string }>;
}

export interface CreateAssignmentResult {
	created: AssignmentView[];
	unresolvedTemplate?: { query: string; candidates: Array<{ id: string; name: string }> };
	unresolvedUsers: Array<{ query: string; candidates: Array<{ id: string; name: string }> }>;
}
