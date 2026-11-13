# Bdarija

A Moroccan Darija AI workspace with an original zellige illustration, self-hosted fonts, responsive RTL interface, browser-local chat history, search, prompt library, export, recording and transcription.

## Build

Node.js 22 or newer; no npm dependencies.

```sh
node build.mjs
```

The self-contained Cloudflare Worker is emitted to `dist/server/index.js`. Assets are embedded in the Worker. `.openai/hosting.json` retains the Sites project identity.

## Runtime configuration

Set `GEMINI_API_KEY` as a server-side secret in Sites runtime environment settings. Optional `GEMINI_MODEL` defaults to `gemini-2.5-flash`. No key belongs in frontend code or tracked files. The interface clearly reports an unconnected service when the key is absent; it never supplies fabricated responses.

`GET /api/status` reports configuration presence (not a live upstream connectivity probe). `POST /api/chat` receives `{messages:[{role:"user"|"model",text:string}]}` and returns `{reply:string}`. `POST /api/transcribe` receives `{audio:base64,mimeType:string}` and returns `{transcript:string}`.

Chats are stored in the visitor's browser. Submitted messages and stopped voice recordings are sent to Gemini when configured. API errors are sanitized, request sizes limited, and upstream requests time out after 30 seconds.

## Verification

Server checks cover validation, missing configuration, success with a mocked upstream, upstream failures, cancellation/timeouts, and real bundled assets. Live Gemini calls have not been verified because no key was supplied. Browser visual QA was unavailable because this managed Sites environment did not expose `cua_repl.js`.

The zellige vector is original artwork inspired by the supplied geometric references; watermarked reference images are not used. Fonts are redistributed under the included OFL licenses.
