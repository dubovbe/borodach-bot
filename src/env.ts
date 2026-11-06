export interface Env {
  BOT_TOKEN: string;
  BOT_INFO: string;
  WEBHOOK_SECRET: string;
  DATABASE_URL: string;
  FIRST_ADMIN_ID: string;
  INVITATION_SECRET?: string;
  SCHEDULER: DurableObjectNamespace;
}
