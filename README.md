# Bdarija

A Moroccan Darija AI workspace with a Moroccan robot mascot logo, self-hosted fonts, responsive RTL interface, browser-local chat history, search, export, recording and transcription.

## Build

Node.js 22 or newer; no npm dependencies.

```sh
node build.mjs
```

The self-contained Cloudflare Worker is emitted to `dist/server/index.js`. Assets are embedded in the Worker. `.openai/hosting.json` retains the Sites project identity.

## Runtime configuration

Set `GEMINI_API_KEY` as a server-side secret in Sites runtime environment settings. Optional `GEMINI_MODEL` defaults to `gemini-3.5-flash-lite`. No key belongs in frontend code or tracked files. The interface clearly reports an unconnected service when the key is absent; it never supplies fabricated responses.

`GET /api/status` reports configuration presence (not a live upstream connectivity probe). `POST /api/chat` receives `{messages:[{role:"user"|"model",text:string}]}` and returns `{reply:string}`. `POST /api/transcribe` receives `{audio:base64,mimeType:string}` and returns `{transcript:string}`.

Chats are stored in the visitor's browser. Submitted messages and stopped voice recordings are sent to Gemini when configured. API errors are sanitized, request sizes limited, and upstream requests time out after 30 seconds.

## Verification

Server checks cover validation, missing configuration, success with a mocked upstream, upstream failures, cancellation/timeouts, and real bundled assets. Live Gemini calls have not been verified because no key was supplied. Browser visual QA was unavailable because this managed Sites environment did not expose `cua_repl.js`.

The mascot asset was prepared from the user’s supplied robot-and-fez logo reference with a transparent background. The library, suggestions, welcome footer, and automatic disconnected-service banner were removed as requested. Fonts are redistributed under the included OFL licenses.

## Cloudflare Workers (GitHub builds)

Upload the complete project to the repository root, including `src/`, `build.mjs`, and `wrangler.jsonc`. Set Build command to `node build.mjs`, Deploy command to `npx wrangler deploy`, and Root directory to `/`. The Wrangler entrypoint is `dist/server/index.js`; this Worker serves the embedded frontend and the API routes. Uploading standalone `index.html` alone only deploys the frontend. Keep `GEMINI_API_KEY` in Cloudflare Worker Secrets. Existing secret values are never included in this archive.

## Image generation

The composer has Chat and Create image modes. Images use the Cloudflare Workers AI binding named `AI` with `@cf/black-forest-labs/flux-1-schnell`, one image per request and four inference steps. `POST /api/image` takes `{prompt:string}` (1–2000 characters) and returns `{image:base64,mimeType:string}`. Image generation does not require a Gemini key. `wrangler.jsonc` declares the AI binding, keeping it attached across GitHub deployments.

Workers AI has a shared account-level free daily allocation, not unlimited image generation. The app does not automatically retry failed image requests. Cancelling the browser's wait cannot guarantee cancellation of a job already submitted to Cloudflare.

Image metadata is stored with the chat in localStorage; image blobs are stored in IndexedDB to avoid overflowing localStorage. If browser storage is unavailable, images remain available within the current tab session and the UI prompts the visitor to download a copy. Deleting conversations also removes unreferenced locally stored images. Generated images are downloaded individually; text export contains image references, not embedded image files.

Validation covered API success, validation, fixed model/settings, quota errors, missing AI binding, timeouts, invalid image output, download rendering, mode switching, cancellation and in-session storage fallback with mocked dependencies. Actual Workers AI generation on the user's account requires deploying this update to the Cloudflare Worker with the configured binding.
