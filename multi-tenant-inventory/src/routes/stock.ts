import { randomUUID } from "node:crypto";
import { and, eq, sum } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../db/index.ts";
import { inventory, items, tenants } from "../db/schema.ts";
import { restateClient } from "../services/restate-client.ts";
import { stockMovementService } from "../services/restate.ts";
import { executionMetadata, tenantIsolation } from "./middleware.ts";

export const stockRoutes = new Elysia({ prefix: "/stock" })
	// 1. Cross-tenant aggregation (Bypasses Tenant Isolation middleware)
	.use(executionMetadata)
	.get(
		"/aggregate",
		async ({ query, set }) => {
			const { parent_account_id } = query;
			if (!parent_account_id) {
				set.status = 400;
				return { success: false, error: "Missing parent_account_id query parameter." };
			}

			try {
				const aggregated = await db
					.select({
						itemId: inventory.itemId,
						sku: items.sku,
						name: items.name,
						totalQuantity: sum(inventory.currentQuantity).mapWith(Number),
					})
					.from(inventory)
					.innerJoin(items, eq(inventory.itemId, items.id))
					.innerJoin(tenants, eq(inventory.tenantId, tenants.id))
					.where(eq(tenants.parentAccountId, parent_account_id))
					.groupBy(inventory.itemId, items.sku, items.name);

				return { success: true, parentAccountId: parent_account_id, data: aggregated };
			} catch (error: any) {
				set.status = 500;
				return { success: false, error: error.message || "Failed to fetch aggregated levels" };
			}
		},
		{
			query: t.Object({
				parent_account_id: t.String(),
			}),
		},
	)

	// 2. Tenant isolated endpoints
	.use(tenantIsolation)
	.post(
		"/item",
		async ({ body, tenantId, set }) => {
			const { sku, name, description, currentQuantity = 0, reorderLevel = 0 } = body;

			try {
				const result = await db.transaction(async (tx) => {
					// Check if item exists globally in items table
					let item = await tx
						.select()
						.from(items)
						.where(eq(items.sku, sku))
						.limit(1)
						.then((r) => r[0]);

					if (!item) {
						const itemId = randomUUID();
						await tx.insert(items).values({
							id: itemId,
							sku,
							name,
							description: description ?? null,
						});
						item = { id: itemId, sku, name, description: description ?? null };
					} else {
						// Update catalog details if item already exists
						await tx
							.update(items)
							.set({ name, description: description ?? item.description })
							.where(eq(items.id, item.id));
					}

					// Find or create local inventory for this tenant/item
					let inv = await tx
						.select()
						.from(inventory)
						.where(and(eq(inventory.tenantId, tenantId), eq(inventory.itemId, item.id)))
						.limit(1)
						.then((r) => r[0]);

					if (!inv) {
						const invId = randomUUID();
						await tx.insert(inventory).values({
							id: invId,
							tenantId,
							itemId: item.id,
							currentQuantity,
							reorderLevel,
						});
						inv = {
							id: invId,
							tenantId,
							itemId: item.id,
							currentQuantity,
							reorderLevel,
						};
					} else {
						await tx
							.update(inventory)
							.set({
								currentQuantity,
								reorderLevel,
							})
							.where(eq(inventory.id, inv.id));
					}

					return {
						itemId: item.id,
						inventoryId: inv.id,
						sku: item.sku,
						name: item.name,
						currentQuantity,
						reorderLevel,
					};
				});

				return { success: true, data: result };
			} catch (error: any) {
				set.status = 500;
				return { success: false, error: error.message || "Failed to create/update stock item" };
			}
		},
		{
			body: t.Object({
				sku: t.String(),
				name: t.String(),
				description: t.Optional(t.String()),
				currentQuantity: t.Optional(t.Number()),
				reorderLevel: t.Optional(t.Number()),
			}),
		},
	)

	.post(
		"/move",
		async ({ body, tenantId, requestId, startTime, set }) => {
			const { sku, type, quantity } = body;
			let outcome = "success";

			try {
				// Call the Restate Virtual Object keyed by tenantId
				const result = await restateClient
					.objectClient<typeof stockMovementService>({ name: "StockMovement" }, tenantId)
					.move({ sku, type, quantity });

				return { success: true, data: result };
			} catch (error: any) {
				outcome = `failure: ${error.message || error}`;
				set.status = error.errorCode || 400;
				return { success: false, error: error.message || "Stock movement processing failed" };
			} finally {
				// Instrument and record JSON structured log
				const latency = Math.round(performance.now() - startTime);
				const logEntry = {
					request_id: requestId,
					tenant_id: tenantId,
					latency_ms: latency,
					movement_type: type,
					outcome,
				};
				console.log(JSON.stringify(logEntry));
			}
		},
		{
			body: t.Object({
				sku: t.String(),
				type: t.Union([t.Literal("sale"), t.Literal("restock"), t.Literal("waste")]),
				quantity: t.Number(),
			}),
		},
	)

	.get("/levels", async ({ tenantId, set }) => {
		try {
			const levels = await db
				.select({
					id: inventory.id,
					sku: items.sku,
					name: items.name,
					description: items.description,
					currentQuantity: inventory.currentQuantity,
					reorderLevel: inventory.reorderLevel,
				})
				.from(inventory)
				.innerJoin(items, eq(inventory.itemId, items.id))
				.where(eq(inventory.tenantId, tenantId));

			return { success: true, data: levels };
		} catch (error: any) {
			set.status = 500;
			return { success: false, error: error.message || "Failed to fetch stock levels" };
		}
	});
