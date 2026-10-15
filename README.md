# n8n LinkedIn Feed

Retrieve up to **N unique organic posts** from the signed-in account's main LinkedIn feed. Credentials and Limit are configurable in n8n. Posts arrive as separate items, ready for downstream nodes.

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

Each incoming item starts a new recent-first collection. Each returned post links back to its corresponding input item through `pairedItem`. Sponsored cards and non-post upsells are excluded; organic company posts remain eligible. Duplicate post URNs are removed while preserving feed order.

| Option               | Default | Behavior                                                   |
| -------------------- | ------- | ---------------------------------------------------------- |
| Limit                | 20      | Positive safe integer; requested unique organic posts      |
| Maximum Pages        | 100     | Fails when reached while additional posts are still needed |
| Maximum Retries      | 2       | Retries per page; configurable from 0 to 10                |
| Request Timeout (Ms) | 25000   | Timeout for each HTTP request                              |

The node returns fewer than Limit when LinkedIn exhausts the feed. An empty exhausted feed returns no items. Network, authentication, parsing, and page-limit failures fail the node; enabling **Continue On Fail** returns a paired item containing a sanitized `error` string.

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

Tests cover byte framing and references, extraction and filtering, initial bindings, pagination, cookie rotation, retries, sanitized errors, and n8n input/output pairing. Fixtures use fabricated identifiers and content derived from observed protocol shapes.

For integration checks, set `N8N_RUNTIME_DIR` to a directory containing an installed n8n 2.43.5 package, or run with n8n installed in this project's `node_modules`:

```sh
N8N_RUNTIME_DIR=/path/to/n8n-runtime npm run test:install
N8N_RUNTIME_DIR=/path/to/n8n-runtime npm run test:live -- --env-file investigation/linkedin-http/.env --limit 20
```

The installation check installs the built node directly from the source directory into a temporary directory and uses n8n's package loader and execution engine with a fixture response. Both checks isolate n8n settings in temporary folders and clean them up. The opt-in live check uses the n8n package loader and HTTP helper to retrieve the requested count with your supplied session. It reports counts only and does not persist credentials or post contents. You can alternatively provide `LI_AT`, `JSESSIONID`, and `LINKEDIN_USER_AGENT` as environment variables.

The installed package includes compiled node code, credential code, the icon, this README, and the example workflow. Investigation files, tests, development scripts, and credentials are excluded. This is an internal, unlicensed package; the lint configuration retains n8n checks with narrowly documented exceptions for private-package metadata, the cookie dependency, and domain-error boundaries.
