/** Fabricated server response matching the browser-verified comment POST. */
export function commentResult(activityId = '101', commentId = '999', errors: unknown[] = []) {
	return Buffer.from(
		`0:${JSON.stringify({ states: [], response: { $type: 'proto.sdui.responses.ServerRequestResponse', errors, isRetryable: false, completionAction: { actions: [{ $type: 'proto.sdui.actions.core.UpsertToCollection', value: { components: [{ semanticId: `replyBox-urn:li:comment:(activity:${activityId},${commentId})` }, { semanticId: `urn:li:comment:(activity:${activityId},${commentId})`, item: '$L1' }] } }] } } })}\n1:["$","unused-module",null,{}]\n`,
	);
}
