# n8n LinkedIn Feed and Comments

Retrieve up to **N unique organic posts** from the signed-in account's main LinkedIn feed. Credentials and Limit are configurable in n8n. Posts arrive as separate items, ready for downstream nodes. **LinkedIn Comment** publishes a plain-text comment using a post URN and text, with the same session credential.

This private package targets **self-hosted n8n 2.43.5 and Node.js 24+**. It uses the plain HTTP session protocol demonstrated in `investigation/`, including LinkedIn's recent-first feed refresh and server-supplied continuation payloads.

## Build and install on your server

Check out or copy the source onto your server. In the project directory, use Node.js 24 (`nvm use` if you use nvm):

```sh
npm ci
npm run check
```

Install the built node directly from that source directory into your n8n user directory:

```sh
mkdir -p ~/.n8n/nodes
npm install --prefix ~/.n8n/nodes --omit=dev --ignore-scripts --install-links /absolute/path/on/server/n8n-linkedin
```

Restart n8n. Your instance must allow community packages. If you configured a custom n8n user directory, use its `nodes` directory instead. Queue-mode workers need the same package installed.

For a deployment using custom extensions instead of package installation, set `N8N_CUSTOM_EXTENSIONS=/absolute/path/on/server/n8n-linkedin/dist` in the n8n service environment after building. Keep the project's installed runtime dependencies available alongside that `dist` directory. Restart n8n and its workers after updating. This loading mode registers `CUSTOM.linkedInFeed`, `CUSTOM.linkedInComment`, and their generated `Tool` variants; package installation uses the `n8n-nodes-linkedin-feed` prefix. Existing workflows must reference the type prefix used by their deployment.

`--install-links` installs a copy of the built package instead of a symlink to the source directory. `--ignore-scripts` skips installation hooks because you already built the node.

For an existing Docker container named `n8n` with `/home/node/.n8n` persisted, run the build above on your server, then copy the compiled output and package manifest into the container:

```sh
docker exec --user node n8n mkdir -p /tmp/linkedin-feed-source/dist
docker cp dist/. n8n:/tmp/linkedin-feed-source/dist/
docker cp package.json n8n:/tmp/linkedin-feed-source/package.json
docker exec --user node n8n npm install --prefix /home/node/.n8n/nodes --omit=dev --ignore-scripts --install-links /tmp/linkedin-feed-source
docker restart n8n
```

## Configure credentials

1. Sign in to LinkedIn in your browser.
2. Open developer tools, then Application/Storage → Cookies → `https://www.linkedin.com`.
3. Copy the **values** of `li_at` and `JSESSIONID`.
4. Copy the browser's User-Agent from a LinkedIn request's headers.
5. Create a **LinkedIn Session API** credential in n8n and enter those three fields.

Both cookie fields are masked and stored by n8n's encrypted credential manager. JSESSIONID accepts surrounding quotes. The credential's test performs one feed POST.

Cookie changes are retained in memory for that collection. If LinkedIn requires sign-in or verification, export current cookies again and update the credential. The node does not modify the PoC's `.env` or n8n's saved credentials.

## Retrieve posts

Add **LinkedIn Feed**, select **Get Posts**, select your credential, and set **Limit** (default `20`). Limit supports expressions, for example `={{ $json.numberOfPosts }}`.

Import [the example workflow](examples/get-feed.json) and select your credential before execution.

To use the node with an **AI Agent**, click **+** under the agent's **Tools** connector, search for **LinkedIn Feed**, and select **LinkedIn Feed Tool**. Configure its session credential and Limit. n8n generates this separate tool variant from the node's `usableAsTool` setting; the regular **LinkedIn Feed** node already on the canvas has a normal workflow output and cannot connect to the Tools connector. After installing or updating the node, restart n8n and reload the editor before adding the tool.

To let the agent choose the number of posts, set the tool's **Limit** to **Expression** and enter:

```text
{{ $fromAI('limit', 'Number of posts to retrieve; a positive whole number', 'number') }}
```

This exposes a numeric tool argument: the agent calls the tool with `{"limit":5}`. The explicit `'number'` type matters because `$fromAI()` defaults to string. A fixed Limit such as `20` stays node configuration and exposes no limit argument to the agent. Tool descriptions alone do not define the input schema. See [n8n's tool parameter documentation](https://docs.n8n.io/advanced-ai/examples/using-the-fromai-function/).

Argument names are case-sensitive: `$fromAI('Limit', '', 'number')` expects `{"Limit":5}`, while the expression above expects `{"limit":5}`. After changing the expression, rerun the AI Agent so it receives the new schema. Re-executing only the tool step can reuse an earlier tool input.

If **From AI** shows a string field named `input` while the expression expects a numeric `limit`, check the connected chat model's tool-schema conversion. A custom model adapter can lose the structured schema when separate copies of Zod are installed. This can leave Calculator working (it accepts a text input) while this node fails because `$fromAI('limit', ...)` resolves to `undefined`. Changing the tool description or upgrading n8n alone does not repair that adapter conversion. The node's default Limit is the fixed number `20`; n8n saves a `$fromAI()` expression when you enable model-defined input.

The [tool example](examples/get-feed-as-tool.json) contains this configuration. Import it, select your LinkedIn credential, and connect its output to an existing AI Agent's **Tools** connector. The example contains only the tool node, so you can use your existing agent and model. It keeps the default automatic tool description. Switch **Tool Description** to **Set Manually** if you want to customize its description. Exact publication timestamps remain unavailable; posts include the publication label supplied by LinkedIn.

New tool instances default to **Set Automatically**, using n8n's operation description. Choose **Set Manually** to customize it; the editor supplies a description of the available data and input requirements. Existing workflows retain their saved choice. Limit still defaults to the fixed number `20`.

| Connection                               | Node to use        | Behavior                                                                                                        |
| ---------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Ordinary workflow and sub-workflow steps | LinkedIn Feed      | Main input/output; evaluates Limit and Options for each input item and pairs returned posts with that input     |
| AI Agent Tools                           | LinkedIn Feed Tool | `ai_tool` output; fixed configuration or typed `$fromAI()` arguments; independent state for each invocation     |
| MCP Server Trigger Tools                 | LinkedIn Feed Tool | Uses n8n's tool contract and MCP schema conversion; n8n manages the MCP endpoint, authentication, and transport |

Chat-model adapters must preserve the tool's schema when advertising it to their model. The integration checks validate n8n's native tool registration, AI SDK schema conversion, and MCP schema serialization with fixture responses; they do not run external models or a live MCP server.

For people-only posts, add **Options → Exclude Companies** and enable it. The node identifies personal profiles from the post author's LinkedIn profile URL, skips company and unidentified authors, and keeps paginating until it reaches Limit or the feed ends. Company mentions in a person's post do not exclude that post. This option is also available on **LinkedIn Feed Tool**.

To skip posts without text, enable **Options → Exclude Empty Text** in **LinkedIn Feed** or **LinkedIn Feed Tool**. It excludes empty and whitespace-only text, including media-only posts. It defaults to off and can be combined with Exclude Companies. Limit counts only posts that pass both filters, so the node keeps paginating as needed until the feed ends or Maximum Pages is reached.

Each incoming item starts a new recent-first collection. Each returned post links back to its corresponding input item through `pairedItem`. Sponsored cards and non-post upsells are excluded; organic company posts remain eligible by default. Duplicate post URNs are removed while preserving feed order.

| Option               | Default | Behavior                                                           |
| -------------------- | ------- | ------------------------------------------------------------------ |
| Limit                | 20      | Positive safe integer; requested unique organic posts              |
| Exclude Companies    | false   | Return only identifiable people posts; Limit counts matching posts |
| Exclude Empty Text   | false   | Skip empty or whitespace-only text; Limit counts matching posts    |
| Maximum Pages        | 100     | Fails when reached while additional posts are still needed         |
| Maximum Retries      | 2       | Retries per page; configurable from 0 to 10                        |
| Request Timeout (Ms) | 25000   | Timeout for each HTTP request                                      |

The node returns fewer than Limit when LinkedIn exhausts the feed. An empty exhausted feed returns no items. Parameters must resolve to numeric integers and booleans as appropriate; strings and null settings are rejected before loading credentials or requesting posts. Network, authentication, parsing, and page-limit failures fail the node by default. n8n's **On Error** settings can continue through the regular or error output with paired, sanitized errors; legacy **Continue On Fail** is also supported. Execution cancellation always stops the collection, including when error continuation is enabled.

Transient connection failures and HTTP `429`, `502`, `503`, and `504` use bounded retries. `Retry-After` is respected. A page has a cumulative retry-wait budget of 60 seconds; longer waits fail with the minimum retry delay so the workflow can be scheduled later.

## Output

```json
{
	"urn": "urn:li:activity:101",
	"url": "https://www.linkedin.com/feed/update/urn:li:activity:101/",
	"text": "Example post text",
	"author": {
		"name": "Example Person",
		"url": "https://www.linkedin.com/in/example-person/",
		"headline": "Software engineer"
	},
	"publication": { "publishedAt": null, "label": "2h • Edited" },
	"media": [{ "type": "image", "url": "https://media.example.com/image.jpg", "title": null }],
	"engagement": { "reactions": 12, "comments": 0, "reposts": 3 }
}
```

For feed/repost entries, `urn` and `url` use the displayed post's comment thread (`activity` or `ugcPost`) when LinkedIn supplies an explicit target for that feed update. If it differs from the surrounding activity, `feedActivityUrn` preserves the surrounding ID. This also deduplicates the same post shown through different feed activities. Refresh saved feed results after updating; older surrounding activity IDs may not accept comments.

Unavailable scalar metadata is `null`; missing media is `[]`. Post text can be empty for media-only or article-only posts. Media contains available URLs and metadata, rather than downloaded files. Absolute publication timestamps are not inferred from relative labels or activity IDs; the current feed provides a publication label. Reaction counts read only supported initial binding expressions; unrecognized expressions yield `null`.

LinkedIn's private SDUI/React Flight protocol can change. The decoder and extraction code are isolated under `nodes/LinkedInFeed/lib/`; unsupported framing or post layouts produce an explicit failure. Returned data excludes raw cards, cookies, continuation tokens, and request headers.

## Development and validation

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run dev
```

Tests cover byte framing and references, bounded text expansion, extraction and filtering, localized author profiles, precise post IDs, initial bindings, pagination, cookie rotation, retries, sanitized errors, parameter validation, cancellation, and n8n input/output pairing. Fixtures use fabricated identifiers and content derived from observed protocol shapes.

For integration checks, set `N8N_RUNTIME_DIR` to a directory containing an installed n8n 2.43.5 package, or run with n8n installed in this project's `node_modules`:

```sh
N8N_RUNTIME_DIR=/path/to/n8n-runtime npm run test:install
N8N_RUNTIME_DIR=/path/to/n8n-runtime npm run test:live -- --env-file investigation/linkedin-http/.env --limit 20
```

The installation check installs the built node directly from the source directory into a temporary directory and exercises n8n's package and custom-directory loaders. Native engine checks cover manual, triggered, and integrated execution, per-item expressions, fixed and dynamic tool parameters, concurrent calls, empty results, authentication failures, tool-description defaults and migration, AI SDK conversion, and MCP schema serialization. Both checks isolate n8n settings in temporary folders and clean them up. The opt-in live check uses the n8n package loader and HTTP helper to retrieve the requested count with your supplied session. It reports counts only and does not persist credentials or post contents. You can alternatively provide `LI_AT`, `JSESSIONID`, and `LINKEDIN_USER_AGENT` as environment variables.

The installed package includes compiled node code, credential code, the icon, this README, and the example workflow. Investigation files, tests, development scripts, and credentials are excluded. This is an internal, unlicensed package; the lint configuration retains n8n checks with narrowly documented exceptions for private-package metadata, the cookie dependency, and domain-error boundaries.

## Create a comment

Add **LinkedIn Comment**, select your existing **LinkedIn Session API** credential, and configure **Post URN** and **Comment Text**. Post URN accepts `urn:li:activity:…` and `urn:li:ugcPost:…`. Use the `urn` returned by LinkedIn Feed directly. Each input item makes exactly one authenticated HTTP POST, with its payload built from the typed comment-thread URN and text. The feed activity in a post URL can differ from its comment thread; do not extract the ID from a saved feed URL or replace the URN prefix. Share IDs are rejected before any request. Refresh Feed results saved with an older version of this node.

LinkedIn's request contains both a feed `updateKey` and a typed `threadUrn`; they can identify different entities. Feed reads the thread from either nested `collection` metadata or sibling `updateKey`/`threadUrn` metadata. A successful HTTP status alone is insufficient: LinkedIn can return HTTP 200 with an explicit comment-failure state and no entry in `errors`.

Both fields support expressions. The [workflow example](examples/create-comment.json) uses `={{ $json.urn }}` and `={{ $json.comment }}` from an upstream item. It creates one comment per input item and pairs each result with its input. Plain text and line breaks are preserved; rich mentions, media attachments, and replies to other comments are not supported.

For an **AI Agent** or **MCP Server Trigger**, use **LinkedIn Comment Tool**. The [tool example](examples/create-comment-as-tool.json) exposes two string arguments:

```text
{{ $fromAI('postUrn', 'URN of the LinkedIn post to comment on', 'string') }}
{{ $fromAI('text', 'Exact plain-text comment to publish', 'string') }}
```

The tool expects an object such as `{"postUrn":"urn:li:activity:123456789","text":"Thanks for sharing."}`. Fixed fields remain configuration and are not exposed as agent arguments. Tool Description defaults to **Set Automatically**; model-defined expressions are configured explicitly. For custom-extension installations, change the example's type prefix to `CUSTOM`.

A successful result contains `postUrn`, `commentUrn`, `commentId`, the submitted `text`, and `postUrl`. Success requires LinkedIn's server response to identify the created comment in the expected thread, including its URN type. Activity posts also return `activityUrn`; UGC posts do not invent an activity ID. Request Timeout defaults to 25,000 ms per request.

Comment submissions are sent **once**, without automatic retries. A timeout, HTTP 500, cancellation during submission, or malformed response can occur after LinkedIn has already created the comment. Errors retain the HTTP status, supported network error code, or confirmation failure stage without exposing cookies or response bodies, and tell you to check the post before retrying. n8n's **Retry On Fail**, manual workflow reruns, and repeated agent calls can still create duplicates; these are separate invocations. Continue On Fail returns a paired error for the affected item; cancellation stops the execution.

This uses LinkedIn's browser session/SDUI HTTP endpoint. The node generates the complete JSON request locally, including independent state and tracking IDs for each invocation. It does not fetch post pages, inspect forms, or require a browser. The server response supplies the created comment URN; unavailable posts and disabled comments are handled through that response. Live verification covered an activity thread with a different feed activity ID and a UGC thread: the compiled node sent one POST for each, parsed LinkedIn's confirmation, and the comments persisted after reloading before test cleanup. This verification used browser-assisted HTTP transport; server-side transport is covered by the isolated n8n integration checks. The protocol can change. Rebuild, reinstall the package copy if applicable, and restart n8n and its workers to load the new node.
