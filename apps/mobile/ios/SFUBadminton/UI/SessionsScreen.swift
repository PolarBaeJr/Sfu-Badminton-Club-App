import SwiftUI

// Port of SessionsScreen.kt.

struct SessionsScreen: View {
    let viewer: Viewer
    let onScan: (() -> Void)?
    @State private var loader: Loader<[UpcomingSession]>

    init(viewer: Viewer, load: @escaping @Sendable (String?) async throws -> [UpcomingSession], onScan: (() -> Void)?) {
        self.viewer = viewer
        self.onScan = onScan
        let status = viewer.status
        _loader = State(initialValue: Loader { try await load(status) })
    }

    var body: some View {
        Group {
            switch loader.state {
            case .loading:
                VStack(spacing: 0) {
                    PageHeader(title: "Sessions")
                    LoadingView()
                }
            case let .failed(message):
                VStack(spacing: 0) {
                    PageHeader(title: "Sessions")
                    ErrorState(message: message) { loader.load() }
                }
            case let .loaded(sessions):
                list(sessions)
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .task(id: "\(viewer.id)|\(viewer.status ?? "")") { loader.load() }
        .onDisappear { loader.cancel() }
    }

    private func list(_ sessions: [UpcomingSession]) -> some View {
        GeometryReader { geo in
            ScrollView {
                LazyVStack(spacing: 12) {
                    PageHeader(title: "Sessions", padding: EdgeInsets(top: 20, leading: 0, bottom: 8, trailing: 0))
                    if let onScan {
                        GhostButton(title: "Scan the door code", icon: "scan", action: onScan)
                    }
                    if sessions.isEmpty {
                        EmptyState(message: "No sessions are scheduled yet.").frame(height: geo.size.height * 0.6)
                    }
                    ForEach(Array(sessions.enumerated()), id: \.element.id) { i, session in
                        SessionCard(session: session, next: i == 0)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 20)
            }
            .refreshable { await loader.refresh() }
        }
    }
}

private struct SessionCard: View {
    let session: UpcomingSession
    let next: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 12)
        let time = timeRange(session.startTime, session.endTime)
        VStack(alignment: .leading, spacing: 0) {
            Text(formatSessionDate(session.date).uppercased()).foregroundStyle(Palette.muted).textStyle(TypeStyle.sessDate)
            Text(session.name ?? "Club session")
                .foregroundStyle(Palette.text)
                .textStyle(TextSpec(face: .condensed, size: 22, relativeTo: .title3))
                .padding(.top, 6)
            if !time.isEmpty {
                Text(time).foregroundStyle(Palette.text).textStyle(TypeStyle.sessTime).padding(.top, 6)
            }
            if !session.location.isEmpty {
                Text(session.location).foregroundStyle(Palette.muted).textStyle(TypeStyle.sessMeta).padding(.top, 8)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.surface)
        // The next session carries the web's red spine.
        .overlay(alignment: .leading) {
            if next { Rectangle().fill(Palette.accent).frame(width: 3) }
        }
        .clipShape(shape)
        .overlay(shape.strokeBorder(Palette.line, lineWidth: 1))
    }
}
