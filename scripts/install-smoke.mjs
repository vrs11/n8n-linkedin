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
	const {
		PackageDirectoryLoader,
		CustomDirectoryLoader,
		WorkflowExecute,
		Workflow,
		version,
		createNodeAsTool,
		convertNodeToAiTool,
		makeHandleToolInvocation,
		SupplyDataContext,
		NodeHelpers,
		getConnectedTools,
		getParametersJsonSchema,
		zodToDraft202012,
	} = runtime();
	const loader = new PackageDirectoryLoader(
		resolve(isolated, 'node_modules/n8n-nodes-linkedin-feed'),
	);
	await loader.loadAll();
	const node = loader.nodeTypes.linkedInFeed.type;
	assert(loader.credentialTypes.linkedInSessionApi);
	assert.equal(node.description.credentials[0].name, 'linkedInSessionApi');
	// Exercise n8n's actual tool wrapper: argument types come from $fromAI, not the UI field type.
	const toolExample = JSON.parse(
		readFileSync(new URL('../examples/get-feed-as-tool.json', import.meta.url), 'utf8'),
	).nodes[0];
	const toolType = convertNodeToAiTool({ description: structuredClone(node.description) });
	let receivedArguments;
	const { response: tool } = createNodeAsTool({
		node: toolExample,
		nodeType: toolType,
		handleToolInvocation: async (args) => {
			receivedArguments = args;
			return 'fixture tool result';
		},
	});
	assert.equal(tool.schema.safeParse({ limit: 5 }).success, true);
	assert.equal(tool.schema.safeParse({ limit: 'Retrieve the latest 5 posts' }).success, false);
	assert.equal(tool.schema.safeParse('Retrieve the latest 5 posts').success, false);
	assert.equal(tool.schema.safeParse({ input: 'Retrieve the latest 5 posts' }).success, false);
	assert.equal(tool.schema.safeParse({ Limit: 5 }).success, false);
	assert.equal(await tool.invoke({ limit: 5 }), 'fixture tool result');
	assert.deepEqual(receivedArguments, { limit: 5 });
	const definition = {
		name: 'LinkedIn Feed',
		type: 'n8n-nodes-linkedin-feed.linkedInFeed',
		typeVersion: 1,
		position: [0, 0],
		parameters: { operation: 'getPosts', limit: 1, options: {} },
		credentials: { linkedInSessionApi: { id: 'fixture', name: 'fixture' } },
	};
	const fixture = readFileSync(new URL('../tests/fixtures/install-feed.rsc', import.meta.url));
	const mixedFixture = readFileSync(
		new URL('../tests/fixtures/install-mixed-feed.rsc', import.meta.url),
	);
	let responseBody = fixture;
	let responseStatus = 200;
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
			if (options.method === 'GET')
				return {
					statusCode: 200,
					headers: { 'content-type': 'text/html' },
					body: readFileSync(new URL('../tests/fixtures/comment-page.html', import.meta.url)),
				};
			if (options.url.includes('comments.createComment')) {
				assert.equal(JSON.parse(options.body).states[0].value, 'Fixture comment');
				return {
					statusCode: 200,
					headers: { 'content-type': 'application/octet-stream' },
					body: readFileSync(new URL('../tests/fixtures/comment-created.rsc', import.meta.url)),
				};
			}
			assert.equal(JSON.parse(options.body).clientArguments.payload.startIndex, 0);
			return {
				statusCode: responseStatus,
				headers: { 'content-type': 'application/octet-stream' },
				body: responseBody,
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
	// Also execute through the real AI-tool context so $fromAI resolves the numeric argument.
	toolType.execute = node.execute;
	toolExample.credentials = definition.credentials;
	const toolWorkflow = new Workflow({
		id: 'fixture-tool-workflow',
		nodes: [toolExample],
		connections: {},
		active: false,
		nodeTypes: { getByNameAndVersion: () => toolType, getKnownTypes: () => ({}) },
		settings: { executionOrder: 'v1' },
	});
	additionalData.currentNodeExecutionIndex = 0;
	const toolNode = toolWorkflow.getNode(toolExample.name);
	const { response: executableTool } = createNodeAsTool({
		node: toolNode,
		nodeType: toolType,
		handleToolInvocation: makeHandleToolInvocation(
			(index) =>
				new SupplyDataContext(
					toolWorkflow,
					toolNode,
					additionalData,
					'manual',
					run,
					index,
					[{ json: {} }],
					{},
					'ai_tool',
					{ ...execution, node: toolNode },
					[],
				),
			toolNode,
			toolType,
			run,
		),
	});
	const toolOutput = JSON.parse(await executableTool.invoke({ limit: 5 }));
	assert.equal(toolOutput.length, 1); // The fixture feed exhausts after one post.
	assert.equal(toolOutput[0].urn, 'urn:li:activity:101');

	// Use both loading paths deployed by n8n: an installed package and N8N_CUSTOM_EXTENSIONS.
	const customLoader = new CustomDirectoryLoader(
		resolve(isolated, 'node_modules/n8n-nodes-linkedin-feed/dist'),
	);
	await customLoader.loadAll();
	assert(customLoader.credentialTypes.linkedInSessionApi);
	let compatibilityCases = 0;
	const freshRun = () => ({
		startData: {},
		resultData: { runData: {} },
		executionData: {
			contextData: {},
			nodeExecutionStack: [],
			waitingExecution: {},
			waitingExecutionSource: {},
		},
	});
	const makeWorkflow = (type, definition) =>
		new Workflow({
			id: 'compatibility-fixture',
			nodes: [definition],
			connections: {},
			active: false,
			nodeTypes: { getByNameAndVersion: () => type, getKnownTypes: () => ({}) },
			settings: { executionOrder: 'v1' },
		});
	const makeTool = (type, definition) => {
		const workflow = makeWorkflow(type, definition);
		const toolNode = workflow.getNode(definition.name);
		const run = freshRun();
		const data = { node: toolNode, data: { main: [[{ json: {} }]] }, source: { main: [null] } };
		const { response: tool } = createNodeAsTool({
			node: toolNode,
			nodeType: type,
			handleToolInvocation: makeHandleToolInvocation(
				(index) =>
					new SupplyDataContext(
						workflow,
						toolNode,
						additionalData,
						'manual',
						run,
						index,
						[{ json: {} }],
						{},
						'ai_tool',
						data,
						[],
					),
				toolNode,
				type,
				run,
			),
		});
		return { tool, node: toolNode, run };
	};
	const urns = (posts) => posts.map((post) => post.urn);
	for (const [prefix, base] of [
		['n8n-nodes-linkedin-feed', node],
		['CUSTOM', customLoader.nodeTypes.linkedInFeed.type],
	]) {
		responseBody = mixedFixture;
		for (const mode of ['manual', 'trigger', 'integrated']) {
			const definition = {
				name: 'Feed',
				type: `${prefix}.linkedInFeed`,
				typeVersion: 1,
				position: [0, 0],
				credentials: { linkedInSessionApi: { id: 'fixture', name: 'fixture' } },
				parameters: {
					limit: '={{ $json.count }}',
					options: { excludeCompanies: '={{ $json.peopleOnly }}' },
				},
			};
			const workflow = makeWorkflow(base, definition);
			const run = freshRun();
			const data = {
				node: workflow.getNode('Feed'),
				data: {
					main: [
						[{ json: { count: 1, peopleOnly: false } }, { json: { count: 2, peopleOnly: true } }],
					],
				},
				source: { main: [null] },
			};
			const result = await new WorkflowExecute(additionalData, mode, run).runNode(
				workflow,
				data,
				run,
				0,
				additionalData,
				mode,
			);
			assert.deepEqual(
				result.data[0].map((post) => post.json.urn),
				['urn:li:activity:100', 'urn:li:activity:101', 'urn:li:activity:102'],
			);
			assert.deepEqual(
				result.data[0].map((post) => post.pairedItem),
				[{ item: 0 }, { item: 1 }, { item: 1 }],
			);
			compatibilityCases++;
		}
		for (const onError of ['continueRegularOutput', 'continueErrorOutput']) {
			const definition = {
				name: 'Feed',
				type: `${prefix}.linkedInFeed`,
				typeVersion: 1,
				position: [0, 0],
				onError,
				credentials: { linkedInSessionApi: { id: 'fixture', name: 'fixture' } },
				parameters: { limit: '={{ $json.count }}', options: {} },
			};
			const workflow = makeWorkflow(base, definition);
			const run = freshRun();
			const data = {
				node: workflow.getNode('Feed'),
				data: { main: [[{ json: { count: 0 } }, { json: { count: 1 } }]] },
				source: null,
			};
			const engine = new WorkflowExecute(additionalData, 'manual', run);
			const result = await engine.runNode(workflow, data, run, 0, additionalData, 'manual');
			assert.equal(result.data[0][0].json.error, 'Limit must be a positive safe integer.');
			assert.deepEqual(result.data[0][0].pairedItem, { item: 0 });
			assert.equal(result.data[0][1].json.urn, 'urn:li:activity:100');
			if (onError === 'continueErrorOutput') {
				engine.handleNodeErrorOutput(workflow, data, result.data, 0);
				assert.equal(result.data[0].length, 1);
				assert.equal(result.data[1].length, 1);
				assert.equal(result.data[0][0].json.urn, 'urn:li:activity:100');
				assert.equal(result.data[1][0].json.error, 'Limit must be a positive safe integer.');
			}
			compatibilityCases++;
		}
		const converted = convertNodeToAiTool({ description: structuredClone(base.description) });
		converted.execute = base.execute;
		const toolDefinition = {
			name: 'Feed Tool',
			type: `${prefix}.linkedInFeedTool`,
			typeVersion: 1,
			position: [0, 0],
			credentials: { linkedInSessionApi: { id: 'fixture', name: 'fixture' } },
			parameters: {
				limit: toolExample.parameters.limit,
				options: {
					excludeCompanies: "={{ $fromAI('peopleOnly', 'Return only people posts', 'boolean') }}",
				},
			},
		};
		const dynamic = makeTool(converted, toolDefinition);
		assert.equal(dynamic.node.parameters.descriptionType, 'auto');
		assert.equal(dynamic.tool.description, base.description.description);
		const connected = await getConnectedTools(
			{ getNode: () => ({ name: 'Agent' }), getInputConnectionData: async () => [dynamic.tool] },
			true,
			false,
		);
		assert.equal(connected.length, 1);
		const schema = getParametersJsonSchema({
			type: 'function',
			name: dynamic.tool.name,
			description: dynamic.tool.description,
			inputSchema: connected[0].schema,
		});
		assert.equal(schema.properties.limit.type, 'number');
		assert.equal(schema.properties.peopleOnly.type, 'boolean');
		const mcpSchema = zodToDraft202012(dynamic.tool.schema, { removeAdditionalStrategy: 'strict' });
		assert.equal(mcpSchema.properties.limit.type, 'number');
		assert.equal(mcpSchema.properties.peopleOnly.type, 'boolean');
		compatibilityCases += 3;

		const parallel = await Promise.all([
			dynamic.tool.invoke({ limit: 1, peopleOnly: true }),
			dynamic.tool.invoke({ limit: 2, peopleOnly: false }),
		]);
		assert.deepEqual(
			parallel.map((result) => urns(JSON.parse(result))),
			[['urn:li:activity:101'], ['urn:li:activity:100', 'urn:li:activity:101']],
		);
		assert.equal(dynamic.run.resultData.runData['Feed Tool'].length, 2);
		compatibilityCases++;
		for (const args of [
			{ limit: '5', peopleOnly: true },
			{ input: '5' },
			{ limit: 0, peopleOnly: false },
			{ limit: 1.5, peopleOnly: false },
			{ limit: 1, peopleOnly: 'false' },
		]) {
			const before = requests;
			await assert.rejects(dynamic.tool.invoke(args));
			assert.equal(requests, before, 'Invalid tool arguments must not request the feed');
			compatibilityCases++;
		}
		const fixed = makeTool(converted, { ...toolDefinition, parameters: { limit: 2, options: {} } });
		assert.deepEqual(Object.keys(fixed.tool.schema.shape), []);
		assert.deepEqual(urns(JSON.parse(await fixed.tool.invoke({}))), [
			'urn:li:activity:100',
			'urn:li:activity:101',
		]);
		compatibilityCases++;
		const legacy = makeTool(converted, {
			...toolDefinition,
			parameters: {
				...toolDefinition.parameters,
				descriptionType: 'manual',
				toolDescription: 'Use my saved description',
			},
		});
		assert.equal(legacy.node.parameters.descriptionType, 'manual');
		assert.equal(legacy.tool.description, 'Use my saved description');
		assert(
			NodeHelpers.displayParameter(
				legacy.node.parameters,
				converted.description.properties.find((prop) => prop.name === 'descriptionType'),
				legacy.node,
				converted.description,
			),
		);
		compatibilityCases++;
		responseBody = Buffer.from('0:[[],null,[]]\n');
		assert.deepEqual(JSON.parse(await dynamic.tool.invoke({ limit: 5, peopleOnly: true })), []);
		compatibilityCases++;
		responseStatus = 403;
		await assert.rejects(dynamic.tool.invoke({ limit: 5, peopleOnly: false }), /requires sign-in/);
		responseStatus = 200;
		compatibilityCases++;
	}
	let commentCompatibilityCases = 0;
	const commentExample = JSON.parse(
		readFileSync(new URL('../examples/create-comment-as-tool.json', import.meta.url), 'utf8'),
	).nodes[0];
	for (const [prefix, sourceLoader] of [
		['n8n-nodes-linkedin-feed', loader],
		['CUSTOM', customLoader],
	]) {
		const base = sourceLoader.nodeTypes.linkedInComment.type;
		assert(base);
		assert.equal(base.description.credentials[0].name, 'linkedInSessionApi');
		const definition = {
			name: 'Comment',
			type: `${prefix}.linkedInComment`,
			typeVersion: 1,
			position: [0, 0],
			credentials: { linkedInSessionApi: { id: 'fixture', name: 'fixture' } },
			parameters: { postUrn: '={{ $json.urn }}', text: '={{ $json.comment }}', options: {} },
		};
		for (const mode of ['manual', 'trigger', 'integrated']) {
			const workflow = makeWorkflow(base, definition);
			const run = freshRun();
			const data = {
				node: workflow.getNode('Comment'),
				data: { main: [[{ json: { urn: 'urn:li:share:202', comment: 'Fixture comment' } }]] },
				source: { main: [null] },
			};
			const result = await new WorkflowExecute(additionalData, mode, run).runNode(
				workflow,
				data,
				run,
				0,
				additionalData,
				mode,
			);
			assert.equal(result.data[0][0].json.commentUrn, 'urn:li:comment:(activity:101,999)');
			assert.equal(result.data[0][0].json.postUrn, 'urn:li:share:202');
			assert.deepEqual(result.data[0][0].pairedItem, { item: 0 });
			commentCompatibilityCases++;
		}
		const converted = convertNodeToAiTool({ description: structuredClone(base.description) });
		converted.execute = base.execute;
		const dynamic = makeTool(converted, {
			...commentExample,
			type: `${prefix}.linkedInCommentTool`,
			credentials: definition.credentials,
		});
		assert.equal(dynamic.node.parameters.descriptionType, 'auto');
		const schema = getParametersJsonSchema({
			type: 'function',
			name: dynamic.tool.name,
			description: dynamic.tool.description,
			inputSchema: dynamic.tool.schema,
		});
		const mcp = zodToDraft202012(dynamic.tool.schema, { removeAdditionalStrategy: 'strict' });
		for (const result of [schema, mcp]) {
			assert.equal(result.properties.postUrn.type, 'string');
			assert.equal(result.properties.text.type, 'string');
			commentCompatibilityCases++;
		}
		const result = JSON.parse(
			await dynamic.tool.invoke({ postUrn: 'urn:li:activity:101', text: 'Fixture comment' }),
		);
		assert.equal(result[0].commentUrn, 'urn:li:comment:(activity:101,999)');
		commentCompatibilityCases++;
		const before = requests;
		for (const args of [
			{ input: 'leave a comment' },
			{ postUrn: 101, text: 'Fixture comment' },
			{ postUrn: 'urn:li:activity:101', text: 5 },
			{ postUrn: 'invalid', text: 'Fixture comment' },
		]) {
			await assert.rejects(dynamic.tool.invoke(args));
			commentCompatibilityCases++;
		}
		assert.equal(requests, before, 'Invalid comment tool inputs must not send requests');
	}
	console.log(
		JSON.stringify({
			n8n: version,
			isolatedInstallation: true,
			nodeLoaded: true,
			credentialLoaded: true,
			executed: true,
			numericToolInput: true,
			compatibilityCases,
			commentCompatibilityCases,
			customNodeLoaded: true,
			requests,
		}),
	);
} finally {
	rmSync(isolated, { recursive: true, force: true });
}
