import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "./db/index.ts";
import { orders, paymentEvents } from "./db/schema.ts";
import { app } from "./server.ts";

let testServer: any;

beforeAll(async () => {
	// Start Elysia server on port 3000 to listen for coordinator requests (if not already running)
	try {
		testServer = app.listen(3000);
	} catch (e) {
		// Port already in use by running dev server
	}

	// Register deployment with Restate coordinator
	try {
		execSync(
			"npx @restatedev/restate deployments register --use-http1.1 --force --yes http://localhost:3000/restate",
			{ stdio: "ignore" },
		);
	} catch (e) {
		console.warn("Could not auto-register deployment with Restate coordinator. Is Restate running?");
	}
}, 20000);

afterAll(async () => {
	if (testServer) {
		await testServer.stop();
	}
});

describe("Payment Reliability Service Tests", () => {
	beforeEach(async () => {
		// Clear database tables before each test
		await db.delete(paymentEvents);
		await db.delete(orders);
	});

	it("1. Idempotency: Returns immediately if the order is already paid", async () => {
		const orderId = "order-already-paid";

		// Seed order as paid
		await db.insert(orders).values({
			id: orderId,
			amount: 5000,
			currency: "USD",
			status: "paid",
		});

		// Trigger payment charge
		const res = await app.handle(
			new Request("http://localhost:3000/payments/charge", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					orderId,
				}),
			}),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.success).toBe(true);
		expect(body.data.status).toBe("paid");
		expect(body.data.message).toContain("already paid");

		// Verify no INITIATED events were recorded in paymentEvents
		const events = await db.select().from(paymentEvents).where(eq(paymentEvents.orderId, orderId));
		expect(events.length).toBe(0);
	});

	it("2. Concurrency: Serializes concurrent payment charges and prevents double charging", async () => {
		const orderId = `order_${randomUUID().substring(0, 8)}`;

		// Dispatch 5 concurrent payment charge requests in parallel
		const requests = Array.from({ length: 5 }).map(async () => {
			const res = await app.handle(
				new Request("http://localhost:3000/payments/charge", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						orderId,
						amount: 2500,
						currency: "NGN",
					}),
				}),
			);
			return { status: res.status, body: (await res.json()) as any };
		});

		const results = await Promise.all(requests);

		// Assertions:
		// At least one of the requests will capture the lock and run the charge flow.
		// If that run succeeds, the subsequent requests return "Order is already paid".
		// If it fails/times out, some requests might return failure status codes.
		// We verify that the API processed the request responses successfully.
		const successfulCharges = results.filter((r) => r.status === 200);
		expect(successfulCharges.length).toBeGreaterThan(0);

		// Check database status
		const dbOrder = await db
			.select()
			.from(orders)
			.where(eq(orders.id, orderId))
			.limit(1)
			.then((r) => r[0]);
		expect(dbOrder).toBeDefined();

		// Check logged events: We expect exactly one provider resolution transaction (either success, error, or reconciliation required)
		const events = await db.select().from(paymentEvents).where(eq(paymentEvents.orderId, orderId));
		const outcomeEvents = events.filter((e) =>
			["PROVIDER_SUCCESS", "PROVIDER_ERROR", "RECONCILIATION_REQUIRED"].includes(e.eventType),
		);
		expect(outcomeEvents.length).toBeLessThanOrEqual(1);
	});

	it("3. Reconciliation: Correctly identifies discrepancies and mismatches", async () => {
		const failedOrderId = "order-failed-db";
		const timeoutOrderId = "order-timeout-db";

		// Seed mismatched records in DB
		await db.insert(orders).values([
			{ id: failedOrderId, amount: 5000, currency: "NGN", status: "failed" },
			{ id: timeoutOrderId, amount: 3000, currency: "NGN", status: "pending" },
		]);

		await db.insert(paymentEvents).values([
			{
				id: randomUUID(),
				orderId: failedOrderId,
				eventType: "PROVIDER_ERROR",
				rawResponse: JSON.stringify({ error: "Paystack 500 Internal Server Error" }),
				createdAt: new Date().toISOString(),
			},
			{
				id: randomUUID(),
				orderId: timeoutOrderId,
				eventType: "RECONCILIATION_REQUIRED",
				rawResponse: JSON.stringify({ error: "Paystack Request Timeout" }),
				createdAt: new Date().toISOString(),
			},
		]);

		const providerTransactions = [
			{ order_id: "order-missing-db", reference: "pay_ref_missing_123", amount: 1500, status: "success" },
			{ order_id: failedOrderId, reference: "pay_ref_failed_456", amount: 5000, status: "success" },
		];

		const queryParam = encodeURIComponent(JSON.stringify(providerTransactions));
		const res = await app.handle(
			new Request(`http://localhost:3000/payments/reconcile?transactions=${queryParam}`, {
				method: "GET",
			}),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.success).toBe(true);
		expect(body.summary.totalProviderTransactionsChecked).toBe(2);
		expect(body.summary.discrepanciesCount).toBeGreaterThanOrEqual(3);

		// Assert specific discrepancy types are present
		const discrepancyTypes = body.discrepancies.map((d: any) => d.type);
		expect(discrepancyTypes).toContain("DISCREPANCY_MISSING_IN_DB");
		expect(discrepancyTypes).toContain("DISCREPANCY_STATUS_MISMATCH");
		expect(discrepancyTypes).toContain("DISCREPANCY_RECONCILIATION_REQUIRED");
	});
});
