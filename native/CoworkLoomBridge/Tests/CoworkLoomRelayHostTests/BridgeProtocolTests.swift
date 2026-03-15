import Foundation
import Testing

@testable import CoworkLoomRelayCore
@testable import CoworkLoomRelayHost

@Test
func bridgeStateCodableRoundTripPreservesPairingMetadata() throws {
    let event = BridgeEvent.state(
        .init(
            supported: true,
            advertising: true,
            peer: .init(id: "peer-live", name: "My iPhone", state: "connected"),
            localDeviceId: "mac-device-id",
            localDeviceName: "Cowork Mac",
            discoveredPeers: [
                .init(id: "peer-discovered", name: "Alex iPhone", deviceId: "ios-device-id"),
            ],
            publishedWorkspaceId: "ws_1",
            publishedWorkspaceName: "Agent Coworker",
            openChannelCount: 2,
            lastError: nil
        )
    )

    let data = try JSONEncoder().encode(event)
    let decoded = try JSONDecoder().decode(BridgeEvent.self, from: data)

    #expect(decoded == event)
}

@Test
func bridgeApprovalRequestRoundTripPreservesPeerIdentity() throws {
    let event = BridgeEvent.approvalRequested(
        .init(
            peerId: "peer-approval",
            peerName: "My iPhone"
        )
    )

    let data = try JSONEncoder().encode(event)
    let decoded = try JSONDecoder().decode(BridgeEvent.self, from: data)

    #expect(decoded == event)
}

@MainActor
@Test
func relayAdvertisementIncludesIdentityKeyAndPublishedWorkspaceMetadata() {
    let deviceID = UUID(uuidString: "65e38fae-e34f-4086-bf5d-682806bc5396")!
    let identityKeyID = "test-identity-key"

    let advertisement = LoomBridgeService.makeRelayAdvertisement(
        localDeviceID: deviceID,
        identityKeyID: identityKeyID,
        publishedWorkspaceId: "workspace-1",
        publishedWorkspaceName: "AIWorkspace"
    )

    #expect(advertisement.deviceID == deviceID)
    #expect(advertisement.identityKeyID == identityKeyID)
    #expect(advertisement.metadata[RelayProtocolConstants.roleMetadataKey] == RelayProtocolConstants.hostMetadataRole)
    #expect(advertisement.metadata[RelayProtocolConstants.protocolMetadataKey] == String(RelayProtocolConstants.protocolVersion))
    #expect(advertisement.metadata[RelayProtocolConstants.workspaceIdMetadataKey] == "workspace-1")
    #expect(advertisement.metadata[RelayProtocolConstants.workspaceNameMetadataKey] == "AIWorkspace")
}
