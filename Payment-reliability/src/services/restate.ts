import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { orders, paymentEvents } from "../db/schema.ts";

export interface PaymentRequest {
	orderId: string;
}

export interface PaymentResponse {
	success: boolean;
	status: "pending" | "paid" | "failed";
	message: string;
	reference?: string;
}

export const paymentService = restate.object({
	name: "PaymentService",
	handlers: {
		/**
		 * Orchestrates payment processing for a specific order.
		 * Sequentially initiates, calls mock provider, and resolves state.
		 */
		processPayment: async (ctx: restate.ObjectContext, request: PaymentRequest): Promise<PaymentResponse> => {
			const orderId = ctx.key;

			// 1. Idempotency Check (Check Restate state first)
			const paymentStatus = await ctx.get<string>("payment_status");
			if (paymentStatus === "paid") {
				return {
					success: true,
					status: "paid",
					message: "Order is already paid.",
				};
			}

			// If state is not found/paid, retrieve order from DB to verify it exists and check DB status
			const order = await ctx.run("check-db-status", async () => {
				return await db.select().from(orders).where(eq(orders.id, orderId)).limit(1).then((r) => r[0]);
			});

			if (!order) {
				throw new restate.TerminalError(`Order with ID "${orderId}" not found.`);
			}

			if (order.status === "paid") {
				ctx.set("payment_status", "paid");
				return {
					success: true,
					status: "paid",
					message: "Order is already paid.",
				};
			}

			// 2. Phase 1: Log Initiation
			await ctx.run("log-initiation", async () => {
				await db.insert(paymentEvents).values({
					id: randomUUID(),
					orderId,
					eventType: "INITIATED",
					createdAt: new Date().toISOString(),
				});
			});

			// Generate a deterministic random value to simulate failure modes consistently during replay.
			const randVal = ctx.rand.random();

			try {
				// 3. Phase 2 & 3: The Provider Call and State Resolution
				const providerResult = await ctx.run(
					"provider-call",
					async () => {
						// Success Mode (40% probability)
						if (randVal < 0.4) {
							return {
								status: "success",
								reference: `pay_ref_${ctx.rand.uuidv4().substring(0, 8)}`,
							};
						}

						// 500 Provider Error Mode (20% probability) -> Throw TerminalError to fail immediately without retry
						if (randVal < 0.6) {
							throw new restate.TerminalError("Paystack 500 Internal Server Error");
						}

						// Request Timeout Mode (20% probability) -> Throw Standard Error to trigger retries
						if (randVal < 0.8) {
							throw new Error("Paystack Request Timeout (Socket Hangup)");
						}

						// Network Failure Mode (20% probability) -> Throw Standard Error to trigger retries
						throw new Error("Paystack Network Failure (Connection Reset)");
					},
					{
						maxRetryAttempts: 2, // 3 attempts total (initial try + 2 retries)
					},
				);

				// Success resolution
				await ctx.run("resolve-success-db", async () => {
					await db.transaction(async (tx) => {
						await tx
							.update(orders)
							.set({ status: "paid" })
							.where(eq(orders.id, orderId));

						await tx.insert(paymentEvents).values({
							id: randomUUID(),
							orderId,
							eventType: "PROVIDER_SUCCESS",
							providerReference: providerResult.reference,
							rawResponse: JSON.stringify(providerResult),
							createdAt: new Date().toISOString(),
						});
					});
				});

				ctx.set("payment_status", "paid");

				return {
					success: true,
					status: "paid",
					message: "Payment processed successfully.",
					reference: providerResult.reference,
				};
			} catch (error: any) {
				const isProviderError = error.message.includes("500") || error.message.includes("Paystack 500");

				if (isProviderError) {
					// Hard Failure (4xx/5xx) -> Log PROVIDER_ERROR and set order to failed
					await ctx.run("resolve-provider-error-db", async () => {
						await db.transaction(async (tx) => {
							await tx
								.update(orders)
								.set({ status: "failed" })
								.where(eq(orders.id, orderId));

							await tx.insert(paymentEvents).values({
								id: randomUUID(),
								orderId,
								eventType: "PROVIDER_ERROR",
								rawResponse: JSON.stringify({ error: error.message }),
								createdAt: new Date().toISOString(),
							});
						});
					});

					return {
						success: false,
						status: "failed",
						message: `Payment failed due to provider error: ${error.message}`,
					};
				}

				// Retry Exhaustion (Timeout/Network Failure) -> Log RECONCILIATION_REQUIRED, leave order pending
				await ctx.run("resolve-reconciliation-required-db", async () => {
					await db.insert(paymentEvents).values({
						id: randomUUID(),
						orderId,
						eventType: "RECONCILIATION_REQUIRED",
						rawResponse: JSON.stringify({ error: error.message }),
						createdAt: new Date().toISOString(),
					});
				});

				return {
					success: false,
					status: "pending",
					message: `Payment timed out / network failed after retries. Reconciliation required: ${error.message}`,
				};
			}
		},
	},
});
