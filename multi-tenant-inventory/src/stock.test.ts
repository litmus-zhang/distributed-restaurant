import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "./db/index.ts";
import { inventory, items, stockMovements, tenants } from "./db/schema.ts";
import { app } from "./server.ts";

describe("Multi-Tenant Inventory Service Tests", () => {
	const tenantIdA = "tenant-a";
	const tenantIdB = "tenant-b";
	const parentAccountId = "parent-default";

	beforeEach(async () => {
		// Clean database tables
		await db.delete(stockMovements);
		await db.delete(inventory);
		await db.delete(items);
		await db.delete(tenants);

		// Seed tenants
		await db.insert(tenants).values([
			{
				id: tenantIdA,
				name: "Tenant A Location",
				parentAccountId,
			},
			{
				id: tenantIdB,
				name: "Tenant B Location",
				parentAccountId,
			},
		]);
	});

	it("1. Tenant Isolation: Rejects requests missing X-Tenant-ID header", async () => {
		const res = await app.handle(
			new Request("http://localhost:3000/stock/levels", {
				method: "GET",
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toContain("Missing X-Tenant-ID");
	});

	it("2. Stock Item Setup: Creates global catalog item and initializes tenant inventory", async () => {
		const res = await app.handle(
			new Request("http://localhost:3000/stock/item", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Tenant-ID": tenantIdA,
				},
				body: JSON.stringify({
					sku: "SKU-BURGER",
					name: "Cheese Burger",
					description: "Double cheese burger patty",
					currentQuantity: 100,
					reorderLevel: 20,
				}),
			}),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.success).toBe(true);
		expect(body.data.sku).toBe("SKU-BURGER");
		expect(body.data.currentQuantity).toBe(100);

		// Verify database state
		const itemsDb = await db.select().from(items).where(eq(items.sku, "SKU-BURGER"));
		expect(itemsDb.length).toBe(1);
		expect(itemsDb[0]?.name).toBe("Cheese Burger");

		const inventoryDb = await db
			.select()
			.from(inventory)
			.where(eq(inventory.itemId, itemsDb[0]!.id));
		expect(inventoryDb.length).toBe(1);
		expect(inventoryDb[0]?.tenantId).toBe(tenantIdA);
		expect(inventoryDb[0]?.currentQuantity).toBe(100);
		expect(inventoryDb[0]?.reorderLevel).toBe(20);
	});

	it("3. Stock Movements: Records a sale movement and updates stock levels", async () => {
		// Set up initial item and stock first
		await app.handle(
			new Request("http://localhost:3000/stock/item", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Tenant-ID": tenantIdA,
				},
				body: JSON.stringify({
					sku: "SKU-FRIES",
					name: "French Fries",
					currentQuantity: 50,
					reorderLevel: 10,
				}),
			}),
		);

		// Perform a sale movement of 15 units
		const res = await app.handle(
			new Request("http://localhost:3000/stock/move", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Tenant-ID": tenantIdA,
				},
				body: JSON.stringify({
					sku: "SKU-FRIES",
					type: "sale",
					quantity: 15,
				}),
			}),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.success).toBe(true);
		expect(body.data.currentQuantity).toBe(35);

		// Verify stock movement log exists
		const movements = await db.select().from(stockMovements);
		expect(movements.length).toBe(1);
		expect(movements[0]?.type).toBe("sale");
		expect(movements[0]?.quantity).toBe(15);
	});

	it("4. Stock Movements Validation: Rejects sales that cause negative stock", async () => {
		// Set up item with 20 stock
		await app.handle(
			new Request("http://localhost:3000/stock/item", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Tenant-ID": tenantIdA,
				},
				body: JSON.stringify({
					sku: "SKU-COKE",
					name: "Coca Cola",
					currentQuantity: 20,
					reorderLevel: 5,
				}),
			}),
		);

		// Attempt to sell 25 units (causes negative stock)
		const res = await app.handle(
			new Request("http://localhost:3000/stock/move", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Tenant-ID": tenantIdA,
				},
				body: JSON.stringify({
					sku: "SKU-COKE",
					type: "sale",
					quantity: 25,
				}),
			}),
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.success).toBe(false);
		expect(body.error).toContain("Insufficient stock");

		// Verify quantity is unchanged in database
		const itemsDb = await db.select().from(items).where(eq(items.sku, "SKU-COKE"));
		const inventoryDb = await db
			.select()
			.from(inventory)
			.where(eq(inventory.itemId, itemsDb[0]!.id));
		expect(inventoryDb[0]?.currentQuantity).toBe(20);
	});

	it("5. Cross-Tenant Aggregation: Sums quantities correctly grouped by item ID across tenants", async () => {
		// 1. Create global item in catalog
		const itemId = randomUUID();
		await db.insert(items).values({
			id: itemId,
			sku: "SKU-SHAKE",
			name: "Milk Shake",
		});

		// 2. Set inventory levels for Tenant A and Tenant B
		await db.insert(inventory).values([
			{
				id: randomUUID(),
				tenantId: tenantIdA,
				itemId,
				currentQuantity: 30,
				reorderLevel: 5,
			},
			{
				id: randomUUID(),
				tenantId: tenantIdB,
				itemId,
				currentQuantity: 45,
				reorderLevel: 5,
			},
		]);

		// 3. Request cross-tenant aggregation for the parent account
		const res = await app.handle(
			new Request(
				`http://localhost:3000/stock/aggregate?parent_account_id=${parentAccountId}`,
				{
					method: "GET",
				},
			),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.success).toBe(true);
		expect(body.data.length).toBe(1);
		expect(body.data[0]?.sku).toBe("SKU-SHAKE");
		expect(body.data[0]?.totalQuantity).toBe(75); // 30 + 45 = 75
	});
});
