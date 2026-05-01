import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  phoneNumber: text("phone_number").primaryKey(),
  runnerUserId: text("runner_user_id").notNull().unique(),
  workspaceId: text("workspace_id").notNull(),
  jwt: text("jwt").notNull(),
  refreshToken: text("refresh_token").notNull(),
  jwtExpiresAt: timestamp("jwt_expires_at", { withTimezone: true }).notNull(),
  managedAgentId: text("managed_agent_id"),
  managedAgentVersion: integer("managed_agent_version"),
  managedAgentsSessionId: text("managed_agents_session_id"),
  lastUserMsgAt: timestamp("last_user_msg_at", { withTimezone: true }),
  lastAssistantMsgAt: timestamp("last_assistant_msg_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const linkTokens = pgTable("link_tokens", {
  token: text("token").primaryKey(),
  runnerUserId: text("runner_user_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  jwt: text("jwt").notNull(),
  refreshToken: text("refresh_token").notNull(),
  jwtExpiresAt: timestamp("jwt_expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type LinkToken = typeof linkTokens.$inferSelect;
export type NewLinkToken = typeof linkTokens.$inferInsert;
