import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { runtime } from './runtime.mjs';

const { values } = parseArgs({
	options: { source: { type: 'string', default: '.' } },
});
const isolated = mkdtempSync(resolve(tmpdir(), 'linkedin-node-install-'));
try {
	const installation = spawnSync(
		'npm',
		[
			'install',
			'--prefix',
			isolated,
			resolve(values.source),
			'--install-links',
			'--omit=dev',
			'--no-audit',
			'--no-fund',
			'--ignore-scripts',
			'--cache',
			resolve(isolated, 'npm-cache'),
		],
		{ encoding: 'utf8' },
	);
	assert.equal(installation.status, 0, `Isolated npm installation failed: ${installation.stderr}`);
	const { PackageDirectoryLoader, WorkflowExecute, Workflow, version } = runtime();
	const loader = new PackageDirectoryLoader(
		resolve(isolated, 'node_modules/n8n-nodes-linkedin-feed'),
	);
	await loader.loadAll();
	const node = loader.nodeTypes.linkedInFeed.type;
	assert(loader.credentialTypes.linkedInSessionApi);
	assert.equal(node.description.credentials[0].name, 'linkedInSessionApi');
	const definition = {
		name: 'LinkedIn Feed',
		type: 'n8n-nodes-linkedin-feed.linkedInFeed',
		typeVersion: 1,
		position: [0, 0],
		parameters: { operation: 'getPosts', limit: 1, options: {} },
		credentials: { linkedInSessionApi: { id: 'fixture', name: 'fixture' } },
	};
	const fixture = readFileSync(new URL('../tests/fixtures/install-feed.rsc', import.meta.url));
	let requests = 0;
	const additionalData = {
		executionId: 'fixture',
		timezone: 'UTC',
		restApiUrl: 'http://localhost/rest',
		instanceBaseUrl: 'http://localhost',
		credentialsHelper: {
			isCredentialUsableByNode: () => true,
			getDecrypted: async () => ({
				liAt: 'fixture-only',
				jsessionId: 'ajax:fixture-only',
				userAgent: 'fixture-browser',
			}),
		},
		evalLlmMockHandler: async (options) => {
			requests++;
			assert.equal(JSON.parse(options.body).clientArguments.payload.startIndex, 0);
			return {
				statusCode: 200,
				headers: { 'content-type': 'application/octet-stream' },
				body: fixture,
			};
		},
	};
	const workflow = new Workflow({
		id: 'fixture-workflow',
		nodes: [definition],
		connections: {},
		active: false,
		nodeTypes: { getByNameAndVersion: () => node, getKnownTypes: () => ({}) },
		settings: { executionOrder: 'v1' },
	});
	const run = {
		startData: {},
		resultData: { runData: {} },
		executionData: {
			contextData: {},
			nodeExecutionStack: [],
			waitingExecution: {},
			waitingExecutionSource: {},
		},
	};
	const execution = {
		node: workflow.getNode(definition.name),
		data: { main: [[{ json: {} }]] },
		source: { main: [null] },
	};
	const engine = new WorkflowExecute(additionalData, 'manual', run);
	const result = await engine.runNode(workflow, execution, run, 0, additionalData, 'manual');
	const [output] = result.data;
	assert.equal(output.length, 1);
	assert.equal(output[0].json.urn, 'urn:li:activity:101');
	assert.equal(output[0].json.text, 'Fixture post. Café 🚀');
	assert.deepEqual(output[0].pairedItem, { item: 0 });
	console.log(
		JSON.stringify({
			n8n: version,
			isolatedInstallation: true,
			nodeLoaded: true,
			credentialLoaded: true,
			executed: true,
			requests,
		}),
	);
} finally {
	rmSync(isolated, { recursive: true, force: true });
}
