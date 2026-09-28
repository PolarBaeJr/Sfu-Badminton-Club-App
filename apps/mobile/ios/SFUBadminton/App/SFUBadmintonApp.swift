import SwiftUI

@main
struct SFUBadmintonApp: App {
    // Hosted unit tests launch the app too: build nothing then, so no test
    // touches the Keychain session or the network through the app.
    private static let underTest = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil

    @State private var container: AppContainer? = underTest ? nil : AppContainer()
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            if let container {
                AppRoot(container: container, model: model)
                    .preferredColorScheme(.dark)
                    .onOpenURL { takeLink($0) }
                    .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                        if let url = activity.webpageURL { takeLink(url) }
                    }
                    .onChange(of: scenePhase) { _, phase in
                        // A token that expired while the app was in the
                        // background is refreshed on return, before the first
                        // screen's read needs it.
                        guard phase == .active, let services = container.services else { return }
                        Task { _ = try? await services.sessions.validAccessToken() }
                    }
            } else {
                Color.black
            }
        }
    }

    /// An https link the system handed over, queued for the signed-in screens to route.
    private func takeLink(_ url: URL) {
        guard url.scheme?.lowercased() == "https" else { return }
        model.pendingLink = url.absoluteString
    }
}
