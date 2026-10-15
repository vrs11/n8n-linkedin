import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class LinkedInSessionApi implements ICredentialType {
	name = 'linkedInSessionApi';
	displayName = 'LinkedIn Session API';
	documentationUrl = 'https://www.linkedin.com/legal/l/cookie-table';
	icon = 'file:../nodes/LinkedInFeed/linkedinFeed.svg' as const;
	properties: INodeProperties[] = [
		// eslint-disable-next-line @n8n/community-nodes/credential-unnecessary-password -- li_at authenticates the browser session.
		{
			displayName: 'li_at',
			name: 'liAt',
			type: 'string',
			default: '',
			required: true,
			typeOptions: { password: true },
			description: 'The li_at cookie value from your signed-in LinkedIn browser session',
		},
		// eslint-disable-next-line @n8n/community-nodes/credential-unnecessary-password -- JSESSIONID supplies the session's CSRF secret.
		{
			displayName: 'JSESSIONID',
			name: 'jsessionId',
			type: 'string',
			default: '',
			required: true,
			typeOptions: { password: true },
			description: 'The JSESSIONID cookie value, with or without surrounding quotes',
		},
		{
			displayName: 'User-Agent',
			name: 'userAgent',
			type: 'string',
			default: '',
			required: true,
			description: 'The User-Agent header from the browser where you exported the cookies',
		},
	];
}
