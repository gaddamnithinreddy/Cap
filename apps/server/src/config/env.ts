import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string(),
  FRONTEND_URL: z.string().default("http://localhost:5173"),

  // Auth
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  GOOGLE_REDIRECT_URI: z.string().default("http://localhost:4000/api/v1/auth/google/callback"),
  GITHUB_CLIENT_ID: z.string(),
  GITHUB_CLIENT_SECRET: z.string(),
  GITHUB_REDIRECT_URI: z.string().default("http://localhost:4000/api/v1/auth/github/callback"),

  // Encryption
  ENCRYPTION_KEY: z.string().min(32),

  // Daytona (sandbox provider)
  DAYTONA_API_KEY: z.string().optional(),
  DAYTONA_SERVER_URL: z.string().optional(),
  DAYTONA_TARGET: z.string().optional(),
  // Optional: boot sandboxes from a pre-built Daytona snapshot instead of the default image.
  DAYTONA_SNAPSHOT: z.string().optional(),
  // Optional: when "true", build-template bakes deps into a dedicated Daytona snapshot
  // (parity with the old E2B template). Default provisions deps at sandbox start.
  DAYTONA_BUILD_SNAPSHOT: z.string().optional(),

  // LLM
  LLM_PROVIDER: z.enum(["vercel", "openai", "openrouter", "gemini"]).default("vercel"),
  AI_GATEWAY_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  // Google Gemini via its OpenAI-compatible endpoint.
  GEMINI_API_KEY: z.string().optional(),
});

type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env = validateEnv();
