import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import { eq } from "drizzle-orm";
import { compensateItem, db, verifyAndReserveItem } from "../db/index.ts";
import { syncLog, syncOutbox } from "../db/schema.ts";

export interface SyncChange {
	sku: string;
	quantityChange: number;
	versionNumber: number;
}

/**
 * Saga orchestrator handler for processing a batch of synced operations.
 * Implements verify-and-reserve, logging, and reverse compensation rollback.
 */
export async function processSyncBatch(
	ctx: restate.ObjectContext,
	request: {
		syncId: string;
		changes: SyncChange[];
	},
) {
	const { syncId, changes } = request;
	const tenantId = ctx.key; // The Virtual Object is keyed by tenantId

	// Keep track of successful steps for compensation
	const completedSteps: SyncChange[] = [];

	try {
		for (const change of changes) {
			// Step 1: Verify & Reserve
			const reserveResult = await ctx.run(async () => {
				return await verifyAndReserveItem(
					tenantId,
					change.sku,
					change.quantityChange,
					change.versionNumber,
				);
			});

			if (!reserveResult.success) {
				// Throw TerminalError to abort and trigger compensation
				throw new restate.TerminalError(
					`RESERVATION_FAILED: SKU ${change.sku} failed due to ${reserveResult.reason}`,
				);
			}

			// Step 2: Log step success in the database
			await ctx.run(async () => {
				await db.insert(syncLog).values({
					id: randomUUID(),
					tenantId,
					syncId,
					sku: change.sku,
					quantityChange: change.quantityChange,
					status: "reserved",
					createdAt: new Date().toISOString(),
				});
			});

			completedSteps.push(change);
		}

		// All steps in the batch succeeded! Mark outbox as processed.
		await ctx.run(async () => {
			await db
				.update(syncOutbox)
				.set({ status: "processed" })
				.where(eq(syncOutbox.id, syncId));
		});

		return { success: true };
	} catch (error: any) {
		// Only run compensations and fail outbox for permanent/terminal failures
		if (error instanceof restate.TerminalError) {
			const errorMessage = error.message || "Terminal error during sync";

			// Compensation Flow: Rollback completed steps in reverse order
			for (const step of [...completedSteps].reverse()) {
				await ctx.run(async () => {
					await compensateItem(tenantId, step.sku, step.quantityChange);
				});

				await ctx.run(async () => {
					await db.insert(syncLog).values({
						id: randomUUID(),
						tenantId,
						syncId,
						sku: step.sku,
						quantityChange: step.quantityChange,
						status: "compensated",
						createdAt: new Date().toISOString(),
					});
				});
			}

			// Mark outbox status as failed_conflict
			await ctx.run(async () => {
				await db
					.update(syncOutbox)
					.set({ status: "failed_conflict" })
					.where(eq(syncOutbox.id, syncId));
			});

			return {
				success: false,
				error: errorMessage,
			};
		}

		// Rethrow transient errors so Restate can retry the invocation
		throw error;
	}
}

export const inventorySaga = restate.object({
	name: "InventorySaga",
	handlers: {
		processSyncBatch,
	},
});
