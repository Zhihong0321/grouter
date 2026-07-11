export interface ApiKeyRecord {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  status: "active" | "revoked";
  rateLimitRpm: number;
  budgetCents: number;
  spentCents: number;
  modelRestrictions: string[] | null;
  unlimited: boolean;
  /** Smart Routing Mode -- per-key, per-client opt-in. See src/lib/tierRouting.ts. */
  smartRouting: {
    claudeCode: boolean;
    codex: boolean;
  };
}
