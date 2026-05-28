import { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { inventory } from "./schema.ts";

export const sqlite = new Database("sqlite.db");
export const db = drizzle({
	client: sqlite,
	casing: "snake_case",
});

export interface VerifyReserveResult {
	success: boolean;
	reason?: "not_found" | "version_mismatch" | "insufficient_stock";
}

/**
 * Atomic verify and reserve operation for an inventory item.
 * Verifies version number matches, sufficient stock is available, and then
 * decrements quantity and increments version number.
 */
export async function verifyAndReserveItem(
	tenantId: string,
	sku: string,
	quantityChange: number,
	versionNumber: number,
): Promise<VerifyReserveResult> {
	return await db.transaction(async (tx) => {
		const [item] = await tx
			.select()
			.from(inventory)
			.where(and(eq(inventory.tenantId, tenantId), eq(inventory.sku, sku)))
			.limit(1);

		if (!item) {
			return { success: false, reason: "not_found" };
		}

		// Optimistic Concurrency Control Check
		if (item.versionNumber !== versionNumber) {
			return { success: false, reason: "version_mismatch" };
		}

		// Quantity check (if quantityChange is negative, e.g. selling/decrementing stock)
		if (item.quantity + quantityChange < 0) {
			return { success: false, reason: "insufficient_stock" };
		}

		// Update quantity and version number
		await tx
			.update(inventory)
			.set({
				quantity: item.quantity + quantityChange,
				versionNumber: item.versionNumber + 1,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(inventory.id, item.id));

		return { success: true };
	});
}

/**
 * Compensating transaction to undo a previous decrement.
 * Increments quantity back and increments version number.
 */
export async function compensateItem(
	tenantId: string,
	sku: string,
	quantityChange: number,
): Promise<{ success: boolean; reason?: string }> {
	return await db.transaction(async (tx) => {
		const [item] = await tx
			.select()
			.from(inventory)
			.where(and(eq(inventory.tenantId, tenantId), eq(inventory.sku, sku)))
			.limit(1);

		if (!item) {
			return { success: false, reason: "not_found" };
		}

		// Undo the change: subtract quantityChange (e.g. subtracting -5 adds 5 back)
		await tx
			.update(inventory)
			.set({
				quantity: item.quantity - quantityChange,
				versionNumber: item.versionNumber + 1,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(inventory.id, item.id));

		return { success: true };
	});
}
