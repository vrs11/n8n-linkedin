import type { INodeProperties } from 'n8n-workflow';
export function toolDescriptionProperties(manualDescription: string): INodeProperties[] {
	return [
		{
			displayName: 'Tool Description',
			name: 'descriptionType',
			type: 'options',
			noDataExpression: true,
			displayOptions: { show: { '@tool': [true] } },
			options: [
				{
					name: 'Set Automatically',
					value: 'auto',
					description: 'Describe the selected operation',
				},
				{
					name: 'Set Manually',
					value: 'manual',
					description: 'Provide a detailed tool description',
				},
			],
			default: 'auto',
		},
		{
			displayName: 'Description',
			name: 'toolDescription',
			type: 'string',
			typeOptions: { rows: 4 },
			displayOptions: { show: { '@tool': [true], descriptionType: ['manual'] } },
			default: manualDescription,
			description: 'Describe this tool and its arguments to the AI Agent',
		},
	];
}
