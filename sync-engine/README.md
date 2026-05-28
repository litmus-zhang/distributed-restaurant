# Multi-Tenant Inventory Sync Engine (ElysiaJS + Restate)

A robust, offline-capable synchronization engine for a multi-tenant inventory system. It queues client-side inventory mutations locally and resolves them upon reconnection using the Outbox Pattern (Elysia API side) and a Saga Orchestrator (Restate side) for distributed transactional safety with Optimistic Concurrency Control (OCC).

---

## Technology Stack

- **Runtime**: [Bun](https://bun.sh/)
- **API Framework**: [ElysiaJS](https://elysiajs.com/)
- **Orchestration**: [Restate SDK](https://restate.dev/) (`@restatedev/restate-sdk` and `@restatedev/restate-sdk-clients`)
- **Database**: [Drizzle ORM](https://orm.drizzle.team/) with `@libsql/client` (SQLite)
- **Linter & Formatter**: [Biome](https://biomejs.dev/)

---

## Features

1. **Client-Side Queue**: Queues write operations locally, tracking client timestamps, sequence numbers, and UUIDs.
2. **Outbox Pattern**: API endpoint `/sync/push` stores incoming sync batches in a `sync_outbox` table and commits in a single SQLite transaction before triggering the Restate Saga.
3. **Saga Orchestrator**: The `InventorySaga` virtual object processes changes sequentially:
   - **Step 1 (Verify & Reserve)**: Atomically checks item existence, validates version (OCC), checks stock constraints, decrements quantity, and increments version.
   - **Step 2 (Log)**: Logs step success in `sync_log` as `reserved`.
   - **Compensation (Rollback)**: If *any* item in the batch fails (OCC mismatch or insufficient stock), the Saga catches the `TerminalError` and rollbacks all previously completed steps in reverse order, recording compensations as `compensated` and marking the sync status as `failed_conflict`.
4. **Resiliency**: Transient failures (like database locked errors) are safely rethrown and retried automatically by Restate with exponential backoff.

---

## Setup & Running Guide

### 1. Install Dependencies
Ensure you have [Bun](https://bun.sh/) installed, then run:
```bash
bun install
```

### 2. Set Up Database Schema
Apply the Drizzle schema to your local SQLite database:
```bash
bun run push
```

### 3. Run the Test Suite
We have written integration and conflict resolution tests. Run them instantly (uses an in-memory mocked Restate context for fast, daemon-free verification):
```bash
bun test
```

### 4. Start the Application

#### A. Start the Elysia API Server (Port 3000)
```bash
bun dev
```


#### B. Start the Restate Coordinator (Docker)
Start the coordinator to manage the durable execution flow:
```bash
docker run --name restate_dev --rm -p 8080:8080 -p 9070:9070 docker.io/restatedev/restate
```

OR install Restate Server locally:
```bash
brew install restate-server

## Run restate-server

restate-server
```

#### C. Register the Deployment
Tell the coordinator where to find your Saga service:
```bash
npx @restatedev/restate deployments register http://localhost:9080
```