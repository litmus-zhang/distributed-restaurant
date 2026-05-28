import { Elysia } from "elysia";
import { stockRoutes } from "./routes/stock.ts";
import { restateHandler } from "./services/restate-client.ts";

export const app = new Elysia()
	.all("/restate/*", ({ request }) => restateHandler(request), {
		tags: ["Restate stock movement orchestration"],
		parse: "none",
	})
	.onError(({ error, set }) => {
		// Ensure error status is propagated or defaulted to 500
		set.status = set.status === 200 ? 500 : set.status;
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			error: errorMessage || "An unexpected error occurred",
		};
	})
	.get("/", "Hello World")
	.use(stockRoutes)

