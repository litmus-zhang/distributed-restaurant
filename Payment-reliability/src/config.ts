import env from "env-var";

export const config = {
	NODE_ENV: env
		.get("NODE_ENV")
		.default("development")
		.asEnum(["production", "test", "development"]),

	PORT: env.get("PORT").default(3000).asPortNumber(),
	API_URL: env
		.get("API_URL")
		.default(`https://${env.get("PUBLIC_DOMAIN").asString()}`)
		.asString(),
	DATABASE_URL: env.get("DATABASE_URL").required().asString(),
	LOCK_STORE: env.get("LOCK_STORE").default("memory").asEnum(["memory"]),
	RESTATE_URL: env.get("RESTATE_URL").default("http://localhost:8080").asString(),
};
