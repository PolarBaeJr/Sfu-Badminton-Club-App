import Foundation

// Port of Sessions.kt (the Expo app's src/lib/sessions.ts and the date helpers
// from its SessionsScreen.tsx). Keep in step with them.

struct ActiveSeasonRow: Equatable, Sendable {
    let id: String
    let name: String?
}

extension ActiveSeasonRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.reqString("id")
        name = try row.optString("name")
    }
}

/// get_active_season() returns a set; the first row is the season, none means no season.
func loadActiveSeason(_ postgrest: Postgrest) async throws -> ActiveSeasonRow? {
    try await postgrest.list(PostgrestQuery.rpc("get_active_season"), what: "the season", ActiveSeasonRow.init(json:)).first
}

struct UpcomingSession: Equatable, Sendable {
    var id: String
    var name: String? = nil
    var date: String
    var startTime: String? = nil
    var endTime: String? = nil
    var location: String = ""
    var track: String = ""
}

extension UpcomingSession {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.reqString("id")
        name = try row.optString("name")
        date = try row.reqString("date")
        startTime = try row.optString("start_time")
        endTime = try row.optString("end_time")
        location = try row.optString("location") ?? ""
        track = try row.optString("track") ?? ""
    }
}

func upcomingSessionsQuery(playerStatus: String?, today: String, activeSeasonId: String?) -> PostgrestQuery {
    var query = PostgrestQuery.select("sessions", "id, name, date, start_time, end_time, location, track")
        .eq("status", "open")
        .isIn("track", visibleTracksFor(playerStatus))
        .gte("date", today)
    if let seasonFilter = activeSeasonOrFilter(activeSeasonId) { query = query.or(seasonFilter) }
    return query
        .order("date", ascending: true)
        .order("start_time", ascending: true, nullsLast: true)
}

/// Open sessions from today on, in the active season (and season-less ones), on
/// the member's tracks: the scope of the web's schedule, with "today" taken on
/// the club's clock rather than the phone's.
func loadUpcomingSessions(_ postgrest: Postgrest, playerStatus: String?) async throws -> [UpcomingSession] {
    let season = try await loadActiveSeason(postgrest)
    return try await postgrest.list(
        upcomingSessionsQuery(playerStatus: playerStatus, today: clubToday(), activeSeasonId: season?.id),
        what: "sessions",
        UpcomingSession.init(json:),
    )
}

private let sessionDateFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    f.calendar = Calendar(identifier: .gregorian)
    f.dateFormat = "EEE d MMM"
    return f
}()

/// "Sun 4 Oct" from a Postgres DATE, read as a date with no zone so it cannot slip a day.
func formatSessionDate(_ date: String) -> String {
    guard let day = parseIsoDay(String(date.prefix(10))) else { return date }
    return sessionDateFormatter.string(from: day)
}

/// A strict YYYY-MM-DD at UTC midnight, as LocalDate.parse reads it: 2026-02-30 is refused.
func parseIsoDay(_ text: String) -> Date? {
    guard let m = text.wholeMatch(of: /(\d{4})-(\d{2})-(\d{2})/),
          let y = Int(m.1), let mo = Int(m.2), let d = Int(m.3) else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    guard let date = calendar.date(from: DateComponents(year: y, month: mo, day: d)) else { return nil }
    let back = calendar.dateComponents([.year, .month, .day], from: date)
    guard back.year == y, back.month == mo, back.day == d else { return nil }
    return date
}

func timeRange(_ start: String?, _ end: String?) -> String {
    let s = start.map { String($0.prefix(5)) }
    let e = end.map { String($0.prefix(5)) }
    if let s, !s.isEmpty, let e, !e.isEmpty { return "\(s) to \(e)" }
    return s ?? ""
}
