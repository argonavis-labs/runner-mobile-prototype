import { integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  phoneNumber: text("phone_number").primaryKey(),
  runnerUserId: text("runner_user_id").notNull().unique(),
  workspaceId: text("workspace_id").notNull(),
  jwt: text("jwt").notNull(),
  refreshToken: text("refresh_token").notNull(),
  jwtExpiresAt: timestamp("jwt_expires_at", { withTimezone: true }).notNull(),
  spectrumUserId: text("spectrum_user_id").notNull(),
  assignedPhoneNumber: text("assigned_phone_number"),
  email: text("email"),
  timeZone: text("time_zone"),
  managedAgentId: text("managed_agent_id"),
  managedAgentVersion: integer("managed_agent_version"),
  managedAgentVaultId: text("managed_agent_vault_id"),
  managedAgentsSessionId: text("managed_agents_session_id"),
  runnerContactSentAt: timestamp("runner_contact_sent_at", { withTimezone: true }),
  lastUserMsgAt: timestamp("last_user_msg_at", { withTimezone: true }),
  lastAssistantMsgAt: timestamp("last_assistant_msg_at", { withTimezone: true }),
  lastHeartbeatTickAt: timestamp("last_heartbeat_tick_at", { withTimezone: true }),
  lastHeartbeatSlot: text("last_heartbeat_slot"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const memoryReplicas = pgTable(
  "memory_replicas",
  {
    id: serial("id").primaryKey(),
    runnerUserId: text("runner_user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runnerWorkspaceIdx: uniqueIndex("memory_replicas_runner_workspace_idx").on(
      table.runnerUserId,
      table.workspaceId,
    ),
  }),
);

export const memoryFiles = pgTable(
  "memory_files",
  {
    id: serial("id").primaryKey(),
    replicaId: integer("replica_id")
      .notNull()
      .references(() => memoryReplicas.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull().default(""),
    contentHash: text("content_hash").notNull(),
    revision: integer("revision").notNull().default(0),
    origin: text("origin").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    taskMeta: jsonb("task_meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    replicaPathIdx: uniqueIndex("memory_files_replica_path_idx").on(table.replicaId, table.path),
  }),
);

export const memoryFileRevisions = pgTable("memory_file_revisions", {
  id: serial("id").primaryKey(),
  replicaId: integer("replica_id")
    .notNull()
    .references(() => memoryReplicas.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  content: text("content").notNull().default(""),
  contentHash: text("content_hash").notNull(),
  fileRevision: integer("file_revision").notNull(),
  origin: text("origin").notNull(),
  operation: text("operation").notNull(),
  parentRevisionId: integer("parent_revision_id"),
  mergeParentId: integer("merge_parent_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memorySyncClients = pgTable(
  "memory_sync_clients",
  {
    id: text("id").primaryKey(),
    replicaId: integer("replica_id")
      .notNull()
      .references(() => memoryReplicas.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("memory_sync_clients_token_hash_idx").on(table.tokenHash),
  }),
);

export type MemoryReplica = typeof memoryReplicas.$inferSelect;
export type MemoryFile = typeof memoryFiles.$inferSelect;
export type MemoryFileRevision = typeof memoryFileRevisions.$inferSelect;
export type MemorySyncClient = typeof memorySyncClients.$inferSelect;

export const phoneLinkCodes = pgTable("phone_link_codes", {
  code: text("code").primaryKey(),
  runnerUserId: text("runner_user_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  email: text("email").notNull(),
  jwt: text("jwt").notNull(),
  refreshToken: text("refresh_token").notNull(),
  jwtExpiresAt: timestamp("jwt_expires_at", { withTimezone: true }).notNull(),
  timeZone: text("time_zone"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  consumedPhone: text("consumed_phone"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PhoneLinkCode = typeof phoneLinkCodes.$inferSelect;
