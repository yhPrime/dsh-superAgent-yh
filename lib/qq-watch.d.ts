import { t as SourceKind } from "./kind-QyVv7MlE.js";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
declare const SOURCE = "qq";
/** The conversation a QQ trigger belongs to: a group, or a direct conversation. */
type QqChatKind = 'group' | 'private';
/** The native conversation id used as a Thread id; group and private conversations never share one. */
declare const qqThread: (chatKind: QqChatKind, chatId: string) => string;
declare const QqConfigSchema: z.ZodObject<{
  mode: z.ZodDefault<z.ZodEnum<{
    onebot: "onebot";
    official: "official";
  }>>;
  httpUrl: z.ZodDefault<z.ZodString>;
  wsUrl: z.ZodDefault<z.ZodString>;
  httpToken: z.ZodDefault<z.ZodString>;
  wsToken: z.ZodDefault<z.ZodString>;
  selfId: z.ZodDefault<z.ZodString>;
  baseUrl: z.ZodDefault<z.ZodString>;
  token: z.ZodDefault<z.ZodString>;
  chats: z.ZodDefault<z.ZodArray<z.ZodObject<{
    chatId: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    listen: z.ZodEnum<{
      mentions: "mentions";
      all: "all";
    }>;
  }, z.core.$strict>>>;
  directMessages: z.ZodDefault<z.ZodBoolean>;
  otherChats: z.ZodDefault<z.ZodEnum<{
    mentions: "mentions";
    none: "none";
  }>>;
}, z.core.$strict>;
type QqConfig = z.infer<typeof QqConfigSchema>;
declare const qqKind: SourceKind<QqConfig>;
declare const name = "dsh-superagent-yh-qq";
declare const inject: string[];
declare function apply(ctx: Context): void;
export { QqConfig, QqConfigSchema, SOURCE, apply, inject, name, qqKind, qqThread };