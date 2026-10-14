"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { AppUIMessage } from "@/lib/agent/ui-message";
import {
	type Session,
	generateSessionId,
	saveSession,
	getSession,
} from "@/lib/agent/session-store";
import { taskStore } from "@/lib/agent/task-store";

// ============================================================================
// useSession — 管理当前会话状态，自动持久化到 IndexedDB
// ============================================================================

/** 每个用户独立记录当前活动会话，避免身份切换后串会话 */
function activeSessionKey(userId: string): string {
	return `spreadjs-agent-active-session:${userId}`;
}

export function getActiveSessionId(userId: string): string | null {
	if (typeof window === "undefined") return null;
	return localStorage.getItem(activeSessionKey(userId));
}

function setActiveSessionId(userId: string, id: string) {
	localStorage.setItem(activeSessionKey(userId), id);
}

function clearActiveSessionId(userId: string) {
	localStorage.removeItem(activeSessionKey(userId));
}

function createNewSession(userId: string): Session {
	return {
		id: generateSessionId(`u_${userId}`),
		title: "新会话",
		messages: [],
		snapshotMap: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

async function generateTitle(firstMessage: string): Promise<string> {
	try {
		const res = await fetch("/api/title", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ firstMessage }),
		});
		if (!res.ok) return "新会话";
		const { title } = await res.json();
		return title || "新会话";
	} catch {
		return "新会话";
	}
}

interface UseSessionReturn {
	session: Session;
	/** 保存消息到当前会话（应在每次 messages 变化后调用） */
	syncMessages: (messages: AppUIMessage[]) => void;
	/** 立即刷新：取消防抖，将最新 messages 写入 DB（AI 回复结束时调用） */
	flushMessages: () => void;
	/** 切换到指定会话 */
	switchSession: (sessionId: string) => Promise<AppUIMessage[]>;
	/** 新建会话，返回新会话 */
	newSession: () => Session;
	/** 手动触发标题刷新（外部监听 session.title 变化） */
	onTitleChange: (cb: (title: string) => void) => () => void;
	/** 关联 messageId 和 snapshotId */
	linkSnapshot: (messageId: string, snapshotId: string) => void;
	/** 获取 messageId 对应的 snapshotId */
	getSnapshotId: (messageId: string) => string | undefined;
	/** Fork 会话：复制 messageId 之前的所有消息到新会话，返回新会话和被 fork 消息的文本 */
	forkSession: (messageId: string, messages: AppUIMessage[]) => Promise<{ session: Session; inputText: string }>;
	/** 保存本次 AI 回复的真实 token 用量到当前会话（不更新 updatedAt） */
	saveTokenUsage: (usage: { promptTokens: number; contextWindow: number }) => void;
}

export function useSession(userId: string): UseSessionReturn {
	const [session, setSession] = useState<Session>(() => createNewSession(userId));
	const titleCallbacksRef = useRef<Set<(title: string) => void>>(new Set());
	const titleGeneratedRef = useRef(false);

	// ref 持有最新 messages，防抖定时器读取时始终拿到最新值
	const latestMessagesRef = useRef<AppUIMessage[]>([]);
	const dbTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// switchSession 后跳过一次 syncMessages 的 updatedAt 更新
	const skipTimestampRef = useRef(false);
	// session 快照 ref，供 DB 写入读取而不触发 re-render
	const sessionRef = useRef(session);
	useEffect(() => {
		sessionRef.current = session;
	}, [session]);

	// 组件卸载时清理防抖定时器
	useEffect(() => () => { if (dbTimerRef.current) clearTimeout(dbTimerRef.current); }, []);

	const syncMessages = useCallback(
		(messages: AppUIMessage[]) => {
			// 始终保存最新 messages 到 ref（零成本，不触发 render）
			latestMessagesRef.current = messages;

			// 防抖：2s 内只触发一次 setSession + DB 写入（流式传输期间的安全网）
			if (dbTimerRef.current) clearTimeout(dbTimerRef.current);
			const shouldSkipTimestamp = skipTimestampRef.current;
			skipTimestampRef.current = false;
			dbTimerRef.current = setTimeout(() => {
				const msgs = latestMessagesRef.current;
				setSession((prev) => {
					// 切换会话时仅同步消息，不更新 updatedAt，避免仅选中就置顶
					const updated = {
						...prev,
						messages: msgs,
						updatedAt: shouldSkipTimestamp ? prev.updatedAt : Date.now(),
					};
					saveSession(updated).catch(() => {});
					setActiveSessionId(userId, prev.id);
					return updated;
				});
			}, 2000);

			// 第一条用户消息出现时，异步生成标题（首次即刻触发，不受防抖影响）
			if (!titleGeneratedRef.current && messages.length > 0) {
				const firstUser = messages.find((m) => m.role === "user");
				if (firstUser) {
					const text = firstUser.parts
						.filter((p) => p.type === "text")
						.map((p) => (p as { type: "text"; text: string }).text)
						.join(" ")
						.trim();
					if (text) {
						titleGeneratedRef.current = true;
						// 捕获发起请求时的会话 ID，防止 API 返回时写入错误的会话
						const targetSessionId = sessionRef.current.id;
						generateTitle(text).then((title) => {
							if (sessionRef.current.id !== targetSessionId) {
								// 会话已切换：将标题写入原始会话的 DB，不更新当前会话状态
								getSession(targetSessionId).then((original) => {
									if (original) {
										saveSession({ ...original, title, updatedAt: Date.now() }).catch(() => {});
										titleCallbacksRef.current.forEach((cb) => cb(title));
									}
								});
								return;
							}
							setSession((prev) => {
								const updated = { ...prev, title, updatedAt: Date.now() };
								saveSession(updated).catch(() => {});
								titleCallbacksRef.current.forEach((cb) => cb(title));
								return updated;
							});
						});
					}
				}
			}
		},
		[userId],
	);

	const flushMessages = useCallback(() => {
		// 取消挂起的防抖定时器
		if (dbTimerRef.current) {
			clearTimeout(dbTimerRef.current);
			dbTimerRef.current = null;
		}
		const msgs = latestMessagesRef.current;
		if (msgs.length === 0) return;
		const plans = taskStore.exportPlans();
		setSession((prev) => {
			const updated = {
				...prev,
				messages: msgs,
				taskPlans: plans.length > 0 ? plans : undefined,
				updatedAt: Date.now(),
			};
			saveSession(updated).catch(() => {});
			setActiveSessionId(userId, prev.id);
			return updated;
		});
	}, [userId]);

	const switchSession = useCallback(async (sessionId: string): Promise<AppUIMessage[]> => {
		// 取消挂起的防抖定时器，防止旧会话的消息写入新会话
		if (dbTimerRef.current) {
			clearTimeout(dbTimerRef.current);
			dbTimerRef.current = null;
		}

		// 保存当前会话的任务计划
		const plans = taskStore.exportPlans();
		if (plans.length > 0) {
			setSession((prev) => {
				const updated = { ...prev, taskPlans: plans };
				saveSession(updated).catch(() => {});
				return updated;
			});
		}

		const found = await getSession(sessionId);
		if (!found) return [];
		titleGeneratedRef.current = true;
		skipTimestampRef.current = true;
		latestMessagesRef.current = found.messages;
		setSession(found);
		setActiveSessionId(userId, found.id);

		// 恢复目标会话的任务计划
		if (found.taskPlans && found.taskPlans.length > 0) {
			taskStore.importPlans(found.taskPlans);
		} else {
			taskStore.reset();
		}

		return found.messages;
	}, [userId]);

	const newSession = useCallback((): Session => {
		// 取消挂起的防抖定时器，防止旧会话的消息写入新会话
		if (dbTimerRef.current) {
			clearTimeout(dbTimerRef.current);
			dbTimerRef.current = null;
		}

		// 保存当前会话的任务计划
		const plans = taskStore.exportPlans();
		if (plans.length > 0) {
			setSession((prev) => {
				const updated = { ...prev, taskPlans: plans };
				saveSession(updated).catch(() => {});
				return updated;
			});
		}

		taskStore.reset();
		const s = createNewSession(userId);
		titleGeneratedRef.current = false;
		latestMessagesRef.current = [];
		setSession(s);
		clearActiveSessionId(userId);
		return s;
	}, [userId]);

	const onTitleChange = useCallback((cb: (title: string) => void) => {
		titleCallbacksRef.current.add(cb);
		return () => { titleCallbacksRef.current.delete(cb); };
	}, []);

	const linkSnapshot = useCallback((messageId: string, snapshotId: string) => {
		setSession((prev) => {
			const map = { ...prev.snapshotMap, [messageId]: snapshotId };
			const updated = { ...prev, snapshotMap: map, updatedAt: Date.now() };
			saveSession(updated).catch(() => {});
			return updated;
		});
	}, []);

	const getSnapshotId = useCallback((messageId: string): string | undefined => {
		return sessionRef.current.snapshotMap?.[messageId];
	}, []);

	const saveTokenUsage = useCallback((usage: { promptTokens: number; contextWindow: number }) => {
		setSession((prev) => {
			// 仅更新 tokenUsage，保留 updatedAt 不变（避免无谓置顶）
			const updated = { ...prev, tokenUsage: usage };
			saveSession(updated).catch(() => {});
			return updated;
		});
	}, []);

	/** Fork 会话：复制 messageId 之前的所有消息到新会话，返回新会话和被 fork 消息的文本 */
	const forkSession = useCallback(async (messageId: string, messages: AppUIMessage[]): Promise<{ session: Session; inputText: string }> => {
		// 取消挂起的防抖定时器，防止旧会话的消息写入 fork 会话
		if (dbTimerRef.current) {
			clearTimeout(dbTimerRef.current);
			dbTimerRef.current = null;
		}

		const msgIdx = messages.findIndex((m) => m.id === messageId);
		// 不含当前消息，还原到"该消息尚未发出"的状态
		const forkedMessages = msgIdx <= 0 ? [] : messages.slice(0, msgIdx);

		// 提取被 fork 消息的文本，用于回填输入框
		const targetMsg = msgIdx === -1 ? undefined : messages[msgIdx];
		const inputText = targetMsg?.parts
			.filter((p) => p.type === "text")
			.map((p) => (p as { type: "text"; text: string }).text)
			.join("\n")
			.trim() ?? "";

		// 复制相关的 snapshotMap 条目
		const srcMap = sessionRef.current.snapshotMap ?? {};
		const forkedSnapshotMap: Record<string, string> = {};
		const forkedMsgIds = new Set(forkedMessages.map((m) => m.id));
		for (const [mid, sid] of Object.entries(srcMap)) {
			if (forkedMsgIds.has(mid)) forkedSnapshotMap[mid] = sid;
		}

		const forked: Session = {
			id: generateSessionId(`u_${userId}`),
			title: `${sessionRef.current.title}（分支）`,
			messages: forkedMessages,
			snapshotMap: forkedSnapshotMap,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		await saveSession(forked);
		titleGeneratedRef.current = forkedMessages.length > 0;
		latestMessagesRef.current = forkedMessages;
		taskStore.reset();
		setSession(forked);
		return { session: forked, inputText };
	}, [userId]);

	// 注意：不再在初次挂载时持久化空会话。
	// 会话仅在收到第一条消息（syncMessages 调用）时才写入 DB，
	// 避免每次刷新都产生一个空的"新会话"记录。

	return { session, syncMessages, flushMessages, switchSession, newSession, onTitleChange, linkSnapshot, getSnapshotId, forkSession, saveTokenUsage };
}
