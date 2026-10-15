import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	resolve: {
		alias: {
			'n8n-workflow': fileURLToPath(
				new URL('./node_modules/n8n-workflow/dist/cjs/index.js', import.meta.url),
			),
		},
	},
	test: {
		include: ['tests/**/*.test.ts'],
		server: { deps: { external: [/n8n-workflow/, /@n8n\//] } },
	},
});
