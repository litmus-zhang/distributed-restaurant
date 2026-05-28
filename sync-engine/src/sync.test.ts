import { beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { LocalQueue } from "./client/queue.ts";
import { db } from "./db/index.ts";
import { inventory, syncLog, syncOutbox } from "./db/schema.ts";
import { app } from "./server.ts";
import type { inventorySaga } from "./services/restate.ts";
import { restateClient } from "./services/restate-client.ts";

describe("Inventory Sync Engine Saga Tests", () => {
	const tenantId = "tenant-1";
	const clientId = "pos-terminal-1";

	beforeEach(async () => {
		// Clean the database tables
		await db.delete(inventory);
		await db.delete(syncOutbox);
		await db.delete(syncLog);

		// Seed initial inventory
		await db.insert(inventory).values([
			{
				id: randomUUID(),
				tenantId,
				sku: "SKU-A",
				quantity: 10,
				versionNumber: 1,
				updatedAt: new Date().toISOString(),
			},
			{
				id: randomUUID(),
				tenantId,
				sku: "SKU-B",
				quantity: 5,
				versionNumber: 1,
				updatedAt: new Date().toISOString(),
			},
		]);
	});

	it("Scenario 1: Clean Sync - Standard operations succeed", async () => {
		const queue = new LocalQueue(tenantId, clientId);

		// Client queues some mutations
		queue.enqueue("SKU-A", -3, 1); // sell 3 units of SKU-A (expected version 1)
		queue.enqueue("SKU-B", -2, 1); // sell 2 units of SKU-B (expected version 1)

		const batch = queue.getBatch();

		// 1. POST to Elysia route /sync/push
		const res = await app.handle(
			new Request("http://localhost:3000/sync/push", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					tenantId,
					changes: batch.map((item) => ({
						sku: item.sku,
						quantityChange: item.quantityChange,
						versionNumber: item.versionNumber,
					})),
				}),
			}),
		);
		const response = (await res.json()) as { syncId: string; status: string };

		expect(response.syncId).toBeDefined();
		expect(response.status).toBe("pending");

		// Verify outbox has a pending record
		const outboxBefore = await db
			.select()
			.from(syncOutbox)
			.where(eq(syncOutbox.id, response.syncId))
			.limit(1);
		expect(outboxBefore.length).toBe(1);
		expect(outboxBefore[0]?.status).toBe("pending");

		// 2. Invoke Restate Saga using the Restate Client
		const sagaResult = await restateClient
			.objectClient<typeof inventorySaga>({ name: "InventorySaga" }, tenantId)
			.processSyncBatch({
				syncId: response.syncId,
				changes: batch.map((item) => ({
					sku: item.sku,
					quantityChange: item.quantityChange,
					versionNumber: item.versionNumber,
				})),
			});

		expect(sagaResult.success).toBe(true);

		// 3. Verify database state after successful sync
		// SKU-A quantity should be 10 - 3 = 7, versionNumber = 2
		const itemsA = await db
			.select()
			.from(inventory)
			.where(eq(inventory.sku, "SKU-A"))
			.limit(1);
		expect(itemsA.length).toBe(1);
		expect(itemsA[0]?.quantity).toBe(7);
		expect(itemsA[0]?.versionNumber).toBe(2);

		// SKU-B quantity should be 5 - 2 = 3, versionNumber = 2
		const itemsB = await db
			.select()
			.from(inventory)
			.where(eq(inventory.sku, "SKU-B"))
			.limit(1);
		expect(itemsB.length).toBe(1);
		expect(itemsB[0]?.quantity).toBe(3);
		expect(itemsB[0]?.versionNumber).toBe(2);

		// Outbox status should now be 'processed'
		const outboxesAfter = await db
			.select()
			.from(syncOutbox)
			.where(eq(syncOutbox.id, response.syncId))
			.limit(1);
		expect(outboxesAfter.length).toBe(1);
		expect(outboxesAfter[0]?.status).toBe("processed");

		// Verify saga logs
		const logs = await db
			.select()
			.from(syncLog)
			.where(eq(syncLog.syncId, response.syncId));
		expect(logs.length).toBe(2);
		expect(logs.every((l) => l.status === "reserved")).toBe(true);
	});

	it("Scenario 2: Conflict Scenario - OCC Version Mismatch triggers compensation", async () => {
		const queue = new LocalQueue(tenantId, clientId);

		// Client queues updates, but the second item has a stale version number
		queue.enqueue("SKU-A", -2, 1); // Expected version is 1 (matches)
		queue.enqueue("SKU-B", -1, 99); // Expected version is 99 (mismatch! Server is 1)

		const batch = queue.getBatch();

		const response = await app
			.handle(
				new Request("http://localhost:3000/sync/push", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						tenantId,
						changes: batch.map((item) => ({
							sku: item.sku,
							quantityChange: item.quantityChange,
							versionNumber: item.versionNumber,
						})),
					}),
				}),
			)
			.then((res) => res.json() as Promise<{ syncId: string; status: string }>);

		// Invoke Restate Saga
		const sagaResult = await restateClient
			.objectClient<typeof inventorySaga>({ name: "InventorySaga" }, tenantId)
			.processSyncBatch({
				syncId: response.syncId,
				changes: batch.map((item) => ({
					sku: item.sku,
					quantityChange: item.quantityChange,
					versionNumber: item.versionNumber,
				})),
			});

		expect(sagaResult.success).toBe(false);
		expect(sagaResult.error).toContain("version_mismatch");

		// 3. Verify Compensation / Database State
		// SKU-A was successfully reserved (-2) but should be compensated back to 10
		const itemsA = await db
			.select()
			.from(inventory)
			.where(eq(inventory.sku, "SKU-A"))
			.limit(1);
		expect(itemsA.length).toBe(1);
		expect(itemsA[0]?.quantity).toBe(10);
		// Reserved (1 -> 2), then compensated (2 -> 3)
		expect(itemsA[0]?.versionNumber).toBe(3);

		// SKU-B failed reservation entirely, should remain at quantity 5 and version 1
		const itemsB = await db
			.select()
			.from(inventory)
			.where(eq(inventory.sku, "SKU-B"))
			.limit(1);
		expect(itemsB.length).toBe(1);
		expect(itemsB[0]?.quantity).toBe(5);
		expect(itemsB[0]?.versionNumber).toBe(1);

		// Outbox should be marked as failed_conflict
		const outboxes = await db
			.select()
			.from(syncOutbox)
			.where(eq(syncOutbox.id, response.syncId))
			.limit(1);
		expect(outboxes.length).toBe(1);
		expect(outboxes[0]?.status).toBe("failed_conflict");

		// Verify sync_log has both reservation and compensation records
		const logs = await db
			.select()
			.from(syncLog)
			.where(eq(syncLog.syncId, response.syncId));
		// 1 reserved record + 1 compensated record
		expect(logs.length).toBe(2);

		const reservedLog = logs.find(
			(l) => l.sku === "SKU-A" && l.status === "reserved",
		);
		const compensatedLog = logs.find(
			(l) => l.sku === "SKU-A" && l.status === "compensated",
		);
		expect(reservedLog).toBeDefined();
		expect(compensatedLog).toBeDefined();
	});

	it("Scenario 3: Conflict Scenario - Insufficient Stock triggers compensation", async () => {
		const queue = new LocalQueue(tenantId, clientId);

		// First item succeeds, second item requests more quantity than available
		queue.enqueue("SKU-A", -1, 1); // sell 1 (matches, leaves 9)
		queue.enqueue("SKU-B", -10, 1); // sell 10 (insufficient stock, available is 5)

		const batch = queue.getBatch();

		const response = await app
			.handle(
				new Request("http://localhost:3000/sync/push", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						tenantId,
						changes: batch.map((item) => ({
							sku: item.sku,
							quantityChange: item.quantityChange,
							versionNumber: item.versionNumber,
						})),
					}),
				}),
			)
			.then((res) => res.json() as Promise<{ syncId: string; status: string }>);

		// Invoke Restate Saga
		const sagaResult = await restateClient
			.objectClient<typeof inventorySaga>({ name: "InventorySaga" }, tenantId)
			.processSyncBatch({
				syncId: response.syncId,
				changes: batch.map((item) => ({
					sku: item.sku,
					quantityChange: item.quantityChange,
					versionNumber: item.versionNumber,
				})),
			});

		expect(sagaResult.success).toBe(false);
		expect(sagaResult.error).toContain("insufficient_stock");

		// Verify state is fully rolled back
		const itemsA = await db
			.select()
			.from(inventory)
			.where(eq(inventory.sku, "SKU-A"))
			.limit(1);
		expect(itemsA.length).toBe(1);
		expect(itemsA[0]?.quantity).toBe(10);
		expect(itemsA[0]?.versionNumber).toBe(3); // reserved and compensated

		const itemsB = await db
			.select()
			.from(inventory)
			.where(eq(inventory.sku, "SKU-B"))
			.limit(1);
		expect(itemsB.length).toBe(1);
		expect(itemsB[0]?.quantity).toBe(5);
		expect(itemsB[0]?.versionNumber).toBe(1); // failed before modifying database

		const outboxes = await db
			.select()
			.from(syncOutbox)
			.where(eq(syncOutbox.id, response.syncId))
			.limit(1);
		expect(outboxes.length).toBe(1);
		expect(outboxes[0]?.status).toBe("failed_conflict");
	});
});
