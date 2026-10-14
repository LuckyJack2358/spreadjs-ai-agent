import {
	isDataUIPart,
	isToolUIPart,
	type DynamicToolUIPart,
	type ToolUIPart,
	type UIMessage,
} from "ai";
import type { ToolResult } from "@/lib/agent/types";
import type { Task } from "@/lib/agent/task-types";
import { builtinToolNames, type BuiltinToolName } from "@/lib/tools/names";

export interface RetryStatusData {
	attempt: number;
	maxRetries: number;
	reason: string;
}

export interface AddTasksInput {
	tasks: Array<{
		id: string;
		label: string;
	}>;
}

export interface AskUserInput {
	question: string;
	options: string[];
}

export interface CompleteTaskInput {
	taskId: string;
}

export interface TaskToolData {
	planId: string | null;
	tasks: Task[];
}

export interface AddTasksOutputData extends TaskToolData {
	taskCount: number;
}

export interface CompleteTaskOutputData extends TaskToolData {
	completedTaskId: string;
	nextTask: string | null;
	remaining: number;
}

export interface AskUserOutputData {
	question: string;
	options: string[];
	awaitingSelection: true;
}

export interface ProposeFillDataItem {
	field: string;
	address: string;
	value: string;
	confidence?: number;
	note?: string;
}

export interface ProposeFillDataInput {
	assignmentId: string;
	items: ProposeFillDataItem[];
	recognizedFrom?: string;
}

export interface ProposeFillDataOutputData {
	assignmentId: string;
	items: ProposeFillDataItem[];
	lowConfidenceCount: number;
	recognizedFrom?: string;
}

export type AppDataParts = Record<string, unknown> & {
	"retry-status": RetryStatusData;
};

type AppToolName = BuiltinToolName | "take_screenshot";

type GenericAppTool = {
	input: Record<string, unknown>;
	output: unknown;
};

type SpecialAppTools = {
	add_tasks: {
		input: AddTasksInput;
		output: ToolResult<AddTasksOutputData>;
	};
	complete_task: {
		input: CompleteTaskInput;
		output: ToolResult<CompleteTaskOutputData>;
	};
	ask_user: {
		input: AskUserInput;
		output: ToolResult<AskUserOutputData>;
	};
	propose_fill_data: {
		input: ProposeFillDataInput;
		output: ToolResult<ProposeFillDataOutputData>;
	};
};

type GenericAppTools = {
	[NAME in Exclude<AppToolName, keyof SpecialAppTools>]: GenericAppTool;
};

export type AppTools = GenericAppTools & SpecialAppTools;
export type AppUIMessage = UIMessage<unknown, AppDataParts, AppTools> & {
	interrupted?: boolean;
};
export type AppUIMessagePart = AppUIMessage["parts"][number];
export type AppToolUIPart = ToolUIPart<AppTools> | DynamicToolUIPart;
export type TaskToolPart =
	| Extract<ToolUIPart<AppTools>, { type: "tool-add_tasks" }>
	| Extract<ToolUIPart<AppTools>, { type: "tool-complete_task" }>;
export type AskUserToolPart = Extract<ToolUIPart<AppTools>, { type: "tool-ask_user" }>;
export type ProposeFillDataToolPart = Extract<ToolUIPart<AppTools>, { type: "tool-propose_fill_data" }>;
export type RetryStatusPart = {
	type: "data-retry-status";
	id?: string;
	data: RetryStatusData;
};

export function isAppToolPart(part: AppUIMessagePart): part is AppToolUIPart {
	return isToolUIPart(part);
}

export function isTaskToolPart(part: AppUIMessagePart): part is TaskToolPart {
	return isAppToolPart(part) && (part.type === "tool-add_tasks" || part.type === "tool-complete_task");
}

export function isAskUserToolPart(part: AppUIMessagePart): part is AskUserToolPart {
	return isAppToolPart(part) && part.type === "tool-ask_user";
}

export function isProposeFillDataToolPart(part: AppUIMessagePart): part is ProposeFillDataToolPart {
	return isAppToolPart(part) && part.type === "tool-propose_fill_data";
}

export function getProposeFillDataOutputData(part: ProposeFillDataToolPart): ProposeFillDataOutputData | null {
	if (part.state !== "output-available" || !part.output.success || !part.output.data) {
		return null;
	}
	return part.output.data;
}

export function isRetryStatusPart(part: AppUIMessagePart): part is RetryStatusPart {
	return isDataUIPart(part) && part.type === "data-retry-status";
}

export function getAppToolName(part: AppToolUIPart): string {
	return part.type === "dynamic-tool"
		? part.toolName
		: part.type.slice(5);
}

export function isAppToolName(name: string): name is AppToolName {
	return name in appToolNameLookup;
}

export function getTaskToolData(part: TaskToolPart): AddTasksOutputData | CompleteTaskOutputData | null {
	if (part.state !== "output-available" || !part.output.success || !part.output.data) {
		return null;
	}
	return part.output.data;
}

export function getAskUserOutputData(part: AskUserToolPart): AskUserOutputData | null {
	if (part.state !== "output-available" || !part.output.success || !part.output.data) {
		return null;
	}
	return part.output.data;
}

export function getPartState(part: AppUIMessagePart | undefined): string | undefined {
	if (!part) return undefined;
	return "state" in part ? part.state : undefined;
}

export function getPartText(part: AppUIMessagePart | undefined): string | undefined {
	if (!part) return undefined;
	if (part.type === "text" || part.type === "reasoning") {
		return part.text;
	}
	return undefined;
}

const appToolNameLookup = Object.fromEntries(
	[...builtinToolNames, "take_screenshot"].map((name) => [name, true]),
) as Record<AppToolName, true>;
