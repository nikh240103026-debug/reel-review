# ReelReview

Video review, client feedback, and editing-job management for an editing agency.

## Local development

Requirements: Node.js 20.9 or newer and npm.

```bash
npm install
npm run setup
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). `npm run setup` creates a
private `.env.local` with fresh app and editor-access secrets; it does not
overwrite an existing file. Use the generated `EDITOR_ACCESS_KEY` from that
file to unlock the editor. Keep `.env.local` private and do not commit it.

The default local configuration uses an embedded PGlite database and local
filesystem storage under `.data/`. No external database or object store is
required for local development. AI review requires an Anthropic API key;
without one, the app uses its labelled offline draft mode. `ffmpeg` and
`ffprobe` are optional for app use, but the test fixtures and end-to-end test
require `ffmpeg`.

## Vercel production deployment

Vercel functions do not provide the durable shared disk this app's local
development database and storage need. Use Supabase PostgreSQL and a private
S3-compatible object store for durable state and video files. Supabase Storage
can serve both PostgreSQL and object storage; Cloudflare R2 is an alternative
if its billing setup works for you.

1. Create a Supabase project and a private Storage bucket. In Supabase Storage
   settings, enable S3 access and create an S3 access-key pair. Copy the S3
   endpoint and project region shown there. Follow Supabase's [S3
   authentication](https://supabase.com/docs/guides/storage/s3/authentication)
   and [S3 compatibility](https://supabase.com/docs/guides/storage/s3/compatibility)
   guides. Supabase S3 access keys grant
   project-wide Storage access and bypass Storage RLS, so use them only on the
   server; never expose them to browsers or commit them. The app issues
   short-lived, object-specific signed URLs to the browser for transfers.
   Supabase's S3 API supports multipart uploads and presigned URLs.

   For Supabase Free, the maximum individual file size is 50 MB. The app
   automatically uses a 50 MiB upload limit when the endpoint is on
   `*.supabase.co`. Set `MAX_UPLOAD_MB` to the file limit configured for your
   project/bucket if your plan supports a higher value. Supabase's Free plan
   also has a total Storage quota; check its [current Storage
   limits](https://supabase.com/docs/guides/storage/uploads/file-limits) before
   using it for a large video library.
2. Apply the database migrations with `npm run db:migrate` using the Supabase
   connection URL from Project Settings → Database. Use the pooler URL when
   appropriate for serverless connections.
3. Add the following server-only environment variables in the Vercel project
   settings for Production (and Preview if you use preview deployments):

   ```text
   APP_URL=https://reelreview.com
   APP_SECRET=<at least 32 random characters>
   EDITOR_ACCESS_KEY=<at least 16 private characters>
   DATABASE_URL=<Supabase PostgreSQL connection URL>
   S3_ENDPOINT=<Supabase Storage S3 endpoint>
   S3_REGION=<Supabase project region>
   S3_FORCE_PATH_STYLE=true
   S3_BUCKET=<private Supabase Storage bucket name>
   S3_ACCESS_KEY_ID=<Supabase Storage S3 access key ID>
   S3_SECRET_ACCESS_KEY=<Supabase Storage S3 secret access key>
   MAX_UPLOAD_MB=50
   ```

   Generate new private values for `APP_SECRET` and `EDITOR_ACCESS_KEY`; do not
   use values from `.env.example` or commit them. Configure these variables
   directly in Vercel—never paste secrets into source control or chat.
4. If using Cloudflare R2 instead of Supabase Storage, configure the bucket's
   CORS policy to allow the deployed app origin to `GET`, `HEAD`, and `PUT`
   objects, allow the `Range` request header, and expose `ETag`,
   `Content-Range`, and `Accept-Ranges`. Set `R2_ACCOUNT_ID`, `S3_BUCKET`,
   `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`; `S3_ENDPOINT` is derived from
   the account ID.
5. Redeploy after setting the variables. Vercel production now rejects missing
   public URL, PostgreSQL, or S3-compatible storage configuration instead of
   silently using localhost links or ephemeral local storage.

Add `ANTHROPIC_API_KEY` in Vercel only if Claude-powered review is required;
without it, the app uses its labelled offline draft mode. See `.env.example`
for optional settings.

### Local editing agent and native-editor review

Install FFmpeg and FFprobe on each editing computer, then register the agent
from that computer. The agent detects Premiere Pro, After Effects, and Resolve
installations in their standard locations on Windows and macOS. Those adapters
apply the supported edits to a flattened render using FFmpeg and open the
result in the selected editor for human review; they do not edit native project
files. A copied review render is kept under `Reviewed Renders` inside the
agent's configured work directory so the editor can continue reading it after
the job completes. Only adapters whose required editor and media tools are
detected are advertised by the agent.

## Checks

```bash
npm run typecheck
npm run lint
npm test
```

The end-to-end test exercises the app over HTTP against a production build and
requires `ffmpeg`:

```bash
npm run build
npm run e2e
```
