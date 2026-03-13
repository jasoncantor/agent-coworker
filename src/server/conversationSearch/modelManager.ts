import { env, pipeline } from "@huggingface/transformers";

import { CONVERSATION_SEARCH_MODEL_KEYS, CONVERSATION_SEARCH_MODEL_SPECS, type ConversationSearchModelKey } from "./types";

type FeatureExtractionTensor = {
  data: Float32Array | Float64Array | ArrayLike<number>;
  dims?: number[];
};

type FeatureExtractor = {
  (texts: string | string[], options?: {
    pooling?: "mean";
    normalize?: boolean;
  }): Promise<FeatureExtractionTensor>;
  dispose?: () => Promise<void>;
};

export class ConversationSearchCancelledError extends Error {
  constructor(message = "Conversation search download cancelled") {
    super(message);
    this.name = "ConversationSearchCancelledError";
  }
}

type ProgressEvent = {
  status?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
};

export type ConversationSearchModelManagerDeps = {
  loadPipeline?: typeof pipeline;
};

function tensorToVectors(tensor: FeatureExtractionTensor): Float32Array[] {
  const rawData = Array.from(tensor.data);
  const dims = Array.isArray(tensor.dims) ? tensor.dims : [];
  if (dims.length <= 1) {
    return [Float32Array.from(rawData)];
  }

  const vectorCount = Math.max(1, dims[0] ?? 1);
  const vectorSize = Math.max(1, dims[dims.length - 1] ?? rawData.length);
  const vectors: Float32Array[] = [];
  for (let index = 0; index < vectorCount; index += 1) {
    const start = index * vectorSize;
    const end = start + vectorSize;
    vectors.push(Float32Array.from(rawData.slice(start, end)));
  }
  return vectors;
}

export class ConversationSearchModelManager {
  private readonly loadPipelineImpl: typeof pipeline;
  private readonly modelsDir: string;

  private readonly extractorPromises = new Map<ConversationSearchModelKey, Promise<FeatureExtractor>>();

  constructor(modelsDir: string, deps: ConversationSearchModelManagerDeps = {}) {
    this.modelsDir = modelsDir;
    this.loadPipelineImpl = deps.loadPipeline ?? pipeline;
    this.configureEnvironment();
  }

  async downloadAll(opts: {
    shouldCancel?: () => boolean;
    onProgress?: (key: ConversationSearchModelKey, event: ProgressEvent) => void;
  }): Promise<void> {
    for (const key of CONVERSATION_SEARCH_MODEL_KEYS) {
      if (opts.shouldCancel?.()) {
        throw new ConversationSearchCancelledError();
      }
      await this.downloadModel(key, opts);
    }
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.embedTexts("query", [text]);
    return vector ?? new Float32Array();
  }

  async embedContexts(texts: string[]): Promise<Float32Array[]> {
    return await this.embedTexts("context", texts);
  }

  async dispose(): Promise<void> {
    for (const promise of this.extractorPromises.values()) {
      try {
        const extractor = await promise;
        await extractor.dispose?.();
      } catch {
        // ignore best-effort cleanup
      }
    }
    this.extractorPromises.clear();
  }

  private async downloadModel(
    key: ConversationSearchModelKey,
    opts: {
      shouldCancel?: () => boolean;
      onProgress?: (key: ConversationSearchModelKey, event: ProgressEvent) => void;
    },
  ): Promise<void> {
    const spec = CONVERSATION_SEARCH_MODEL_SPECS[key];
    const loadFeaturePipeline = this.loadPipelineImpl as unknown as (
      task: "feature-extraction",
      modelId: string,
      options: {
        cache_dir: string;
        revision: string;
        progress_callback: (event: unknown) => void;
      },
    ) => Promise<FeatureExtractor>;
    const extractor = await loadFeaturePipeline("feature-extraction", spec.modelId, {
      cache_dir: this.modelsDir,
      revision: spec.revision,
      progress_callback: (event) => {
        if (opts.shouldCancel?.()) {
          throw new ConversationSearchCancelledError();
        }
        opts.onProgress?.(key, event as ProgressEvent);
      },
    }) as FeatureExtractor;

    await extractor.dispose?.();
  }

  private async embedTexts(key: ConversationSearchModelKey, texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor(key);
    const tensor = await extractor(texts.length === 1 ? texts[0]! : texts, {
      pooling: "mean",
      normalize: true,
    });
    const vectors = tensorToVectors(tensor);
    if (texts.length === 1 && vectors.length > 1) {
      return [vectors[0]!];
    }
    return vectors;
  }

  private async getExtractor(key: ConversationSearchModelKey): Promise<FeatureExtractor> {
    const existing = this.extractorPromises.get(key);
    if (existing) return await existing;

    const spec = CONVERSATION_SEARCH_MODEL_SPECS[key];
    const loadFeaturePipeline = this.loadPipelineImpl as unknown as (
      task: "feature-extraction",
      modelId: string,
      options: {
        cache_dir: string;
        local_files_only: true;
        revision: string;
      },
    ) => Promise<FeatureExtractor>;
    const promise = loadFeaturePipeline("feature-extraction", spec.modelId, {
      cache_dir: this.modelsDir,
      local_files_only: true,
      revision: spec.revision,
    });
    this.extractorPromises.set(key, promise);

    try {
      return await promise;
    } catch (error) {
      this.extractorPromises.delete(key);
      throw error;
    }
  }

  private configureEnvironment(): void {
    env.allowLocalModels = true;
    env.useFS = true;
    env.useFSCache = true;
    env.useBrowserCache = false;
    env.cacheDir = this.modelsDir;
  }
}
