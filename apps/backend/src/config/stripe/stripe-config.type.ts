export type StripeConfig = {
  /** Full secret key. Present ONLY on the worker process. */
  secretKey?: string;
  /** Restricted key (rk_), safe for the api process. Cannot create transfers. */
  restrictedKey?: string;
  webhookSecretPlatform?: string;
  webhookSecretConnect?: string;
};
