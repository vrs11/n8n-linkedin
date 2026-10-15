import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

export default [
	...configWithoutCloudSupport,
	{ ignores: ['investigation/**', 'node_modules/**', 'dist/**', 'coverage/**'] },
	{
		files: ['package.json'],
		rules: {
			// Private installation: do not invent a publisher identity or assign a public license.
			'@n8n/community-nodes/valid-author': 'off',
			'@n8n/community-nodes/require-homepage': 'off',
			'n8n-nodes-base/community-package-json-author-missing': 'off',
			'n8n-nodes-base/community-package-json-license-not-default': 'off',
			// A single explicit runtime dependency supplies standards-compliant cookie handling.
			'@n8n/community-nodes/no-runtime-dependencies': 'off',
			// Compatibility is constrained to the n8n-workflow API validated by this package.
			'@n8n/community-nodes/valid-peer-dependencies': 'off',
		},
	},
	{
		files: [
			'nodes/LinkedInFeed/LinkedInFeed.node.ts',
			'nodes/LinkedInComment/LinkedInComment.node.ts',
		],
		rules: {
			// Defaults come from one shared typed object rather than repeated literals.
			'n8n-nodes-base/node-param-default-missing': 'off',
			// All errors cross the adapter's sanitizing catch boundary before n8n receives them.
			'n8n-nodes-base/node-execute-block-wrong-error-thrown': 'off',
		},
	},
	{
		files: [
			'nodes/LinkedInFeed/lib/**/*.ts',
			'nodes/LinkedInComment/lib/**/*.ts',
			'nodes/shared/**/*.ts',
		],
		rules: {
			// Domain functions remain independent of execution context; the adapter wraps errors.
			'@n8n/community-nodes/require-node-api-error': 'off',
		},
	},
];
