import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { inventory, items, stockMovements } from "../db/schema.ts";

export interface StockMoveRequest {
	sku: string;
	type: "sale" | "restock" | "waste";
	quantity: number;
}

export interface StockMoveResponse {
	success: boolean;
	inventoryId?: string;
	currentQuantity?: number;
	reorderLevel?: number;
	error?: string;
}

export const stockMovementService = restate.object({
	name: "StockMovement",
	handlers: {
		/**
		 * Records a stock movement for a specific item under the current tenant.
		 * Validates stock availability for 'sale' and 'waste' movements.
		 * Updates inventory and logs stock movement atomically.
		 */
		move: async (ctx: restate.ObjectContext, request: StockMoveRequest): Promise<StockMoveResponse> => {
			const tenantId = ctx.key;
			const { sku, type, quantity } = request;

			if (quantity <= 0) {
				throw new restate.TerminalError("Quantity must be a positive integer.");
			}

			if (type !== "sale" && type !== "restock" && type !== "waste") {
				throw new restate.TerminalError(`Invalid movement type: ${type}`);
			}

			// Atomic database operation inside ctx.run to comply with Restate durability rules.
			const dbResult = await ctx.run("record-movement-db", async () => {
				return await db.transaction(async (tx) => {
					// 1. Locate the global item catalog entry by SKU
					const item = await tx
						.select()
						.from(items)
						.where(eq(items.sku, sku))
						.limit(1)
						.then((r) => r[0]);

					if (!item) {
						return {
							success: false,
							error: `Item with SKU "${sku}" does not exist in catalog.`,
						};
					}

					// 2. Find or initialize the inventory record for this tenant and item
					let inv = await tx
						.select()
						.from(inventory)
						.where(and(eq(inventory.tenantId, tenantId), eq(inventory.itemId, item.id)))
						.limit(1)
						.then((r) => r[0]);

					if (!inv) {
						// For restock, we can dynamically initialize a new inventory record with 0 quantity.
						// For sales/waste, we cannot record a movement without inventory history.
						if (type === "restock") {
							const newInvId = randomUUID();
							await tx.insert(inventory).values({
								id: newInvId,
								tenantId,
								itemId: item.id,
								currentQuantity: 0,
								reorderLevel: 0,
							});
							inv = {
								id: newInvId,
								tenantId,
								itemId: item.id,
								currentQuantity: 0,
								reorderLevel: 0,
							};
						} else {
							return {
								success: false,
								error: `Inventory not initialized for SKU "${sku}" under tenant "${tenantId}".`,
							};
						}
					}

					// 3. Compute new quantity and perform business rule check
					let newQuantity = inv.currentQuantity;
					if (type === "sale" || type === "waste") {
						if (inv.currentQuantity < quantity) {
							return {
								success: false,
								error: `Insufficient stock for ${type}. Current stock: ${inv.currentQuantity}, requested: ${quantity}.`,
							};
						}
						newQuantity -= quantity;
					} else {
						// type is 'restock'
						newQuantity += quantity;
					}

					// 4. Update the location-specific inventory count
					await tx
						.update(inventory)
						.set({ currentQuantity: newQuantity })
						.where(eq(inventory.id, inv.id));

					// 5. Insert audit log into stock movements
					await tx.insert(stockMovements).values({
						id: randomUUID(),
						inventoryId: inv.id,
						type,
						quantity,
						createdAt: new Date().toISOString(),
					});

					return {
						success: true,
						inventoryId: inv.id,
						currentQuantity: newQuantity,
						reorderLevel: inv.reorderLevel,
					};
				});
			});

			if (!dbResult.success) {
				// Raise a terminal error so Restate halts retry loops and bubbles the error up immediately
				throw new restate.TerminalError(dbResult.error || "Database stock movement operation failed");
			}

			// Low-Stock alert check (can be hooked up with ctx.send() or delayed triggers)
			if (dbResult.currentQuantity !== undefined && dbResult.reorderLevel !== undefined) {
				if (dbResult.currentQuantity <= dbResult.reorderLevel) {
					// In a real environment, we would trigger a low-stock alert process.
					// e.g. ctx.objectSendClient(alertService, tenantId).trigger({ sku, level: dbResult.currentQuantity });
					console.log(`[ALERT] Tenant ${tenantId}: SKU ${sku} reached low-stock level. Current: ${dbResult.currentQuantity}, Reorder level: ${dbResult.reorderLevel}`);
				}
			}

			return dbResult;
		},
	},
});
