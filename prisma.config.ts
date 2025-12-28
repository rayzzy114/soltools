import { defineConfig } from "prisma/config"
import { PrismaPg } from "@prisma/adapter-pg"

// hard default for test env; still reads DATABASE_URL if set
const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5433/pumpfun_panel?schema=public"

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: databaseUrl,
  },
  adapter: async () => {
    return new PrismaPg({ connectionString: databaseUrl })
  },
})

