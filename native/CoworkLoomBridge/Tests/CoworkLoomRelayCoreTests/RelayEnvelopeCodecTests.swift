import Testing

@testable import CoworkLoomRelayCore

@Test
func relayEnvelopeCodecRoundTrip() throws {
    let envelope = RelayEnvelope.openSocket(
        .init(
            channelId: "channel-1",
            workspaceId: "workspace-1",
            resumeSessionId: "session-1"
        )
    )

    let encoded = try RelayEnvelopeCodec.encode(envelope)
    let decoded = try RelayEnvelopeCodec.decode(encoded)

    #expect(decoded == envelope)
}

@Test
func connectionEpochTrackerInvalidatesOlderEpochs() {
    var tracker = ConnectionEpochTracker()

    let first = tracker.advance()
    #expect(tracker.current == first)
    #expect(tracker.isCurrent(first))

    let second = tracker.advance()
    #expect(second != first)
    #expect(tracker.current == second)
    #expect(!tracker.isCurrent(first))
    #expect(tracker.isCurrent(second))
}
