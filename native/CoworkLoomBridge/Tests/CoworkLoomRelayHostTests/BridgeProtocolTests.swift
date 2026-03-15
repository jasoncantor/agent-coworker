import Foundation
import Testing

import Loom

@testable import CoworkLoomRelayClient
@testable import CoworkLoomRelayCore
@testable import CoworkLoomRelayHost

private func makeTemporaryApprovedPeerStorageURL() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("cowork-loom-bridge-tests", isDirectory: true)
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appendingPathComponent("approved-peer-id.txt")
}

private func makeTemporaryClientSupportDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("cowork-loom-relay-client-tests", isDirectory: true)
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
}

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

@MainActor
@Test
func approvedPeerTrustProviderOnlyKeepsLatestApprovedPeer() async throws {
    let storageURL = try makeTemporaryApprovedPeerStorageURL()
    defer {
        try? FileManager.default.removeItem(at: storageURL.deletingLastPathComponent())
    }

    let provider = ApprovedPeerTrustProvider(storageURL: storageURL)
    provider.setApprovedPeerID(nil)

    let peerA = LoomPeerIdentity(
        deviceID: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!,
        name: "Phone A",
        deviceType: .iPhone,
        iCloudUserID: nil,
        identityKeyID: nil,
        identityPublicKey: nil,
        isIdentityAuthenticated: true,
        endpoint: "peer-a.local"
    )
    let peerB = LoomPeerIdentity(
        deviceID: UUID(uuidString: "22222222-2222-2222-2222-222222222222")!,
        name: "Phone B",
        deviceType: .iPhone,
        iCloudUserID: nil,
        identityKeyID: nil,
        identityPublicKey: nil,
        isIdentityAuthenticated: true,
        endpoint: "peer-b.local"
    )

    try await provider.grantTrust(to: peerA)
    #expect(await provider.evaluateTrust(for: peerA) == .trusted)

    try await provider.grantTrust(to: peerB)

    #expect(await provider.evaluateTrust(for: peerA) == .requiresApproval)
    #expect(await provider.evaluateTrust(for: peerB) == .trusted)
}

@MainActor
@Test
func approvedPeerTrustProviderTrustsMatchingIdentityKeyAfterDeviceIDChanges() async throws {
    let storageURL = try makeTemporaryApprovedPeerStorageURL()
    defer {
        try? FileManager.default.removeItem(at: storageURL.deletingLastPathComponent())
    }

    let provider = ApprovedPeerTrustProvider(storageURL: storageURL)
    provider.setApprovedPeerID(nil)

    let approvedPeer = LoomPeerIdentity(
        deviceID: UUID(uuidString: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")!,
        name: "Phone A",
        deviceType: .iPhone,
        iCloudUserID: nil,
        identityKeyID: "identity-key-a",
        identityPublicKey: nil,
        isIdentityAuthenticated: true,
        endpoint: "peer-a.local"
    )
    let reissuedPeer = LoomPeerIdentity(
        deviceID: UUID(uuidString: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")!,
        name: "Phone A",
        deviceType: .iPhone,
        iCloudUserID: nil,
        identityKeyID: "identity-key-a",
        identityPublicKey: nil,
        isIdentityAuthenticated: true,
        endpoint: "peer-a-reissued.local"
    )
    let otherPeer = LoomPeerIdentity(
        deviceID: UUID(uuidString: "cccccccc-cccc-cccc-cccc-cccccccccccc")!,
        name: "Phone B",
        deviceType: .iPhone,
        iCloudUserID: nil,
        identityKeyID: "identity-key-b",
        identityPublicKey: nil,
        isIdentityAuthenticated: true,
        endpoint: "peer-b.local"
    )

    try await provider.grantTrust(to: approvedPeer)

    #expect(await provider.evaluateTrust(for: approvedPeer) == .trusted)
    #expect(await provider.evaluateTrust(for: reissuedPeer) == .trusted)
    #expect(await provider.evaluateTrust(for: otherPeer) == .requiresApproval)
}

@MainActor
@Test
func failedConnectPeerLeavesRequestedPeerTrustedWhileClearingConnectingState() async throws {
    struct PersistedApprovedPeer: Decodable {
        let deviceID: UUID
        let identityKeyID: String?
    }

    actor EventRecorder {
        var events: [BridgeEvent] = []

        func append(_ event: BridgeEvent) {
            events.append(event)
        }

        func all() -> [BridgeEvent] {
            events
        }
    }

    let storageURL = try makeTemporaryApprovedPeerStorageURL()
    defer {
        try? FileManager.default.removeItem(at: storageURL.deletingLastPathComponent())
    }

    let recorder = EventRecorder()
    let service = LoomBridgeService(
        emitEvent: { event in
            Task {
                await recorder.append(event)
            }
        },
        trustProvider: ApprovedPeerTrustProvider(storageURL: storageURL)
    )
    let requestedPeerID = "33333333-3333-3333-3333-333333333333"

    await service.handle(.connectPeer(peerId: requestedPeerID))
    await Task.yield()
    await Task.yield()

    let storedPeer = try JSONDecoder().decode(PersistedApprovedPeer.self, from: Data(contentsOf: storageURL))
    #expect(storedPeer.deviceID.uuidString.lowercased() == requestedPeerID)
    #expect(storedPeer.identityKeyID == nil)

    let emittedEvents = await recorder.all()
    let finalState = emittedEvents.compactMap { event -> BridgeState? in
        guard case let .state(state) = event else {
            return nil
        }
        return state
    }.last

    #expect(finalState?.peer == nil)
    #expect(finalState?.lastError == "Requested Loom peer was not found in discovery results.")
}

@Test
func defaultConfigurationPersistsClientDeviceIDAcrossReinitialization() throws {
    let supportDirectory = try makeTemporaryClientSupportDirectory()
    let previousOverride = ProcessInfo.processInfo.environment["COWORK_LOOM_RELAY_CLIENT_APP_SUPPORT_DIR"]
    setenv("COWORK_LOOM_RELAY_CLIENT_APP_SUPPORT_DIR", supportDirectory.path, 1)
    defer {
        if let previousOverride {
            setenv("COWORK_LOOM_RELAY_CLIENT_APP_SUPPORT_DIR", previousOverride, 1)
        } else {
            unsetenv("COWORK_LOOM_RELAY_CLIENT_APP_SUPPORT_DIR")
        }
        try? FileManager.default.removeItem(at: supportDirectory)
    }

    let first = CoworkLoomRelayClientConfiguration()
    let second = CoworkLoomRelayClientConfiguration()
    let storedDeviceID = try String(
        contentsOf: supportDirectory.appendingPathComponent("device-id.txt"),
        encoding: .utf8
    ).trimmingCharacters(in: .whitespacesAndNewlines)

    #expect(first.deviceID == second.deviceID)
    #expect(storedDeviceID == first.deviceID.uuidString.lowercased())
}
