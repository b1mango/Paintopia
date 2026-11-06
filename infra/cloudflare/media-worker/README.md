# Private image edge delivery

Bind `ASSETS` to the existing private `paintopia-assets` R2 bucket. Keep R2 public access disabled.
Set a random `MEDIA_SIGNING_KEY` Worker secret and the identical `PAINTOPIA_MEDIA_SIGNING_KEY` API secret. Set `PAINTOPIA_MEDIA_EDGE_URL` to the deployed HTTPS Worker URL. Without both API variables the existing authenticated R2 delivery remains active.

The application checks asset/gallery access before issuing a 120-second HMAC URL. The Worker verifies every request **before** looking in Cache API, including cache hits. Allowed image keys are `thumbnails/*.webp`, `(temporary|pending|permanent)/<user>/<image>.(png|jpg|jpeg|webp)` and `gallery/<image>.(png|jpg|jpeg|webp)`. Import bundles and configuration backups remain blocked. Original downloads include the attachment filename in the signature; HEAD and single-byte-range requests are supported. Internal cache lifetime is one day; browser lifetime is bounded by the URL's remaining lifetime (maximum 60 seconds). Previously issued URLs can remain usable for at most 120 seconds after unsharing/deletion. No new URL is issued once access is revoked. Keys must be immutable; version the key or purge cache if bytes change.

Set `observability.enabled = false` to avoid persisting signed query URLs. Do not add signing keys to wrangler config or Git. Deployment requires an authorized Cloudflare account and the production API environment configuration. Verify unsigned, tampered, and expired requests return 403; then verify an authenticated thumbnail returns WebP. Deploying a Worker alone does not enable application delivery.

## Deploying path changes

Pushing the application to GitHub or deploying Vercel does not deploy this Worker. When the API starts signing a new object prefix, deploy the matching Worker before enabling that API change:

```sh
npm --workspace @paintopia/api test -- tests/media-edge.test.ts
npx wrangler deploy --config infra/cloudflare/media-worker/wrangler.jsonc
```

Verify a fresh download from both creation and assets: the final response must return the original image with `Content-Disposition: attachment`, while unsigned requests must still return 403. Re-enter through the application to obtain a fresh signature; reloading an expired media URL is not a valid check.
