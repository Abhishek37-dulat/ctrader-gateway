export type CTraderEnv = "demo" | "live";

export type RequestCtx = Readonly<{
  userId: string;
  env?: CTraderEnv;
  tokenOverride?: string;
}>;
