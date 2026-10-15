import type {
	ICredentialTestFunctions,
	ICredentialsDecrypted,
	INodeCredentialTestResult,
} from 'n8n-workflow';
import { LinkedInClient, initialPayload } from '../LinkedInFeed/lib/client';
import { DEFAULT_OPTIONS, publicError } from '../LinkedInFeed/lib/types';
import type { SessionCredentials } from '../LinkedInFeed/lib/types';
export const sessionMethods = {
	credentialTest: {
		async linkedInSessionTest(
			this: ICredentialTestFunctions,
			credentials: ICredentialsDecrypted,
		): Promise<INodeCredentialTestResult> {
			try {
				const client = new LinkedInClient(
					// n8n's credential-test hook exposes request; executions use httpRequest.
					(options) =>
						// eslint-disable-next-line @n8n/community-nodes/no-deprecated-workflow-functions -- Credential-test hooks expose only request in the supported n8n API.
						this.helpers.request({
							uri: options.url,
							method: options.method,
							headers: options.headers,
							body: options.body,
							timeout: options.timeout,
							encoding: null,
							resolveWithFullResponse: true,
							simple: false,
							followRedirect: false,
							followAllRedirects: false,
						}),
					credentials.data as unknown as SessionCredentials,
					{ ...DEFAULT_OPTIONS, maxRetries: 0 },
				);
				await client.page(initialPayload());
				return { status: 'OK', message: 'LinkedIn session is valid.' };
			} catch (error) {
				return { status: 'Error', message: publicError(error) };
			}
		},
	},
};
