import { createClient } from '@supabase/supabase-js'

const requireEnv = (name: string) => {
  const value = process.env[name]

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

export const APP_ENV = {
  supabaseUrl: requireEnv('SUPABASE_URL'),
  supabaseServiceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  // Embeddings: self-hosted TEI (BAAI/bge-small-en-v1.5, 384-d) by default.
  // Setting EMBED_BASE_URL enables the brain bridge (related-thought retrieval +
  // capture); TEI needs no API key. The query prefix is applied to searches
  // only (see brain.ts); captured passages are embedded unprefixed.
  embedBaseUrl: process.env.EMBED_BASE_URL ?? '',
  embedModel: process.env.EMBED_MODEL ?? 'BAAI/bge-small-en-v1.5',
  embedQueryPrefix:
    process.env.EMBED_QUERY_PREFIX ??
    'Represent this sentence for searching relevant passages: ',
  embedApiKey: process.env.EMBED_API_KEY ?? '',
}

export const supabase = createClient(
  APP_ENV.supabaseUrl,
  APP_ENV.supabaseServiceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
)
