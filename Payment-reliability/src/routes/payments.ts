import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../db/index.ts";
import { orders, paymentEvents } from "../db/schema.ts";
import { restateClient } from "../services/restate-client.ts";
import { paymentService } from "../services/restate.ts";

export const paymentRoutes = new Elysia({ prefix: "/payments" })
	.post(
		"/charge",
		async ({ body, set }) => {
			const { orderId, amount = 1000, currency = "NGN" } = body;

			try {
				// Upsert order record as pending if it doesn't exist
				await db.transaction(async (tx) => {
					const existing = await tx
						.select()
						.from(orders)
						.where(eq(orders.id, orderId))
						.limit(1)
						.then((r) => r[0]);

					if (!existing) {
						await tx.insert(orders).values({
							id: orderId,
							amount,
							currency,
							status: "pending",
						});
					}
				});

				// Dispatch Request-Response to Restate Virtual Object (keyed by orderId)
				const result = await restateClient
					.objectClient<typeof paymentService>({ name: "PaymentService" }, orderId)
					.processPayment({ orderId });

				return { success: result.success, data: result };
			} catch (error: any) {
				set.status = error.errorCode || 400;
				return {
					success: false,
					error: error.message || "Payment processing failed",
				};
			}
		},
		{
			body: t.Object({
				orderId: t.String(),
				amount: t.Optional(t.Number()),
				currency: t.Optional(t.String()),
			}),
		},
	)

	.get(
		"/reconcile",
		async ({ query, set }) => {
			const { transactions } = query;
			if (!transactions) {
				set.status = 400;
				return { success: false, error: "Missing transactions query parameter" };
			}

			try {
				const providerTxList: any[] = JSON.parse(transactions);
				const discrepancies: any[] = [];

				// Load all orders and events from the SQLite database
				const allOrders = await db.select().from(orders);
				const allEvents = await db.select().from(paymentEvents);

				const ordersMap = new Map(allOrders.map((o) => [o.id, o]));

				// Group events by order ID
				const eventsByOrderMap = new Map<string, typeof allEvents>();
				for (const event of allEvents) {
					if (!eventsByOrderMap.has(event.orderId)) {
						eventsByOrderMap.set(event.orderId, []);
					}
					eventsByOrderMap.get(event.orderId)!.push(event);
				}

				// Track matched references to find missing success transactions in reverse check
				const matchedProviderRefs = new Set<string>();

				// 1. Check from Provider's transactions to DB
				for (const tx of providerTxList) {
					const orderId = tx.order_id;
					const reference = tx.reference;
					const status = tx.status; // 'success' | 'failed'
					const amount = tx.amount;

					const dbOrder = ordersMap.get(orderId);
					const dbEvents = eventsByOrderMap.get(orderId) || [];

					const hasSuccessEvent = dbEvents.some(
						(e) => e.eventType === "PROVIDER_SUCCESS" && e.providerReference === reference,
					);
					const hasReconciledEvent = dbEvents.some(
						(e) => e.eventType === "RECONCILED" && e.providerReference === reference,
					);

					if (status === "success") {
						// Case A: Successful in provider but no success log in our database
						if (!hasSuccessEvent && !hasReconciledEvent) {
							discrepancies.push({
								type: "DISCREPANCY_MISSING_IN_DB",
								message: `Order "${orderId}" has a successful transaction in provider (ref: ${reference}) but no success event logged in our database.`,
								orderId,
								providerReference: reference,
								providerAmount: amount,
							});
						}

						// Case B: Successful in provider but database status is not 'paid' (Status mismatch)
						if (dbOrder && dbOrder.status !== "paid") {
							discrepancies.push({
								type: "DISCREPANCY_STATUS_MISMATCH",
								message: `Order "${orderId}" is marked as successful in provider (ref: ${reference}) but our order status in the database is "${dbOrder.status}".`,
								orderId,
								providerReference: reference,
								dbStatus: dbOrder.status,
							});
						}

						matchedProviderRefs.add(reference);
					}
				}

				// 2. Check from DB events to Provider (Reverse check)
				for (const event of allEvents) {
					if (event.eventType === "PROVIDER_SUCCESS" && event.providerReference) {
						const isMatched = providerTxList.some(
							(tx) => tx.reference === event.providerReference && tx.status === "success",
						);

						// Case C: Success in DB but missing or not successful in provider records
						if (!isMatched) {
							discrepancies.push({
								type: "DISCREPANCY_MISSING_IN_PROVIDER",
								message: `Success event recorded in our DB for order "${event.orderId}" (ref: ${event.providerReference}) but provider lists no successful transaction.`,
								orderId: event.orderId,
								providerReference: event.providerReference,
							});
						}
					}

					// Case D: Order flagged as requiring manual reconciliation due to exhausted retries
					if (event.eventType === "RECONCILIATION_REQUIRED") {
						discrepancies.push({
							type: "DISCREPANCY_RECONCILIATION_REQUIRED",
							message: `Order "${event.orderId}" is flagged as RECONCILIATION_REQUIRED due to network timeouts/socket hang-ups.`,
							orderId: event.orderId,
							details: event.rawResponse ? JSON.parse(event.rawResponse) : null,
						});
					}
				}

				return {
					success: true,
					reconciledAt: new Date().toISOString(),
					summary: {
						totalProviderTransactionsChecked: providerTxList.length,
						discrepanciesCount: discrepancies.length,
					},
					discrepancies,
				};
			} catch (error: any) {
				set.status = 500;
				return {
					success: false,
					error: error.message || "Failed to process reconciliation",
				};
			}
		},
		{
			query: t.Object({
				transactions: t.String(),
			}),
		},
	);
