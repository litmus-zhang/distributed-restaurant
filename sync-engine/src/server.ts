import { Elysia } from "elysia";
import { syncRoutes } from "./routes/sync.ts";
import { restateHandler } from "./services/restate-client.ts";

export const app = new Elysia()
	.get("/", "Hello World")
	.use(syncRoutes)
	.all("/restate/*", ({ request }) => restateHandler(request), {
		tags: ["Restate workflow orchestration"],
		parse: "none",
	});
