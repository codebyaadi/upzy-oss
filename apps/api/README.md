# api

Elysia on Bun. Entry: `src/index.ts`; the app factory (`createApp`) and the `App` type used by the Eden client live in `src/app.ts`. Routes are plugins in `src/modules`; the `org: true` macro requires a session with an active organization and injects `orgId`.
