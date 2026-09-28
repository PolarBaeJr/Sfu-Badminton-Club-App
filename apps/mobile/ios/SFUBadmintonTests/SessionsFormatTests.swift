import XCTest
@testable import SFUBadminton

// Port of SessionsFormatTest.kt.
final class SessionsFormatTests: XCTestCase {
    func test_formatsAPostgresDateWithoutAZone() {
        XCTAssertEqual("Sun 4 Oct", formatSessionDate("2026-10-04"))
        XCTAssertEqual("Sun 4 Oct", formatSessionDate("2026-10-04T00:00:00"))
    }

    func test_leavesAMalformedDateUnchanged() {
        XCTAssertEqual("soon", formatSessionDate("soon"))
    }

    func test_writesATimeRangeAStartAloneOrNothing() {
        XCTAssertEqual("18:00 to 20:30", timeRange("18:00:00", "20:30:00"))
        XCTAssertEqual("18:00", timeRange("18:00:00", nil))
        XCTAssertEqual("", timeRange(nil, nil))
    }

    func test_buildsTheWebsScheduleQuery() {
        XCTAssertEqual(
            "/rest/v1/sessions?select=id%2Cname%2Cdate%2Cstart_time%2Cend_time%2Clocation%2Ctrack" +
                "&status=eq.open&track=in.%28competitive%2Call%29&date=gte.2026-10-04" +
                "&or=%28season_id.eq.s1%2Cseason_id.is.null%29&order=date.asc%2Cstart_time.asc.nullslast",
            upcomingSessionsQuery(playerStatus: "competitive", today: "2026-10-04", activeSeasonId: "s1").pathAndQuery(),
        )
    }

    func test_leavesTheSeasonFilterOffWithNoActiveSeason() {
        XCTAssertEqual(
            "/rest/v1/sessions?select=id%2Cname%2Cdate%2Cstart_time%2Cend_time%2Clocation%2Ctrack" +
                "&status=eq.open&track=in.%28competitive%2Crecreational%2Call%29&date=gte.2026-10-04" +
                "&order=date.asc%2Cstart_time.asc.nullslast",
            upcomingSessionsQuery(playerStatus: "pending_approval", today: "2026-10-04", activeSeasonId: nil).pathAndQuery(),
        )
    }
}
