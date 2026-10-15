import { CREATE_COMMENT } from '../nodes/LinkedInComment/lib/comment';
/** Fabricated, minimized shapes from browser-observed LinkedIn SDUI traffic. */
export function commentArgs(activityId = '101') {
	const names = [
		'commentFieldBinding',
		'richCommentFieldBinding',
		'linkPreviewIngestedContentId',
		'externalImageUrl',
		'externalImageId',
		'lastPasteCharacterCount',
		'pasteToCreateDuration',
		'hasEditsSinceLastPaste',
	];
	return {
		$type: 'proto.sdui.actions.requests.RequestedArguments',
		requestedStateKeys: [],
		payload: {
			optimisticKey: 'auto-component-fixture',
			collection: {
				updateKey: {
					feedType: 3,
					items: [
						{
							feedUpdateUrn: { updateUrnActivityUrn: { activityUrn: { activityId } } },
							trackingId: 'fixture-only',
						},
					],
					aggregationType: 0,
					aggregationReasonTypes: [],
					isVideoCarousel: false,
				},
				threadUrn: { threadUrnActivityThreadUrn: { activityUrn: { activityId } } },
			},
			...Object.fromEntries(
				names.map((name) => [name, { key: `${name}-fixture`, namespace: 'MemoryNamespace' }]),
			),
		},
		requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
	};
}
export function commentPage(args: unknown = commentArgs()) {
	const flight = `1:${JSON.stringify({ requestId: CREATE_COMMENT, requestedArguments: args, onClientRequestFailureAction: { neverExecute: true } })}\n0:["$L1","$L1"]\n`;
	return Buffer.from(
		`<html><script type="text/javascript" id="rehydrate-data" nonce="fixture">window.__como_rehydration__ = ${JSON.stringify([flight])}</script></html>`,
	);
}
export function commentResult(activityId = '101', commentId = '999', errors: unknown[] = []) {
	return Buffer.from(
		`0:${JSON.stringify({ states: [], response: { $type: 'proto.sdui.responses.ServerRequestResponse', errors, isRetryable: false, completionAction: { actions: [{ $type: 'proto.sdui.actions.core.UpsertToCollection', value: { components: [{ semanticId: `replyBox-urn:li:comment:(activity:${activityId},${commentId})` }, { semanticId: `urn:li:comment:(activity:${activityId},${commentId})`, item: '$L1' }] } }] } } })}\n1:["$","unused-module",null,{}]\n`,
	);
}
