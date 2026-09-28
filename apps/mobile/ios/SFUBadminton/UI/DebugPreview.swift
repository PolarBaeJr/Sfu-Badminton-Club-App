#if DEBUG
import SwiftUI

// A debug-only way to see the signed-in screens without an account: launch
// with `-previewTab leaderboard` (or challenges, sessions, myStats, membership)
// and optionally `-previewPending YES` or `-previewScrollToBottom YES` (the
// ladder opened at its end). The screens draw from the invented
// fixtures below through the same pure builders the live loaders use. No
// service, Keychain item or network request exists in this mode.
enum DebugPreview {
    static var tab: Tab? {
        guard let name = UserDefaults.standard.string(forKey: "previewTab") else { return nil }
        return Tab.allCases.first { "\($0)" == name }
    }

    static var pending: Bool { UserDefaults.standard.bool(forKey: "previewPending") }

    static var scrollToBottom: Bool { UserDefaults.standard.bool(forKey: "previewScrollToBottom") }

    static let viewer = Viewer(
        id: "p-me",
        fullName: "Alex Rivera",
        status: "competitive",
        isExec: false,
        feeExempt: false,
        avatarUrl: nil,
        createdAt: "2026-09-01T00:00:00Z",
        handle: "alex_rivera",
        memberCode: "QX7K2M9",
    )

    static let ladder: [LadderRow] = [
        LadderRow(id: "p1", name: "Jordan Blake", handle: "jblake", status: "competitive", singlesElo: 1284, doublesElo: 1190),
        LadderRow(id: "p2", name: "Casey Morgan", handle: "casey_m", status: "competitive", singlesElo: 1231.6, doublesElo: 1302),
        LadderRow(id: "p3", name: "Rowan Ellis", handle: nil, status: "recreational", singlesElo: 1180, doublesElo: 1105),
        LadderRow(id: "p4", name: "Sam Okafor", handle: "samo", status: "competitive", singlesElo: 1180, doublesElo: 1150),
        LadderRow(id: "p-me", name: "Alex Rivera", handle: "alex_rivera", status: "competitive", singlesElo: 1122.4, doublesElo: 1088),
        LadderRow(id: "p5", name: "Taylor Nguyen", handle: "tnguyen", status: "recreational", singlesElo: 1050, doublesElo: 1210),
        LadderRow(id: "p6", name: "Morgan Price", handle: "mprice", status: "competitive", singlesElo: 1012, doublesElo: 990),
        LadderRow(id: "p7", name: "Riley Chen", handle: nil, status: "recreational", singlesElo: 980, doublesElo: 1001),
        LadderRow(id: "p8", name: "Quinn Adler", handle: "quinn_a", status: "competitive", singlesElo: 944, doublesElo: 930),
        LadderRow(id: "p9", name: "Drew Castillo", handle: "drewc", status: "recreational", singlesElo: 900, doublesElo: 920),
    ]

    static let season = ActiveSeasonRow(id: "s-fall", name: "Fall 2026")

    private static func match(_ id: String, _ season: String, _ day: String, _ type: String, _ status: String, win: Bool?, delta: Double?, score: String) -> MyMatchRow {
        var participant: [(String, JSONValue)] = [("player_id", .string("p-me")), ("points_scored", .int(42)), ("points_allowed", .int(35))]
        if let win { participant.append(("win_flag", .bool(win))) }
        if let delta { participant.append(("rating_delta", .double(delta))) }
        return MyMatchRow(
            id: id,
            seasonId: season,
            playedAt: "\(day)T02:00:00Z",
            matchType: type,
            resultStatus: status,
            scoreSummary: score,
            participants: .array([.object([("player_id", .string("p-other")), ("win_flag", .bool(!(win ?? false)))]), .object(participant)]),
        )
    }

    static let matches: [MyMatchRow] = [
        match("m1", "s-fall", "2026-09-24", "singles", "confirmed", win: true, delta: 14.6, score: "21-17, 21-19"),
        match("m2", "s-fall", "2026-09-20", "doubles", "confirmed", win: false, delta: -9.5, score: "18-21, 21-23"),
        match("m3", "s-fall", "2026-09-17", "singles", "pending_confirmation", win: nil, delta: nil, score: "21-12, 21-15"),
        match("m4", "s-fall", "2026-09-12", "doubles", "walkover", win: true, delta: 6.2, score: "Walkover"),
        // An earlier season's match: never listed under this one.
        match("m0", "s-old", "2026-04-02", "singles", "confirmed", win: true, delta: 30, score: "21-3, 21-4"),
    ]

    static let sessions: [UpcomingSession] = [
        UpcomingSession(id: "x1", name: "Friday Drop in", date: "2026-10-02", startTime: "19:30:00", endTime: "21:30:00", location: "North Gym", track: "all"),
        UpcomingSession(id: "x2", name: "Competitive Night", date: "2026-10-06", startTime: "18:00:00", endTime: "20:30:00", location: "South Gym", track: "competitive"),
        UpcomingSession(id: "x3", name: nil, date: "2026-10-09", startTime: "19:30:00", endTime: nil, location: "", track: "all"),
        UpcomingSession(id: "x4", name: "Tuesday Drop in", date: "2026-10-13", startTime: "19:30:00", endTime: "21:30:00", location: "North Gym", track: "all"),
    ]

    static let statementSeason = StatementSeason(id: "s-fall", name: "Fall 2026", endDate: "2026-12-10", competitiveFeeCents: 6000, recreationalFeeCents: 4000)

    static let feeRows: [OwnFeeRow] = [
        OwnFeeRow(id: "f1", feeType: "tournament", tournamentId: "t1", amountCents: 1500, paidAt: "2026-09-18T20:00:00Z", method: "e_transfer"),
        OwnFeeRow(id: "f2", feeType: "event", clubEventId: "e1", amountCents: nil),
        OwnFeeRow(id: "f3", feeType: "event", clubEventId: "e2", amountCents: 0, paidAt: "2026-09-10T20:00:00Z", method: "waived"),
    ]

    static var data: ScreenData {
        ScreenData(
            siteUrl: "https://site.example.invalid",
            ladder: { ladder },
            myStats: { id in
                try buildMyStats(rating: RatingRow(singlesElo: 1122.4, doublesElo: 1088), ladder: ladder, season: season, matches: matches, playerId: id)
            },
            sessions: { _ in sessions },
            statement: { viewer in
                buildStatement(
                    viewer: viewer,
                    season: statementSeason,
                    feeRows: feeRows,
                    tournamentNames: ["t1": "Fall Open"],
                    eventNames: ["e1": "Year-end banquet", "e2": "Welcome social"],
                )
            },
            signOut: {},
        )
    }

    @MainActor
    static func root(_ tab: Tab) -> some View {
        var v = viewer
        if pending {
            v = Viewer(id: v.id, fullName: v.fullName, status: "pending_approval", isExec: false, feeExempt: false, avatarUrl: nil, createdAt: v.createdAt, handle: v.handle, memberCode: v.memberCode)
        }
        return SignedInTabs(data: data, viewer: v, initialTab: tab)
            .preferredColorScheme(.dark)
    }
}
#endif
