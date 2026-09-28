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
                    Tabs(services: services, userId: session.userId)
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

/// The signed-in shell: brand bar, the open tab's screen, the tab bar. Only the
/// open tab's view exists, as on Android, so a closed tab holds no memory.
/// The screens themselves are placeholders until the data layer lands.
private struct Tabs: View {
    let services: Services
    let userId: String
    @State private var tab: Tab = .leaderboard

    var body: some View {
        VStack(spacing: 0) {
            BrandBar()
            ZStack {
                Palette.background
                screen(tab)
            }
            .frame(maxHeight: .infinity)
            TabBar(tabs: Tab.allCases, selected: tab) { tab = $0 }
        }
        .background(Palette.background.ignoresSafeArea())
    }

    @ViewBuilder
    private func screen(_ tab: Tab) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                PageHeader(title: tab.title, padding: EdgeInsets(top: 20, leading: 0, bottom: 4, trailing: 0))
                Card {
                    BodyText(text: "This screen arrives in the next build.", muted: true)
                }
                if tab == .myStats {
                    GhostButton(title: "Sign out") {
                        Task { await services.sessions.signOut() }
                    }
                }
            }
            .padding(.horizontal, 16)
        }
        .id(tab)
    }
}

/// The site header: the red tile and the club's name. Each page carries its own title.
private struct BrandBar: View {
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                BrandTile(size: 30, corner: 8, markSize: 20)
                Text("SFU Badminton")
                    .foregroundStyle(Palette.text)
                    .textStyle(TypeStyle.brand)
                Spacer()
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
