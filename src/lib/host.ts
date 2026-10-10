// Where the server runs. Serverless hosts give every instance its own memory and disk, so nothing
// process-local (a file ledger, an in-memory counter) is a shared limit there.
export type EnvLike = Record<string, string | undefined>;

export function isServerlessHost(env: EnvLike = process.env): boolean {
  return !!(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.NETLIFY || env.K_SERVICE);
}

/** A public deployment (serverless, or a server marked MOONA_DEPLOYED=1): development shortcuts are off. */
export function isDeployed(env: EnvLike = process.env): boolean {
  return isServerlessHost(env) || env.MOONA_DEPLOYED === "1";
}
