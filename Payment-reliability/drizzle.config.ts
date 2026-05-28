import type { Config } from "drizzle-kit"
import env from "env-var"

const DATABASE_URL = env.get("DATABASE_URL").required().asString()

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  casing: "snake_case",
  dbCredentials: {
    url: DATABASE_URL
  }
} satisfies Config