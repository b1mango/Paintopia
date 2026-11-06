# Image API integration contract

## Shared exports

Import from @paintopia/shared:

- resolveImageSize(resolution: string, aspectRatio = "1:1"): string returns WxH or auto; invalid values throw. Resolutions: 1K/2K/4K/auto (case-insensitive); ratios exported in IMAGE_ASPECT_RATIOS. Either auto input returns auto, never a ratio token.
- validateImageSize(size: string): string normalizes WxH or auto. Integer edges 16–8192, divisible by 16, at most 33,554,432 pixels. No silent alignment: UI aligns and displays errors.
- parsePixelSize, inferImageResolution, inferImageAspectRatio and IMAGE_SIZE_PRESETS are exported. Inference matches presets first, then pixel-area tiers.
- calculateImageQuotaCost(rules, resolution, quality, count = 1) is shared by browser/API. Auto or channel-specific quality uses same-resolution high. Auto resolution uses 4K. Configured prices are honored, including an explicitly configured zero; missing rules use defaults. Count clamps to 1–8.

## Generation inputs

POST /api/generate, /api/generate/stream and /api/generate/edit retain response shapes. JSON params accepts resolution, aspectRatio, size, quality, background (auto/opaque/transparent), n. Multipart edits accept the same fields directly. Explicit size wins; otherwise resolve scale and ratio. Non-auto size and resolution must agree. Exact model tier conflicts and legacy size tier conflicts remain rejected. Normalized n (1–8) is used consistently in requests, asset metadata, job history and quota calculations. alignTo16 is UI-only; server validates submitted pixels.

PNG/JPEG/WebP decoded dimensions are stored as actualWidth/actualHeight and compared on both axes against requested pixels. Undersized output is saved and returned with resolutionWarning without retrying another paid provider. Auto size uses best-effort tier verification; enforced upstream quality is not claimed.

Assets always record the actual successful providerId, providerName and model, including fallback providers. Job params also record the successful provider. Client-supplied actual/upstream/runtime/output/provider/reference metadata is stripped from generation and upload inputs; server-owned fields are rebuilt from actual execution. User prompt sourceId remains intact and is distinct from the server-owned providerId.

## Provider imageCapabilities

Provider create/update/list and /api/image-capabilities model entries expose imageCapabilities:

- qualities?: string[] — missing or [] means no additional channel whitelist.
- sizeField?: "size" | "image_size" | null — missing defaults to size; null omits it.
- resolutionField?: "resolution" | "image_size" | null — missing defaults to resolution; null omits it.
- supportsStreaming?: boolean — false skips stream probing; missing retains mode behavior.

Both fields cannot map to image_size (400). Unsupported configured quality is rejected before network access, without silent remapping. Edits/chat_completions still have no partial stream mode. Background/quality are forwarded. Responses uses the image_generation tool; other modes use body/form.

Configuration persists in provider_configs.config_json (SQLite/PostgreSQL migration code). PATCH with omitted capability preserves it; {} resets defaults. No existing user configuration is proactively rewritten by this task.

## Runtime diagnostics and history

params.__paintopiaRuntime.imageGeneration.attempts[].requests[] contains endpoint, method and parameters captured at the actual fetch boundary on both success/failure. Requests preserve stream fallback, per-image requests, internal retry and polling order within each attempt. Headers, API keys, URL credentials/query strings and image base64 are excluded. Multipart files record type/bytes only. Logical attempt count stays unchanged; HTTP retries add request snapshots.

params.__paintopiaRuntime.imageGeneration.outputs contains [{assetId,width,height,imageUrl}]. The same outputs array is returned directly on each GET /api/generation-history item. GET /api/generation-history is always scoped to the caller, admins included; GET /api/admin/generation-history (admin only, same filters including user) lists every user's jobs for the admin stats page. Width/height are decoded saved pixels, or null when unknown. Old jobs without stored outputs return []; no fabricated dimensions. Failed/rolled-back jobs have no outputs.

## Assets and prompt optimization

GET /api/assets?scope=mine&page=1&pageSize=20 returns {items,total,page,pageSize}. Page >=1, pageSize 1–100. Order: createdAt descending, stable id tie-break. SQL restricts to caller-owned ready assets, including admins. Invalid pagination returns 400. Without both pagination fields, response remains an array, still caller-only. Only scope=mine is supported; this is not an admin asset browser.

POST /api/prompt-tools/optimize accepts optional outputLanguage: "zh" | "en" (omitted means auto, matching the input language; invalid values return 400) and returns one GPT-image natural-language prompt in text, without forced positive/negative groups or weights. English output with detected CJK remnants receives one repair call when a text Provider is configured, with the repair instruction appended to systemPrompt; the response shape and unconfigured-Provider fallback remain unchanged. The system prompt renders the default optimize template with the existing variables, then appends fixed language and single-prompt formatting rules. If no default exists, the built-in general optimizer content is used. targetModel is a template variable, not a template selector. POST /api/prompt-tools/translate is removed (404); historical translate usage/log records remain readable.

Admin template API (all routes require an administrator):

- Template JSON: `{id: string, name: string, type: "optimize", targetModel: string, content: string, isDefault: boolean, createdAt: string, updatedAt: string}`; timestamps are ISO 8601 strings.
- GET /api/admin/templates returns `Template[]`, optimize only, default first, then createdAt descending and id ascending.
- POST /api/admin/templates accepts `{name: string, content: string, targetModel?: string, type?: "optimize"}`; omitted targetModel is `"general"`, omitted type is `"optimize"`. Returns 201 with the created Template (`isDefault: false`).
- PATCH /api/admin/templates/:id accepts the same body (name/content required), returns 200 with the updated Template and preserves isDefault. Omitted targetModel resets to `"general"`.
- POST /api/admin/templates/:id/default needs no body, atomically selects the sole default and returns 200 with the full `Template[]` in GET order.
- DELETE /api/admin/templates/:id returns 204 for a nondefault template. Deleting the default returns 409 `{error:"请先把其他模板设为默认，再删除这份"}`.
- Unknown template IDs return 404 `{error:"提示词模板不存在"}`; invalid input including type `"translate"` returns 400.

SQLite/PostgreSQL migrations add integer is_default (default 0), remove the translate/translate-cinematic seeds, convert custom translate templates to optimize, and upgrade only exact matches of the old built-in optimizer content. Administrator-edited content is preserved. If no default exists, select id=optimize or the earliest created optimizer; seed bootstrap also ensures a default on fresh databases. A partial unique index enforces one default optimizer.

GET /api/gallery/:id/thumbnail retains authentication and gallery visibility checks. Missing/unreadable asset thumbnails fall back to the gallery object's image, cached as `thumbnails/gallery-<id>.webp` (640 maximum edge) or `thumbnails/gallery-<id>-320.webp` for `?size=320`. Existing thumbnails are reused and served through the normal storage response/redirect path. If both asset and gallery storage fail, return 503 with Retry-After: 15. If the gallery has neither a cached thumbnail nor an object key after asset fallback fails, return 404. Orphaned gallery media-feed rows retain thumbnailEdgeUrl=null so clients use this endpoint.

registerPromptSourceRoutes(app, {db: appDb, requireAuth: requireAuth(appDb)}) mounts Fermat's independent service. The image/API task does not edit that service or curated prompt modules.

## Quota lifecycle

Before any paid upstream call, a database transaction conditionally deducts available quota and records an image_quota_reservations row keyed by job ID. Concurrent requests cannot spend the same balance. Success settles the reservation with actual returned image count, refunds unused quota, and writes the final image_generation ledger entry plus succeeded job atomically. Failure refunds a reserved row once; settled/refunded rows are not refunded again. The usage UI reads final ledger entries, not provisional holds. SQLite transactions on a connection are queued to avoid nested BEGIN; PostgreSQL uses database transactions and conditional state transitions.

When some per-image calls fail, completed images are retained and returned. A low-resolution result also remains available with an explicit warning. Actual settlement uses the pricing snapshot taken before generation, proportionally to returned count.

## Verification boundary

API full regression: 113 tests across 14 files passed, including upfront concurrent balance checks (only one upstream request for one remaining credit), partial image retention/pricing and idempotent failure refunds. Shared tests: 13. Web tests: 197. Requests use temporary databases and mocked upstream fetch; no paid generation, production changes or live PostgreSQL instance validation occurred.

An abrupt process/host crash can leave a persisted reservation and running job for reconciliation. This change deliberately does not refund all running jobs on startup, which could incorrectly release another instance's active reservation. Automatic crash reconciliation remains a deployment follow-up. Database/storage failures after paid upstream completion also cannot guarantee recovery of a result held only in process memory.

A separate reviewer audited the feature batch and found issues subsequently corrected: auto-size pricing conflict, history mode/size/source restoration, channel default mapping, source failure isolation and prompt length validation. The final reservation change receives a focused follow-up review; review findings/status are tracked in the external project archive, not represented as paid upstream validation here.

Post-output local failures never trigger backup paid generation. Partial successful storage is retained. If storage completed but settlement fails, images are returned with a warning, the job records a settlement failure, no final usage is charged, and the reservation is refunded. A fault-injection regression verifies one upstream call, one retained asset and restored balance. Total storage failure cannot provide a persisted asset and is reported without a new upstream call.
