/** Fabricated server response matching the browser-verified comment POST. */
export function commentResult(
	activityId = '101',
	commentId = '999',
	errors: unknown[] = [],
	type: 'activity' | 'ugcPost' = 'activity',
) {
	return Buffer.from(
		`0:${JSON.stringify({ states: [], response: { $type: 'proto.sdui.responses.ServerRequestResponse', errors, isRetryable: false, completionAction: { actions: [{ $type: 'proto.sdui.actions.core.UpsertToCollection', value: { components: [{ semanticId: `replyBox-urn:li:comment:(${type}:${activityId},${commentId})` }, { semanticId: `urn:li:comment:(${type}:${activityId},${commentId})`, item: '$L1' }] } }] } } })}\n1:["$","unused-module",null,{}]\n`,
	);
}
