## Open Source King's Cup Web App

An open source implementation of the classic King's Cup drinking game, built for the web.

## Tech Stack

- **Framework**: Next.js (App Router)
- **Game backend**: `game_engine` (FastAPI + Redis) via WebSocket
- **Shared client**: `@kings-cup/shared` (`GameSocket`, retry, logging)
- **UI & Styling**: Tailwind CSS, shadcn/ui
- **Animations**: Motion (`motion/react`)
- **Testing**: Vitest
- **Package Manager**: pnpm

## Development

Install dependencies and run the dev server:

```bash
pnpm install
pnpm dev
```

Set `NEXT_PUBLIC_WS_URL` (e.g. `ws://localhost:8080`) to point at the game engine.

Then open `http://localhost:3000` in your browser.

Verification scripts live under `scripts/verification/`.
