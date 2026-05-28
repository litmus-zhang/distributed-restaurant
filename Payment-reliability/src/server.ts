import { Elysia } from "elysia";
import { paymentRoutes } from "./routes/payments.ts";
import { restateHandler } from "./services/restate-client.ts";

export const app = new Elysia()
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
	.use(paymentRoutes)
	.all("/restate/*", ({ request }) => restateHandler(request), {
		tags: ["Restate payment orchestration"],
		parse: "none",
	});
