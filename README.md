# Buildable Backend

**The AI Brain, Filesystem Authority, and Preview Controller for Buildable**

This is the backend service that powers Buildable - a commercial-grade AI web app builder. The frontend is a read-only control plane; this backend is where all intelligence lives.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           BUILDABLE ARCHITECTURE                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌──────────────────────────┐    ┌──────────────────────────────────┐ │
│   │   FRONTEND (Read-Only)   │    │         BACKEND (Brain)          │ │
│   │   Buildable Labs Frontend      │◄───│   This Repository               │ │
│   │                          │    │                                  │ │
│   │   • Collect user ideas   │    │   • AI Orchestration            │ │
│   │   • Show generation UI   │    │   • Staged Code Generation      │ │
│   │   • Display file tree    │    │   • Validated File Writes       │ │
│   │   • Render preview       │    │   • Project State Management    │ │
│   │   • NEVER modifies code  │    │   • Preview Server Control      │ │
│   └──────────────────────────┘    └──────────────────────────────────┘ │
│              ▲                                   │                      │
│              │ Supabase Realtime                 │                      │
│              │ (Live Progress)                   ▼                      │
│   ┌──────────────────────────────────────────────────────────────────┐ │
│   │                    SUPABASE (State Layer)                        │ │
│   │   • workspaces - Isolated project environments                  │ │
│   │   • workspace_files - Source of truth for all code              │ │
│   │   • generation_sessions - AI pipeline tracking                  │ │
│   │   • file_operations - Audit log / history                       │ │
│   └──────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│   ┌──────────────────────────────────────────────────────────────────┐ │
│   │                    PREVIEW RUNTIME (Future)                       │ │
│   │   • Per-workspace dev servers (Vite)                             │ │
│   │   • Isolated container runtime (E2B / Modal / Fly.io)            │ │
│   │   • Hot reload on file changes                                   │ │
│   └──────────────────────────────────────────────────────────────────┘ │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Core Principles

1. **Frontend is Read-Only** - The frontend never modifies files. It displays state.
2. **Backend is Authority** - All file writes go through validated backend pipelines.
3. **AI is Isolated** - AI can only read/write within workspace directories.
4. **Operations are Logged** - Every file change is recorded for undo/audit.
5. **Generation is Staged** - Plan → Scaffold → Generate → Validate

## Tech Stack

- **Runtime**: Node.js / Bun
- **Framework**: Express or Hono (lightweight)
- **AI**: OpenAI GPT-4 / Anthropic Claude / Google Gemini
- **Database**: Supabase (PostgreSQL + Realtime)
- **Queue**: Bull/BullMQ for async generation jobs
- **Preview**: Vite dev server per workspace
- **Containers**: Docker / E2B / Modal (for isolation)

## Getting Started

```bash
# Clone the repo
git clone https://github.com/yourusername/buildable-backend.git
cd buildable-backend

# Install dependencies
bun install

# Set up environment
cp .env.example .env
# Edit .env with your API keys

# Start development server
bun run dev
```

## Environment Variables

```bash
# Supabase
SUPABASE_URL=your-supabase-url
SUPABASE_SERVICE_KEY=your-service-role-key

# AI Providers (at least one required)
OPENAI_API_KEY=your-openai-key
ANTHROPIC_API_KEY=your-anthropic-key
GOOGLE_AI_KEY=your-google-key

# Preview Server
PREVIEW_BASE_PORT=3100
PREVIEW_HOST=localhost

# Optional
REDIS_URL=redis://localhost:6379
LOG_LEVEL=debug
```

## Project Structure

```
buildable-backend/
├── src/
│   ├── index.ts              # Entry point
│   ├── config/               # Configuration
│   │   └── env.ts
│   ├── api/                  # HTTP routes
│   │   ├── index.ts
│   │   ├── workspace.ts      # Workspace CRUD
│   │   ├── generate.ts       # AI generation endpoint
│   │   └── preview.ts        # Preview management
│   ├── services/             # Business logic
│   │   ├── ai/               # AI orchestration
│   │   │   ├── architect.ts  # Planning phase
│   │   │   ├── coder.ts      # Code generation
│   │   │   └── validator.ts  # Validation phase
│   │   ├── workspace/        # Workspace management
│   │   │   ├── files.ts      # File operations
│   │   │   └── state.ts      # State management
│   │   └── preview/          # Preview servers
│   │       ├── manager.ts    # Server lifecycle
│   │       └── vite.ts       # Vite configuration
│   ├── db/                   # Database layer
│   │   ├── client.ts         # Supabase client
│   │   └── queries.ts        # Query helpers
│   ├── queue/                # Job queue
│   │   ├── worker.ts         # Queue workers
│   │   └── jobs.ts           # Job definitions
│   └── utils/                # Utilities
│       ├── logger.ts
│       └── templates.ts      # Project templates
├── templates/                # Project scaffolds
│   ├── react-vite/
│   ├── landing-page/
│   └── dashboard/
├── tests/
├── docker/
│   └── Dockerfile
├── package.json
├── tsconfig.json
└── README.md
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/workspace` | Create/get workspace |
| GET | `/api/workspace/:id` | Get workspace details |
| GET | `/api/workspace/:id/files` | List all files |
| GET | `/api/workspace/:id/files/:path` | Get single file |
| POST | `/api/workspace/:id/generate` | Start generation |
| GET | `/api/workspace/:id/sessions` | List generation sessions |
| POST | `/api/workspace/:id/preview/start` | Start preview server |
| POST | `/api/workspace/:id/preview/stop` | Stop preview server |

## Generation Pipeline

```
User Prompt
    │
    ▼
┌─────────────────────────────────────────┐
│ 1. ARCHITECT PHASE                      │
│    - Parse user intent                  │
│    - Generate structured project plan   │
│    - Define file structure              │
│    - NO code written yet                │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 2. SCAFFOLDING PHASE                    │
│    - Apply project template             │
│    - Create directory structure         │
│    - Copy boilerplate files             │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 3. GENERATION PHASE                     │
│    - Generate code file-by-file         │
│    - Full context awareness             │
│    - Incremental, diff-based edits      │
│    - Stream progress via Realtime       │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 4. VALIDATION PHASE                     │
│    - Parse/lint generated code          │
│    - Fix missing imports                │
│    - Repair broken references           │
│    - Apply files to database            │
└─────────────────────────────────────────┘
    │
    ▼
Live Preview Ready
```

## Deployment

### Docker

```bash
docker build -t buildable-backend .
docker run -p 3000:3000 --env-file .env buildable-backend
```

### Railway / Fly.io

```bash
# Railway
railway up

# Fly.io
fly deploy
```

## Security

- AI has **NO** access to backend source code
- AI can **ONLY** write to workspace directories
- All file operations are validated server-side
- Secrets are never exposed to AI context
- Rate limiting on all endpoints
- JWT authentication required

## License

MIT
