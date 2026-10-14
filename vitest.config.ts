import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			"@": root,
		},
	},
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		setupFiles: ["tests/setup.ts"],
		// 让 route handler 里的 node:sqlite 单例按文件隔离
		isolate: true,
	},
});