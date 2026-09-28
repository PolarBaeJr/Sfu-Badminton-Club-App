import SwiftUI

struct AppRoot: View {
    let container: AppContainer
    let model: AppModel

    var body: some View {
        Group {
            if let services = container.services {
                switch model.auth {
                case .loading:
                    LoadingView()
                case let .signedOut(notice):
                    SignInScreen(services: services, notice: notice)
                case let .signedIn(session):
                    SignedIn(services: services, userId: session.userId)
                        .id(session.userId)
                }
            } else {
                ConfigErrorScreen(missing: missingNames)
            }
        }
        .background(Palette.background.ignoresSafeArea())
        .task {
            if let services = container.services { model.start(services) }
        }
    }

    private var missingNames: [String] {
        if case let .missing(names) = container.config { return names }
        return []
    }
}

enum Tab: CaseIterable {
    case leaderboard, challenges, sessions, myStats, membership

    var title: String {
        switch self {
        case .leaderboard: return "Leaderboard"
        case .challenges: return "Challenges"
        case .sessions: return "Sessions"
        case .myStats: return "My stats"
        case .membership: return "Membership"
        }
    }

    var icon: String {
        switch self {
        case .leaderboard: return "tab_leaderboard"
        case .challenges: return "tab_challenges"
        case .sessions: return "tab_sessions"
        case .myStats: return "tab_stats"
        case .membership: return "tab_membership"
        }
    }
}

/// What the signed-in screens read and do, as closures, so the same screens
/// draw from the live services or, in a debug build, from fixtures.
struct ScreenData: Sendable {
    let siteUrl: String?
    let ladder: @Sendable () async throws -> [LadderRow]
    let myStats: @Sendable (_ playerId: String) async throws -> MyStats
    let sessions: @Sendable (_ status: String?) async throws -> [UpcomingSession]
    let statement: @Sendable (Viewer) async throws -> Statement
    let signOut: @Sendable () async -> Void

    static func live(_ services: Services) -> ScreenData {
        let postgrest = services.postgrest
        let sessions = services.sessions
        return ScreenData(
            siteUrl: services.siteUrl,
            ladder: { try await loadLadder(postgrest) },
            myStats: { try await loadMyStats(postgrest, playerId: $0) },
            sessions: { try await loadUpcomingSessions(postgrest, playerStatus: $0) },
            statement: { try await loadStatement(postgrest, viewer: $0) },
            signOut: { await sessions.signOut() },
        )
    }
}

/// The member's own row, read once per session and shared by every tab.
private struct SignedIn: View {
    let services: Services
    @State private var viewer: Loader<Viewer?>

    init(services: Services, userId: String) {
        self.services = services
        let postgrest = services.postgrest
        _viewer = State(initialValue: Loader { try await loadViewer(postgrest, userId: userId) })
    }

    var body: some View {
        Group {
            switch viewer.state {
            case .loading:
                LoadingView()
            case let .failed(message):
                ErrorState(message: message) { viewer.load() }
            case let .loaded(data):
                if let data {
                    SignedInTabs(data: .live(services), viewer: data)
                } else {
                    NoPlayerRow(services: services)
                }
            }
        }
        .task { viewer.load() }
    }
}

/// A session with no player row: an account that never finished signing up, or
/// whose row is gone. Treated like the check after a code: the session is
/// dropped on this phone and the sign-in screen says why.
private struct NoPlayerRow: View {
    let services: Services

    var body: some View {
        LoadingView().task { await services.sessions.signOut(.unfinished) }
    }
}

/// A screen laid over the tabs. One slot, as on Android: opening another
/// replaces it. `list` is the challenges list, for a member whose tab bar has
/// no Challenges tab.
enum Overlay: Equatable {
    case detail(id: String)
    case newChallenge(opponent: String?)
    case checkIn(token: String)
    case list
}

/// The signed-in shell: brand bar, the open tab's screen, the tab bar. Only the
/// open tab's view exists, as on Android, so a closed tab holds no memory.
struct SignedInTabs: View {
    let data: ScreenData
    let viewer: Viewer
    @State private var tab: Tab
    @State private var overlay: Overlay?
    @State private var notice: String?

    init(data: ScreenData, viewer: Viewer, initialTab: Tab = .leaderboard) {
        self.data = data
        self.viewer = viewer
        _tab = State(initialValue: initialTab)
    }

    private var approved: Bool { isApproved(viewer) }
    private var tabs: [Tab] { Tab.allCases.filter { $0 != .challenges || approved } }

    var body: some View {
        let shown = tabs.contains(tab) ? tab : .leaderboard
        VStack(spacing: 0) {
            // The scanner lands with the challenge screens; until then there is
            // no scan button, rather than one that cannot scan.
            BrandBar(onScan: nil)
            if let notice {
                VStack(alignment: .leading, spacing: 0) {
                    Notice(text: notice)
                    TextLink(text: "Dismiss") { self.notice = nil }
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
            }
            ZStack {
                Palette.background
                if let overlay {
                    overlayView(overlay)
                } else {
                    screen(shown)
                }
            }
            .frame(maxHeight: .infinity)
            TabBar(tabs: tabs, selected: overlay == nil ? shown : nil) {
                tab = $0
                overlay = nil
                notice = nil
            }
        }
        .background(Palette.background.ignoresSafeArea())
    }

    @ViewBuilder
    private func screen(_ tab: Tab) -> some View {
        switch tab {
        case .leaderboard:
            LeaderboardScreen(viewer: viewer, load: data.ladder, onChallenge: nil)
        case .challenges:
            Placeholder(title: tab.title)
        case .sessions:
            SessionsScreen(viewer: viewer, load: data.sessions, onScan: nil)
        case .myStats:
            MyStatsScreen(viewer: viewer, load: data.myStats, signOut: data.signOut)
        case .membership:
            MembershipScreen(viewer: viewer, load: data.statement)
        }
    }

    @ViewBuilder
    private func overlayView(_ overlay: Overlay) -> some View {
        switch overlay {
        case .detail, .newChallenge:
            OverlayFrame(back: "Back to challenges", onBack: { self.overlay = nil }) { Placeholder(title: "Challenges") }
        case .checkIn:
            OverlayFrame(back: "Back", onBack: { self.overlay = nil }) { Placeholder(title: "Check in") }
        case .list:
            OverlayFrame(back: "Back", onBack: { self.overlay = nil }) { Placeholder(title: "Challenges") }
        }
    }
}

/// A screen over the tabs: the web's "Back to ..." link above it.
private struct OverlayFrame<Content: View>: View {
    let back: String
    let onBack: () -> Void
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TextLink(text: back, action: onBack).padding(.horizontal, 12)
            content.frame(maxHeight: .infinity)
        }
    }
}

/// A screen that is not drawn in this build yet.
private struct Placeholder: View {
    let title: String

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                PageHeader(title: title, padding: EdgeInsets(top: 20, leading: 0, bottom: 4, trailing: 0))
                Card {
                    BodyText(text: "This screen arrives in the next build.", muted: true)
                }
            }
            .padding(.horizontal, 16)
        }
    }
}

/// The site header: the red tile and the club's name. Each page carries its own title.
private struct BrandBar: View {
    let onScan: (() -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                BrandTile(size: 30, corner: 8, markSize: 20)
                Text("SFU Badminton")
                    .foregroundStyle(Palette.text)
                    .textStyle(TypeStyle.brand)
                Spacer()
                if let onScan {
                    Button(action: onScan) {
                        Image("scan")
                            .renderingMode(.template)
                            .resizable()
                            .frame(width: 22, height: 22)
                            .foregroundStyle(Palette.ink2)
                            .frame(width: 48, height: 48)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Scan a club QR code")
                }
            }
            .padding(.leading, 14)
            .padding(.trailing, 4)
            .padding(.vertical, 12)
            Rectangle().fill(Palette.line).frame(height: 1)
        }
        .background(Palette.background)
    }
}

/// The web's mobile tab bar: line icons over small labels, red for the open tab.
private struct TabBar: View {
    let tabs: [Tab]
    let selected: Tab?
    let onSelect: (Tab) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Palette.line).frame(height: 1)
            HStack(spacing: 0) {
                ForEach(tabs, id: \.self) { t in
                    let isSelected = selected == t
                    let color = isSelected ? Palette.accent : Palette.muted
                    Button { onSelect(t) } label: {
                        VStack(spacing: 3) {
                            Image(t.icon)
                                .renderingMode(.template)
                                .resizable()
                                .frame(width: 20, height: 20)
                            Text(t.title)
                                .textStyle(TypeStyle.tabLabel)
                                .lineLimit(1)
                        }
                        .foregroundStyle(color)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 8)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(isSelected ? [.isSelected] : [])
                }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 6)
        }
        .background(Palette.background.ignoresSafeArea(edges: .bottom))
    }
}
