import {
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const inventory = sqliteTable(
	"inventory",
	{
		id: text("id").primaryKey(),
		tenantId: text("tenant_id").notNull(),
		sku: text("sku").notNull(),
		quantity: integer("quantity").notNull(),
		versionNumber: integer("version_number").notNull().default(1),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => ({
		tenantSkuIdx: uniqueIndex("tenant_sku_idx").on(table.tenantId, table.sku),
	}),
);

export const syncOutbox = sqliteTable("sync_outbox", {
	id: text("id").primaryKey(),
	tenantId: text("tenant_id").notNull(),
	payload: text("payload").notNull(), // JSON string representing the batch of changes
	status: text("status").notNull().default("pending"), // 'pending' | 'processed' | 'failed_conflict'
	createdAt: text("created_at").notNull(),
});

export const syncLog = sqliteTable("sync_log", {
	id: text("id").primaryKey(),
	tenantId: text("tenant_id").notNull(),
	syncId: text("sync_id").notNull(),
	sku: text("sku").notNull(),
	quantityChange: integer("quantity_change").notNull(),
	status: text("status").notNull(), // 'reserved' | 'compensated'
	createdAt: text("created_at").notNull(),
});
