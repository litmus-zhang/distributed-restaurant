import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

export const tenants = sqliteTable("tenants", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	parentAccountId: text("parent_account_id"),
});

export const items = sqliteTable("items", {
	id: text("id").primaryKey(),
	sku: text("sku").notNull().unique(),
	name: text("name").notNull(),
	description: text("description"),
});

export const inventory = sqliteTable(
	"inventory",
	{
		id: text("id").primaryKey(),
		tenantId: text("tenant_id")
			.notNull()
			.references(() => tenants.id),
		itemId: text("item_id")
			.notNull()
			.references(() => items.id),
		currentQuantity: integer("current_quantity").notNull().default(0),
		reorderLevel: integer("reorder_level").notNull().default(0),
	},
	(table) => ({
		tenantItemIdx: uniqueIndex("tenant_item_idx").on(table.tenantId, table.itemId),
	}),
);

export const stockMovements = sqliteTable("stock_movements", {
	id: text("id").primaryKey(),
	inventoryId: text("inventory_id")
		.notNull()
		.references(() => inventory.id),
	type: text("type").notNull(), // 'sale', 'restock', 'waste'
	quantity: integer("quantity").notNull(),
	createdAt: text("created_at").notNull(),
});
