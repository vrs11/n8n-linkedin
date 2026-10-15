import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { runtime } from './runtime.mjs';

const require = createRequire(import.meta.url);
const { publicError } = require('../dist/nodes/LinkedInFeed/lib/types.js');

try {
	const { values } = parseArgs({
		options: { 'env-file': { type: 'string' }, limit: { type: 'string', default: '20' } },
	});
	const config = { ...process.env };
	if (values['env-file']) {
		for (const line of readFileSync(values['env-file'], 'utf8').split(/\r?\n/)) {
			const match = /^(LI_AT|JSESSIONID|LINKEDIN_USER_AGENT)=(.*)$/.exec(line.trim());
			if (!match) continue;
			try {
				config[match[1]] = JSON.parse(match[2]);
			} catch {
				config[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
			}
		}
	}
	if (!config.LI_AT || !config.JSESSIONID || !config.LINKEDIN_USER_AGENT)
		throw new Error('missing credentials');
	const { PackageDirectoryLoader, getRequestHelperFunctions, version } = runtime();
	const loader = new PackageDirectoryLoader(fileURLToPath(new URL('..', import.meta.url)));
	await loader.loadAll();
	const node = loader.nodeTypes.linkedInFeed.type;
	const definition = {
		name: 'LinkedIn Feed',
		type: 'n8n-nodes-linkedin-feed.linkedInFeed',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	};
	let requests = 0;
	const helpers = getRequestHelperFunctions({}, definition, {});
	const context = {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name) =>
			name === 'operation' ? 'getPosts' : name === 'limit' ? Number(values.limit) : {},
		getCredentials: async () => ({
			liAt: config.LI_AT,
			jsessionId: config.JSESSIONID,
			userAgent: config.LINKEDIN_USER_AGENT,
		}),
		getNode: () => definition,
		getExecutionCancelSignal: () => undefined,
		continueOnFail: () => false,
		helpers: {
			httpRequest: async (options) => {
				requests++;
				return helpers.httpRequest(options);
			},
		},
	};
	const [posts] = await node.execute.call(context);
	assert.equal(
		posts.length,
		Number(values.limit),
		'The live acceptance run must retrieve its requested count',
	);
	assert.equal(new Set(posts.map((post) => post.json.urn)).size, posts.length);
	assert(posts.every((post) => post.json.url && post.pairedItem.item === 0));
	// Print counts only. Credentials, post contents, and server cursors never leave this process.
	console.log(
		JSON.stringify({
			n8n: version,
			requested: Number(values.limit),
			returned: posts.length,
			requests,
			unique: true,
		}),
	);
} catch (error) {
	console.error(publicError(error));
	process.exitCode = 1;
}
