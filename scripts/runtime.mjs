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
	const { getRequestHelperFunctions } = require(
		resolve(
			coreRoot,
			'dist/execution-engine/node-execution-context/utils/request-helpers/factory.js',
		),
	);
	const version = require('n8n/package.json').version;
	const { WorkflowExecute } = require('n8n-core');
	const { Workflow } = require('n8n-workflow');
	return { PackageDirectoryLoader, getRequestHelperFunctions, WorkflowExecute, Workflow, version };
}
