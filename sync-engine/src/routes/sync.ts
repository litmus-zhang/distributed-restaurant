import { randomUUID } from "node:crypto";
import { Elysia, t } from "elysia";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { syncOutbox } from "../db/schema.ts";
import type { inventorySaga } from "../services/restate.ts";
import { restateClient } from "../services/restate-client.ts";

export const syncRoutes = new Elysia({ prefix: "/sync" }).post(
	"/push",
	async ({ body, set }) => {
		const { tenantId, changes } = body;
		const syncId = randomUUID();

		try {
			// SQLite Transaction: Insert changes into pending sync outbox table
			await db.transaction(async (tx) => {
				await tx.insert(syncOutbox).values({
					id: syncId,
					tenantId,
					payload: JSON.stringify(changes),
					status: "pending",
					createdAt: new Date().toISOString(),
				});
			});

			// Trigger Restate Virtual Object asynchronously using send (only outside test mode)
			if (config.NODE_ENV !== "test") {
				try {
					// Call the processSyncBatch handler on the InventorySaga object keyed by tenantId
					restateClient
						.objectSendClient<typeof inventorySaga>(
							{ name: "InventorySaga" },
							tenantId,
						)
						.processSyncBatch({
							syncId,
							changes,
						});
				} catch (restateError) {
					console.warn(
						"Warning: Failed to trigger Restate Saga via client connection:",
						restateError,
					);
				}
			}

			// Return syncId and status immediately to the client
			return { syncId, status: "pending" };
		} catch (error: any) {
			set.status = 500;
			return {
				success: false,
				error: error.message || "Failed to queue sync batch",
			};
		}
	},
	{
		body: t.Object({
			tenantId: t.String(),
			changes: t.Array(
				t.Object({
					sku: t.String(),
					quantityChange: t.Number(),
					versionNumber: t.Number(),
				}),
			),
		}),
	},
);
