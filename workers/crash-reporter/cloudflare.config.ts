import { defineConfig } from "cf/config";

export default defineConfig({
	accountId: "ec4ecdec16bd6fc65e76f4f585f5bd9d",
	worker: {
		name: "camofox-telemetry",
		compatibilityDate: "2024-12-01",
		entrypoint: "index.ts",
		observability: {
			enabled: true,
		},
	},
});
