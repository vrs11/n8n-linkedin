import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

export function runtime() {
	// Isolate settings before loading n8n's lazily initialized DI services.
	const userFolder = mkdtempSync(resolve(tmpdir(), 'linkedin-n8n-settings-'));
	process.env.N8N_USER_FOLDER = userFolder;
	process.env.N8N_DIAGNOSTICS_ENABLED = 'false';
	process.env.N8N_VERSION_NOTIFICATIONS_ENABLED = 'false';
	process.on('exit', () => rmSync(userFolder, { recursive: true, force: true }));
	const require = createRequire(resolve(process.env.N8N_RUNTIME_DIR ?? '.', 'package.json'));
	require('reflect-metadata');
	const coreRoot = resolve(require.resolve('n8n-core/package.json'), '..');
	const { PackageDirectoryLoader } = require(
		resolve(coreRoot, 'dist/nodes-loader/package-directory-loader.js'),
	);
	const { CustomDirectoryLoader } = require(
		resolve(coreRoot, 'dist/nodes-loader/custom-directory-loader.js'),
	);
	const { getRequestHelperFunctions } = require(
		resolve(
			coreRoot,
			'dist/execution-engine/node-execution-context/utils/request-helpers/factory.js',
		),
	);
	const version = require('n8n/package.json').version;
	const { createNodeAsTool } = require(
		resolve(coreRoot, 'dist/execution-engine/node-execution-context/utils/create-node-as-tool.js'),
	);
	const { makeHandleToolInvocation } = require(
		resolve(
			coreRoot,
			'dist/execution-engine/node-execution-context/utils/get-input-connection-data.js',
		),
	);
	const { SupplyDataContext } = require(
		resolve(coreRoot, 'dist/execution-engine/node-execution-context/supply-data-context.js'),
	);
	const { convertNodeToAiTool } = require(
		resolve(require.resolve('n8n/package.json'), '..', 'dist/tool-generation/ai-tools.js'),
	);
	const { WorkflowExecute } = require('n8n-core');
	const { Workflow, NodeHelpers } = require('n8n-workflow');
	const { getParametersJsonSchema } = require('@n8n/ai-utilities');
	const langchainRoot = resolve(require.resolve('@n8n/n8n-nodes-langchain/package.json'), '..');
	const { getConnectedTools } = require(resolve(langchainRoot, 'dist/utils/helpers.js'));
	const { zodToDraft202012 } = require('@n8n/ai-utilities/json-schema');
	return {
		PackageDirectoryLoader,
		CustomDirectoryLoader,
		getRequestHelperFunctions,
		WorkflowExecute,
		Workflow,
		NodeHelpers,
		version,
		createNodeAsTool,
		convertNodeToAiTool,
		makeHandleToolInvocation,
		SupplyDataContext,
		getConnectedTools,
		getParametersJsonSchema,
		zodToDraft202012,
	};
}
