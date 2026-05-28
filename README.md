# Bountip Task Workspace

This workspace contains three resilient, multi-tenant microservices built using **ElysiaJS**, **Bun**, **Restate**, and **Drizzle ORM** (SQLite). Each project tackles a specific challenge in building robust distributed systems:

1. **[multi-tenant-inventory](file:///Users/mac/Downloads/devprojects/bountip-task/multi-tenant-inventory)**: Resilient inventory tracking for a restaurant chain using location-based multi-tenancy and Restate Virtual Objects to prevent negative stock.
2. **[sync-engine](file:///Users/mac/Downloads/devprojects/bountip-task/sync-engine)**: An offline-capable synchronization engine using the Outbox pattern and a Saga orchestrator with Optimistic Concurrency Control (OCC).
3. **[Payment-reliability](file:///Users/mac/Downloads/devprojects/bountip-task/Payment-reliability)**: A resilient payment processing system utilizing Restate state-based idempotency checks, mock API retry strategies, and third-party transaction reconciliation.

---

## 🛠️ Prerequisites & Shared Services

All three projects share a common tech stack. Before running any service, ensure you have the following installed:

- **Bun Runtime**: [Bun Installation Guide](https://bun.sh/)
- **Docker**: For running the Restate Coordinator.
- **Restate Server** (Optional alternative to Docker):
  ```bash
  brew install restatedev/tap/restate-server
  ```

### Running the Restate Coordinator (Global)
To process durable execution flows, start the Restate Coordinator globally:
```bash
docker run --name restate_dev --rm -p 8080:8080 -p 9070:9070 docker.io/restatedev/restate
```
*Note: The Restate Admin Console will be accessible at [http://localhost:9070](http://localhost:9070).*

---

## 📂 Project Directory Breakdown

### 1. Multi-Tenant Inventory Service
Manages restaurant locations, global item catalogs, and location-specific stock. Sequentializes stock movements via a Virtual Object keyed by tenant ID to avoid race conditions.

#### 🚀 How to Run Locally
1. Navigate to the project:
   ```bash
   cd multi-tenant-inventory
   ```
2. Install dependencies & initialize SQLite DB:
   ```bash
   bun install
   bun run push
   ```
3. Start the Elysia server:
   ```bash
   bun dev
   ```
4. Register the deployment with the Restate Coordinator:
   ```bash
   npx @restatedev/restate deployments register --use-http1.1 --force http://localhost:3000/restate
   ```
5. Run the integration test suite:
   ```bash
   bun test
   ```

#### 🧠 Assumptions & Tradeoffs
- **Tenant Isolation**: Used a "Shared Database, Discriminator Column" strategy for multi-tenancy. This is highly cost-effective and simple to manage but relies on middleware to validate `X-Tenant-ID` headers to prevent data leakages.
- **SQLite Locking**: Relying on SQLite means database-level locking could bottleneck performance during heavy write concurrency. However, because Restate serializes calls per tenant, database-level lock contention is minimized.

#### 💡 Given More Time
- **Automatic Low-Stock Webhooks**: Build out-of-band alerting systems (detailed in the project's [README](file:///Users/mac/Downloads/devprojects/bountip-task/multi-tenant-inventory/README.md)) that dispatch Slack notifications or emails asynchronously without delaying the primary path.

---

### 2. Multi-Tenant Inventory Sync Engine
Queues write operations locally on client devices when offline and pushes them in batches. Uses a Saga orchestrator with Optimistic Concurrency Control (OCC) to guarantee consistency or run rollback compensations.

#### 🚀 How to Run Locally
1. Navigate to the project:
   ```bash
   cd sync-engine
   ```
2. Install dependencies & initialize SQLite DB:
   ```bash
   bun install
   bun run push
   ```
3. Start the Elysia server:
   ```bash
   bun dev
   ```
4. Register the deployment with the Restate Coordinator:
   ```bash
   npx @restatedev/restate deployments register --use-http1.1 --force http://localhost:3000/restate
   ```
5. Run the integration test suite:
   ```bash
   bun test
   ```

#### 🧠 Assumptions & Tradeoffs
- **Optimistic Concurrency Control (OCC)**: Assumes that concurrent edits to the same item are rare. When conflicts do happen, the Saga rejects and rolls back the entire batch. In high-concurrency environments, this would lead to high client retry rates.
- **Strict Sagas**: Compensating/rolling back the entire transaction upon a single failure ensures data integrity but compromises availability for non-conflicting items in the same batch.

#### 💡 Given More Time
- **Granular Merging & Interactive Conflict Resolution**: Instead of failing the entire batch, implement a partial commit mechanism. The engine could apply non-conflicting changes and return a list of specific item conflicts to the client for interactive merging (e.g. "Last-Write-Wins" or manual review).

---

### 3. Payment Reliability Service
Handles durable integration with a payment provider mock. Features dual-layered idempotency checks (Restate KV cache and SQLite DB check), automatic retries for transient failures, and a reconciliation suite to catch mismatched database states.

#### 🚀 How to Run Locally
1. Navigate to the project:
   ```bash
   cd Payment-reliability
   ```
2. Install dependencies & initialize SQLite DB:
   ```bash
   bun install
   bun run push
   ```
3. Start the Elysia server:
   ```bash
   bun dev
   ```
4. Register the deployment with the Restate Coordinator:
   ```bash
   npx @restatedev/restate deployments register --use-http1.1 --force http://localhost:3000/restate
   ```
5. Run the integration test suite:
   ```bash
   bun test
   ```

#### 🧠 Assumptions & Tradeoffs
- **Dual-Layered Idempotency**: Storing `"payment_status"` as `"paid"` in Restate's KV state store prevents database queries for duplicate payment requests. If the Restate cache is cleared, the system falls back to a database lookup, ensuring we never double-charge.
- **Provider Retry Tuning**: Retries on transient timeouts are capped at `maxRetryAttempts: 2` (3 attempts total) before flagging the order as `RECONCILIATION_REQUIRED`. Capping the retries protects against infinite loops but requires manual intervention for slow recovery periods.

#### 💡 Given More Time
- **Automated Reconciliation Jobs**: Build an autonomous Restate Cron/Timer that actively fetches records flagged as `RECONCILIATION_REQUIRED`, pulls statuses from the provider's transaction logs API, and resolves them automatically without human intervention.
