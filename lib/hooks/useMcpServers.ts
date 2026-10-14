"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { McpServerStatus } from "@/lib/mcp/types";

const STORAGE_KEY = "spreadjs-agent-mcp-config";
const VERSION_KEY = "spreadjs-agent-mcp-config-version";
const ENSURE_THROTTLE_MS = 5_000;
const OAUTH_CHANNEL = "mcp-oauth";

/** 内置 spreadjs-mcp server 配置，随 BUILTIN_CONFIG_VERSION 版本化管理 */
const BUILTIN_CONFIG_VERSION = 3;
const SPREADJS_MCP_TOKEN_PLACEHOLDER = "REPLACE_WITH_YOUR_GRAPECITY_MCP_TOKEN";

function buildBuiltinSpreadjsServer(token = SPREADJS_MCP_TOKEN_PLACEHOLDER, enabled = false) {
	return {
		url: "https://mcp.grapecity.com.cn/mcp/spreadjs",
		headers: {
			token:"gcmcp_6ce3ac58-9638-431a-9edc-5c541cfb644c_sg3wVo1u5x_hd696oPMF7TIHVC7yCeQhY5HcZJzqJAU",
		},
		enabled: true,
	};
}

const BUILTIN_SPREADJS_SERVER = {
	...buildBuiltinSpreadjsServer(),
};

/** 默认 MCP 配置（含内置 spreadjs-mcp） */
export const DEFAULT_MCP_CONFIG = JSON.stringify({
	mcpServers: {
		"spreadjs-mcp": BUILTIN_SPREADJS_SERVER,
	},
}, null, "\t");

/**
 * 启动时迁移本地配置：若内置版本号高于本地记录，
 * 则用最新内置配置覆盖 spreadjs-mcp，保留用户自定义的其他 server。
 */
function migrateLocalConfig(): string {
	const localVersion = parseInt(localStorage.getItem(VERSION_KEY) ?? "0", 10);
	const raw = localStorage.getItem(STORAGE_KEY);

	if (!raw) {
		localStorage.setItem(STORAGE_KEY, DEFAULT_MCP_CONFIG);
		localStorage.setItem(VERSION_KEY, String(BUILTIN_CONFIG_VERSION));
		return DEFAULT_MCP_CONFIG;
	}

	if (localVersion >= BUILTIN_CONFIG_VERSION) {
		return raw;
	}

	// 版本落后：覆盖内置 server，保留用户自定义 server
	try {
		const config = JSON.parse(raw);
		config.mcpServers = config.mcpServers ?? {};
		const current = config.mcpServers["spreadjs-mcp"];
		const currentToken = current?.headers?.token;
		const preservedToken = typeof currentToken === "string" &&
			currentToken &&
			currentToken !== SPREADJS_MCP_TOKEN_PLACEHOLDER
			? currentToken
			: SPREADJS_MCP_TOKEN_PLACEHOLDER;
		const enabled = preservedToken !== SPREADJS_MCP_TOKEN_PLACEHOLDER &&
			current?.enabled !== false;
		config.mcpServers["spreadjs-mcp"] = buildBuiltinSpreadjsServer(preservedToken, enabled);
		const migrated = JSON.stringify(config, null, "\t");
		localStorage.setItem(STORAGE_KEY, migrated);
		localStorage.setItem(VERSION_KEY, String(BUILTIN_CONFIG_VERSION));
		return migrated;
	} catch {
		// 本地配置损坏，重置
		localStorage.setItem(STORAGE_KEY, DEFAULT_MCP_CONFIG);
		localStorage.setItem(VERSION_KEY, String(BUILTIN_CONFIG_VERSION));
		return DEFAULT_MCP_CONFIG;
	}
}

interface McpServersState {
	servers: McpServerStatus[];
	loading: boolean;
	error: string | null;
	lastCheck: number;
}

export function useMcpServers() {
	const [state, setState] = useState<McpServersState>({
		servers: [],
		loading: false,
		error: null,
		lastCheck: 0,
	});
	const lastEnsure = useRef(0);

	useEffect(() => {
		// 迁移本地配置（自动覆盖过期的内置 server 地址）
		const config = migrateLocalConfig();
		applyConfig(config).catch(() => {});
	}, []);

	// 监听 OAuth 弹窗回调
	useEffect(() => {
		const bc = new BroadcastChannel(OAUTH_CHANNEL);
		bc.onmessage = (ev) => {
			const { success, error: oauthError } = ev.data ?? {};
			if (success) {
				refreshStatus();
			} else if (oauthError) {
				setState((s) => ({ ...s, error: `OAuth 授权失败: ${oauthError}` }));
			}
		};
		return () => bc.close();
	}, []);

	async function applyConfig(configJson: string): Promise<McpServerStatus[]> {
		setState((s) => ({ ...s, loading: true, error: null }));
		try {
			const res = await fetch("/api/mcp/servers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: configJson,
			});
			if (!res.ok) {
				const err = await res.json();
				throw new Error(err.error ?? `HTTP ${res.status}`);
			}
			const data = await res.json();
			setState({
				servers: data.servers,
				loading: false,
				error: null,
				lastCheck: Date.now(),
			});
			return data.servers;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			setState((s) => ({ ...s, loading: false, error: msg }));
			throw e;
		}
	}

	async function refreshStatus() {
		try {
			const res = await fetch("/api/mcp/servers");
			const data = await res.json();
			setState((s) => ({
				...s,
				servers: data.servers,
				lastCheck: Date.now(),
			}));
		} catch { /* ignore */ }
	}

	const saveAndConnect = useCallback(async (configJson: string) => {
		try { JSON.parse(configJson); } catch {
			throw new Error("JSON 格式错误");
		}
		localStorage.setItem(STORAGE_KEY, configJson);
		await applyConfig(configJson);
	}, []);

	const toggleServer = useCallback(async (name: string, enabled: boolean) => {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (!saved) return;
		const config = JSON.parse(saved);
		if (config.mcpServers?.[name]) {
			config.mcpServers[name].enabled = enabled;
			const json = JSON.stringify(config, null, 2);
			localStorage.setItem(STORAGE_KEY, json);
			await applyConfig(json);
		}
	}, []);

	const disconnectAll = useCallback(async () => {
		localStorage.removeItem(STORAGE_KEY);
		await applyConfig(JSON.stringify({ mcpServers: {} }));
	}, []);

	const ensureConnected = useCallback(async () => {
		if (Date.now() - lastEnsure.current < ENSURE_THROTTLE_MS) return;
		lastEnsure.current = Date.now();
		const saved = localStorage.getItem(STORAGE_KEY);
		if (!saved) return;
		try {
			const res = await fetch("/api/mcp/servers");
			const data = await res.json();
			// 后端内存丢失（server 数量与本地配置不一致）或有 enabled server 未连接时重连
			let expectedCount = 0;
			try {
				const localConfig = JSON.parse(saved);
				expectedCount = Object.values(localConfig.mcpServers ?? {}).filter(
					(s: unknown) => (s as { enabled?: boolean }).enabled !== false
				).length;
			} catch { /* ignore */ }
			const hasDisconnected = data.servers.some(
				(s: McpServerStatus) => s.enabled && !s.connected,
			);
			const backendLostState = data.servers.length < expectedCount;
			if (hasDisconnected || backendLostState) {
				await applyConfig(saved);
			} else {
				setState((s) => ({
					...s,
					servers: data.servers,
					lastCheck: Date.now(),
				}));
			}
		} catch {
			await applyConfig(saved).catch(() => {});
		}
	}, []);

	const authorizeServer = useCallback(async (name: string) => {
		setState((s) => ({ ...s, error: null }));
		try {
			const res = await fetch("/api/mcp/oauth/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ serverName: name }),
			});
			if (!res.ok) {
				const err = await res.json();
				throw new Error(err.error ?? `HTTP ${res.status}`);
			}
			const { authorizationUrl } = await res.json();

			const w = 600, h = 700;
			const left = window.screenX + (window.outerWidth - w) / 2;
			const top = window.screenY + (window.outerHeight - h) / 2;
			window.open(
				authorizationUrl,
				"mcp-oauth-popup",
				`width=${w},height=${h},left=${left},top=${top},popup=yes`,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			setState((s) => ({ ...s, error: msg }));
		}
	}, []);

	const toolCount = state.servers.reduce(
		(sum, s) => sum + (s.connected ? s.toolCount : 0), 0,
	);

	const configJson = typeof window !== "undefined"
		? localStorage.getItem(STORAGE_KEY) ?? ""
		: "";

	return {
		...state,
		toolCount,
		configJson,
		saveAndConnect,
		toggleServer,
		disconnectAll,
		ensureConnected,
		authorizeServer,
	};
}
