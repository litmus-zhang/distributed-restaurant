import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const orders = sqliteTable("orders", {
	id: text("id").primaryKey(),
	amount: integer("amount").notNull(),
	currency: text("currency").notNull(),
	status: text("status").notNull().default("pending"), // 'pending' | 'paid' | 'failed'
});

export const paymentEvents = sqliteTable("payment_events", {
	id: text("id").primaryKey(),
	orderId: text("order_id")
		.notNull()
		.references(() => orders.id),
	eventType: text("event_type").notNull(), // 'INITIATED' | 'PROVIDER_SUCCESS' | 'PROVIDER_ERROR' | 'TIMEOUT' | 'NETWORK_FAILURE' | 'RECONCILED' | 'RECONCILIATION_REQUIRED'
	providerReference: text("provider_reference"),
	rawResponse: text("raw_response"), // JSON string response from payment provider
	createdAt: text("created_at").notNull(),
});
