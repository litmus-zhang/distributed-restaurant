# Multi-Tenant Inventory Service (ElysiaJS + Restate)

A resilient, multi-tenant inventory service designed for a restaurant chain. It manages a global item catalog alongside location-specific stock levels, employing **Tenant Isolation Middleware** for security and a **Restate Virtual Object** (keyed by tenant) to sequentialize stock movements, prevent negative balances, and execute database operations atomically.

---

## Technology Stack

- **Runtime**: [Bun](https://bun.sh/)
- **API Framework**: [ElysiaJS](https://elysiajs.com/)
- **Orchestration**: [Restate SDK](https://restate.dev/) (`@restatedev/restate-sdk` and `@restatedev/restate-sdk-clients`)
- **Database**: [Drizzle ORM](https://orm.drizzle.team/) with `bun:sqlite` (SQLite)
- **Linter & Formatter**: [Biome](https://biomejs.dev/)

---

## Features

1. **3NF & Discriminator-Based Multi-Tenancy**:
   - `tenants`: Primary metadata (`id`, `name`, `parent_account_id`).
   - `items`: Global catalog containing SKUs, names, and descriptions.
   - `inventory`: Junction table mapping `tenant_id` and `item_id` to location-specific stock.
   - `stock_movements`: Audited movement logs (`sale`, `restock`, `waste`).
   - **Composite Index**: An optimized unique composite index on `(tenant_id, item_id)` to speed up location-specific queries and prevent duplicate records.
2. **Tenant Isolation Middleware**: Extracts the `X-Tenant-ID` header, verifies the tenant in the database (auto-seeding a default tenant if missing to prevent FK issues), and attaches the `tenantId` to the request context.
3. **Durable Stock Movements (Restate Virtual Object)**: The `StockMovement` Virtual Object is keyed by `tenant_id`, sequentializing movements to eliminate race conditions.
   - **Atomicity**: Validates stock boundaries (ensuring sales/waste don't result in negative stock), updates inventory levels, and records the movement log inside a single database transaction wrapped in `ctx.run()`.
   - **Errors**: Raises a `TerminalError` on validation failure, causing Restate to immediately bubble up the response instead of triggering retry loops.
4. **Structured JSON Telemetry**: Outputs structured JSON log statements to stdout for `/stock/move` containing `request_id`, `tenant_id`, `latency_ms`, `movement_type`, and `outcome` (success or detailed reason).
5. **Cross-Tenant Aggregation**: A dedicated endpoint `GET /stock/aggregate` allows parent accounts to sum `current_quantity` grouped by `item_id` across all associated tenants.

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
We have written a comprehensive suite of integration and validation tests. Run them instantly (uses an in-memory mocked Restate context for fast, daemon-free verification):
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

Or install and run the Restate Server locally:
```bash
brew install restatedev/tap/restate-server
restate-server
```

#### C. Register the Deployment
Tell the Restate coordinator where to find your virtual object service:
```bash
npx @restatedev/restate deployments register --use-http1.1 --force http://localhost:3000/restate
```

#### D. View the Restate Admin Dashboard
Open [http://localhost:9070](http://localhost:9070) in your browser to inspect service invocations, track state, and debug execution logs.

---

## Low-Stock Alerts Design Patterns

To implement resilient, non-blocking low-stock alerts without adding execution latency or database transaction locks to the primary path, you can use Restate's durable asynchronous execution capabilities.

### 1. Decoupled Asynchronous Alerts (Fire-and-Forget)
Rather than executing synchronous alerting logic (e.g. sending a Slack message, email, or webhook request) within the database transaction block, trigger an alert asynchronously after the movement completes. 

By using `ctx.objectSendClient()` or `ctx.serviceSendClient()`, the stock movement endpoint returns a success response immediately, and Restate guarantees that the alert task will eventually execute reliably in the background, even if the notification server is temporarily offline:

```typescript
// Inside StockMovement virtual object handler:
if (dbResult.currentQuantity <= dbResult.reorderLevel) {
  // Fire-and-forget trigger to an external Alerting Service
  ctx.serviceSendClient(alertService).sendNotification({
    tenantId,
    sku,
    currentQuantity: dbResult.currentQuantity,
    reorderLevel: dbResult.reorderLevel
  });
}
```

### 2. Delayed & Debounced Alerts (Delayed Calls)
To prevent spamming staff with alerts on every single transaction during rapid stock fluctuations, you can implement debounced alerting. Using Restate's delayed calls option, you schedule an alert check in the future (e.g. 5 minutes from now):

```typescript
// Inside StockMovement handler:
if (dbResult.currentQuantity <= dbResult.reorderLevel) {
  ctx.objectSendClient(alertService, `${tenantId}:${sku}`)
    .scheduleAlertCheck({
      tenantId,
      sku,
      currentQuantity: dbResult.currentQuantity,
      reorderLevel: dbResult.reorderLevel
    }, restate.rpc.sendOpts({ delay: { minutes: 5 } }));
}
```

The stateful `AlertingService` (a Virtual Object keyed by `${tenantId}:${sku}`) can check its local state to see if a notification was already sent recently. If not, it verifies if stock is still low and dispatches a single alert, updating its state:

```typescript
export const alertingService = restate.object({
  name: "AlertingService",
  handlers: {
    scheduleAlertCheck: async (ctx: restate.ObjectContext, req: AlertPayload) => {
      const alreadySent = await ctx.get<boolean>("alert_sent") ?? false;
      if (alreadySent) return; // Debounce / skip duplicate notification

      // Check fresh stock levels via a DB call or local state cache
      const isStillLow = await ctx.run("check-db-stock", () => ...);
      if (isStillLow) {
        await ctx.run("send-alert", () => sendSlackAlert(req));
        ctx.set("alert_sent", true);
        
        // Reset the alert state after 1 hour (durable sleep)
        ctx.objectSendClient(alertingService, ctx.key).resetAlertState(
          restate.rpc.sendOpts({ delay: { hours: 1 } })
        );
      }
    },
    resetAlertState: async (ctx: restate.ObjectContext) => {
      ctx.clear("alert_sent");
    }
  }
});
```