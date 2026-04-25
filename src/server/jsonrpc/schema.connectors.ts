import { z } from "zod";
import { openAiNativeConnectorsEventSchema } from "../../shared/openaiNativeConnectors";

const cwdParamsSchema = z
  .object({
    cwd: z.string().optional(),
  })
  .passthrough();

export const jsonRpcConnectorsRequestSchemas = {
  "cowork/connectors/openai-native/list": cwdParamsSchema,
  "cowork/connectors/openai-native/refresh": cwdParamsSchema,
  "cowork/connectors/openai-native/setEnabled": cwdParamsSchema
    .extend({
      connectorId: z.string().trim().min(1),
      enabled: z.boolean(),
    })
    .passthrough(),
} as const;

export const jsonRpcConnectorsResultSchemas = {
  "cowork/connectors/openai-native/list": z
    .object({ event: openAiNativeConnectorsEventSchema })
    .strict(),
  "cowork/connectors/openai-native/refresh": z
    .object({ event: openAiNativeConnectorsEventSchema })
    .strict(),
  "cowork/connectors/openai-native/setEnabled": z
    .object({ event: openAiNativeConnectorsEventSchema })
    .strict(),
} as const;
