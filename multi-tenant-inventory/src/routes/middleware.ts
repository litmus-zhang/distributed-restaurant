import { randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { tenants } from "../db/schema.ts";

/**
 * Tenant Isolation Middleware.
 * Extracts X-Tenant-ID from the headers and verifies it exists in the database.
 * If the tenant does not exist, it automatically creates a shell record to prevent FK issues.
 */
export const tenantIsolation = new Elysia().derive({ as: "global" }, async ({ headers, set }) => {
	const tenantId = headers["x-tenant-id"];
	if (!tenantId) {
		set.status = 400;
		throw new Error("Missing X-Tenant-ID header");
	}

	// Auto-create or verify tenant in database to ensure relational integrity
	const tenantExists = await db
		.select()
		.from(tenants)
		.where(eq(tenants.id, tenantId))
		.limit(1)
		.then((r) => r.length > 0);

	if (!tenantExists) {
		await db.insert(tenants).values({
			id: tenantId,
			name: `Auto Tenant ${tenantId}`,
			parentAccountId: "parent-default", // Default parent account for aggregation tests
		});
	}

	return { tenantId };
});

/**
 * Context helper middleware that injects execution metadata (requestId, startTime) for structured logging.
 */
export const executionMetadata = new Elysia().derive({ as: "global" }, () => {
	return {
		requestId: randomUUID(),
		startTime: performance.now(),
	};
});
