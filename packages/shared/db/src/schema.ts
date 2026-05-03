import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  phoneNumber: text("phone_number").primaryKey(),
  runnerUserId: text("runner_user_id").notNull().unique(),
  workspaceId: text("workspace_id").notNull(),
  jwt: text("jwt").notNull(),
  refreshToken: text("refresh_token").notNull(),
  jwtExpiresAt: timestamp("jwt_expires_at", { withTimezone: true }).notNull(),
  spectrumUserId: text("spectrum_user_id").notNull(),
  assignedPhoneNumber: text("assigned_phone_number"),
  managedAgentId: text("managed_agent_id"),
  managedAgentVersion: integer("managed_agent_version"),
  managedAgentVaultId: text("managed_agent_vault_id"),
  managedAgentsSessionId: text("managed_agents_session_id"),
  runnerContactSentAt: timestamp("runner_contact_sent_at", { withTimezone: true }),
  lastUserMsgAt: timestamp("last_user_msg_at", { withTimezone: true }),
  lastAssistantMsgAt: timestamp("last_assistant_msg_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
