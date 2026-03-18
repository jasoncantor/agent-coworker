import {
  awsBedrockProxyForcedHeaders,
  discoverAwsBedrockProxyModels,
  resolveAwsBedrockProxyApiKey,
  resolveAwsBedrockProxyBaseUrl,
  type AwsBedrockProxyDiscoveredModel,
} from "./awsBedrockProxyShared";

/**
 * @deprecated Use AwsBedrockProxyDiscoveredModel instead.
 */
export type OpenAiProxyDiscoveredModel = AwsBedrockProxyDiscoveredModel;

/**
 * @deprecated Use resolveAwsBedrockProxyApiKey instead.
 */
export const resolveOpenAiProxyApiKey = resolveAwsBedrockProxyApiKey;

/**
 * @deprecated Use resolveAwsBedrockProxyBaseUrl instead.
 */
export const resolveOpenAiProxyBaseUrl = resolveAwsBedrockProxyBaseUrl;

/**
 * @deprecated Use awsBedrockProxyForcedHeaders instead.
 */
export const openAiProxyForcedHeaders = awsBedrockProxyForcedHeaders;

/**
 * @deprecated Use discoverAwsBedrockProxyModels instead.
 */
export const discoverOpenAiProxyModels = discoverAwsBedrockProxyModels;
