import { describe, expect, test } from "bun:test";

import {
  createModelStreamReplayRuntime,
  replayModelStreamRawEvent,
  shouldIgnoreNormalizedChunkForRawBackedTurn,
} from "../src/client/modelStreamReplay";

describe("modelStreamReplay", () => {
  test("keeps normalized chunks when a raw event produces no replay updates", () => {
    const runtime = createModelStreamReplayRuntime();

    expect(replayModelStreamRawEvent(runtime, {
      type: "model_stream_raw",
      sessionId: "session-1",
      turnId: "turn-1",
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.unknown_future_event",
      },
    })).toEqual([]);

    expect(shouldIgnoreNormalizedChunkForRawBackedTurn(runtime, {
      type: "model_stream_chunk",
      sessionId: "session-1",
      turnId: "turn-1",
      index: 1,
      provider: "openai",
      model: "gpt-5.2",
      partType: "reasoning_delta",
      part: {
        id: "reasoning-1",
        mode: "summary",
        text: "normalized reasoning still needed",
      },
    })).toBe(false);
  });

  test("marks turns raw-backed after replayable raw output is produced", () => {
    const runtime = createModelStreamReplayRuntime();

    const updates = replayModelStreamRawEvent(runtime, {
      type: "model_stream_raw",
      sessionId: "session-1",
      turnId: "turn-raw",
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.output_item.added",
        item: { type: "reasoning", id: "rs_live", summary: [] },
      },
    });

    expect(updates).not.toHaveLength(0);
    expect(shouldIgnoreNormalizedChunkForRawBackedTurn(runtime, {
      type: "model_stream_chunk",
      sessionId: "session-1",
      turnId: "turn-raw",
      index: 1,
      provider: "openai",
      model: "gpt-5.2",
      partType: "reasoning_delta",
      part: {
        id: "reasoning-2",
        mode: "summary",
        text: "stale normalized reasoning",
      },
    })).toBe(true);
  });
});
