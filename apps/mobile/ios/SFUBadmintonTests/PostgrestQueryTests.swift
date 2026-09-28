import XCTest
@testable import SFUBadminton

// Port of PostgrestQueryTest.kt.
final class PostgrestQueryTests: XCTestCase {
    func test_stripsWhitespaceFromASelectExceptInsideQuotes() {
        XCTAssertEqual("id,name,\"a b\"", PostgrestQuery.cleanSelect(" id,  name,\n\"a b\" "))
    }

    func test_encodesTheRfc3986WayNeverAsAForm() {
        XCTAssertEqual("a%20b%2Bc~._-", percentEncode("a b+c~._-"))
        XCTAssertEqual("%C3%A9", percentEncode("\u{00E9}"))
    }

    func test_readsTheViewersOwnRow() {
        XCTAssertEqual(
            "/rest/v1/players_self?select=id%2Cfull_name%2Cstatus%2Cis_exec%2Cfee_exempt%2Cavatar_url%2Ccreated_at",
            PostgrestQuery.select("players_self", "id, full_name, status, is_exec, fee_exempt, avatar_url, created_at").pathAndQuery(),
        )
    }

    func test_readsHandleAndMemberCodeByUserId() {
        XCTAssertEqual(
            "/rest/v1/players?select=handle%2Cmember_code&user_id=eq.u1",
            PostgrestQuery.select("players", "handle, member_code").eq("user_id", "u1").pathAndQuery(),
        )
    }

    func test_readsTheMembersFeesNewestFirst() {
        XCTAssertEqual(
            "/rest/v1/club_fees?select=id%2Cfee_type%2Cseason_id%2Ctournament_id%2Cclub_event_id%2Camount_cents%2C" +
                "paid_at%2Cmethod%2Creference%2Ccreated_at%2Cfee_submissions%28id%2Cstatus%2Creference%2C" +
                "reject_reason%2Csubmitted_at%29&player_id=eq.p1&order=created_at.desc",
            PostgrestQuery.select("club_fees", ownFeeColumns).eq("player_id", "p1")
                .order("created_at", ascending: false).pathAndQuery(),
        )
    }

    func test_deduplicatesAnInListAndQuotesAValueHoldingAReservedCharacter() {
        XCTAssertEqual(
            "/rest/v1/tournaments?select=id%2Cname&id=in.%28a%2Cb%2C%22c%2Cd%22%29",
            PostgrestQuery.select("tournaments", "id, name").isIn("id", ["a", "b", "a", "c,d"]).pathAndQuery(),
        )
    }

    func test_callsAnRpcByPostWithNoQueryString() {
        let q = PostgrestQuery.rpc("get_leaderboard")
        XCTAssertEqual("POST", q.method)
        XCTAssertEqual("/rest/v1/rpc/get_leaderboard", q.pathAndQuery())
    }

    func test_sendsTheAnonKeyAndTheMembersToken() {
        XCTAssertEqual(
            ["apikey": "anon", "Authorization": "Bearer tok", "Accept": "application/json"],
            PostgrestQuery.headers(anonKey: "anon", accessToken: "tok", withBody: false),
        )
        XCTAssertEqual("application/json", PostgrestQuery.headers(anonKey: "anon", accessToken: "tok", withBody: true)["Content-Type"])
    }
}
