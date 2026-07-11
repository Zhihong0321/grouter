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
}
